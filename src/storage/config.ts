import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface Config {
  /** Provider id used by default for one-shot prompts. Any built-in or custom id. */
  default?: string;
  allConsent?: boolean;
}

async function readConfigFile(): Promise<Config> {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Config;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function writeConfigFile(config: Config): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(CONFIG_FILE, 0o600);
}

export async function getConfig(): Promise<Config> {
  return readConfigFile();
}

export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  const current = await readConfigFile();
  const next = { ...current, ...patch };
  await writeConfigFile(next);
  return next;
}

export const CONFIG_FILE_PATH = CONFIG_FILE;
