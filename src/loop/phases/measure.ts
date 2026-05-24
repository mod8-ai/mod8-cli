/**
 * MEASURE phase — real Phase 3 implementation.
 *
 * Triggered by the scheduler when state.waitUntilTs ≤ now AND
 * state.currentProposalId is set.  Compares the metric snapshot
 * captured at act-time against live metrics queried fresh from each
 * connected metrics adapter.
 *
 * Deterministic — no LLM call required.  The judgement "intended
 * outcome met?" is computed by parsing the success_criteria string
 * for a metric-name and threshold; if parsing fails we report
 * intended_outcome_met="inconclusive" and let learn decide what to
 * do with that.
 *
 * Success-criteria grammar (intentionally restrictive):
 *   "<metric_name> <op> <number>[%]"
 *   ops: > >= < <= = != ~  (~ = within 10% of)
 *
 * Anything that doesn't match the grammar produces inconclusive.
 */

import { runDeterministicPhase, type PhaseResult } from '../runPhase.js';
import { read as readSnapshot } from '../../memory/snapshots.js';
import * as metrics from '../../memory/metrics.js';
import * as events from '../events.js';
import * as state from '../state.js';
import * as audit from '../audit.js';
import type { PolicyConfig, ProductContext } from '../types.js';

export interface MeasureInput {
  proposalId: string;
}

export interface Measurement {
  schemaVersion: 1;
  proposalId: string;
  measuredAt: number;
  metricDeltas: Record<string, number>;
  intendedOutcomeMet: boolean | 'inconclusive';
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

export interface MeasureOutput {
  schemaVersion: 1;
  measurement: Measurement | null;
}

export async function run(
  ctx: ProductContext,
  policy: PolicyConfig,
  input: MeasureInput
): Promise<PhaseResult<MeasureOutput>> {
  return runDeterministicPhase<MeasureOutput>({
    ctx,
    phase: 'measure',
    policy,
    summary: `measure outcomes for proposal ${input.proposalId}`,
    body: async () => {
      const snap = await readSnapshot(ctx, input.proposalId);
      if (!snap) {
        await events.append(ctx, {
          phase: 'measure',
          kind: 'skipped',
          payload: { reason: `no snapshot for proposal ${input.proposalId}` },
        });
        return { schemaVersion: 1, measurement: null };
      }

      // Per-source deltas vs the snapshot timestamp.
      const allDeltas: Record<string, number> = {};
      for (const source of Object.keys(snap.bySource)) {
        try {
          const d = await metrics.computeDelta(ctx, source, snap.capturedAt);
          for (const [k, v] of Object.entries(d)) {
            // Prefix by source so plausible.visitors and posthog.visitors don't collide.
            allDeltas[`${source}.${k}`] = v;
          }
        } catch { /* tolerate */ }
      }

      // Outcome judgement from success_criteria.
      const judgement = judge(snap.successCriteria, allDeltas);

      const measurement: Measurement = {
        schemaVersion: 1,
        proposalId: input.proposalId,
        measuredAt: Date.now(),
        metricDeltas: allDeltas,
        intendedOutcomeMet: judgement.met,
        confidence: judgement.confidence,
        notes: judgement.notes,
      };

      // Clear the wait window so scheduler doesn't re-fire.
      try {
        const cur = await state.load(ctx);
        const updates: Partial<typeof cur> = {};
        delete (cur as Partial<typeof cur>).waitUntilTs;
        delete (cur as Partial<typeof cur>).currentProposalId;
        await state.save(ctx, { ...cur, ...updates });
      } catch { /* tolerate */ }

      await audit.append(ctx, 'measure.complete', {
        proposalId: input.proposalId,
        intendedOutcomeMet: judgement.met,
        confidence: judgement.confidence,
      });

      return { schemaVersion: 1, measurement };
    },
  });
}

function judge(
  successCriteria: string | undefined,
  deltas: Record<string, number>
): { met: boolean | 'inconclusive'; confidence: 'high' | 'medium' | 'low'; notes: string } {
  if (!successCriteria) {
    return { met: 'inconclusive', confidence: 'low', notes: 'no success_criteria on proposal' };
  }
  // Parse: <metric> <op> <number>[%]
  const m = successCriteria.match(/^\s*([a-z0-9._-]+)\s*(>=|<=|>|<|!=|=|~)\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/i);
  if (!m) {
    return { met: 'inconclusive', confidence: 'low', notes: `success_criteria "${successCriteria}" does not parse — expected "<metric> <op> <number>[%]"` };
  }
  const [, metric, op, numStr] = m;
  const target = Number(numStr);
  // Look up metric across all deltas — exact match preferred,
  // then suffix match.
  let actual: number | undefined = deltas[metric!];
  let matchedKey: string | undefined = metric;
  if (actual === undefined) {
    for (const [k, v] of Object.entries(deltas)) {
      if (k.endsWith(`.${metric}`)) { actual = v; matchedKey = k; break; }
    }
  }
  if (actual === undefined) {
    return { met: 'inconclusive', confidence: 'low', notes: `metric "${metric}" not in deltas (had: ${Object.keys(deltas).join(', ')})` };
  }
  const met = check(actual, op!, target);
  // Confidence: high when delta magnitude is ≥3× target, medium when ≥1.5×, low otherwise.
  const magnitude = Math.abs(actual) / Math.max(1, Math.abs(target));
  const confidence = magnitude >= 3 ? 'high' : magnitude >= 1.5 ? 'medium' : 'low';
  return {
    met,
    confidence,
    notes: `${matchedKey}=${actual.toFixed(2)}% ${op} ${target} → ${met}`,
  };
}

function check(actual: number, op: string, target: number): boolean {
  switch (op) {
    case '>': return actual > target;
    case '>=': return actual >= target;
    case '<': return actual < target;
    case '<=': return actual <= target;
    case '=': return Math.abs(actual - target) < 0.01;
    case '!=': return Math.abs(actual - target) >= 0.01;
    case '~': return Math.abs(actual - target) / Math.max(1, Math.abs(target)) <= 0.10;
    default: return false;
  }
}
