export const PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(s: string): s is Provider {
  return (PROVIDERS as readonly string[]).includes(s);
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  google: 'Google (Gemini)',
};
