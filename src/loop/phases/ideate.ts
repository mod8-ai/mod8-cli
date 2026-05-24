/**
 * IDEATE phase — real Phase 2 implementation.
 *
 * Uses runStructuredPhase (generateObject) to produce a schema-validated
 * Proposal[] from the latest sense bundle + product memory + priors.
 *
 * Outputs are persisted via loop/proposal.ts so prioritize/build can
 * load them by id, and /why has them visible.
 */

import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import type { PolicyConfig, ProductContext, SignalBundle } from '../types.js';
import { runStructuredPhase, runDeterministicPhase } from '../runPhase.js';
import type { PhaseResult } from '../runPhase.js';
import { load as loadPrompt } from '../promptLoader.js';
import { newProposalId, save as saveProposal, type Proposal, PROPOSAL_KINDS } from '../proposal.js';
import { productFiles } from '../../memory/paths.js';
import * as feedback from '../../memory/feedback.js';
import * as events from '../events.js';

const ProposalLlmSchema = z.object({
  kind: z.enum(PROPOSAL_KINDS),
  title: z.string().max(120),
  summary: z.string(),
  targetFiles: z.array(z.string()),
  evidenceDigests: z.array(z.string()),
  rationale: z.string(),
  estimatedEffort: z.enum(['small', 'medium', 'large']),
  estimatedRisk: z.enum(['low', 'medium', 'high']),
  estimatedImpact: z.enum(['low', 'medium', 'high']),
  rollbackHint: z.string(),
  successCriteria: z.string(),
});

const IdeateLlmOutput = z.object({
  proposals: z.array(ProposalLlmSchema).max(5),
});

export interface IdeateOutput {
  schemaVersion: 1;
  proposals: Proposal[];
}

export async function run(
  ctx: ProductContext,
  policy: PolicyConfig,
  bundle: SignalBundle
): Promise<PhaseResult<IdeateOutput>> {
  // If the bundle has no fresh signals, skip ideate — nothing to react to.
  if (bundle.newSignals.length === 0) {
    return runDeterministicPhase<IdeateOutput>({
      ctx,
      phase: 'ideate',
      policy,
      summary: 'ideate skipped — no new signals',
      body: async () => {
        await events.append(ctx, {
          phase: 'ideate',
          kind: 'skipped',
          payload: { reason: 'no new signals from sense' },
        });
        return { schemaVersion: 1, proposals: [] };
      },
    });
  }

  const system = await loadPrompt('ideate', { slug: ctx.slug });
  const userMessage = await assembleUserMessage(ctx, bundle);

  const llmResult = await runStructuredPhase({
    ctx,
    phase: 'ideate',
    policy,
    system,
    userMessage,
    schema: IdeateLlmOutput,
    maxOutputTokens: 4000,
  });

  if (!llmResult.ok || !llmResult.output) {
    return {
      ok: llmResult.ok,
      output: { schemaVersion: 1, proposals: [] },
      ...(llmResult.reason ? { reason: llmResult.reason } : {}),
      durationMs: llmResult.durationMs,
    };
  }

  const proposals: Proposal[] = [];
  for (const draft of llmResult.output.proposals) {
    const p: Proposal = {
      schemaVersion: 1,
      id: newProposalId(),
      productSlug: ctx.slug,
      createdAt: Date.now(),
      createdByPhase: 'ideate',
      originTickId: ctx.tickId,
      kind: draft.kind,
      title: draft.title,
      summary: draft.summary,
      targetFiles: draft.targetFiles,
      evidenceDigests: draft.evidenceDigests,
      rationale: draft.rationale,
      estimatedEffort: draft.estimatedEffort,
      estimatedRisk: draft.estimatedRisk,
      estimatedImpact: draft.estimatedImpact,
      rollbackHint: draft.rollbackHint,
      successCriteria: draft.successCriteria,
    };
    try {
      await saveProposal(ctx, p);
      proposals.push(p);
    } catch (err) {
      await events.append(ctx, {
        phase: 'ideate',
        kind: 'error',
        payload: { reason: `failed to save proposal: ${err instanceof Error ? err.message : String(err)}` },
      });
    }
  }

  return {
    ok: true,
    output: { schemaVersion: 1, proposals },
    durationMs: llmResult.durationMs,
  };
}

async function assembleUserMessage(ctx: ProductContext, bundle: SignalBundle): Promise<string> {
  const productMd = existsSync(productFiles.productMd(ctx))
    ? await fs.readFile(productFiles.productMd(ctx), 'utf8')
    : '(no product.md available)';
  const architectureMd = existsSync(productFiles.architectureMd(ctx))
    ? await fs.readFile(productFiles.architectureMd(ctx), 'utf8')
    : '(no architecture.md available)';
  const priors = existsSync(productFiles.priors(ctx))
    ? await fs.readFile(productFiles.priors(ctx), 'utf8')
    : '{}';

  // Compact summary of new signals — cap at 20 to keep context modest.
  const sampleSignals = bundle.newSignals.slice(0, 20).map((s) => ({
    digest: s.digest, source: s.source, kind: s.kind, title: s.title,
    body: s.body ? s.body.slice(0, 400) : undefined,
  }));

  // Recent feedback corpora across all sources (most recent 5 per source).
  const sources = ['inbox-folder', 'github', 'git-local'];
  const recentBySource: Record<string, unknown[]> = {};
  for (const src of sources) {
    const all = await feedback.readAll(ctx, src, 5);
    recentBySource[src] = all.map((s) => ({
      digest: s.digest, kind: s.kind, title: s.title,
      body: s.body ? s.body.slice(0, 200) : undefined,
    }));
  }

  return [
    '## product.md',
    productMd,
    '',
    '## architecture.md (excerpt)',
    architectureMd.slice(0, 8000),
    '',
    '## priors.json',
    priors.slice(0, 4000),
    '',
    '## new signals from this sense run',
    JSON.stringify(sampleSignals, null, 2),
    '',
    '## recent signals by source',
    JSON.stringify(recentBySource, null, 2),
    '',
    'Now propose 1-5 improvements per the schema.',
  ].join('\n');
}
