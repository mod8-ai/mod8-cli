/**
 * Provider-model resolution + Vercel AI SDK client construction.
 *
 * Used by both the one-shot `mod8 agent "<task>"` command and the
 * interactive REPL.  Lives in its own module so a future "switch model
 * mid-session" feature in the REPL can call rebuild() cheaply.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { readAuth, effectiveProxyUrl } from '../storage/auth.js';
import { resolveConfigured } from '../storage/providers.js';

/** Optional metadata the CLI tags onto each proxy request via headers
 *  (X-Mod8-Project-Id / -Project-Name / -Topic).  The mod8.ai proxy
 *  reads these to attribute spend to the cwd's project, so the user's
 *  Projects dashboard can show "PropFlow cost $4.20 in Claude this
 *  month" instead of one unattributed total.  Optional — old CLI
 *  versions and direct API calls don't send them and the proxy degrades
 *  gracefully. */
export interface ProxyAttribution {
  projectId?: string;
  projectName?: string;
  topic?: string;
}

export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'deepseek';

export interface ResolvedModel {
  kind: ProviderKind;
  modelId: string;
  label: string;
}

export interface ProviderConnection {
  model: ReturnType<ReturnType<typeof createAnthropic>>;
  source: 'proxy' | 'local';
}

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Map a model id to the right provider client.  Accepts the raw ids
 *  each provider uses plus short aliases (claude / gpt / gemini /
 *  deepseek). */
export function resolveModel(input: string): ResolvedModel {
  const id = input.trim();
  const lower = id.toLowerCase();
  if (lower === 'claude') return { kind: 'anthropic', modelId: 'claude-sonnet-4-6', label: 'Claude' };
  if (lower === 'gpt') return { kind: 'openai', modelId: 'gpt-4o', label: 'GPT' };
  if (lower === 'gemini') return { kind: 'google', modelId: 'gemini-2.5-flash', label: 'Gemini' };
  if (lower === 'deepseek') return { kind: 'deepseek', modelId: 'deepseek-chat', label: 'DeepSeek' };

  if (lower.startsWith('claude-')) return { kind: 'anthropic', modelId: id, label: 'Claude' };
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
    return { kind: 'openai', modelId: id, label: 'GPT' };
  }
  if (lower.startsWith('gemini-')) return { kind: 'google', modelId: id, label: 'Gemini' };
  if (lower.startsWith('deepseek-')) return { kind: 'deepseek', modelId: id, label: 'DeepSeek' };

  throw new Error(
    `Unknown model "${id}".  Try: claude-sonnet-4-6, gpt-4o, gemini-2.5-flash, deepseek-chat (or short aliases: claude, gpt, gemini, deepseek).`
  );
}

export async function buildProviderModel(
  resolved: ResolvedModel,
  attribution?: ProxyAttribution
): Promise<ProviderConnection> {
  const auth = await readAuth();
  if (auth) {
    const proxyUrl = effectiveProxyUrl(auth);
    return buildProxyConnection(resolved, proxyUrl, auth.mod8Key, attribution);
  }
  return buildLocalConnection(resolved);
}

/** Build the static header set sent on EVERY upstream request through
 *  the mod8 proxy.  Includes the project attribution headers when the
 *  caller supplied them.  Header names match what
 *  proxy/src/transparent-forward.ts looks for (case-insensitive). */
function buildProxyHeaders(attribution?: ProxyAttribution): Record<string, string> {
  const h: Record<string, string> = {};
  if (attribution?.projectId) h['X-Mod8-Project-Id'] = attribution.projectId;
  if (attribution?.projectName) h['X-Mod8-Project-Name'] = attribution.projectName;
  if (attribution?.topic) h['X-Mod8-Topic'] = attribution.topic;
  return h;
}

function buildProxyConnection(
  resolved: ResolvedModel,
  proxyUrl: string,
  mod8Key: string,
  attribution?: ProxyAttribution
): ProviderConnection {
  const headers = buildProxyHeaders(attribution);
  switch (resolved.kind) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        baseURL: `${proxyUrl}/v1/anthropic/v1`,
        apiKey: mod8Key,
        headers,
      });
      return { model: anthropic(resolved.modelId), source: 'proxy' };
    }
    case 'openai': {
      const openai = createOpenAI({
        baseURL: `${proxyUrl}/v1/openai/v1`,
        apiKey: mod8Key,
        headers,
      });
      return { model: openai(resolved.modelId), source: 'proxy' };
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        baseURL: `${proxyUrl}/v1/google/v1beta`,
        apiKey: mod8Key,
        headers,
      });
      return { model: google(resolved.modelId), source: 'proxy' };
    }
    case 'deepseek': {
      const deepseek = createOpenAICompatible({
        name: 'deepseek',
        baseURL: `${proxyUrl}/v1/deepseek/v1`,
        apiKey: mod8Key,
        headers,
      });
      return { model: deepseek(resolved.modelId), source: 'proxy' };
    }
  }
}

async function buildLocalConnection(resolved: ResolvedModel): Promise<ProviderConnection> {
  const entry = await resolveConfigured(resolved.kind);
  if (!entry) {
    throw new Error(
      `${resolved.kind}: no local key configured and you're not logged in.  Run \`mod8 login\` (recommended) or \`mod8 keys set ${resolved.kind}\`.`
    );
  }
  switch (resolved.kind) {
    case 'anthropic': {
      const anthropic = createAnthropic({ apiKey: entry.apiKey });
      return { model: anthropic(resolved.modelId), source: 'local' };
    }
    case 'openai': {
      const openai = createOpenAI({ apiKey: entry.apiKey });
      return { model: openai(resolved.modelId), source: 'local' };
    }
    case 'google': {
      const google = createGoogleGenerativeAI({ apiKey: entry.apiKey });
      return { model: google(resolved.modelId), source: 'local' };
    }
    case 'deepseek': {
      const deepseek = createOpenAICompatible({
        name: 'deepseek',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: entry.apiKey,
      });
      return { model: deepseek(resolved.modelId), source: 'local' };
    }
  }
}
