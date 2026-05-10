/**
 * Provider configuration store.
 *
 * Replaces the old keys.json with a richer providers.json keyed by provider
 * id, each entry carrying:
 *   - apiKey:       the BYOK secret
 *   - apiType:      'anthropic' | 'openai-compat' | 'gemini'
 *   - name:         display label
 *   - baseUrl?:     for openai-compat providers (Anthropic/Gemini use SDK defaults)
 *   - defaultModel: model id used when a turn doesn't specify one
 *   - color:        display color (hex)
 *   - custom:       true if user-registered (not from KNOWN_PROVIDERS)
 *
 * Backwards compat: on first read, if providers.json is missing but the legacy
 * keys.json exists (with anthropic/openai/google entries), import them using
 * built-in templates from the registry.  keys.json is left untouched on disk
 * so existing tooling keeps working.
 */

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  KNOWN_PROVIDERS,
  PROVIDER_SYNONYMS,
  HIGH_CONFIDENCE_BRAND_ALIASES,
  templateById,
  pickPaletteColor,
  type ApiType,
  type ProviderTemplate,
} from '../providers/registry.js';

const CONFIG_DIR = process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8');
const PROVIDERS_FILE = join(CONFIG_DIR, 'providers.json');
const LEGACY_KEYS_FILE = join(CONFIG_DIR, 'keys.json');

export interface ProviderEntry {
  apiKey: string;
  apiType: ApiType;
  name: string;
  baseUrl?: string;
  defaultModel: string;
  color: string;
  custom?: boolean;
}

export type ProvidersFile = Record<string, ProviderEntry>;

