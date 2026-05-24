/**
 * Kill-switch helpers.  Two ways to freeze the loop:
 *   1. Touch the STOP file at ~/.config/mod8/STOP (default path —
 *      overridable per-product via policy.kill_switch_file).
 *   2. Set env MOD8_LOOP_KILL=1 (handy for CI / test fixtures).
 *
 * Every phase entry + every adapter sink call MUST start with
 * `if (kill.check()) return killSwitchEvent(...);` — there's no
 * decorator or registry that enforces this; the rule is "1 line at
 * the top of every callable that can do something the user might want
 * to halt."
 *
 * The check is synchronous + cheap (just an existsSync) so the
 * overhead is irrelevant compared to the upside of being able to
 * freeze a misbehaving loop in one keystroke (`touch
 * ~/.config/mod8/STOP`).
 */

import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { GLOBAL_PATHS } from '../memory/paths.js';
import type { PolicyConfig } from './types.js';

export interface KillState {
  /** True when the loop should freeze.  Caller is expected to bail
   *  out and emit an audit/event entry. */
  active: boolean;
  /** Human-readable reason for the freeze (file path / env var). */
  reason: string;
}

/** Synchronous check.  Returns inert state when nothing is set so
 *  callers can `if (kill.check().active) return;` cleanly. */
export function check(policy?: Pick<PolicyConfig, 'kill_switch_file'>): KillState {
  if (process.env.MOD8_LOOP_KILL === '1') {
    return { active: true, reason: 'env MOD8_LOOP_KILL=1' };
  }
  const path = policy?.kill_switch_file
    ? expandTilde(policy.kill_switch_file)
    : GLOBAL_PATHS.killSwitch;
  if (existsSync(path)) {
    return { active: true, reason: `STOP file present: ${path}` };
  }
  return { active: false, reason: '' };
}

/** Activate the kill switch by creating the STOP file.  Used by
 *  `mod8 loop halt` and the /halt slash command (Phase 2). */
export async function activate(policy?: Pick<PolicyConfig, 'kill_switch_file'>): Promise<string> {
  const path = policy?.kill_switch_file
    ? expandTilde(policy.kill_switch_file)
    : GLOBAL_PATHS.killSwitch;
  await fs.writeFile(path, `created ${new Date().toISOString()}\n`, { mode: 0o600 });
  return path;
}

/** Clear the kill switch by deleting the STOP file.  Idempotent.
 *  Used by `mod8 loop resume` (Phase 2). */
export async function clear(policy?: Pick<PolicyConfig, 'kill_switch_file'>): Promise<void> {
  const path = policy?.kill_switch_file
    ? expandTilde(policy.kill_switch_file)
    : GLOBAL_PATHS.killSwitch;
  try {
    await fs.unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return path.replace(/^~/, process.env.HOME ?? '');
  }
  return path;
}
