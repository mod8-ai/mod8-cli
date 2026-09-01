/**
 * Where mod8's own voice gets its tokens.
 *
 * The harness is the harness.  Which account pays for a turn is fuel, not
 * identity — so the host voice is NOT tied to one provider.  It prefers
 * mod8's own account (the proxy) on the brand model, falls back to any other
 * account it can reach, and the user never learns the difference unless they
 * ask (`/status`) or everything is dry.
 *
 * Fuel ladder, in order:
 *   1. anthropic  — the brand voice (local key if the user has one, else the
 *                   proxy's account; buildProviderModel() already prefers a
 *                   local key over the proxy).
 *   2. the other proxy providers, while logged in — still mod8's own account.
 *   3. anything else the user has a local key for.
 *
 * Only providers with a Vercel AI SDK client are eligible: the host runs
 * through the agent runtime with a read-only tool set, and the text-only
 * legacy path can't carry tools.
 */

import { configuredProviderIds, resolveConfigured } from '../storage/providers.js';
import { readAuth } from '../storage/auth.js';
import { PROXY_PROVIDER_IDS } from './proxy.js';
import { templateById } from './registry.js';
import { lastGoodFuel, dryFuelIds } from '../storage/hostFuel.js';

/** Provider ids with an AI SDK client — must match SDK_PROVIDER_IDS in chat.tsx. */
const HOST_CAPABLE_IDS: readonly string[] = ['anthropic', 'openai', 'google', 'deepseek'];

/** The brand voice's first choice. */
export const HOST_PREFERRED_ID = 'anthropic';

export interface HostRoute {
  providerId: string;
  model: string;
  /** True when this is the brand's first-choice route. */
  preferred: boolean;
}

/**
 * Model for the host voice on a given provider.  `MOD8_HOST_MODEL` keeps
 * overriding the preferred route (unchanged behaviour); every other route
 * can be pinned with `MOD8_HOST_MODEL_<PROVIDER>`, mirroring the loop's
 * `MOD8_LOOP_MODEL_<PHASE>` convention.
 */
export function hostModelFor(providerId: string): string {
  const perProvider = process.env[`MOD8_HOST_MODEL_${providerId.toUpperCase()}`];
  if (perProvider) return perProvider;
  if (providerId === HOST_PREFERRED_ID) {
    return process.env.MOD8_HOST_MODEL ?? 'claude-sonnet-4-6';
  }
  return templateById(providerId)?.defaultModel ?? 'claude-sonnet-4-6';
}

/**
 * Every route the host voice could speak through right now, best first.
 * Empty means the user has no keys and isn't logged in — the only case where
 * mod8 is allowed to say it can't answer.
 */
export async function hostRouteCandidates(): Promise<HostRoute[]> {
  const auth = await readAuth();
  const localIds = await configuredProviderIds();

  const usable = async (id: string): Promise<boolean> => {
    if (localIds.includes(id) && (await resolveConfigured(id))?.apiKey) return true;
    // Logged in → mod8's own account can serve any proxy provider.
    return Boolean(auth) && (PROXY_PROVIDER_IDS as readonly string[]).includes(id);
  };

  const base = [
    HOST_PREFERRED_ID,
    ...PROXY_PROVIDER_IDS.filter((id) => id !== HOST_PREFERRED_ID),
    ...HOST_CAPABLE_IDS.filter(
      (id) => !(PROXY_PROVIDER_IDS as readonly string[]).includes(id)
    ),
  ];

  // What we learned last time.  Order:
  //   1. the brand route, whenever it is not inside its dry cooloff — so a
  //      top-up is noticed on its own, at the cost of at most one silent
  //      probe an hour.  Without this the voice would settle on whatever
  //      answered once and never come home.
  //   2. the tank that last answered — skips the walk on every later session.
  //   3. everything else still believed to have fuel.
  //   4. the dry ones, demoted but never removed: if all else is gone, a dry
  //      tank is still worth one more try before mod8 admits it can't answer.
  const [lastGood, dry] = await Promise.all([lastGoodFuel(), dryFuelIds()]);
  const wet = (id: string): boolean => !dry.includes(id);
  const ordered = [
    ...(wet(HOST_PREFERRED_ID) ? [HOST_PREFERRED_ID] : []),
    ...(lastGood && lastGood !== HOST_PREFERRED_ID && wet(lastGood) ? [lastGood] : []),
    ...base.filter((id) => id !== lastGood && id !== HOST_PREFERRED_ID && wet(id)),
    ...base.filter((id) => !wet(id)),
  ];

  const routes: HostRoute[] = [];
  for (const id of ordered) {
    if (routes.some((r) => r.providerId === id)) continue;
    if (!(await usable(id))) continue;
    routes.push({
      providerId: id,
      model: hostModelFor(id),
      preferred: id === HOST_PREFERRED_ID,
    });
  }
  return routes;
}

/** Best route available right now, or null when there is no fuel at all. */
export async function resolveHostRoute(): Promise<HostRoute | null> {
  return (await hostRouteCandidates())[0] ?? null;
}

/**
 * The next route to try after `failedIds` have already failed this session.
 * Returns null when the ladder is exhausted.
 */
export async function nextHostRoute(failedIds: readonly string[]): Promise<HostRoute | null> {
  const candidates = await hostRouteCandidates();
  return candidates.find((r) => !failedIds.includes(r.providerId)) ?? null;
}

/**
 * Failure kinds that mean "this account can't pay", not "this message was
 * bad".  Only these justify quietly moving the voice to another tank —
 * a context-too-long or a bad request would fail identically everywhere.
 */
const FUEL_FAILURE_KINDS: readonly string[] = ['no-credit', 'auth', 'forbidden', 'server'];

export function isFuelFailure(kind: string): boolean {
  return FUEL_FAILURE_KINDS.includes(kind);
}
