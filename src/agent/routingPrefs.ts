/**
 * Per-user routing preferences — the personalization layer.
 *
 * Every time the user picks a provider for a given topic (either by
 * accepting mod8's static recommendation or by explicitly overriding
 * with "use X" / "/handoff X"), we increment a counter in
 * ~/.mod8/routing-prefs.json:
 *
 *   {
 *     "frontend-ui":  { "anthropic": 18, "openai":  3 },
 *     "backend-api":  { "openai":    7,  "anthropic": 1 },
 *     "database":     { "google":    4 }
 *   }
 *
 * The most-picked provider per topic becomes the user's "usual pick"
 * for that topic — which the comparison panel marks with a ★ even if
 * the static recommendation differs.  Means after a week of use, the
 * panel reflects YOUR routing habits, not just the curated defaults.
 *
 * Stored under $MOD8_CONFIG_DIR (defaults to ~/.mod8/) so the verify
 * sandbox can override it cleanly.  Best-effort I/O: a read failure
 * yields an empty prefs map, a write failure logs to stderr but never
 * throws (recording a pref is telemetry, not core flow).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type ProviderId = string;
export type TopicKey = string;

/** Per-topic provider tallies.  The keys are provider ids (anthropic /
 *  openai / google / deepseek); values are how many times the user has
 *  picked that provider for this topic.  Higher = stronger preference. */
export type RoutingPrefs = Record<TopicKey, Record<ProviderId, number>>;

const PREFS_FILENAME = 'routing-prefs.json';

function configDir(): string {
  return process.env['MOD8_CONFIG_DIR'] ?? join(homedir(), '.mod8');
}

function prefsPath(): string {
  return join(configDir(), PREFS_FILENAME);
}

export async function loadPrefs(): Promise<RoutingPrefs> {
  try {
    const raw = await fs.readFile(prefsPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    // Shallow validate: top-level keys → string-keyed object of numbers.
    const out: RoutingPrefs = {};
    for (const [topic, counts] of Object.entries(parsed as Record<string, unknown>)) {
      if (!counts || typeof counts !== 'object' || Array.isArray(counts)) continue;
      const sane: Record<string, number> = {};
      for (const [prov, n] of Object.entries(counts as Record<string, unknown>)) {
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) sane[prov] = n;
      }
      if (Object.keys(sane).length > 0) out[topic] = sane;
    }
    return out;
  } catch {
    return {};
  }
}

async function savePrefs(prefs: RoutingPrefs): Promise<void> {
  try {
    await fs.mkdir(configDir(), { recursive: true });
    await fs.writeFile(prefsPath(), JSON.stringify(prefs, null, 2), {
      mode: 0o600,
    });
  } catch (err) {
    process.stderr.write(
      `mod8: failed to save routing prefs: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

/** Record that the user picked `provider` for `topic`.  Increments the
 *  per-(topic, provider) counter.  No-op when topic is empty (rideAlong
 *  or general categories pass through here as empty strings). */
export async function recordPick(
  topic: TopicKey | null | undefined,
  provider: ProviderId
): Promise<void> {
  if (!topic || !provider) return;
  const prefs = await loadPrefs();
  if (!prefs[topic]) prefs[topic] = {};
  prefs[topic][provider] = (prefs[topic][provider] ?? 0) + 1;
  await savePrefs(prefs);
}

/** Returns the provider the user picks most often for this topic, or
 *  null when there's no signal yet (less than `minPicks` total picks
 *  for this topic).  The minimum threshold prevents a single accidental
 *  override from flipping mod8's recommendation permanently. */
export function preferredProviderFor(
  prefs: RoutingPrefs,
  topic: TopicKey,
  minPicks = 2
): ProviderId | null {
  const counts = prefs[topic];
  if (!counts) return null;
  let best: ProviderId | null = null;
  let bestN = 0;
  let total = 0;
  for (const [prov, n] of Object.entries(counts)) {
    total += n;
    if (n > bestN) {
      bestN = n;
      best = prov;
    }
  }
  if (total < minPicks) return null;
  return best;
}

/** True when the user's pick disagrees with mod8's static recommendation
 *  — used to label the comparison panel as personalized vs default. */
export function isPersonalized(
  prefs: RoutingPrefs,
  topic: TopicKey,
  staticRecommended: ProviderId,
  minPicks = 2
): boolean {
  const preferred = preferredProviderFor(prefs, topic, minPicks);
  return preferred !== null && preferred !== staticRecommended;
}
