/**
 * Per-million-token pricing in USD. List prices, not promotional rates,
 * batch API, or prompt-caching pricing. Update as providers publish changes.
 *
 * Lookup is exact-match first, then longest-prefix.
 */
export interface ModelPricing {
  inputPerMtok: number;
  outputPerMtok: number;
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic (Claude 4.x family — list prices)
  'claude-opus-4-7': { inputPerMtok: 15, outputPerMtok: 75 },
  'claude-opus-4': { inputPerMtok: 15, outputPerMtok: 75 },
  'claude-sonnet-4-6': { inputPerMtok: 3, outputPerMtok: 15 },
  'claude-sonnet-4-5': { inputPerMtok: 3, outputPerMtok: 15 },
  'claude-sonnet-4': { inputPerMtok: 3, outputPerMtok: 15 },
  'claude-haiku-4-5': { inputPerMtok: 1, outputPerMtok: 5 },
  'claude-haiku-4': { inputPerMtok: 1, outputPerMtok: 5 },

  // OpenAI
  'gpt-4o': { inputPerMtok: 2.5, outputPerMtok: 10 },
  'gpt-4o-mini': { inputPerMtok: 0.15, outputPerMtok: 0.6 },
  'gpt-4.1': { inputPerMtok: 2, outputPerMtok: 8 },
  'gpt-4.1-mini': { inputPerMtok: 0.4, outputPerMtok: 1.6 },

  // Google
  'gemini-2.0-flash': { inputPerMtok: 0.075, outputPerMtok: 0.3 },
  'gemini-2.5-flash': { inputPerMtok: 0.075, outputPerMtok: 0.3 },
  'gemini-2.5-pro': { inputPerMtok: 1.25, outputPerMtok: 5 },
};

export function priceFor(model: string, inputTokens: number, outputTokens: number): number {
  let p = PRICING[model];
  if (!p) {
    // Longest matching prefix
    let bestKey: string | undefined;
    for (const key of Object.keys(PRICING)) {
      if (model.startsWith(key) && (!bestKey || key.length > bestKey.length)) {
        bestKey = key;
      }
    }
    if (bestKey) p = PRICING[bestKey];
  }
  if (!p) return 0;
  return (inputTokens / 1_000_000) * p.inputPerMtok + (outputTokens / 1_000_000) * p.outputPerMtok;
}

export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.001) return '<$0.001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
