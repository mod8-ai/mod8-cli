/**
 * Append-only crash log at `~/.config/mod8/crashes.log`.  Installed once
 * at CLI startup via `installCrashHandlers()` to catch
 * uncaughtException + unhandledRejection.  Read by the `/diagnose`
 * command so users can paste the last few crashes into a support
 * thread without sharing keys.
 *
 * Best-effort writes only — a failure to log must NEVER mask the
 * original crash.
 */

import { promises as fs } from 'node:fs';
import { writeFileSync, appendFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8');
const LOG_FILE = join(CONFIG_DIR, 'crashes.log');
const MAX_BYTES = 128 * 1024;

export interface CrashEntry {
  ts: number;
  kind: 'uncaughtException' | 'unhandledRejection' | 'manual';
  message: string;
  stack?: string;
  context?: string;
}

/** Synchronous log write so a crash that's about to exit the process
 *  still gets persisted.  Async fs.appendFile would race the exit. */
export function logCrashSync(entry: CrashEntry): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(LOG_FILE, line, { mode: 0o600 });
    try {
      const st = statSync(LOG_FILE);
      if (st.size > MAX_BYTES) {
        const buf = readFileSync(LOG_FILE, 'utf8');
        const half = buf.slice(Math.floor(buf.length / 2));
        const trimmed = half.slice(half.indexOf('\n') + 1);
        writeFileSync(LOG_FILE, trimmed, { mode: 0o600 });
      }
    } catch { /* rotation best-effort */ }
  } catch { /* never block a crash */ }
}

export async function readRecentCrashes(n = 5): Promise<CrashEntry[]> {
  try {
    const buf = await fs.readFile(LOG_FILE, 'utf8');
    const lines = buf.split('\n').filter((l) => l.trim());
    const out: CrashEntry[] = [];
    for (const l of lines.slice(-n)) {
      try { out.push(JSON.parse(l) as CrashEntry); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Install global crash handlers.  Call once at CLI entry. */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    logCrashSync({
      ts: Date.now(),
      kind: 'uncaughtException',
      message: err.message,
      stack: err.stack,
    });
    // Preserve default Node behavior: print + exit non-zero.
    // eslint-disable-next-line no-console
    console.error('mod8: uncaught exception —', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logCrashSync({
      ts: Date.now(),
      kind: 'unhandledRejection',
      message: err.message,
      stack: err.stack,
    });
    // eslint-disable-next-line no-console
    console.error('mod8: unhandled rejection —', err);
    process.exit(1);
  });
}

export const CRASH_LOG_PATH = LOG_FILE;
