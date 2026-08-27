/**
 * Single-pass tick entry — `mod8 loop tick` calls this directly, and
 * Phase 2's daemon calls this on a schedule.  Same body, different
 * lifecycle owners.
 *
 * Responsibilities:
 *   - Acquire the advisory lock at ~/.config/mod8/loop.tick.lock.
 *     Concurrent ticks no-op cleanly (log + return) — never queue.
 *   - Build the ProductContext for the requested slug.
 *   - Run the kill switch check at the top.
 *   - Load policy.yaml (refuse to run if missing — caller handles the
 *     thrown PolicyMissing).
 *   - Load the FSM state.
 *   - Ensure product.md exists (refuse to run if missing — same path).
 *   - Ensure adapters are registered.
 *   - Ask scheduler.decidePhases() what to run.
 *   - Execute phases in order, threading outputs.
 *   - Persist updated state.
 *   - Emit + audit tick boundaries.
 *
 * Errors at any step inside the tick are caught + audit-logged.  The
 * function never throws past this boundary — callers (CLI / daemon)
 * treat the returned TickResult as authoritative.
 */

import lockfile from 'proper-lockfile';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import * as kill from './kill.js';
import * as events from './events.js';
import * as audit from './audit.js';
import * as state from './state.js';
import * as product from '../memory/product.js';
import { loadPolicy, PolicyMissing } from './policy.js';
import { decidePhases } from './scheduler.js';
import * as proposalStore from './proposal.js';
import { loadAllAdapters, list as listAdapters } from './adapters/registry.js';
import * as feedback from '../memory/feedback.js';
import { buildProductContext, GLOBAL_PATHS, productDirFor } from '../memory/paths.js';
import { run as runSense } from './phases/sense.js';
import { run as runIdeate } from './phases/ideate.js';
import { run as runPrioritize } from './phases/prioritize.js';
import { run as runBuild } from './phases/build.js';
import type { LoopState, PhaseId, Signal, SignalBundle } from './types.js';

export interface TickResult {
  ok: boolean;
  /** When false, this is the reason tick exited early (lock held, kill
   *  switch, product.md missing, policy missing). */
  reason?: string;
  /** Tick id assigned for this run; 0 when the tick never started. */
  tickId: number;
  /** Per-phase outcomes — kind + duration when the phase ran, the
   *  scheduler's skipped reason otherwise. */
  phaseOutcomes: Array<{ phase: PhaseId; ran: boolean; ok: boolean; durationMs: number; reason?: string }>;
}

export interface TickOptions {
  slug: string;
  repoRoot: string;
  /** Test override: provide a clock instead of Date.now() — used by
   *  Phase 1 verification fixtures. */
  now?: number;
  /** Skip the advisory lock — debug only, never in production. */
  unsafeNoLock?: boolean;
  /** Ignore cadence gates (`mod8 loop tick --force`). */
  force?: boolean;
}

