import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { Provider } from '../types.js';
import { PROVIDERS } from '../types.js';

const CONFIG_DIR = process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8');
const KEYS_FILE = join(CONFIG_DIR, 'keys.json');

async function readKeysFile(): Promise<Record<string, string>> {
  try {
    const data = await fs.readFile(KEYS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function writeKeysFile(keys: Record<string, string>): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const data = JSON.stringify(keys, null, 2) + '\n';
  await fs.writeFile(KEYS_FILE, data, { mode: 0o600 });
  // chmod explicitly in case the file already existed with looser perms
  await fs.chmod(KEYS_FILE, 0o600);
}

export async function setKey(provider: Provider, key: string): Promise<void> {
  const keys = await readKeysFile();
  keys[provider] = key;
  await writeKeysFile(keys);
}

export async function getKey(provider: Provider): Promise<string | undefined> {
  const keys = await readKeysFile();
  return keys[provider];
}

export async function getAllKeys(): Promise<Record<Provider, string | undefined>> {
  const keys = await readKeysFile();
  const out = {} as Record<Provider, string | undefined>;
  for (const p of PROVIDERS) out[p] = keys[p];
  return out;
}

export async function removeKey(provider: Provider): Promise<boolean> {
  const keys = await readKeysFile();
  if (!(provider in keys)) return false;
  delete keys[provider];
  await writeKeysFile(keys);
  return true;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '*'.repeat(Math.max(key.length, 4));
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export const KEYS_FILE_PATH = KEYS_FILE;
export const CONFIG_DIR_PATH = CONFIG_DIR;
