import chalk from 'chalk';
import { getProviderClient } from '../providers/index.js';
import type { StreamUsage } from '../providers/types.js';
import { formatCost } from '../providers/pricing.js';
import { getConfig } from '../storage/config.js';
import { classifyError } from '../util/errors.js';

type ProviderId = string;

export interface ProviderFlagOptions {
  claude?: boolean;
  openai?: boolean;
  gemini?: boolean;
}

export async function resolveProvider(opts: ProviderFlagOptions): Promise<ProviderId> {
  const flags = [opts.claude, opts.openai, opts.gemini].filter(Boolean).length;
  if (flags > 1) {
    throw new Error('Cannot use multiple provider flags. Pick one of -c, -o, -g, or use --all.');
  }
  if (opts.claude) return 'anthropic';
  if (opts.openai) return 'openai';
  if (opts.gemini) return 'google';
  const config = await getConfig();
  return config.default ?? 'anthropic';
}

export function formatStats(usage: StreamUsage): string {
  const totalTokens = (usage.inputTokens + usage.outputTokens).toLocaleString();
  const seconds = (usage.latencyMs / 1000).toFixed(2);
  return `${chalk.dim('—')} ${chalk.bold(usage.model)}  ${chalk.dim(`${totalTokens} tok · ${seconds}s · ${formatCost(usage.costUsd)}`)}`;
}

export interface RunPromptOptions {
  provider: ProviderId;
  prompt: string;
}

export async function runPrompt({ provider, prompt }: RunPromptOptions): Promise<void> {
  let client;
  try {
    client = await getProviderClient(provider);
  } catch (err) {
    console.error(chalk.red('mod8: ') + (err as Error).message);
    process.exit(1);
  }
  let usage: StreamUsage | undefined;
  let lastChar = '';
  try {
    for await (const event of client.stream(prompt)) {
      if (event.type === 'text') {
        process.stdout.write(event.delta);
        if (event.delta.length > 0) {
          lastChar = event.delta[event.delta.length - 1]!;
        }
      } else if (event.type === 'done') {
        usage = event.usage;
      }
    }
  } catch (err) {
    if (lastChar !== '\n' && lastChar !== '') process.stdout.write('\n');
    console.error(chalk.red('mod8: ') + chalk.dim(`${provider}: `) + classifyError(err, provider));
    process.exit(1);
  }

  if (lastChar !== '\n') process.stdout.write('\n');
  if (usage) {
    console.log();
    console.log(formatStats(usage));
  }
}
