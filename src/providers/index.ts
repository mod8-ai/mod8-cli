/**
 * Public entry point for getting a provider client by id.
 *
 * Routing rules:
 *   1. MOD8_MOCK=1  → mock (test path; handled inside buildProviderClient)
 *   2. auth.json    → proxy client for {anthropic, openai, google, deepseek};
 *                      custom OpenAI-compat ids fall through to (3)
 *   3. otherwise    → local BYOK from providers.json (current behavior)
 *
 * Used by one-shot (`mod8 -c/-o/-g/-d`), `--all`, and config-set default
 * routing.  The chat REPL uses streamProviderChat from genericChat.ts
 * directly — that module mirrors the same routing.
 */

import type { ProviderClient } from './types.js';
import { buildProviderClient } from './generic.js';
import { readAuth, effectiveProxyUrl, type AuthData } from '../storage/auth.js';
import { makeProxyClient, toProxyProviderId } from './proxy.js';

export async function getProviderClient(id: string): Promise<ProviderClient> {
  if (process.env.MOD8_MOCK === '1') return buildProviderClient(id);

  const auth = await readAuth();
  if (auth) {
    const proxyId = toProxyProviderId(id);
    if (proxyId) {
      return makeProxyClient({
        proxyUrl: effectiveProxyUrl(auth),
        mod8Key: auth.mod8Key,
        providerId: proxyId,
      });
    }
    // Custom providers (mistral / groq / openrouter / xai / custom): the
    // proxy doesn't carry them yet.  Fall back to local providers.json so
    // the user isn't blocked.
  }
  return buildProviderClient(id);
}

export async function authedSession(): Promise<AuthData | null> {
  return readAuth();
}
