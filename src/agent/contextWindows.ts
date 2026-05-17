/**
 * Model → context-window-size lookup.
 *
 * Used by the chat UI to show a "context: 84% · 168k/200k" bar so the
 * user sees when an agent is running out of room — the situation that
 * causes models to "forget" earlier tool calls mid-task.
 *
 * Numbers are approximate: providers cap at slightly different limits
 * for input vs total, and tool-call traffic, prompt caching, and system
 * prompts all consume some of the window invisibly.  Erring on the
 * larger side here means the warning fires LATE rather than early,
 * which is the failure mode the user prefers (no false alarms).
 *
 * Default for unknown models: 128_000 — the most common modern floor.
 */

const TABLE: Array<{ match: (id: string) => boolean; window: number }> = [
  // Anthropic Claude
  { match: (id) => /^claude-(opus|sonnet|haiku)-4/.test(id), window: 200_000 },
  { match: (id) => /^claude-3.*sonnet/.test(id), window: 200_000 },
  { match: (id) => /^claude-3.*opus/.test(id), window: 200_000 },
  { match: (id) => /^claude-3.*haiku/.test(id), window: 200_000 },

  // OpenAI
  { match: (id) => /^gpt-5/.test(id), window: 400_000 },
  { match: (id) => /^gpt-4\.1/.test(id), window: 1_000_000 },
  { match: (id) => /^gpt-4o/.test(id), window: 128_000 },
  { match: (id) => /^gpt-4-turbo/.test(id), window: 128_000 },
  { match: (id) => /^o1|^o3|^o4/.test(id), window: 200_000 },

  // Google Gemini
  { match: (id) => /gemini-2.*pro/.test(id), window: 2_000_000 },
  { match: (id) => /gemini-2.*flash/.test(id), window: 1_000_000 },
  { match: (id) => /gemini-1\.5-pro/.test(id), window: 2_000_000 },
  { match: (id) => /gemini-1\.5-flash/.test(id), window: 1_000_000 },

  // DeepSeek — chat / coder both support 1M as of 2026; older 128k builds
  //  still ship on some self-hosted forks, but the official API is 1M.
  { match: (id) => /^deepseek/.test(id), window: 1_048_576 },

  // xAI / Grok
  { match: (id) => /^grok-4/.test(id), window: 256_000 },
  { match: (id) => /^grok-3/.test(id), window: 131_072 },
  { match: (id) => /^grok-2/.test(id), window: 131_072 },

  // Mistral
  { match: (id) => /mistral-large/.test(id), window: 128_000 },
  { match: (id) => /codestral/.test(id), window: 256_000 },

  // Groq-hosted Llama
  { match: (id) => /llama-3\.[123]-70b/.test(id), window: 131_072 },
  { match: (id) => /llama-3\.[123]-8b/.test(id), window: 131_072 },
];

export function contextWindowFor(modelId: string): number {
  for (const row of TABLE) {
    if (row.match(modelId)) return row.window;
  }
  return 128_000;
}
