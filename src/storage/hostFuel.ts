/**
 * Remembers which tank mod8's voice last drank from, so the invisible
 * failover costs one walk down the ladder — not one per session.
 *
 * Without this, a user whose brand account is dry pays a silent retry (or
 * three) on the first message of every single session.  Invisible is not the
 * same as free: the user still waits.  So a tank that answers is remembered,
 * and a tank that reports it can't pay is skipped for a cooloff — long enough
 * to stop re-probing all day, short enough that a top-up is noticed on its own
 * without anyone having to run a command.
 *
 * Deliberately NOT a cache of anything secret: provider ids and timestamps
 * only.  Corrupt or unreadable state is treated as "no memory" — the ladder
 * still works, it just walks again.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8');
const FUEL_FILE = join(CONFIG_DIR, 'host-fuel.json');

/** How long a tank that said "I can't pay" is skipped before we re-probe. */
export const DRY_COOLOFF_MS = 60 * 60 * 1000; // 1 hour

interface FuelState {
  /** Provider id that last answered a host turn. */
  lastGood?: string;
  /** providerId → epoch ms when it reported it couldn't pay. */
  dry?: Record<string, number>;
}

async function read(): Promise<FuelState> {
  try {
    const raw = await readFile(FUEL_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as FuelState;
  } catch {
    return {};
  }
}

async function write(state: FuelState): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(FUEL_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    /* remembering is an optimization — never fail a turn over it */
  }
}

/** Provider id that last answered, if any. */
export async function lastGoodFuel(): Promise<string | undefined> {
  return (await read()).lastGood;
}

/** Provider ids still inside their dry cooloff. */
export async function dryFuelIds(now = Date.now()): Promise<string[]> {
  const { dry = {} } = await read();
  return Object.entries(dry)
    .filter(([, ts]) => now - ts < DRY_COOLOFF_MS)
    .map(([id]) => id);
}

/** This tank answered — start here next time. */
export async function markFuelGood(providerId: string): Promise<void> {
  const state = await read();
  if (state.dry) delete state.dry[providerId];
  state.lastGood = providerId;
  await write(state);
}

/** This tank said it can't pay — skip it until the cooloff expires. */
export async function markFuelDry(providerId: string, now = Date.now()): Promise<void> {
  const state = await read();
  state.dry = { ...(state.dry ?? {}), [providerId]: now };
  if (state.lastGood === providerId) delete state.lastGood;
  await write(state);
}

/** Test seam / `mod8 dev:host-route --reset`. */
export async function clearFuelMemory(): Promise<void> {
  await write({});
}

export const HOST_FUEL_PATH = FUEL_FILE;
