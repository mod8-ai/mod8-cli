import chalk from 'chalk';
import { getProviderClient } from '../providers/index.js';
import type { ProviderResponse } from '../providers/types.js';
import { formatCost } from '../providers/pricing.js';
import { getConfig, updateConfig } from '../storage/config.js';
import { confirm } from '../util/prompt.js';
import { classifyError } from '../util/errors.js';
import {
  configuredProviderIds,
  resolveConfigured,
  type ProviderEntry,
} from '../storage/providers.js';
import { templateById } from '../providers/registry.js';
import { readAuth } from '../storage/auth.js';
import { PROXY_PROVIDER_IDS } from '../providers/proxy.js';

interface ProviderResult {
  id: string;
  label: string;
  color: string;
  ok: boolean;
  response?: ProviderResponse;
  error?: string;
}

/**
 * Resolve which providers `--all` should fan out to.  Order:
 *   1. Every provider currently configured in providers.json (post-migration)
 *   2. Plus any of the legacy three (anthropic/openai/google) that have an
 *      env-var key set, so out-of-the-box `--all` still works for users who
 *      only export ANTHROPIC_API_KEY etc.
 *   3. In MOD8_MOCK mode with no configured providers, fall back to the
 *      original three so existing mock-driven tests keep working.
 */
async function resolveAllProviders(): Promise<{ id: string; entry: ProviderEntry }[]> {
  // In MOD8_MOCK mode we always run the legacy three side-by-side, regardless
  // of which env keys happen to be set, so the mock-driven --all tests are
  // deterministic and so demos always show three blocks even with an empty
  // sandbox.
  if (process.env.MOD8_MOCK === '1') {
    const ids = ['anthropic', 'openai', 'google'];
    const out: { id: string; entry: ProviderEntry }[] = [];
    for (const id of ids) {
      const tpl = templateById(id);
      out.push({
        id,
        entry: {
          apiKey: 'mock',
          apiType: tpl?.apiType ?? 'openai-compat',
          name: tpl?.name ?? id,
          defaultModel: tpl?.defaultModel ?? `${id}-mock-1`,
          color: tpl?.color ?? '#888888',
        },
      });
    }
    return out;
  }

  const auth = await readAuth();
  const localIds = await configuredProviderIds();
  let ids: string[];
  if (auth) {
    // Proxy mode: all four built-in proxy providers are live.  Append any
    // local custom providers (mistral/groq/openrouter/xai/custom) that the
    // proxy doesn't carry yet — those still call out directly with the
    // user's local key.
    const customLocal = localIds.filter(
      (id) => !(PROXY_PROVIDER_IDS as readonly string[]).includes(id)
    );
    ids = [...PROXY_PROVIDER_IDS, ...customLocal];
  } else {
    ids = localIds;
    // Add legacy ids whose env keys are set but who aren't yet stored.
    for (const legacy of ['anthropic', 'openai', 'google'] as const) {
      if (!ids.includes(legacy)) {
        const env = await resolveConfigured(legacy);
        if (env) ids.push(legacy);
      }
    }
  }
  const out: { id: string; entry: ProviderEntry }[] = [];
  for (const id of ids) {
    let entry = await resolveConfigured(id);
    if (!entry && auth && (PROXY_PROVIDER_IDS as readonly string[]).includes(id)) {
      // Synthesize from template — the proxy client doesn't need a local key.
      const tpl = templateById(id);
      if (tpl) {
        entry = {
          name: tpl.name,
          apiType: tpl.apiType,
          apiKey: '',
          defaultModel: tpl.defaultModel,
          ...(tpl.baseUrl ? { baseUrl: tpl.baseUrl } : {}),
          color: tpl.color,
          custom: false,
        };
      }
    }
    if (entry) out.push({ id, entry });
    else if (process.env.MOD8_MOCK === '1') {
      // Synthesize a placeholder so the mock dispatcher still gets called.
      out.push({
        id,
        entry: {
          apiKey: 'mock',
          apiType: 'openai-compat',
          name: id,
          defaultModel: `${id}-mock-1`,
          color: '#888888',
        },
      });
    }
  }
  return out;
}

