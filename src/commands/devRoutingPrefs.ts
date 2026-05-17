/**
 * `mod8 dev:routing-prefs <action> [args]` — exposes the routingPrefs
 * module for behavioral testing.  Drives the same code path the chat
 * UI uses, so the YAML specs can assert against real disk state.
 *
 * Actions:
 *   load                      → print the current prefs as JSON.
 *   record <topic> <provider> → increment (topic, provider) counter.
 *   preferred <topic> [min]   → print preferredProviderFor(topic, min).
 *                               Default min = 2.
 *
 * Stored under $MOD8_CONFIG_DIR/routing-prefs.json so each spec can
 * run in a clean sandbox without touching the real ~/.mod8/.
 */

import {
  loadPrefs,
  recordPick,
  preferredProviderFor,
} from '../agent/routingPrefs.js';

export async function devRoutingPrefs(
  action: string,
  arg1?: string,
  arg2?: string
): Promise<void> {
  if (action === 'load') {
    const prefs = await loadPrefs();
    process.stdout.write(JSON.stringify(prefs) + '\n');
    return;
  }
  if (action === 'record') {
    if (!arg1 || !arg2) {
      process.stderr.write('usage: dev:routing-prefs record <topic> <provider>\n');
      process.exitCode = 2;
      return;
    }
    await recordPick(arg1, arg2);
    const prefs = await loadPrefs();
    process.stdout.write(JSON.stringify(prefs) + '\n');
    return;
  }
  if (action === 'preferred') {
    if (!arg1) {
      process.stderr.write('usage: dev:routing-prefs preferred <topic> [minPicks]\n');
      process.exitCode = 2;
      return;
    }
    const minPicks = arg2 ? Number.parseInt(arg2, 10) : 2;
    const prefs = await loadPrefs();
    const result = preferredProviderFor(prefs, arg1, minPicks);
    process.stdout.write(JSON.stringify({ topic: arg1, preferred: result }) + '\n');
    return;
  }
  process.stderr.write(`unknown action: ${action}\n`);
  process.exitCode = 2;
}
