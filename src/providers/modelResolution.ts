/**
 * Single source of truth for picking the model for a provider call.
 *
 * Resolution priority (matches the user-facing contract — env > config >
 * template default):
 *
 *   1. opts.model            — explicit per-call override (rare; used by
 *                               compare flow when targeting specific models)
 *   2. MOD8_<ID>_MODEL env   — quick override without editing providers.json,
 *                               case-insensitive on the env var name
 *   3. entry.defaultModel    — the value the user wrote into providers.json
 *   4. (none)                — providers without a default fail loudly so the
 *                               caller can surface a useful error
 *
 * NEVER silently substitute a different model from any internal allowlist —
 * if the user wrote "gemini-2.5-flash" we send "gemini-2.5-flash" to the
 * provider, and let the provider decide whether that's valid.
 */

export type ModelSource = 'opts' | 'env' | 'providers.json' | 'none';

export interface ResolvedModel {
  model: string;
  source: ModelSource;
  /** The env var name we checked, for debug logging. */
  envVar: string;
}

/** Build the env var name for a given provider id ("google" → "MOD8_GOOGLE_MODEL"). */
export function envVarForProvider(providerId: string): string {
  const sanitized = providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `MOD8_${sanitized}_MODEL`;
}

/** Read the env override for a provider id, or undefined if unset/empty. */
export function envModelFor(providerId: string): string | undefined {
  const v = process.env[envVarForProvider(providerId)];
  return v && v.length > 0 ? v : undefined;
}

export function resolveModel(
  providerId: string,
  optsModel: string | undefined,
  entryDefaultModel: string | undefined
): ResolvedModel {
  const envVar = envVarForProvider(providerId);
  if (optsModel && optsModel.length > 0) {
    return { model: optsModel, source: 'opts', envVar };
  }
  const envModel = envModelFor(providerId);
  if (envModel) {
    return { model: envModel, source: 'env', envVar };
  }
  if (entryDefaultModel && entryDefaultModel.length > 0) {
    return { model: entryDefaultModel, source: 'providers.json', envVar };
  }
  return { model: '', source: 'none', envVar };
}
