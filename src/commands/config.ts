import chalk from 'chalk';
import { getConfig, updateConfig, CONFIG_FILE_PATH } from '../storage/config.js';
import { KNOWN_PROVIDERS } from '../providers/registry.js';
import { isKnownOrConfigured } from '../storage/providers.js';

export async function configGet(): Promise<void> {
  const config = await getConfig();
  const defaultStr = config.default ?? 'anthropic';
  const defaultSource = config.default ? 'configured' : 'fallback';
  const consentStr = config.allConsent ? 'given' : 'not yet (first --all will prompt)';

  console.log();
  console.log(`  default:  ${chalk.bold(defaultStr)} ${chalk.dim(`(${defaultSource})`)}`);
  console.log(`  consent:  ${chalk.dim(consentStr)}`);
  console.log();
  console.log(chalk.dim(`Stored at ${CONFIG_FILE_PATH}`));
}

export async function configSet(key: string, value: string): Promise<void> {
  if (key !== 'default') {
    console.error(chalk.red(`Unknown config key '${key}'.`) + ' Available keys: default.');
    process.exit(1);
  }
  if (!(await isKnownOrConfigured(value))) {
    const known = KNOWN_PROVIDERS.map((p) => p.id).join(', ');
    console.error(
      chalk.red(`Unknown provider '${value}'.`) +
        ` Built-in: ${known}.\n  Or configure a custom one first: mod8 add-provider`
    );
    process.exit(1);
  }
  await updateConfig({ default: value });
  console.log(chalk.green('✓') + ` Default provider set to ${value}`);
}
