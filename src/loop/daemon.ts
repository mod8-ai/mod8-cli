/**
 * mod8 loop daemon — long-running tick loop that wraps tick.ts on a
 * schedule.  Phase 2 lifecycle: start writes a PID file, runs ticks
 * at the configured cadence, handles SIGTERM/SIGINT for graceful
 * shutdown, recovers in-flight worktrees on restart.
 *
 * Same tick body as cron-driven `mod8 loop tick` — the daemon is
 * purely a lifecycle layer.
 */

import { promises as fs } from 'node:fs';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { GLOBAL_PATHS, buildProductContext } from '../memory/paths.js';
import * as worktree from './worktree.js';
import { tick } from './tick.js';
import { loadPolicy, PolicyMissing } from './policy.js';
import * as kill from './kill.js';
import * as events from './events.js';
import * as audit from './audit.js';

export interface DaemonOptions {
  slug: string;
  repoRoot: string;
  /** Override scheduling interval (default: derived from policy.cadence.sense_every_minutes). */
  intervalMs?: number;
  /** When true, daemon detaches via process.disown — used by
   *  `mod8 loop start` so the caller exits while daemon keeps running. */
  detach?: boolean;
}

/** Read the PID file.  Returns null if absent or unreadable. */
export async function readPid(): Promise<number | null> {
  if (!existsSync(GLOBAL_PATHS.daemonPid)) return null;
  try {
    const buf = await fs.readFile(GLOBAL_PATHS.daemonPid, 'utf8');
    const pid = parseInt(buf.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

/** Is the recorded PID still alive? */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

/** Start the daemon in the current process.  Blocks until SIGTERM or
 *  SIGINT.  Caller (mod8 loop start) handles detach. */
export async function startInline(opts: DaemonOptions): Promise<void> {
  await ensurePidDir();

  // Refuse if a live daemon already exists.
  const existing = await readPid();
  if (existing && isPidAlive(existing)) {
    throw new Error(`daemon already running (pid ${existing}). use \`mod8 loop stop\` first.`);
  }
  // Stale PID file — clean it up.
  if (existing && !isPidAlive(existing)) {
    try { unlinkSync(GLOBAL_PATHS.daemonPid); } catch { /* tolerate */ }
  }

  writeFileSync(GLOBAL_PATHS.daemonPid, `${process.pid}\n`, { mode: 0o600 });

  // Crash recovery: clean up stale worktrees, mark crashed builds as
  // aborted-crash.  Best-effort.
  try {
    const ctx = buildProductContext(opts.slug, opts.repoRoot, 0);
    const r = await worktree.cleanupStale(ctx);
    if (r.cleanedUp > 0 || r.orphans > 0) {
      await events.append(ctx, {
        phase: 'sense',
        kind: 'start',
        payload: { daemon: 'startup-cleanup', cleanedUp: r.cleanedUp, orphans: r.orphans },
      });
    }
    await audit.append(ctx, 'daemon.start', { pid: process.pid, ...r });
  } catch { /* tolerate startup-cleanup failures */ }

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`mod8 loop: stopping (${signal})\n`);
    try { unlinkSync(GLOBAL_PATHS.daemonPid); } catch { /* tolerate */ }
    void (async () => {
      try {
        const ctx = buildProductContext(opts.slug, opts.repoRoot, 0);
        await audit.append(ctx, 'daemon.stop', { pid: process.pid, signal });
      } catch { /* tolerate */ }
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // Derive interval from policy if not overridden.
  const intervalMs = opts.intervalMs ?? await deriveIntervalMs(opts);

  // First tick immediately, then every intervalMs.
  // eslint-disable-next-line no-constant-condition
  while (!stopping) {
    if (kill.check().active) {
      // Sleep the full interval; check again on wake.
      await sleep(intervalMs);
      continue;
    }
    try {
      await tick({ slug: opts.slug, repoRoot: opts.repoRoot });
    } catch (err) {
      // tick.ts catches its own errors; this is for catastrophic
      // failures (e.g. policy load throwing PolicyMissing).
      process.stderr.write(`mod8 loop tick (daemon) error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    await sleep(intervalMs);
  }
}

async function deriveIntervalMs(opts: DaemonOptions): Promise<number> {
  try {
    const ctx = buildProductContext(opts.slug, opts.repoRoot, 0);
    const policy = await loadPolicy(ctx);
    // Use sense cadence as the tick interval; it's the most frequent.
    return policy.cadence.sense_every_minutes * 60 * 1000;
  } catch (err) {
    if (err instanceof PolicyMissing) throw err;
    return 60 * 60 * 1000; // 1h fallback
  }
}

async function ensurePidDir(): Promise<void> {
  await fs.mkdir(dirname(GLOBAL_PATHS.daemonPid), { recursive: true, mode: 0o700 });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** Send SIGTERM to the daemon.  Returns whether it was killed. */
export async function stopRunning(): Promise<{ stopped: boolean; pid: number | null }> {
  const pid = await readPid();
  if (!pid) return { stopped: false, pid: null };
  if (!isPidAlive(pid)) {
    try { unlinkSync(GLOBAL_PATHS.daemonPid); } catch { /* tolerate */ }
    return { stopped: false, pid };
  }
  try {
    process.kill(pid, 'SIGTERM');
    return { stopped: true, pid };
  } catch {
    return { stopped: false, pid };
  }
}
