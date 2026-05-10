/**
 * `mod8 dev:host-system` — print the host system prompt as it would be
 * assembled RIGHT NOW (with current providers.json state).  No LLM call.
 *
 * Behavioral specs use this to verify the host-self-knowledge fix: after a
 * provider is added mid-session via the inline paste-key flow, the next
 * host turn rebuilds the system prompt with the new provider visible —
 * not the stale snapshot taken at chat startup.
 */

import { readHostContext, buildHostSystem } from '../providers/hostSystem.js';

export async function devHostSystem(): Promise<void> {
  const ctx = await readHostContext();
  process.stdout.write(buildHostSystem(ctx));
  process.stdout.write('\n');
}
