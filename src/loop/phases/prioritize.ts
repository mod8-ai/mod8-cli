/**
 * PRIORITIZE phase — real Phase 2 implementation.  Deterministic, no
 * LLM call.  Picks AT MOST ONE proposal to advance to build per the
 * scoring formula in prompts/prioritize.md.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import type { PolicyConfig, ProductContext } from '../types.js';
import { runDeterministicPhase, type PhaseResult } from '../runPhase.js';
import { productFiles } from '../../memory/paths.js';
import { updateState as updateProposalState, type Proposal } from '../proposal.js';
import * as events from '../events.js';
import type { IdeateOutput } from './ideate.js';

export interface PrioritizeOutput {
  schemaVersion: 1;
  picked: Proposal | null;
  scored: Array<{ proposal: Proposal; score: number; reasoning: string }>;
}

const WEIGHTS = {
  impact: { low: 1, medium: 3, high: 5 },
  risk: { low: 1, medium: 2, high: 4 },
  effort: { small: 1, medium: 2, large: 4 },
} as const;

interface PriorsFile {
  proposalKinds?: Record<string, { alpha?: number; beta?: number; count?: number; priorWeight?: number }>;
}

export async function run(
  ctx: ProductContext,
  policy: PolicyConfig,
  input: IdeateOutput
): Promise<PhaseResult<PrioritizeOutput>> {
  return runDeterministicPhase<PrioritizeOutput>({
    ctx,
    phase: 'prioritize',
    policy,
    summary: `prioritize over ${input.proposals.length} proposal(s)`,
    body: async () => {
      if (input.proposals.length === 0) {
        return { schemaVersion: 1, picked: null, scored: [] };
      }
      const priors = await loadPriors(ctx);
      const scored = input.proposals.map((p) => {
        const impact = WEIGHTS.impact[p.estimatedImpact];
        const risk = WEIGHTS.risk[p.estimatedRisk];
        const effort = WEIGHTS.effort[p.estimatedEffort];
        const kindPriors = priors.proposalKinds?.[p.kind];
        const count = kindPriors?.count ?? 0;
        const confidence = count >= 5 ? 1.0 : count >= 2 ? 0.7 : 0.4;
        const priorWeight = clamp(kindPriors?.priorWeight ?? 1.0, 0.1, 2.0);
        const score = (impact * confidence * priorWeight) / (risk * effort);
        const reasoning = `impact=${impact}×conf=${confidence}×prior=${priorWeight.toFixed(2)} / (risk=${risk}×effort=${effort}) = ${score.toFixed(3)}`;
        return { proposal: p, score, reasoning };
      });
      scored.sort((a, b) => b.score - a.score);

      const top = scored[0]!;
      // Rank, don't threshold (plan 5.4): the human [a]pprove is the real
      // gate.  A fixed 1.0 cut-off could never be crossed by a proposal kind
      // with no priors (confidence 0.4), so the loop never bootstrapped.
      const picked = top.score > 0 ? top.proposal : null;

      // Mark non-picked proposals as rejected-priority.
      for (const s of scored) {
        if (picked && s.proposal.id === picked.id) continue;
        try { await updateProposalState(ctx, s.proposal.id, 'rejected-priority'); } catch { /* tolerate */ }
      }

      await events.append(ctx, {
        phase: 'prioritize',
        kind: 'complete',
        payload: {
          considered: scored.length,
          picked: picked?.id ?? null,
          topScore: top.score,
        },
      });

      return { schemaVersion: 1, picked, scored };
    },
  });
}

async function loadPriors(ctx: ProductContext): Promise<PriorsFile> {
  const path = productFiles.priors(ctx);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as PriorsFile;
  } catch {
    return {};
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
