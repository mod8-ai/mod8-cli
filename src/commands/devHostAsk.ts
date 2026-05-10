/**
 * `mod8 dev:host-ask <prompt>` — non-interactive endpoint that runs a single
 * turn through the host (mod8) system prompt with the user's currently-
 * configured providers injected.  Hidden from --help; it exists primarily so
 * `mod8 verify` can assert on real LLM responses to meta questions.
 *
 * Useful from the shell too: a quick meta query without entering the REPL.
 */

import chalk from 'chalk';
import { streamProviderChat } from '../providers/genericChat.js';
import { readHostContext, buildHostSystem } from '../providers/hostSystem.js';
import { classifyError } from '../util/errors.js';
import { formatStats } from './prompt.js';
import type { StreamUsage } from '../providers/types.js';

const HOST_PROVIDER_ID = 'anthropic';

export async function devHostAsk(prompt: string): Promise<void> {
  const ctx = await readHostContext();
  const system = buildHostSystem(ctx);

  let usage: StreamUsage | undefined;
  let lastChar = '';
  try {
    for await (const event of streamProviderChat({
      providerId: HOST_PROVIDER_ID,
      system,
      messages: [{ role: 'user', content: prompt }],
    })) {
      if (event.type === 'text') {
        // Strip handoff tokens so they don't leak into stdout.
        const cleaned = event.delta.replace(/<SWITCH_TO_(WORK|HOST)>/gi, '');
        if (cleaned) {
          process.stdout.write(cleaned);
          lastChar = cleaned[cleaned.length - 1] ?? '';
        }
      } else if (event.type === 'done') {
        usage = event.usage;
      }
    }
  } catch (err) {
    if (lastChar !== '\n' && lastChar !== '') process.stdout.write('\n');
    console.error(chalk.red('mod8: ') + classifyError(err, HOST_PROVIDER_ID));
    process.exit(1);
  }

  if (lastChar !== '\n') process.stdout.write('\n');
  if (usage) {
    console.log();
    console.log(formatStats(usage));
  }
}
