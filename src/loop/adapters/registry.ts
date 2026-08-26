/**
 * Central adapter registry.  Adapters self-register via `register()`
 * on module import; consumers look them up by id with `get()`.
 *
 * Why a registry rather than direct imports: phases (sense, build, act)
 * need to dispatch by id from policy.yaml or runtime configuration —
 * "the user enabled vercel + plausible" — without a giant switch.
 * The registry also gives us a single place to enumerate available
 * adapters for `mod8 connect list` (Phase 4).
 */

import type { Adapter, AdapterCredsBase } from './types.js';

const REGISTRY = new Map<string, Adapter<AdapterCredsBase>>();

export function register(adapter: Adapter<AdapterCredsBase>): void {
  if (REGISTRY.has(adapter.id)) {
    throw new Error(`adapter "${adapter.id}" registered twice`);
  }
  REGISTRY.set(adapter.id, adapter);
}

export function get(id: string): Adapter<AdapterCredsBase> | undefined {
  return REGISTRY.get(id);
}

export function list(): Adapter<AdapterCredsBase>[] {
  return Array.from(REGISTRY.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function listByKind(kind: 'source' | 'sink' | 'both'): Adapter<AdapterCredsBase>[] {
  return list().filter((a) => a.kind === kind || (kind !== 'both' && a.kind === 'both'));
}

/** Side-effect import of Phase-1 adapters.  Each adapter module
 *  calls register() on import. */
export async function loadPhase1Adapters(): Promise<void> {
  await import('./git-local.js');
  await import('./claude-code.js');
  await import('./github.js');
}

/** Phase-2 adapters: vercel + plausible.  Loaded by tick.ts after
 *  Phase-1 set, so both groups co-exist. */
export async function loadPhase2Adapters(): Promise<void> {
  await import('./vercel.js');
  await import('./plausible.js');
}

/** Phase-3 adapters: posthog + ga4 + stripe + slack + discord. */
export async function loadPhase3Adapters(): Promise<void> {
  await import('./posthog.js');
  await import('./ga4.js');
  await import('./stripe.js');
  await import('./slack.js');
  await import('./discord.js');
}

/** Phase-4 adapters: support inbox + social + npm. */
export async function loadPhase4Adapters(): Promise<void> {
  await import('./intercom.js');
  await import('./crisp.js');
  await import('./front.js');
  await import('./email-imap.js');
  await import('./twitter.js');
  await import('./meta.js');
  await import('./bluesky.js');
  await import('./hn.js');
  await import('./reddit.js');
  await import('./npm.js');
}

/** Load every adapter we have.  Idempotent — re-registration is
 *  tolerated (registry throws on dup; importers swallow). */
export async function loadAllAdapters(): Promise<void> {
  const tryImport = async (loader: () => Promise<void>) => {
    try { await loader(); } catch { /* already loaded or not yet implemented */ }
  };
  await tryImport(loadPhase1Adapters);
  await tryImport(loadPhase2Adapters);
  await tryImport(loadPhase3Adapters);
  await tryImport(loadPhase4Adapters);
}
