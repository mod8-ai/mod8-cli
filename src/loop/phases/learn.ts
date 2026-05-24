/**
 * LEARN phase — real Phase 3 implementation.
 *
 * Beta-Binomial conjugate update on products/<slug>/memory/priors.json.
 *
 * Inputs:
 *   - measurement (from measure phase)
 *   - the proposal that was acted on (load by id)
 *   - the approval (for editCount + autoApplied flags)
 *
 * Update rules (per plan):
 *   - intended_outcome_met === true + no rollback in 7d → α += 1
 *   - intended_outcome_met === false OR rolled back → β += 1
 *   - editCount > 0 → α += 0.5, β += 0.5; running mean of avgUserEditChars
 *   - priorWeight = α / (α + β), clamped [0.1, 2.0]
 *
 * Same update applied to each signalSource the proposal cited.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { runDeterministicPhase, type PhaseResult } from '../runPhase.js';
import { productFiles } from '../../memory/paths.js';
import { load as loadProposal } from '../proposal.js';
import { load as loadApproval } from '../../approval/store.js';
import * as events from '../events.js';
import * as audit from '../audit.js';
import type { PolicyConfig, ProductContext } from '../types.js';
import type { Measurement } from './measure.js';

export interface LearnInput {
  measurement: Measurement;
  approvalId?: string;
}

interface PriorsFile {
  schemaVersion: 1;
  proposalKinds: Record<string, { count: number; alpha: number; beta: number; avgUserEditChars: number; priorWeight: number }>;
  signalSources: Record<string, { count: number; ledToAccepted: number; weight: number }>;
  hotFiles: Record<string, { editsLast30d: number; revertsLast30d: number }>;
  lastUpdated: number;
}

const EMPTY: PriorsFile = {
  schemaVersion: 1,
  proposalKinds: {},
  signalSources: {},
  hotFiles: {},
  lastUpdated: 0,
};

export interface LearnOutput {
  schemaVersion: 1;
  priorsBefore: PriorsFile;
  priorsAfter: PriorsFile;
  changedKinds: string[];
  changedSources: string[];
}

export async function run(
  ctx: ProductContext,
  policy: PolicyConfig,
  input: LearnInput
): Promise<PhaseResult<LearnOutput>> {
  return runDeterministicPhase<LearnOutput>({
    ctx,
    phase: 'learn',
    policy,
    summary: 'learn — update priors',
    body: async () => {
      const proposal = await loadProposal(ctx, input.measurement.proposalId);
      const approval = input.approvalId ? await loadApproval(ctx, input.approvalId) : null;

      const before = await loadPriors(ctx);
      const after: PriorsFile = JSON.parse(JSON.stringify(before));

      const changedKinds: string[] = [];
      const changedSources: string[] = [];

      if (proposal) {
        const kindKey = proposal.kind;
        const cur = after.proposalKinds[kindKey] ?? { count: 0, alpha: 1, beta: 1, avgUserEditChars: 0, priorWeight: 0.5 };
        const editCount = approval?.editCount ?? 0;
        const wasReverted = approval?.state === 'rolled-back';
        const met = input.measurement.intendedOutcomeMet === true && !wasReverted;
        const refuted = input.measurement.intendedOutcomeMet === false || wasReverted;
        if (met) cur.alpha += 1;
        else if (refuted) cur.beta += 1;
        if (editCount > 0) {
          cur.alpha += 0.5;
          cur.beta += 0.5;
          // Running mean (simple form).
          const editChars = approval?.evidence.testOutput ? approval.evidence.testOutput.length : 0;
          cur.avgUserEditChars = cur.count === 0 ? editChars : ((cur.avgUserEditChars * cur.count + editChars) / (cur.count + 1));
        }
        cur.count += 1;
        cur.priorWeight = clamp(cur.alpha / (cur.alpha + cur.beta), 0.1, 2.0);
        after.proposalKinds[kindKey] = cur;
        changedKinds.push(kindKey);

        for (const digest of proposal.evidenceDigests) {
          const source = await sourceForDigest(ctx, digest) ?? 'unknown';
          const s = after.signalSources[source] ?? { count: 0, ledToAccepted: 0, weight: 0.5 };
          s.count += 1;
          if (met) s.ledToAccepted += 1;
          s.weight = clamp(s.ledToAccepted / Math.max(1, s.count), 0.05, 1.0);
          after.signalSources[source] = s;
          if (!changedSources.includes(source)) changedSources.push(source);
        }
      }

      after.lastUpdated = Date.now();

      // Atomic write.
      const path = productFiles.priors(ctx);
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp.${process.pid}`;
      await fs.writeFile(tmp, JSON.stringify(after, null, 2), { mode: 0o600 });
      await fs.rename(tmp, path);

      await events.append(ctx, {
        phase: 'learn',
        kind: 'complete',
        payload: { changedKinds, changedSources, met: input.measurement.intendedOutcomeMet },
      });
      await audit.append(ctx, 'learn.complete', {
        proposalId: input.measurement.proposalId,
        changedKinds,
        changedSources,
      });

      return { schemaVersion: 1, priorsBefore: before, priorsAfter: after, changedKinds, changedSources };
    },
  });
}

async function loadPriors(ctx: ProductContext): Promise<PriorsFile> {
  const path = productFiles.priors(ctx);
  if (!existsSync(path)) return EMPTY;
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as Partial<PriorsFile>;
    return {
      schemaVersion: 1,
      proposalKinds: parsed.proposalKinds ?? {},
      signalSources: parsed.signalSources ?? {},
      hotFiles: parsed.hotFiles ?? {},
      lastUpdated: parsed.lastUpdated ?? 0,
    };
  } catch { return EMPTY; }
}

/** Look up which feedback source produced the given digest.  Phase 3
 *  shipping: scan all feedback corpora for the matching digest.
 *  Linear scan, but bounded by the per-source caps. */
async function sourceForDigest(ctx: ProductContext, digest: string): Promise<string | null> {
  const fb = await import('../../memory/feedback.js');
  for (const src of ['inbox-folder', 'github', 'git-local', 'plausible', 'vercel']) {
    const all = await fb.readAll(ctx, src);
    if (all.some((s) => s.digest === digest)) return src;
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
