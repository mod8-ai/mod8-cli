/**
 * mod8 auth.json — credentials for the mod8-hosted proxy.
 *
 *   ~/.config/mod8/auth.json:
 *     {
 *       "mod8Key":  "sk-mod8-...",     // bearer token for proxy
 *       "proxyUrl": "https://...",     // base URL (override w/ MOD8_PROXY_URL)
 *       "email":    "you@example.com"  // shown in startup banner
 *     }
 *
 * When this file exists, the CLI routes every request through the proxy
 * instead of the user's local providers.json.  When it's absent, the CLI
 * uses the BYOK local providers (current behavior).
 *
 * File mode 0600 — same as providers.json + config.json.
 */

import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const DEFAULT_PROXY_URL = 'https://mod8-proxy-6jnzdar4rq-uc.a.run.app';

const CONFIG_DIR = process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8');
const AUTH_FILE = join(CONFIG_DIR, 'auth.json');

export interface AuthData {
  mod8Key: string;
  proxyUrl: string;
  email?: string;
}

export async function readAuth(): Promise<AuthData | null> {
  try {
    const raw = await fs.readFile(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.mod8Key !== 'string') return null;
    return {
      mod8Key: parsed.mod8Key,
      proxyUrl:
        typeof parsed.proxyUrl === 'string' && parsed.proxyUrl
          ? parsed.proxyUrl
          : DEFAULT_PROXY_URL,
      ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeAuth(data: AuthData): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(AUTH_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(AUTH_FILE, 0o600);
}

export async function deleteAuth(): Promise<boolean> {
  try {
    await fs.unlink(AUTH_FILE);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Resolve the proxy URL: env override > auth.json > default. */
export function effectiveProxyUrl(auth: AuthData | null): string {
  if (process.env.MOD8_PROXY_URL) return process.env.MOD8_PROXY_URL;
  return auth?.proxyUrl ?? DEFAULT_PROXY_URL;
}

export const AUTH_FILE_PATH = AUTH_FILE;
