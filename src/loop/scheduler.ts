/**
 * Scheduler — decides which phases run this tick.
 *
 * Pure function over (state, policy, now).  No I/O.  Returns an
 * ordered list of phase ids; tick.ts executes them in order, feeding
 * each phase's output into the next.
 *
 * Rules (Phase 1 active set in **bold**; Phase 2+ extends):
 *   - **always run sense** (cadence-gated by lastRunByPhase.sense)
 *   - if (ideate cadence elapsed AND sense produced new signals) → ideate → prioritize → build
 *   - if (state.waitUntilTs ≤ now AND state.currentProposalId set) → measure → learn
 *   - act is NEVER scheduled here; it's triggered by approval Panel
 *     callback (Phase 2+) or daemon auto-act for L3+ proposals.
 */

import type { LoopState, PhaseId, PolicyConfig } from './types.js';

const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;

export interface ScheduleDecision {
  /** Phase ids to run in order. */
  phases: PhaseId[];
  /** Reasons per phase — surfaced in events and audit. */
  reasons: Record<PhaseId, string>;
}

export interface ScheduleOptions {
  /** Ignore cadence gates — run sense + the ideate pipeline now.  Set by
   *  `mod8 loop tick --force`; how a human (or a test) makes the loop
   *  work a day on demand. */
  force?: boolean;
  /** Proposals still in 'pending-build'.  When > 0 and ideate is
   *  cadence-skipped, prioritize+build still run so the backlog drains
   *  instead of waiting hours for the next ideate. */
  pendingProposals?: number;
}

export function decidePhases(
  state: LoopState,
  policy: PolicyConfig,
  now: number,
  opts: ScheduleOptions = {}
): ScheduleDecision {
  const phases: PhaseId[] = [];
  const reasons: Partial<Record<PhaseId, string>> = {};
  const force = opts.force === true;

  // Sense: cadence-gated.  Always considered.
  const senseInterval = policy.cadence.sense_every_minutes * MINUTES;
  const lastSense = state.lastRunByPhase.sense ?? 0;
  if (force || now - lastSense >= senseInterval) {
    phases.push('sense');
    reasons.sense = force ? 'forced' : lastSense === 0
      ? 'first sense run for this product'
      : `${Math.floor((now - lastSense) / MINUTES)}m since last sense (interval ${policy.cadence.sense_every_minutes}m)`;
  } else {
    reasons.sense = `skipped — ${Math.ceil((senseInterval - (now - lastSense)) / MINUTES)}m until next sense`;
  }

  // Ideate → Prioritize → Build pipeline.  Cadence-gated by ideate's
  // last-run.  Phase 1's ideate/prioritize/build stubs no-op but still
  // emit events so the operator can confirm cadence is firing.
  const ideateInterval = policy.cadence.ideate_every_hours * HOURS;
  const lastIdeate = state.lastRunByPhase.ideate ?? 0;
  if (force || now - lastIdeate >= ideateInterval) {
    phases.push('ideate', 'prioritize', 'build');
    const reason = force ? 'forced' : lastIdeate === 0
      ? 'first ideate pipeline run for this product'
      : `${Math.floor((now - lastIdeate) / HOURS)}h since last ideate (interval ${policy.cadence.ideate_every_hours}h)`;
    reasons.ideate = reason;
    reasons.prioritize = `chained after ideate (${reason})`;
    reasons.build = `chained after prioritize (${reason})`;
  } else {
    const remaining = Math.ceil((ideateInterval - (now - lastIdeate)) / HOURS);
    reasons.ideate = `skipped — ${remaining}h until next ideate pipeline`;
    if ((opts.pendingProposals ?? 0) > 0) {
      phases.push('prioritize', 'build');
      reasons.prioritize = `${opts.pendingProposals} proposal(s) pending-build — draining backlog`;
      reasons.build = 'chained after prioritize (backlog)';
    }
  }

  // Measure → Learn (Phase 3+).  Fires only when a proposal is past
  // its wait window.  Phase 1: state.waitUntilTs is never set, so
  // this branch is dormant but ready.
  if (state.waitUntilTs && state.waitUntilTs <= now && state.currentProposalId) {
    phases.push('measure', 'learn');
    reasons.measure = `wait window elapsed for proposal ${state.currentProposalId}`;
    reasons.learn = `chained after measure`;
  }

  // act is intentionally absent — triggered out-of-band by approval Panel.

  // Always provide a reasons entry for every phase id even when skipped,
  // for clean reporting via `mod8 loop status`.
  return {
    phases,
    reasons: {
      sense: reasons.sense ?? 'not evaluated',
      ideate: reasons.ideate ?? 'not evaluated',
      prioritize: reasons.prioritize ?? 'not evaluated',
      build: reasons.build ?? 'not evaluated',
      act: reasons.act ?? 'never scheduled — triggered by approval Panel',
      measure: reasons.measure ?? 'not evaluated',
      learn: reasons.learn ?? 'not evaluated',
      marketing: reasons.marketing ?? 'never scheduled — run by `mod8 marketing plan`',
    },
  };
}