async function readProvidersFile(): Promise<ProvidersFile> {
  try {
    const data = await fs.readFile(PROVIDERS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ProvidersFile;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // No providers.json yet — try migrating from legacy keys.json.
    return migrateFromLegacy();
  }
}

async function migrateFromLegacy(): Promise<ProvidersFile> {
  let legacy: Record<string, string>;
  try {
    const data = await fs.readFile(LEGACY_KEYS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    legacy = parsed as Record<string, string>;
  } catch {
    return {};
  }
  const out: ProvidersFile = {};
  for (const [id, key] of Object.entries(legacy)) {
    if (typeof key !== 'string' || !key) continue;
    const tpl = templateById(id);
    if (!tpl) continue; // unknown legacy id — skip silently
    out[id] = entryFromTemplate(tpl, key);
  }
  // Persist so subsequent reads hit providers.json directly.
  if (Object.keys(out).length > 0) await writeProvidersFile(out);
  return out;
}

async function writeProvidersFile(providers: ProvidersFile): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const data = JSON.stringify(providers, null, 2) + '\n';
  await fs.writeFile(PROVIDERS_FILE, data, { mode: 0o600 });
  await fs.chmod(PROVIDERS_FILE, 0o600);
}

export function entryFromTemplate(tpl: ProviderTemplate, apiKey: string): ProviderEntry {
  const entry: ProviderEntry = {
    apiKey,
    apiType: tpl.apiType,
    name: tpl.name,
    defaultModel: tpl.defaultModel,
    color: tpl.color,
  };
  if (tpl.baseUrl) entry.baseUrl = tpl.baseUrl;
  return entry;
}

export async function listProviders(): Promise<ProvidersFile> {
  return readProvidersFile();
}

export async function getProviderEntry(id: string): Promise<ProviderEntry | undefined> {
  const all = await readProvidersFile();
  return all[id];
}

/**
 * Resolve the API key for a provider id, honoring env-var overrides for the
 * three legacy providers (back-compat).  Used by the legacy single-provider
 * call paths so existing setups keep working.
 */
export async function getApiKey(id: string): Promise<string | undefined> {
  if (id === 'anthropic' && process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (id === 'openai' && process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (id === 'google') {
    const k = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
    if (k) return k;
  }
  const entry = await getProviderEntry(id);
  return entry?.apiKey;
}

export async function setProvider(id: string, entry: ProviderEntry): Promise<void> {
  const all = await readProvidersFile();
  all[id] = entry;
  await writeProvidersFile(all);
}

/**
 * Save a key for a known-template provider, preserving any user
 * customizations on an existing entry (display name, defaultModel, baseUrl,
 * custom flag) and only falling back to the template defaults for fields
 * the user hasn't overridden.
 *
 * Used by the inline paste-key flow.  The previous behavior — overwriting
 * the entry wholesale with template defaults — was a regression: a user
 * who had set defaultModel="gemini-2.5-flash" would have it silently
 * reverted to the registry default ("gemini-2.0-flash") on the next
 * inline paste, sending them into a "model no longer available" loop.
 */
export async function saveKeyPreservingEntry(
  apiKey: string,
  template: ProviderTemplate
): Promise<void> {
  const existing = await getProviderEntry(template.id);
  const entry: ProviderEntry = {
    apiKey,
    apiType: existing?.apiType ?? template.apiType,
    name: existing?.name ?? template.name,
    defaultModel: existing?.defaultModel ?? template.defaultModel,
    color: existing?.color ?? template.color,
  };
  const baseUrl = existing?.baseUrl ?? template.baseUrl;
  if (baseUrl) entry.baseUrl = baseUrl;
  if (existing?.custom) entry.custom = true;
  await setProvider(template.id, entry);
}

export async function setProviderKey(id: string, apiKey: string): Promise<void> {
  const all = await readProvidersFile();
  if (all[id]) {
    all[id].apiKey = apiKey;
  } else {
    const tpl = templateById(id);
    if (!tpl) throw new Error(`unknown provider "${id}" — use mod8 add-provider for custom ones`);
    all[id] = entryFromTemplate(tpl, apiKey);
  }
  await writeProvidersFile(all);
}

export async function removeProvider(id: string): Promise<boolean> {
  const all = await readProvidersFile();
  if (!(id in all)) return false;
  delete all[id];
  await writeProvidersFile(all);
  return true;
}

export async function configuredProviderIds(): Promise<string[]> {
  const all = await readProvidersFile();
  return Object.keys(all);
}

/**
 * Resolve a "configured" provider with environment-variable key overrides
 * applied — i.e., the entry that should actually be used for a call.
 */
export async function resolveConfigured(id: string): Promise<ProviderEntry | undefined> {
  const entry = await getProviderEntry(id);
  const envKey = await envKeyFor(id);
  if (entry && envKey) return { ...entry, apiKey: envKey };
  if (entry) return entry;
  // No stored entry, but env key + known template → synthesize an entry.
  if (envKey) {
    const tpl = templateById(id);
    if (tpl) return entryFromTemplate(tpl, envKey);
  }
  return undefined;
}

async function envKeyFor(id: string): Promise<string | undefined> {
  if (id === 'anthropic') return process.env.ANTHROPIC_API_KEY;
  if (id === 'openai') return process.env.OPENAI_API_KEY;
  if (id === 'google') return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
  return undefined;
}

/** Used by add-provider to pick a fresh palette color for a custom provider. */
export async function nextPaletteColor(): Promise<string> {
  const all = await readProvidersFile();
  const used = Object.values(all).map((e) => e.color);
  return pickPaletteColor(used);
}

/** Treat any id appearing in KNOWN_PROVIDERS or providers.json as valid. */
export async function isKnownOrConfigured(id: string): Promise<boolean> {
  if (KNOWN_PROVIDERS.some((p) => p.id === id)) return true;
  const all = await readProvidersFile();
  return id in all;
}

/**
 * Strict variant of the provider-hint resolver — matches only on id (built-in
 * or configured), configured display name, and the curated HIGH-CONFIDENCE
 * brand aliases (claude, gpt, grok, gemini, chatgpt — unambiguous brand
 * names).  Used for bare-name and first-word matching.
 *
 * NOT included: ambiguous synonyms like "haiku", "sonnet", "opus", "bard",
 * "llama" — those are common English/literature words and would false-
 * positive too often.  Users can still route to those via the verb-based
 * path (`use haiku`, `talk to llama`) which goes through full resolution.
 */
export async function strictResolveProviderHint(hint: string): Promise<string | null> {
  const lower = hint.toLowerCase().trim();
  if (!lower) return null;

  const stored = await readProvidersFile();

  // 1. Configured id
  if (stored[lower]) return lower;
  // 2. Built-in id
  if (KNOWN_PROVIDERS.some((p) => p.id === lower)) return lower;
  // 3. Configured display name (case-insensitive)
  for (const [id, entry] of Object.entries(stored)) {
    if (entry.name.toLowerCase() === lower) return id;
  }
  // 4. High-confidence brand alias (claude/gpt/grok/gemini/chatgpt)
  if (HIGH_CONFIDENCE_BRAND_ALIASES[lower]) {
    return HIGH_CONFIDENCE_BRAND_ALIASES[lower];
  }
  return null;
}

/**
 * Map a user-supplied hint (id, display name, or known nickname) to a real
 * provider id.  Tries, in order:
 *   1. Exact id match against the configured store.
 *   2. Exact id match against the built-in registry.
 *   3. Display-name match against the configured store (case-insensitive).
 *   4. Built-in template name match (case-insensitive).
 *   5. PROVIDER_SYNONYMS lookup ("gpt" → "openai", "claude" → "anthropic", …).
 *
 * Returns the canonical id or null if nothing matched.  Does NOT verify the
 * provider is configured (the caller should resolveConfigured() afterwards).
 */
export async function resolveProviderHint(hint: string): Promise<string | null> {
  const lower = hint.toLowerCase().trim();
  if (!lower) return null;

  const stored = await readProvidersFile();

  // 1. Exact id (configured)
  if (stored[lower]) return lower;

  // 2. Exact id (built-in template)
  if (KNOWN_PROVIDERS.some((p) => p.id === lower)) return lower;

  // 3. Display name (configured)
  for (const [id, entry] of Object.entries(stored)) {
    if (entry.name.toLowerCase() === lower) return id;
  }

  // 4. Display name (built-in)
  const tplByName = KNOWN_PROVIDERS.find((p) => p.name.toLowerCase() === lower);
  if (tplByName) return tplByName.id;

  // 5. Synonym
  if (PROVIDER_SYNONYMS[lower]) return PROVIDER_SYNONYMS[lower];

  return null;
}

/**
 * Fuzzy provider-hint resolver — used as a LAST-RESORT fallback after the
 * exact resolvers (resolveProviderHint, strictResolveProviderHint) have
 * returned null.  Picks up typos like "gimini" → google, "anthropc" →
 * anthropic, "claud" → claude, etc.
 *
 * Searches the same universe as strictResolveProviderHint:
 *   - configured provider ids
 *   - configured display names
 *   - built-in template ids
 *   - HIGH_CONFIDENCE_BRAND_ALIASES keys
 *
 * Each candidate string contributes a Levenshtein distance; we keep the
 * BEST distance per resolved id, drop exact matches (distance 0 — those are
 * handled by the exact resolvers), and return everything within distance 2.
 *
 * The CALLER decides what to do with the result (auto-route on distance 1,
 * ask first on distance 2 with short input, etc).  This function just
 * surfaces candidates ranked by edit distance.
 */
export interface FuzzyMatch {
  /** Canonical provider id this candidate resolves to. */
  id: string;
  /** The string in the registry that matched (for display in the prompt). */
  candidate: string;
  /** Levenshtein distance from the user's hint. */
  distance: number;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const an = a.length;
  const bn = b.length;
  let prev = new Array<number>(bn + 1);
  let curr = new Array<number>(bn + 1);
  for (let j = 0; j <= bn; j++) prev[j] = j;
  for (let i = 1; i <= an; i++) {
    curr[0] = i;
    for (let j = 1; j <= bn; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bn]!;
}

export async function fuzzyResolveProviderHint(hint: string): Promise<FuzzyMatch[]> {
  const lower = hint.toLowerCase().trim();
  if (!lower) return [];

  const stored = await readProvidersFile();

  // Candidate haystack: { resolvedId, surfaceString }
  const candidates: Array<{ id: string; surface: string }> = [];
  for (const id of Object.keys(stored)) {
    candidates.push({ id, surface: id });
  }
  for (const [id, entry] of Object.entries(stored)) {
    candidates.push({ id, surface: entry.name.toLowerCase() });
  }
  for (const tpl of KNOWN_PROVIDERS) {
    candidates.push({ id: tpl.id, surface: tpl.id });
    candidates.push({ id: tpl.id, surface: tpl.name.toLowerCase() });
  }
  for (const [alias, id] of Object.entries(HIGH_CONFIDENCE_BRAND_ALIASES)) {
    candidates.push({ id, surface: alias });
  }

  const bestPerId = new Map<string, FuzzyMatch>();
  for (const { id, surface } of candidates) {
    const distance = levenshtein(lower, surface);
    if (distance === 0) continue; // exact match — handled by the strict resolvers
    if (distance > 2) continue; // out of fuzzy range
    const existing = bestPerId.get(id);
    if (!existing || distance < existing.distance) {
      bestPerId.set(id, { id, candidate: surface, distance });
    }
  }

  return Array.from(bestPerId.values()).sort((a, b) =>
    a.distance === b.distance ? a.id.localeCompare(b.id) : a.distance - b.distance
  );
}

export const PROVIDERS_FILE_PATH = PROVIDERS_FILE;
