import chalk from 'chalk';
import {
  setProviderKey,
  removeProvider,
  listProviders,
  PROVIDERS_FILE_PATH,
} from '../storage/providers.js';
import { KNOWN_PROVIDERS, templateById } from '../providers/registry.js';
import { readSecret, maskKey } from '../util/prompt.js';

export async function keysSet(provider: string): Promise<void> {
  const tpl = templateById(provider);
  if (!tpl) {
    console.error(
      chalk.red(`Unknown provider '${provider}'.`) +
        `\n  Built-in: ${KNOWN_PROVIDERS.map((p) => p.id).join(', ')}` +
        `\n  For other providers, use: mod8 add-provider`
    );
    process.exit(1);
  }
  const key = await readSecret(`Enter API key for ${tpl.name}: `);
  if (!key.trim()) {
    console.error(chalk.red('No key entered. Aborted.'));
    process.exit(1);
  }
  await setProviderKey(provider, key.trim());
  console.log(chalk.green('✓') + ` Saved key for ${tpl.name}`);
  console.log(
    chalk.dim(`  Stored at ${PROVIDERS_FILE_PATH} (file is 0600, only readable by you)`)
  );
}

export async function keysList(): Promise<void> {
  const stored = await listProviders();
  console.log();

  // Show every built-in provider — configured or not — plus any custom ones.
  const seen = new Set<string>();
  for (const tpl of KNOWN_PROVIDERS) {
    seen.add(tpl.id);
    const entry = stored[tpl.id];
    const value = entry ? chalk.dim(maskKey(entry.apiKey)) : chalk.dim('(not set)');
    console.log(`  ${tpl.id.padEnd(12)} ${value.padEnd(24)} ${chalk.dim(tpl.name)}`);
  }
  for (const [id, entry] of Object.entries(stored)) {
    if (seen.has(id)) continue;
    console.log(
      `  ${id.padEnd(12)} ${chalk.dim(maskKey(entry.apiKey)).padEnd(24)} ${chalk.dim(entry.name)} ${chalk.dim('(custom)')}`
    );
  }

  console.log();
  console.log(chalk.dim(`Stored at ${PROVIDERS_FILE_PATH}`));
}

export async function keysRemove(provider: string): Promise<void> {
  const stored = await listProviders();
  if (!(provider in stored) && !templateById(provider)) {
    console.error(
      chalk.red(`Unknown provider '${provider}'.`) +
        `\n  Built-in: ${KNOWN_PROVIDERS.map((p) => p.id).join(', ')}`
    );
    process.exit(1);
  }
  const removed = await removeProvider(provider);
  if (removed) {
    console.log(chalk.green('✓') + ` Removed key for ${provider}`);
  } else {
    console.log(chalk.dim(`No key was set for ${provider}.`));
  }
}
