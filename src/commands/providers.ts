/**
 * `mod8 providers` — list configured providers (id, name, color, model, base URL).
 *
 * Different from `mod8 keys list`:
 *   - `keys list` shows every built-in slot + key state (set / not set)
 *   - `providers` shows only what the user has actually configured, with the
 *     details mod8 will use at call time (model, base URL, color)
 */

import chalk from 'chalk';
import { listProviders, PROVIDERS_FILE_PATH } from '../storage/providers.js';

export async function listProvidersCommand(): Promise<void> {
  const stored = await listProviders();
  const entries = Object.entries(stored);
  console.log();
  if (entries.length === 0) {
    console.log(chalk.dim('  no providers configured yet.'));
    console.log(chalk.dim('  add one with: mod8 add-provider'));
    console.log(chalk.dim('  or for a built-in: mod8 keys set <provider>'));
    console.log();
    return;
  }
  for (const [id, e] of entries) {
    const dot = chalk.hex(e.color)('●');
    const tag = e.custom ? chalk.dim(' (custom)') : '';
    const base = e.baseUrl ? chalk.dim(`  ${e.baseUrl}`) : '';
    console.log(
      `  ${dot} ${chalk.bold(id.padEnd(12))} ${chalk.dim(e.name)} · ${chalk.dim(e.apiType)} · ${chalk.dim(e.defaultModel)}${tag}${base}`
    );
  }
  console.log();
  console.log(chalk.dim(`  ${entries.length} provider${entries.length === 1 ? '' : 's'} · stored at ${PROVIDERS_FILE_PATH}`));
}
