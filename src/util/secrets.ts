/**
 * Secret detection + masking.
 *
 * Used by the inline paste-key flow and as a universal sanitizer over user
 * input: every message added to the transcript, persisted to a session, or
 * forwarded to an LLM is run through `sanitizeKeys` so a real API key never
 * leaves the local machine via session JSON, terminal scrollback, or
 * subsequent LLM turns.  The full key only lives in providers.json.
 *
 * Detection is intentionally limited to KNOWN provider key prefixes.  That
 * keeps false-positive risk near zero (we don't accidentally mask normal
 * prose).  Custom providers that don't match a known prefix go through the
 * existing `mod8 add-provider` flow.
 */
import { type ProviderTemplate, templateById } from '../providers/registry.js';

export interface DetectedKey {
  /** The raw API key. */
  key: string;
  /** Provider template inferred from the prefix. */
  template: ProviderTemplate;
  /** Start index of the key in the input string. */
  start: number;
  /** End index (exclusive). */
  end: number;
}

/**
 * Match known key shapes by prefix + a body of safe key characters.  Listed
 * most-specific-first so `sk-ant-`/`sk-or-`/`sk-proj-` win over the generic
 * legacy `sk-` fallback (which still has to be long enough to look like a
 * real key — see the 32-char minimum).
 */
const KEY_RES: Array<{ re: RegExp; templateId: string }> = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, templateId: 'anthropic' },
  { re: /\bsk-or-(?:v\d-)?[A-Za-z0-9_-]{20,}\b/g, templateId: 'openrouter' },
  { re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, templateId: 'openai' },
  { re: /\bgsk_[A-Za-z0-9]{20,}\b/g, templateId: 'groq' },
  { re: /\bxai-[A-Za-z0-9]{20,}\b/g, templateId: 'xai' },
  { re: /\bAIza[A-Za-z0-9_-]{20,}\b/g, templateId: 'google' },
  // Legacy OpenAI / DeepSeek / Mistral — bare "sk-" with a long body. Keep
  // this LAST so the more-specific prefixes above win.
  { re: /\bsk-[A-Za-z0-9]{32,}\b/g, templateId: 'openai' },
];

/**
 * Find the FIRST API key in a piece of text, if any.  Used by the chat REPL
 * to detect a paste, save the provider, and replace the raw key with its
 * masked form before storing/forwarding the message.
 */
export function findApiKey(text: string): DetectedKey | null {
  let best: DetectedKey | null = null;
  for (const { re, templateId } of KEY_RES) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) continue;
    const tpl = templateById(templateId);
    if (!tpl) continue;
    const candidate: DetectedKey = {
      key: m[0],
      template: tpl,
      start: m.index,
      end: m.index + m[0].length,
    };
    // Earliest match wins; on ties, longest match (more-specific prefix).
    if (
      !best ||
      candidate.start < best.start ||
      (candidate.start === best.start && candidate.key.length > best.key.length)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Mask an API key for display.  Preserves enough of the prefix that the
 * provider stays recognizable (e.g. `sk-ant-…AAAA`) without leaking enough
 * material to be useful if the transcript is shared.
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 12) return '*'.repeat(Math.max(trimmed.length, 4));
  const prefixLen =
    trimmed.startsWith('sk-ant-') ? 7
      : trimmed.startsWith('sk-proj-') ? 8
      : trimmed.startsWith('sk-or-') ? 6
      : trimmed.startsWith('AIza') ? 6
      : trimmed.startsWith('gsk_') ? 4
      : trimmed.startsWith('xai-') ? 4
      : trimmed.startsWith('sk-') ? 3
      : 4;
  return `${trimmed.slice(0, prefixLen)}…${trimmed.slice(-4)}`;
}

/**
 * Replace every API key in the input with its masked form.  Idempotent —
 * applying twice yields the same string (masked forms don't match the
 * detection regexes).  Use this on every user message before persisting or
 * forwarding to an LLM so a key never lands in session JSON or a remote
 * provider's request body.
 */
export function sanitizeKeys(text: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < text.length) {
    const remainder = text.slice(cursor);
    const found = findApiKey(remainder);
    if (!found) {
      out += remainder;
      break;
    }
    out += remainder.slice(0, found.start) + maskApiKey(found.key);
    cursor += found.end;
  }
  return out;
}

/**
 * Convenience: did the input contain a key?  Used by the chat REPL to decide
 * whether to surface the masking confirmation or stay silent.
 */
export function containsApiKey(text: string): boolean {
  return findApiKey(text) !== null;
}

