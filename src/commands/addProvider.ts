/**
 * `mod8 add-provider` — interactive flow:
 *   1. Paste API key.
 *   2. mod8 detects format from prefix → suggests built-in template if it knows.
 *   3. User confirms / edits id, display name, base URL, default model.
 *   4. Provider is saved to providers.json with an auto-assigned palette color.
 *
 * Mostly used for non-built-in providers, but also works as a faster path for
 * registering a known one (no need to remember the exact id).
 */

import chalk from 'chalk';
import { readSecret, readLine, maskKey } from '../util/prompt.js';
import { detectFromKey, isValidProviderId, type ApiType } from '../providers/registry.js';
import {
  setProvider,
  nextPaletteColor,
  PROVIDERS_FILE_PATH,
  type ProviderEntry,
} from '../storage/providers.js';

const API_TYPES: ApiType[] = ['anthropic', 'openai-compat', 'gemini'];

function isApiType(s: string): s is ApiType {
  return (API_TYPES as string[]).includes(s);
}

export async function addProviderCommand(): Promise<void> {
  console.log();
  console.log(chalk.bold('mod8 add-provider'));
  console.log(chalk.dim('  Paste an API key. mod8 will detect the format and ask anything it can\'t guess.'));
  console.log();

  const key = (await readSecret('paste key: ')).trim();
  if (!key) {
    console.error(chalk.red('No key entered. Aborted.'));
    process.exit(1);
  }

  const tpl = detectFromKey(key);
  if (tpl) {
    console.log();
    console.log(
      chalk.green('✓') +
        ` Looks like ${chalk.bold(tpl.name)} (${tpl.id}, ${tpl.apiType}).`
    );
  } else {
    console.log();
    console.log(
      chalk.yellow('?') + ` Haven\'t seen this key format before. Tell me about the provider.`
    );
  }

  const id = await promptId(tpl?.id);
  const name = await readLine(
    `display name [${tpl?.name ?? id}]: `,
    tpl?.name ?? id
  );
  const apiType = await promptApiType(tpl?.apiType);
  const baseUrl = await promptBaseUrl(apiType, tpl?.baseUrl);
  const defaultModel = await readLine(
    `default model [${tpl?.defaultModel ?? ''}]: `,
    tpl?.defaultModel ?? ''
  );
  if (!defaultModel) {
    console.error(chalk.red('A default model is required (e.g. "deepseek-chat").'));
    process.exit(1);
  }

  const color = tpl?.color ?? (await nextPaletteColor());

  const entry: ProviderEntry = {
    apiKey: key,
    apiType,
    name,
    defaultModel,
    color,
    custom: !tpl,
  };
  if (baseUrl) entry.baseUrl = baseUrl;

  await setProvider(id, entry);
  console.log();
  console.log(
    chalk.green('✓') +
      ` Saved ${chalk.bold(name)} (${id}) — key ${chalk.dim(maskKey(key))}, color ${chalk.hex(color)('●')}`
  );
  console.log(chalk.dim(`  Stored at ${PROVIDERS_FILE_PATH} (mode 0600)`));
  console.log();
  console.log(chalk.dim(`  Use it: mod8 -c (or any flag) → not yet; in chat: "ask ${id}" / "use ${id}"`));
}

async function promptId(suggested?: string): Promise<string> {
  while (true) {
    const id = await readLine(
      `provider id [${suggested ?? 'lowercase, e.g. "deepseek"'}]: `,
      suggested ?? ''
    );
    if (!id) {
      console.error(chalk.red('  id required (lowercase, letters/digits/dash/underscore).'));
      continue;
    }
    if (!isValidProviderId(id)) {
      console.error(
        chalk.red('  invalid id — use lowercase letters, digits, dash, underscore (max 30 chars).')
      );
      continue;
    }
    return id;
  }
}

async function promptApiType(suggested?: ApiType): Promise<ApiType> {
  const fallback = suggested ?? 'openai-compat';
  while (true) {
    const v = await readLine(
      `api type (anthropic | openai-compat | gemini) [${fallback}]: `,
      fallback
    );
    if (isApiType(v)) return v;
    console.error(chalk.red(`  must be one of: ${API_TYPES.join(', ')}.`));
  }
}

async function promptBaseUrl(apiType: ApiType, suggested?: string): Promise<string | undefined> {
  if (apiType === 'anthropic' || apiType === 'gemini') return undefined;
  while (true) {
    const v = await readLine(
      `base URL [${suggested ?? 'https://api.example.com/v1'}]: `,
      suggested ?? ''
    );
    if (!v) {
      console.error(chalk.red('  base URL is required for openai-compat providers.'));
      continue;
    }
    if (!/^https?:\/\//.test(v)) {
      console.error(chalk.red('  must be http(s):// URL.'));
      continue;
    }
    return v;
  }
}
