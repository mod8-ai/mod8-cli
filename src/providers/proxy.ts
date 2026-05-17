/**
 * ProxyClient — talks to the mod8 hosted proxy (mod8-proxy on Cloud Run)
 * over SSE.  Same ProviderClient surface as local clients so the rest of
 * the CLI doesn't have to branch.
 *
 * Wire format (matches proxy/src/server.ts):
 *   POST /v1/chat
 *     Authorization: Bearer <sk-mod8-...>
 *     { provider, model, messages: [{role,content}], maxTokens?, system? }
 *
 *   SSE events:
 *     data: { "type": "text",  "delta": "..." }
 *     data: { "type": "done",  "tokensIn": N, "tokensOut": M,
 *             "rawCostMicros": X, "chargedMicros": Y,
 *             "balanceAfterMicros": Z, "chargeApplied": true }
 *     data: { "type": "error", "error": "..." }
 *
 * Charged amount uses chargedMicros (raw + 15% markup), not raw — the
 * user's bill, not the provider's bill.
 */

import type {
  ProviderClient,
  ProviderResponse,
  ProviderCallOptions,
  StreamEvent,
} from './types.js';

/** mod8 proxy provider ids — exactly what the proxy understands. */
export type ProxyProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek';

/** Ordered list of all proxy provider ids — used by REPL features that need
 * to enumerate "what's available" in proxy mode (compare-all, /providers). */
export const PROXY_PROVIDER_IDS: readonly ProxyProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
] as const;

/** CLI provider id → proxy provider id.  Custom OpenAI-compat providers
 * (mistral/groq/openrouter/xai/together/custom) don't run through the
 * proxy — they fall back to local providers.json. */
export function toProxyProviderId(id: string): ProxyProviderId | null {
  if (id === 'anthropic' || id === 'openai' || id === 'google' || id === 'deepseek') {
    return id;
  }
  return null;
}

const DEFAULT_MODEL: Record<ProxyProviderId, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  google: 'gemini-2.5-flash',
  deepseek: 'deepseek-chat',
};

interface DoneEvent {
  type: 'done';
  tokensIn: number;
  tokensOut: number;
  rawCostMicros: number;
  chargedMicros: number;
  balanceAfterMicros: number | null;
  chargeApplied: boolean;
}

interface TextEvent {
  type: 'text';
  delta: string;
}

interface ErrorEvent {
  type: 'error';
  error: string;
}

type WireEvent = TextEvent | DoneEvent | ErrorEvent;

export interface ProxyClientOptions {
  proxyUrl: string;
  mod8Key: string;
  providerId: ProxyProviderId;
  defaultModel?: string;
}

export function makeProxyClient(opts: ProxyClientOptions): ProviderClient {
  const id = opts.providerId;
  const fallbackModel = opts.defaultModel ?? DEFAULT_MODEL[id];

  async function* runStream(prompt: string, callOpts: ProviderCallOptions): AsyncIterable<StreamEvent> {
    const model = callOpts.model ?? fallbackModel;
    const start = Date.now();
    const resp = await fetch(`${opts.proxyUrl}/v1/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.mod8Key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: id,
        model,
        messages: [{ role: 'user', content: prompt }],
        ...(callOpts.maxTokens !== undefined ? { maxTokens: callOpts.maxTokens } : {}),
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(
        `mod8 proxy: ${resp.status} ${resp.statusText}${detail ? ` — ${trim(detail)}` : ''}`
      );
    }
    if (!resp.body) {
      throw new Error('mod8 proxy: empty response body');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let chargedMicros = 0;
    let actualModel = model;
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          let ev: WireEvent;
          try {
            ev = JSON.parse(line.slice(6)) as WireEvent;
          } catch {
            continue;
          }
          if (ev.type === 'text') {
            yield { type: 'text', delta: ev.delta };
          } else if (ev.type === 'done') {
            inputTokens = ev.tokensIn;
            outputTokens = ev.tokensOut;
            chargedMicros = ev.chargedMicros;
            sawDone = true;
          } else if (ev.type === 'error') {
            throw new Error(`mod8 proxy: ${ev.error}`);
          }
        }
      }
    }

    if (!sawDone) {
      throw new Error('mod8 proxy: stream ended without a done event');
    }

    yield {
      type: 'done',
      usage: {
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - start,
        model: actualModel,
        costUsd: chargedMicros / 1_000_000,
      },
    };
  }

  return {
    id,
    defaultModel: fallbackModel,

    async call(prompt: string, callOpts: ProviderCallOptions = {}): Promise<ProviderResponse> {
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      let model = fallbackModel;
      let latencyMs = 0;
      for await (const ev of runStream(prompt, callOpts)) {
        if (ev.type === 'text') text += ev.delta;
        else if (ev.type === 'done') {
          inputTokens = ev.usage.inputTokens;
          outputTokens = ev.usage.outputTokens;
          costUsd = ev.usage.costUsd;
          model = ev.usage.model;
          latencyMs = ev.usage.latencyMs;
        }
      }
      return { text, inputTokens, outputTokens, costUsd, latencyMs, model };
    },

    async *stream(prompt: string, callOpts: ProviderCallOptions = {}): AsyncIterable<StreamEvent> {
      yield* runStream(prompt, callOpts);
    },
  };
}

function trim(s: string): string {
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
