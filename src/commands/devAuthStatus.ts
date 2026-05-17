/**
 * `mod8 dev:auth-status` — print the resolved routing decision the CLI
 * would make right now: which auth.json (if any) is loaded + which
 * provider ids would route through the proxy.
 *
 * Pure (no network).  Used by the login behavioral spec to verify the
 * auth.json round-trip + provider-routing predicate without spinning up
 * the proxy.
 */

import { readAuth, AUTH_FILE_PATH } from '../storage/auth.js';
import { toProxyProviderId } from '../providers/proxy.js';

const PROBE_IDS = ['anthropic', 'openai', 'google', 'deepseek', 'mistral', 'custom-foo'];

export async function devAuthStatus(): Promise<void> {
  const auth = await readAuth();
  process.stdout.write(`authFile=${AUTH_FILE_PATH}\n`);
  if (!auth) {
    process.stdout.write('authed=false\n');
    process.stdout.write('mode=local\n');
    return;
  }
  // Mask the key — never echo a full secret, same rule as the rest of the CLI.
  const masked =
    auth.mod8Key.length > 16
      ? auth.mod8Key.slice(0, 12) + '…' + auth.mod8Key.slice(-4)
      : auth.mod8Key.slice(0, 12) + '…';
  process.stdout.write('authed=true\n');
  process.stdout.write('mode=proxy\n');
  process.stdout.write(`email=${auth.email ?? '-'}\n`);
  process.stdout.write(`proxyUrl=${auth.proxyUrl}\n`);
  process.stdout.write(`keyMasked=${masked}\n`);
  for (const id of PROBE_IDS) {
    const proxied = toProxyProviderId(id) !== null;
    process.stdout.write(`route id=${id} proxy=${proxied}\n`);
  }
}
