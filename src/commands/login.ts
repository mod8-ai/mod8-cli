/**
 * `mod8 login` — bridge the CLI to the mod8 hosted product.
 *
 *   1. Open the user's browser to https://mod8-web/cli-login (or whatever
 *      MOD8_LOGIN_URL points at — overridable for staging).
 *   2. Prompt the terminal for the sk-mod8-... key they copy from that page.
 *   3. Validate by calling /v1/chat with a dry-ping… actually just smoke
 *      against the proxy with a 1-token request to confirm shape + balance.
 *   4. Save ~/.config/mod8/auth.json with mode 0600.
 *
 * No callback URL handshake (yet) — paste keeps things deterministic across
 * shells and avoids spawning a local listener.
 */

import chalk from 'chalk';
import { createInterface } from 'readline';
import { exec } from 'child_process';
import { platform } from 'os';
import {
  writeAuth,
  readAuth,
  DEFAULT_PROXY_URL,
  AUTH_FILE_PATH,
} from '../storage/auth.js';

const DEFAULT_LOGIN_URL = 'https://mod8-495901.web.app/cli-login';

interface ProxyMeResponse {
  email?: string;
  availableMicros?: number;
}

export async function loginCommand(): Promise<void> {
  const loginUrl = process.env.MOD8_LOGIN_URL ?? DEFAULT_LOGIN_URL;
  const proxyUrl = process.env.MOD8_PROXY_URL ?? DEFAULT_PROXY_URL;

  const existing = await readAuth();
  if (existing) {
    process.stderr.write(
      chalk.yellow(
        `Already logged in${existing.email ? ` as ${existing.email}` : ''}. ` +
          `Use \`mod8 logout\` to drop credentials first if you want to re-link.\n`
      )
    );
    return;
  }

  process.stdout.write('\n');
  process.stdout.write(chalk.bold('Connect your terminal to mod8\n'));
  process.stdout.write(chalk.dim(`Opening ${loginUrl} …\n\n`));

  // Best-effort browser open.  If it fails, the user sees the URL and can
  // copy it manually — the paste-key path still works.
  openBrowserBestEffort(loginUrl);

  process.stdout.write(`If it didn't open, visit:  ${chalk.cyan(loginUrl)}\n\n`);
  process.stdout.write(`Then paste your CLI key here (starts with ${chalk.bold('sk-mod8-')}):\n`);

  const key = await readLine('> ');
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error('No key entered.');
  }
  if (!trimmed.startsWith('sk-mod8-')) {
    throw new Error(`That doesn't look like a mod8 key (expected sk-mod8-...).`);
  }

  // Sanity-ping the proxy with a tiny request — confirms the key is real
  // AND lets us echo the email + balance back to the user immediately.
  const meta = await pingProxy(proxyUrl, trimmed);

  await writeAuth({
    mod8Key: trimmed,
    proxyUrl,
    ...(meta.email ? { email: meta.email } : {}),
  });

  process.stdout.write(
    `\n${chalk.green('✓')} Saved to ${chalk.dim(AUTH_FILE_PATH)}\n` +
      `${chalk.green('✓')} Logged in${meta.email ? ` as ${chalk.bold(meta.email)}` : ''}` +
      (typeof meta.availableMicros === 'number'
        ? ` — ${chalk.bold(formatUsd(meta.availableMicros))} balance`
        : '') +
      '\n\n' +
      chalk.dim('Try it:  ') +
      chalk.cyan('mod8 -c "hi from the proxy"') +
      '\n'
  );
}

function openBrowserBestEffort(url: string): void {
  const cmd =
    platform() === 'darwin'
      ? `open ${shellQuote(url)}`
      : platform() === 'win32'
        ? `start "" ${shellQuote(url)}`
        : `xdg-open ${shellQuote(url)}`;
  exec(cmd, () => {
    // Silently ignore — terminal-only environments will rely on the printed URL.
  });
}

function shellQuote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

async function readLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (line) => {
      rl.close();
      resolve(line);
    });
    rl.on('error', reject);
  });
}

/**
 * Sanity-check + metadata fetch.  We don't have a "whoami" endpoint on the
 * proxy itself, so we POST a maxTokens=1 anthropic call.  That:
 *   - validates the bearer token (401 if bad)
 *   - confirms the master key is seeded (500 if not)
 *   - returns chargedMicros + balanceAfterMicros, which we use to print the
 *     balance hint.
 *
 * Cost: a fraction of a cent.  Cheap enough that we eat it for the UX.
 */
async function pingProxy(proxyUrl: string, mod8Key: string): Promise<ProxyMeResponse> {
  const resp = await fetch(`${proxyUrl}/v1/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${mod8Key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      maxTokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    }),
  });
  if (resp.status === 401) throw new Error('Key not recognized by the proxy.');
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Proxy ping failed: ${resp.status} ${detail.slice(0, 160)}`);
  }
  if (!resp.body) return {};
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let availableMicros: number | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'done' && typeof ev.balanceAfterMicros === 'number') {
            availableMicros = ev.balanceAfterMicros;
          }
        } catch {
          // ignore non-JSON
        }
      }
    }
  }
  return availableMicros !== undefined ? { availableMicros } : {};
}

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
