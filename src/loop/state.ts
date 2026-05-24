/**
 * Per-product FSM persistence.
 *
 * One file: products/<slug>/state.json.  Written atomically via
 * rename-on-write so a crash mid-write never leaves a half-file —
 * scheduler reads the previous good state on next tick.
 *
 * Holds:
 *   - lastTickId / lastTickAt — what tick ran most recently
 *   - lastRunByPhase — scheduler cadence input
 *   - currentProposalId (Phase 2+) — in-flight proposal
 *   - waitUntilTs (Phase 2+) — when measure should fire
 *   - pausedUntil (Phase 2+) — vacation mode
 *   - phaseAttempts — backoff counters (Phase 2+ exponential backoff)
 *
 * Phase 1 reads + writes lastTickId, lastTickAt, lastRunByPhase.
 * Other fields are scaffolded in the schema so Phase 2's daemon crash
 * recovery doesn't need a schema migration.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { productFiles } from '../memory/paths.js';
import type { LoopState, PhaseId, ProductContext } from './types.js';

/** Genesis state for a brand-new product. */
function emptyState(slug: string): LoopState {
  return {
    schemaVersion: 1,
    productSlug: slug,
    lastTickId: 0,
    lastTickAt: null,
    lastRunByPhase: {},
    phaseAttempts: {},
  };
}

/** Read the FSM.  Returns genesis when missing — callers don't need
 *  to special-case first-run. */
export async function load(ctx: ProductContext): Promise<LoopState> {
  const path = productFiles.state(ctx);
  if (!existsSync(path)) return emptyState(ctx.slug);
  try {
    const buf = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(buf) as LoopState;
    // Cheap shape check — anything malformed gets replaced rather
    // than crash the loop.  Audit entry fires from the caller when
    // they notice the reset (no signal from here).
    if (parsed.schemaVersion !== 1 || parsed.productSlug !== ctx.slug) {
      return emptyState(ctx.slug);
    }
    return {
      ...emptyState(ctx.slug),
      ...parsed,
      // Defensive — never trust raw values for sub-objects.
      lastRunByPhase: parsed.lastRunByPhase ?? {},
      phaseAttempts: parsed.phaseAttempts ?? {},
    };
  } catch {
    return emptyState(ctx.slug);
  }
}

/** Atomic write — write to .tmp then rename.  No torn writes. */
export async function save(ctx: ProductContext, state: LoopState): Promise<void> {
  const path = productFiles.state(ctx);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, path);
}

/** Mark a phase as having run at `at`.  Pure helper — does not save;
 *  caller batches updates and calls save() at end of tick. */
export function recordPhaseRun(state: LoopState, phase: PhaseId, at: number): LoopState {
  return {
    ...state,
    lastRunByPhase: { ...state.lastRunByPhase, [phase]: at },
    lastPhase: phase,
    phaseAttempts: { ...state.phaseAttempts, [phase]: 0 },
  };
}

/** Mark a tick as completed.  Increments lastTickId and stamps the
 *  timestamp.  Used by tick.ts at end-of-tick. */
export function recordTick(state: LoopState, tickId: number, at: number): LoopState {
  return {
    ...state,
    lastTickId: tickId,
    lastTickAt: at,
  };
}

/** Increment the attempt counter for a phase that errored.  Phase 2+
 *  uses this for exponential backoff. */
export function recordPhaseAttempt(state: LoopState, phase: PhaseId): LoopState {
  const prior = state.phaseAttempts[phase] ?? 0;
  return {
    ...state,
    phaseAttempts: { ...state.phaseAttempts, [phase]: prior + 1 },
  };
}
