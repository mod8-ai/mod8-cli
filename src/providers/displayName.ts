/**
 * Resolve the short display name shown in chat banners and the work-mode
 * system prompt's "you are X" line.  Single source of truth so that the
 * host system prompt, the chat speaker block, and the work system prompt
 * all agree on what to call a provider.
 *
 * Rules:
 *   - Anthropic always renders as "claude" — that's the canonical brand.
 *   - For everything else: prefer the user's configured display name when
 *     it's short and clean (no parens), otherwise fall back to the id.
 *
 * Examples:
 *   anthropic + "Anthropic (Claude)"     → "claude"
 *   openai    + "OpenAI (GPT)"           → "openai"     (parens → id)
 *   openai    + "codex"                  → "codex"      (custom name kept)
 *   deepseek  + "DeepSeek"               → "DeepSeek"   (no parens, kept)
 */
export function workerNameFor(id: string, configuredName?: string): string {
  if (id === 'anthropic') return 'claude';
  if (configuredName && !/[()]/.test(configuredName) && configuredName.length <= 32) {
    return configuredName;
  }
  return id;
}
