import type {
  ProviderClient,
  ProviderResponse,
  StreamEvent,
} from './types.js';
import { priceFor } from './pricing.js';

const RESPONSE_FALLBACK = 'Mock five-word reply here now.';

const KNOWN_RESPONSES: Record<string, string> = {
  anthropic: 'Hello! Five words exactly here.',
  openai: 'Five quick words from GPT.',
  google: 'Hi from Gemini, five words.',
  deepseek: 'Five quick words from DeepSeek.',
  mistral: 'Mistral five-word mock reply here.',
  groq: 'Groq five-word mock reply here.',
  xai: 'Grok five-word mock reply here.',
  openrouter: 'OpenRouter five-word mock reply here.',
  together: 'Together five-word mock reply here.',
};

const KNOWN_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  google: 'gemini-2.0-flash',
  deepseek: 'deepseek-chat',
  mistral: 'mistral-large-latest',
  groq: 'llama-3.3-70b-versatile',
  xai: 'grok-2-latest',
  openrouter: 'openai/gpt-4o-mini',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function mockProvider(id: string): ProviderClient {
  const model = KNOWN_MODELS[id] ?? `${id}-mock-1`;
  const responseText = KNOWN_RESPONSES[id] ?? RESPONSE_FALLBACK;

  const buildUsage = (latencyMs: number, inputTokens: number, outputTokens: number) => ({
    inputTokens,
    outputTokens,
    latencyMs,
    model,
    costUsd: priceFor(model, inputTokens, outputTokens),
  });

  const checkFail = () => {
    if (process.env.MOD8_MOCK_FAIL === id) {
      throw new Error(`Mock failure: ${id} provider intentionally failed`);
    }
    const errType = process.env.MOD8_MOCK_ERROR;
    if (errType && (process.env.MOD8_MOCK_ERROR_PROVIDER ?? id) === id) {
      switch (errType) {
        case '401':
          throw new Error('401 Unauthorized: invalid_api_key');
        case '429':
          throw new Error('429 Too Many Requests: rate_limit_exceeded');
        case 'network':
          throw new Error('fetch failed: ENOTFOUND api.example.com');
        case 'quota':
          throw new Error('insufficient credits on your account');
        case 'timeout':
          throw new Error('Request timed out after 60s');
        case 'model':
          throw new Error('model `nope-1` does not exist');
      }
    }
  };

  return {
    id,
    defaultModel: model,

    async call(prompt: string): Promise<ProviderResponse> {
      const delay = 200 + Math.random() * 400;
      await sleep(delay);
      checkFail();
      const inputTokens = Math.max(1, Math.floor(prompt.length / 4));
      const outputTokens = 8;
      const text =
        process.env.MOD8_MOCK_ECHO === '1' ? `[${id}] received:\n${prompt}` : responseText;
      return {
        text,
        ...buildUsage(Math.round(delay), inputTokens, outputTokens),
      };
    },

    async *stream(prompt: string): AsyncIterable<StreamEvent> {
      const start = Date.now();
      await sleep(120 + Math.random() * 180);
      checkFail();
      for (let i = 0; i < responseText.length; i++) {
        yield { type: 'text', delta: responseText[i]! };
        await sleep(8 + Math.random() * 12);
      }
      const latencyMs = Date.now() - start;
      const inputTokens = Math.max(1, Math.floor(prompt.length / 4));
      const outputTokens = 8;
      yield { type: 'done', usage: buildUsage(latencyMs, inputTokens, outputTokens) };
    },
  };
}
