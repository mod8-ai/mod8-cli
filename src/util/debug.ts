/**
 * MOD8_DEBUG=1 instrumentation.
 *
 * Prints to stderr (so it never pollutes piped stdout / one-shot output).
 * Always redacts API keys to the masked form before logging.
 *
 * Use cases:
 *   - "Is the env var being respected?"           → modelResolution log
 *   - "What URL did the SDK try to hit?"          → providerCall log
 *   - "What did the provider actually return?"    → providerResponse log
 *   - "Why does mod8 say 'model not available'?"  → providerError log
 */

import { maskApiKey } from './secrets.js';

export function debugEnabled(): boolean {
  return process.env.MOD8_DEBUG === '1';
}

function ts(): string {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}

function emit(line: string): void {
  process.stderr.write(`[mod8:debug ${ts()}] ${line}\n`);
}

export function debugLog(message: string, fields?: Record<string, unknown>): void {
  if (!debugEnabled()) return;
  if (!fields) {
    emit(message);
    return;
  }
  const parts: string[] = [message];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${formatValue(v)}`);
  }
  emit(parts.join(' '));
}

function formatValue(v: unknown): string {
  if (v === undefined) return '(undefined)';
  if (v === null) return '(null)';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

/**
 * Approximate the URL each provider's SDK will hit.  We don't intercept the
 * network, so this is a best-effort hint based on apiType + baseUrl + model.
 * Useful when debugging a "why isn't my custom model getting through?"
 * report — the URL printed here matches what the SDK actually requests.
 */
export function approximateProviderUrl(
  apiType: 'anthropic' | 'openai-compat' | 'gemini',
  model: string,
  baseUrl?: string
): string {
  switch (apiType) {
    case 'anthropic':
      return `https://api.anthropic.com/v1/messages  (model=${model})`;
    case 'openai-compat': {
      const base = baseUrl ?? 'https://api.openai.com/v1';
      return `${base.replace(/\/$/, '')}/chat/completions  (model=${model})`;
    }
    case 'gemini':
      return `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`;
  }
}

export function debugProviderCall(opts: {
  providerId: string;
  apiType: 'anthropic' | 'openai-compat' | 'gemini';
  model: string;
  modelSource: string;
  baseUrl?: string;
  apiKey: string;
  promptPreview: string;
}): void {
  if (!debugEnabled()) return;
  emit(
    `provider-call providerId=${opts.providerId} apiType=${opts.apiType} model=${JSON.stringify(opts.model)} modelSource=${opts.modelSource} key=${maskApiKey(opts.apiKey)} url=${JSON.stringify(approximateProviderUrl(opts.apiType, opts.model, opts.baseUrl))} prompt=${JSON.stringify(opts.promptPreview.slice(0, 200))}`
  );
}

export function debugProviderError(providerId: string, err: unknown): void {
  if (!debugEnabled()) return;
  const message = err instanceof Error ? err.message : String(err);
  emit(`provider-error providerId=${providerId} message=${JSON.stringify(message.slice(0, 800))}`);
}

export function debugProviderResponse(providerId: string, model: string, tokens: { input: number; output: number; latencyMs: number }): void {
  if (!debugEnabled()) return;
  emit(
    `provider-ok providerId=${providerId} model=${JSON.stringify(model)} input_tok=${tokens.input} output_tok=${tokens.output} latency_ms=${tokens.latencyMs}`
  );
}