export async function tick(opts: TickOptions): Promise<TickResult> {
  const now = opts.now ?? Date.now();
  const phaseOutcomes: TickResult['phaseOutcomes'] = [];

  // 0. Pre-acquire kill switch check (no product context yet, so use
  //    the global STOP file).  Avoids the cost of acquiring the lock
  //    only to immediately bail.
  if (kill.check().active) {
    return { ok: false, reason: kill.check().reason, tickId: 0, phaseOutcomes: [] };
  }

  // 1. Ensure product dir exists so the lock has a place to live.
  await fs.mkdir(productDirFor(opts.slug), { recursive: true, mode: 0o700 });
  await fs.mkdir(dirname(GLOBAL_PATHS.tickLock), { recursive: true, mode: 0o700 });

  // 2. Acquire the advisory lock.  Concurrent ticks get a
  //    "lock-held" outcome and exit cleanly — they NEVER queue.  The
  //    lockfile lib needs the target to exist (it locks a sentinel
  //    file next to it).
  await ensureLockfileTarget();
  let release: (() => Promise<void>) | null = null;
  if (!opts.unsafeNoLock) {
    try {
      release = await lockfile.lock(GLOBAL_PATHS.tickLock, {
        // 60s stale window — daemon ticks should never exceed this in
        // Phase 1 (no LLM calls).  If they do, something's wedged and
        // we want the next tick to recover.
        stale: 60_000,
        retries: 0,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `tick lock held by another process (${err instanceof Error ? err.message : String(err)})`,
        tickId: 0,
        phaseOutcomes: [],
      };
    }
  }

  let nextTickId = 0;
  try {
    // 3. Build context.  Tick id increments by 1 from state.lastTickId.
    //    We need ctx to do anything else, but ctx requires tickId,
    //    so build it once we know.
    const provisionalCtx = buildProductContext(opts.slug, opts.repoRoot, 0);

    // 4. Load policy (throws PolicyMissing — caller renders the user
    //    instruction to write a policy.yaml).
    let policy;
    try {
      policy = await loadPolicy(provisionalCtx);
    } catch (err) {
      if (err instanceof PolicyMissing) {
        return { ok: false, reason: err.message, tickId: 0, phaseOutcomes: [] };
      }
      throw err;
    }

    // 5. Ensure product.md exists (refuses with template path).
    if (!(await product.exists(provisionalCtx))) {
      // Trigger the template scaffold via read(); it throws ProductMdMissing.
      try {
        await product.read(provisionalCtx);
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
          tickId: 0,
          phaseOutcomes: [],
        };
      }
    }

    // 6. Load FSM state.
    const oldState: LoopState = await state.load(provisionalCtx);
    nextTickId = oldState.lastTickId + 1;
    const ctx = buildProductContext(opts.slug, opts.repoRoot, nextTickId);

    // 7. Ensure adapters are loaded (idempotent — registry.register
    //    throws on re-register, which import.meta caching prevents).
    try {
      await loadAllAdapters();
    } catch {
      /* registry already populated — ignore */
    }

    // 8. Per-product kill switch (might have a custom path in policy).
    const ks2 = kill.check(policy);
    if (ks2.active) {
      await events.append(ctx, { phase: 'sense', kind: 'kill-switch', payload: { reason: ks2.reason } });
      await audit.append(ctx, 'tick.skipped', { reason: ks2.reason, tickId: nextTickId });
      return { ok: false, reason: ks2.reason, tickId: nextTickId, phaseOutcomes: [] };
    }

    // 9. Tick boundary — audit + event.
    await audit.append(ctx, 'tick.start', { tickId: nextTickId, now });

    // 10. Schedule.
    const pendingProposals = (await proposalStore.list(ctx)).filter((p) => p.state === 'pending-build').length;
    const decision = decidePhases(oldState, policy, now, { force: opts.force, pendingProposals });
    await audit.append(ctx, 'tick.schedule', {
      tickId: nextTickId,
      phases: decision.phases,
      reasons: decision.reasons,
    });

    // Always record skipped phases for the operator view.
    const scheduled = new Set(decision.phases);
    for (const phase of ['sense', 'ideate', 'prioritize', 'build', 'measure', 'learn'] as PhaseId[]) {
      if (!scheduled.has(phase)) {
        phaseOutcomes.push({
          phase,
          ran: false,
          ok: false,
          durationMs: 0,
          reason: decision.reasons[phase] ?? 'not scheduled',
        });
        await events.append(ctx, {
          phase,
          kind: 'skipped',
          payload: { reason: decision.reasons[phase] },
        });
      }
    }

    // 11. Execute scheduled phases in order, threading outputs.
    let newState = state.recordTick(oldState, nextTickId, now);

    // Outputs threaded between phases.  Each is set when its phase runs
    // and consumed by the next.
    let senseBundle: import('./types.js').SignalBundle | null = null;
    let ideateOut: { schemaVersion: 1; proposals: import('./proposal.js').Proposal[] } | null = null;
    let prioritizeOut: import('./phases/prioritize.js').PrioritizeOutput | null = null;

    for (const phase of decision.phases) {
      switch (phase) {
        case 'sense': {
          const result = await runSense(ctx, policy, {
            lastSenseAt: oldState.lastRunByPhase.sense ?? null,
          });
          phaseOutcomes.push({
            phase, ran: true, ok: result.ok, durationMs: result.durationMs,
            ...(result.reason ? { reason: result.reason } : {}),
          });
          if (result.ok) {
            senseBundle = result.output;
            newState = state.recordPhaseRun(newState, phase, now);
          } else {
            newState = state.recordPhaseAttempt(newState, phase);
          }
          break;
        }
        case 'ideate': {
          let bundle: SignalBundle = senseBundle ?? {
            schemaVersion: 1 as const, productSlug: ctx.slug, tickId: nextTickId,
            newSignals: [], countsBySource: {}, memoryUpdates: [],
          };
          // --force with nothing fresh: ideate from the recent corpus instead
          // of skipping, so a forced tick always has something to think about.
          if (opts.force && bundle.newSignals.length === 0) {
            const recent: Signal[] = [];
            const counts: Record<string, number> = {};
            for (const a of listAdapters()) {
              if (a.kind !== 'source' && a.kind !== 'both') continue;
              const sigs = await feedback.readAll(ctx, a.id, 20).catch(() => []);
              if (sigs.length) { recent.push(...sigs); counts[a.id] = sigs.length; }
            }
            recent.sort((x: Signal, y: Signal) => y.ts - x.ts);
            bundle = { ...bundle, newSignals: recent.slice(0, 40), countsBySource: counts };
            await events.append(ctx, { phase: 'ideate', kind: 'start', payload: { forcedFromCorpus: bundle.newSignals.length } });
          }
          const result = await runIdeate(ctx, policy, bundle);
          phaseOutcomes.push({
            phase, ran: true, ok: result.ok, durationMs: result.durationMs,
            ...(result.reason ? { reason: result.reason } : {}),
          });
          if (result.ok) {
            ideateOut = result.output;
            newState = state.recordPhaseRun(newState, phase, now);
          }
          break;
        }
        case 'prioritize': {
          const input = ideateOut ?? { schemaVersion: 1 as const, proposals: [] };
          const result = await runPrioritize(ctx, policy, input);
          phaseOutcomes.push({
            phase, ran: true, ok: result.ok, durationMs: result.durationMs,
            ...(result.reason ? { reason: result.reason } : {}),
          });
          if (result.ok) {
            prioritizeOut = result.output;
            newState = state.recordPhaseRun(newState, phase, now);
          }
          break;
        }
        case 'build': {
          const input = prioritizeOut ?? { schemaVersion: 1 as const, picked: null, scored: [] };
          const result = await runBuild(ctx, policy, input);
          phaseOutcomes.push({
            phase, ran: true, ok: result.ok, durationMs: result.durationMs,
            ...(result.reason ? { reason: result.reason } : {}),
          });
          if (result.ok) newState = state.recordPhaseRun(newState, phase, now);
          break;
        }
        case 'act':
          // Never scheduled by the scheduler; triggered by approval Panel.
          break;
        case 'measure': {
          const proposalId = oldState.currentProposalId;
          if (!proposalId) {
            phaseOutcomes.push({ phase, ran: false, ok: false, durationMs: 0, reason: 'no in-flight proposal' });
            break;
          }
          const { run: runMeasure } = await import('./phases/measure.js');
          const result = await runMeasure(ctx, policy, { proposalId });
          phaseOutcomes.push({
            phase, ran: true, ok: result.ok, durationMs: result.durationMs,
            ...(result.reason ? { reason: result.reason } : {}),
          });
          if (result.ok) newState = state.recordPhaseRun(newState, phase, now);
          // Thread to learn if measurement exists.
          if (result.ok && result.output?.measurement) {
            const { run: runLearn } = await import('./phases/learn.js');
            const learnResult = await runLearn(ctx, policy, { measurement: result.output.measurement });
            phaseOutcomes.push({
              phase: 'learn', ran: true, ok: learnResult.ok, durationMs: learnResult.durationMs,
              ...(learnResult.reason ? { reason: learnResult.reason } : {}),
            });
            if (learnResult.ok) newState = state.recordPhaseRun(newState, 'learn', now);
          }
          break;
        }
        case 'learn':
          // Chained from measure above — pre-skip when reached
          // independently (shouldn't happen with current scheduler).
          break;
      }
    }

    // 12. Persist state.
    await state.save(ctx, newState);

    // 13. Tick complete.
    await audit.append(ctx, 'tick.complete', {
      tickId: nextTickId,
      durationMs: Date.now() - now,
      phasesRun: phaseOutcomes.filter((p) => p.ran).map((p) => p.phase),
    });

    return { ok: true, tickId: nextTickId, phaseOutcomes };
  } catch (err) {
    // Catch-all so tick never throws to the caller.
    const reason = err instanceof Error ? err.message : String(err);
    try {
      const ctx = buildProductContext(opts.slug, opts.repoRoot, nextTickId);
      await audit.append(ctx, 'tick.error', { tickId: nextTickId, reason });
    } catch { /* tolerate audit failure inside crash path */ }
    return { ok: false, reason, tickId: nextTickId, phaseOutcomes };
  } finally {
    if (release) {
      try { await release(); } catch { /* tolerate */ }
    }
  }
}

/** Ensure the lockfile target exists — proper-lockfile locks a
 *  sentinel next to the target, but requires the target to exist. */
async function ensureLockfileTarget(): Promise<void> {
  if (!existsSync(GLOBAL_PATHS.tickLock)) {
    await fs.writeFile(GLOBAL_PATHS.tickLock, '', { mode: 0o600 });
  }
}