export async function runAll(prompt: string): Promise<void> {
  const targets = await resolveAllProviders();
  if (targets.length === 0) {
    console.error(
      chalk.red('mod8: --all has no configured providers.\n') +
        chalk.dim('  Run mod8 keys set <provider> or mod8 add-provider, then retry.')
    );
    process.exit(1);
  }

  console.log(chalk.dim(`Running against ${targets.length} providers in parallel…`));

  const settled = await Promise.allSettled(
    targets.map(async ({ id }) => {
      const client = await getProviderClient(id);
      return client.call(prompt);
    })
  );

  const results: ProviderResult[] = targets.map(({ id, entry }, i) => {
    const s = settled[i]!;
    if (s.status === 'fulfilled') {
      return { id, label: entry.name, color: entry.color, ok: true, response: s.value };
    }
    return {
      id,
      label: entry.name,
      color: entry.color,
      ok: false,
      error: classifyError(s.reason, id),
    };
  });

  let totalTokens = 0;
  let totalCost = 0;
  let totalLatencyMs = 0;
  let okCount = 0;

  for (const r of results) {
    renderBlock(r);
    if (r.ok && r.response) {
      totalTokens += r.response.inputTokens + r.response.outputTokens;
      totalCost += r.response.costUsd;
      totalLatencyMs = Math.max(totalLatencyMs, r.response.latencyMs);
      okCount++;
    }
  }

  console.log();
  console.log(chalk.dim('─'.repeat(60)));
  const seconds = (totalLatencyMs / 1000).toFixed(2);
  const summary = `${okCount}/${results.length} ok · ${totalTokens.toLocaleString()} tok · ${seconds}s · ${formatCost(totalCost)}`;
  console.log(`${chalk.bold('Total:')}  ${chalk.dim(summary)}`);
}

function renderBlock(result: ProviderResult): void {
  const color = chalk.hex(result.color);
  console.log();
  if (result.ok && result.response) {
    const r = result.response;
    const seconds = (r.latencyMs / 1000).toFixed(2);
    const tokens = (r.inputTokens + r.outputTokens).toLocaleString();
    console.log(
      `${color('▎')} ${chalk.bold(result.label)}  ${chalk.dim(r.model)}  ${chalk.dim(
        `${tokens} tok · ${seconds}s · ${formatCost(r.costUsd)}`
      )}`
    );
    console.log(r.text.trimEnd());
  } else {
    console.log(`${color('▎')} ${chalk.bold(result.label)}  ${chalk.red('✗ failed')}`);
    console.log(chalk.red(`  ${result.error ?? 'Unknown error'}`));
  }
}

/**
 * Gate first --all use behind explicit consent.
 * Must be called BEFORE stdin is consumed (the prompt needs the TTY/pipe to be readable).
 */
export async function ensureAllConsent({ stdinPiped }: { stdinPiped: boolean }): Promise<void> {
  if (process.env.MOD8_AUTO_CONFIRM === '1') return;
  const config = await getConfig();
  if (config.allConsent) return;

  if (stdinPiped) {
    console.error(
      chalk.red('mod8: --all needs first-run confirmation, but stdin is piped.')
    );
    console.error(
      chalk.dim(
        '  Run mod8 --all interactively once, or set MOD8_AUTO_CONFIRM=1 to accept non-interactively.'
      )
    );
    process.exit(1);
  }

  console.log();
  console.log(chalk.yellow('First time using --all:'));
  console.log(
    chalk.dim(
      `  This sends your prompt to every configured provider in parallel.\n` +
        `  Cost depends on prompt length and the providers' rates.\n` +
        '  This confirmation only appears once.'
    )
  );
  console.log();
  const ok = await confirm(chalk.bold('Continue? [y/N]: '));
  if (!ok) {
    console.log(chalk.dim('Cancelled.'));
    process.exit(0);
  }
  await updateConfig({ allConsent: true });
  console.log();
}
