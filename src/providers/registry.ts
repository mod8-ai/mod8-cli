/**
 * Provider registry — built-in catalog of known providers.
 *
 * mod8 supports any provider that speaks one of three API styles:
 *   - "anthropic"     — native Anthropic Messages API
 *   - "gemini"        — native Google generative-ai SDK
 *   - "openai-compat" — OpenAI Chat Completions schema (covers OpenAI itself,
 *                       DeepSeek, Mistral, Groq, OpenRouter, xAI, Together, …)
 *
 * Each entry is a *template*. A provider only becomes "configured" once the
 * user supplies a key (via `mod8 add-provider` or `mod8 keys set <id>`).
 *
 * Unknown key prefixes fall through to a manual prompt in `add-provider`.
 */

export type ApiType = 'anthropic' | 'openai-compat' | 'gemini';

export interface ProviderTemplate {
  id: string;
  /** Human-readable label, shown in side-by-side blocks and listings. */
  name: string;
  apiType: ApiType;
  baseUrl?: string; // omit for SDK-default (anthropic/gemini); openai-compat needs it
  defaultModel: string;
  /** Display color (hex). Falls back to a palette pick if not set. */
  color: string;
  /** Used for paste-detection. Optional — providers without a stable prefix omit. */
  keyPrefix?: string;
}

/**
 * Known providers. Order matters for ambiguity resolution: when two prefixes
 * could match (e.g. "sk-" matches both OpenAI and Mistral), the first match
 * wins, so list more-specific prefixes before more-generic ones.
 */
export const KNOWN_PROVIDERS: ProviderTemplate[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    apiType: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    color: '#A78BFA', // purple (matches chat work-mode brand)
    keyPrefix: 'sk-ant-',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    apiType: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    color: '#EC4899', // pink
    keyPrefix: 'sk-or-',
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT)',
    apiType: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    color: '#10B981', // emerald
    keyPrefix: 'sk-proj-', // newer OpenAI keys; legacy "sk-" also matched via fallback
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiType: 'openai-compat',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    color: '#3B82F6', // blue
    keyPrefix: 'sk-', // generic — only used as last resort below
  },
  {
    id: 'groq',
    name: 'Groq',
    apiType: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    color: '#F59E0B', // amber-500
    keyPrefix: 'gsk_',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    apiType: 'openai-compat',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    color: '#6B7280', // gray
    keyPrefix: 'xai-',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    apiType: 'openai-compat',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    color: '#EF4444', // red
    // No public stable prefix; fall back to manual confirmation.
  },
  {
    id: 'together',
    name: 'Together AI',
    apiType: 'openai-compat',
    baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    color: '#8B5CF6', // violet
    // No stable prefix.
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    apiType: 'gemini',
    // gemini-2.5-flash is the current free-tier flagship as of 2026.
    // gemini-2.0-flash is being deprecated for new users — Google returns
    // "no longer available to new users" on a fresh key.
    defaultModel: 'gemini-2.5-flash',
    color: '#06B6D4', // cyan
    // Google API keys start with AIza but format is shared with all Google APIs.
    keyPrefix: 'AIza',
  },
];

/**
 * Common nicknames → built-in provider id.  When the user says "let me talk
 * to gpt" or "use claude", we want to land on the actual configured provider
 * (which might be stored under "openai" with a custom display name like
 * "codex"), not bail with "unknown provider 'gpt'."
 *
 * The resolver in storage/providers.ts uses this AFTER trying an exact id
 * match and an exact display-name match — synonyms are the last fallback.
 */
export const PROVIDER_SYNONYMS: Record<string, string> = {
  // Anthropic family
  claude: 'anthropic',
  sonnet: 'anthropic',
  opus: 'anthropic',
  haiku: 'anthropic',
  // OpenAI family
  gpt: 'openai',
  chatgpt: 'openai',
  'gpt-4': 'openai',
  'gpt-4o': 'openai',
  // Google family
  gemini: 'google',
  bard: 'google',
  // xAI
  grok: 'xai',
  // Meta / Groq (shorthand most users type)
  llama: 'groq',
};

/**
 * High-confidence brand aliases — unambiguous brand names that don't collide
 * with common English words.  Allowed in STRICT resolution (bare-name and
 * first-word matching) so that `claude`, `gpt`, `grok`, etc. typed alone or
 * with a short instruction route directly without going through the LLM.
 *
 * Excluded on purpose: `sonnet`, `opus`, `haiku`, `bard` — those are poetry/
 * literature words common enough in chat to false-positive.  Also excluded:
 * `llama` (animal/Linux distro) for the same reason.  Those still resolve
 * via the verb-based path (`use sonnet`, `talk to llama`) which is explicit.
 */
export const HIGH_CONFIDENCE_BRAND_ALIASES: Record<string, string> = {
  claude: 'anthropic',
  gpt: 'openai',
  chatgpt: 'openai',
  gemini: 'google',
  grok: 'xai',
};

/**
 * Auto-assignable color palette for user-provided custom providers.
 * Keep distinct from the known-provider colors above.
 */
export const COLOR_PALETTE: string[] = [
  '#6EE7B7', // mint
  '#A78BFA', // purple
  '#FBBF24', // yellow
  '#F472B6', // pink
  '#60A5FA', // sky
  '#FB923C', // orange
  '#34D399', // green
  '#E879F9', // fuchsia
];

export function templateById(id: string): ProviderTemplate | undefined {
  return KNOWN_PROVIDERS.find((p) => p.id === id);
}

/**
 * Detect a provider template from a key prefix. Returns the most specific
 * match, falling back to OpenAI for legacy "sk-" if no other match.
 */
export function detectFromKey(key: string): ProviderTemplate | undefined {
  const trimmed = key.trim();
  // First pass: any provider with an exact prefix match. KNOWN_PROVIDERS is
  // ordered most-specific-first, so the first hit wins.
  for (const p of KNOWN_PROVIDERS) {
    if (p.keyPrefix && trimmed.startsWith(p.keyPrefix)) return p;
  }
  // Legacy fallback: bare "sk-" (no -ant-, -or-, -proj-) → OpenAI.
  if (trimmed.startsWith('sk-')) return templateById('openai');
  return undefined;
}

/** Pick a color for a custom provider given how many already exist. */
export function pickPaletteColor(usedColors: string[]): string {
  for (const c of COLOR_PALETTE) {
    if (!usedColors.includes(c)) return c;
  }
  // Wrap around if user has > palette length custom providers.
  return COLOR_PALETTE[usedColors.length % COLOR_PALETTE.length]!;
}

export function isValidProviderId(id: string): boolean {
  return /^[a-z][a-z0-9_-]{0,30}$/.test(id);
}
