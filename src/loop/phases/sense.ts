/**
 * SENSE phase (collapses sense + understand + compare from the
 * 10-phase mental model into one code file — they share an output
 * type and an agent turn).
 *
 * Phase 1 implementation: deterministic, no LLM.  Walks the
 * registered source adapters, pulls signals since the last sense
 * run, dedupe-appends them to per-source feedback corpora, refreshes
 * codebase memory (architecture/hotpaths/deps/owners), drains the
 * inbox folder.  Emits a SignalBundle for downstream consumption.
 *
 * Phase 2+ adds a thin LLM-driven "understand" pass that summarizes
 * the bundle into a situation.md for ideate to consume; for now
 * ideate is stubbed and the bundle goes straight to the phase event.
 */

import { existsSync } from 'node:fs';
import type { ProductContext, PolicyConfig, Signal, SignalBundle } from '../types.js';
import { runDeterministicPhase, type PhaseResult } from '../runPhase.js';
import { productFiles } from '../../memory/paths.js';
import * as feedback from '../../memory/feedback.js';
import { generate as generateArchitecture } from '../../memory/codebase/architecture.js';
import { generate as generateOwners } from '../../memory/codebase/owners.js';
import { read as readHotpaths, isStale } from '../../memory/codebase/hotpaths.js';
import { list as listAdapters, get as getAdapter } from '../adapters/registry.js';
import { readCreds as readGithubCreds } from '../adapters/github.js';

/** What "since" to use when this is the first-ever sense run.  Wide
 *  enough to catch a meaningful slice of history; narrow enough to
 *  keep the first poll cheap. */
const FIRST_RUN_LOOKBACK_DAYS = 14;

/** Per-product cached "last sense ts" derived from state.lastRunByPhase;
 *  caller passes this in so sense.ts doesn't have to know about state.ts. */
export interface SenseInputs {
  /** epoch ms of the most-recent successful sense run, or null on
   *  first run. */
  lastSenseAt: number | null;
}

export async function run(
  ctx: ProductContext,
  policy: PolicyConfig,
  inputs: SenseInputs
): Promise<PhaseResult<SignalBundle>> {
  return runDeterministicPhase<SignalBundle>({
    ctx,
    phase: 'sense',
    policy,
    summary: 'sense — poll adapters, refresh memory, drain inbox',
    body: () => sense(ctx, policy, inputs),
  });
}

async function sense(
  ctx: ProductContext,
  policy: PolicyConfig,
  inputs: SenseInputs
): Promise<SignalBundle> {
  const since = new Date(
    inputs.lastSenseAt ?? Date.now() - FIRST_RUN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );
  const memoryUpdates: string[] = [];
  const newSignals: Signal[] = [];
  const countsBySource: Record<string, number> = {};

  // 1. Drain inbox-folder first — local user signal trumps remote polls.
  try {
    const inboxAppended = await feedback.drainInbox(ctx);
    if (inboxAppended > 0) {
      countsBySource['inbox-folder'] = inboxAppended;
      memoryUpdates.push('memory/feedback/inbox-folder.jsonl');
    }
  } catch {
    /* tolerate inbox failures */
  }

  // 2. Walk source adapters and dedupe-append signals.
  for (const adapter of listAdapters()) {
    if (adapter.kind !== 'source' && adapter.kind !== 'both') continue;
    if (!adapter.poll) continue;
    const collected: Signal[] = [];
    try {
      const creds = await loadCredsForAdapter(ctx, adapter.id);
      // Cast: registry stores adapters at AdapterCredsBase; per-adapter
      // creds subtypes are validated by the adapter itself.
      for await (const sig of adapter.poll(ctx, creds as never, since)) {
        collected.push(sig);
        // Cap to avoid runaway memory if an adapter misbehaves.
        if (collected.length >= 500) break;
      }
    } catch {
      /* tolerate per-adapter failures — one bad adapter shouldn't
         kill the whole sense run */
    }
    if (collected.length === 0) continue;
    let appended = 0;
    try {
      appended = await feedback.append(ctx, adapter.id, collected);
    } catch {
      /* tolerate per-adapter persist failures */
    }
    if (appended > 0) {
      countsBySource[adapter.id] = appended;
      newSignals.push(...collected.slice(0, appended));
      memoryUpdates.push(`memory/feedback/${adapter.id}.jsonl`);
    }
  }

  // 3. Refresh codebase memory.  Always regenerate architecture.md
  //    when stale, since the markdown is what ideate (Phase 2) reads.
  try {
    const hp = await readHotpaths(ctx);
    const cadenceMs = policy.cadence.sense_every_minutes * 60 * 1000;
    if (isStale(hp, cadenceMs) || !existsSync(productFiles.architectureMd(ctx))) {
      const arch = await generateArchitecture(ctx);
      memoryUpdates.push(arch.path);
      memoryUpdates.push(productFiles.hotpathsJson(ctx));
      memoryUpdates.push(productFiles.depsJson(ctx));
    }
    if (!existsSync(productFiles.ownersMd(ctx))) {
      await generateOwners(ctx);
      memoryUpdates.push(productFiles.ownersMd(ctx));
    }
  } catch {
    /* tolerate codebase scan failures */
  }

  return {
    schemaVersion: 1,
    productSlug: ctx.slug,
    tickId: ctx.tickId,
    newSignals,
    countsBySource,
    memoryUpdates,
  };
}

/** Adapter-specific creds lookup.  Phase 1 only covers github (PAT
 *  via env or stored connector file) and git-local (no creds).  Phase
 *  4 generalizes to a per-adapter loader. */
async function loadCredsForAdapter(ctx: ProductContext, adapterId: string): Promise<unknown> {
  if (adapterId === 'github') {
    return readGithubCreds(ctx);
  }
  if (adapterId === 'git-local') {
    return null;
  }
  // Unknown adapter — caller passes null and the adapter decides what
  // to do (most will fall back to env-driven config in Phase 1).
  // Touch getAdapter so the import isn't dead in case of tree shaking.
  void getAdapter(adapterId);
  return null;
}
