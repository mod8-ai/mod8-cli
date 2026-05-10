/**
 * `mod8 dev:work-ask <providerId> <prompt>` — non-interactive endpoint that
 * runs a single turn through the WORK-mode system prompt for a given
 * configured provider.  Powers behavioral tests for work-mode character
 * (does codex stay in character? does it impersonate mod8?).
 */

import chalk from 'chalk';
import { streamProviderChat } from '../providers/genericChat.js';
import { resolveConfigured } from '../storage/providers.js';
import { buildWorkSystem } from '../providers/workSystem.js';
import { workerNameFor } from '../providers/displayName.js';
import { classifyError } from '../util/errors.js';
import { formatStats } from './prompt.js';
import type { StreamUsage } from '../providers/types.js';

export async function devWorkAsk(providerId: string, prompt: string): Promise<void> {
  const entry = await resolveConfigured(providerId);
  if (!entry) {
    console.error(
      chalk.red('mod8: ') +
        `provider "${providerId}" is not configured. Run mod8 keys set ${providerId} (or mod8 add-provider).`
    );
    process.exit(1);
  }
  const workerName = workerNameFor(providerId, entry.name);
  const system = buildWorkSystem(workerName);

  let usage: StreamUsage | undefined;
  let lastChar = '';
  try {
    for await (const event of streamProviderChat({
      providerId,
      system,
      messages: [{ role: 'user', content: prompt }],
    })) {
      if (event.type === 'text') {
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
    console.error(chalk.red('mod8: ') + classifyError(err, providerId));
    process.exit(1);
  }

  if (lastChar !== '\n') process.stdout.write('\n');
  if (usage) {
    console.log();
    console.log(formatStats(usage));
  }
}
