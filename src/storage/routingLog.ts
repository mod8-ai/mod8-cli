/**
 * Append-only log of every routing decision mod8 makes.  Persisted as
 * JSONL at `~/.config/mod8/routing.jsonl` (overridable via
 * MOD8_CONFIG_DIR).  Powers the `/why` slash command and is the
 * foundation for the "router learns YOU" pitch — without this log the
 * routing claim is unbacked.
 *
 * Each line is one decision.  Append is the only mutation; reads use a
 * tail-from-end pattern to keep cost bounded as the file grows.  We cap
 * the file at MAX_BYTES via a rolling-truncate on append.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8');
const LOG_FILE = join(CONFIG_DIR, 'routing.jsonl');
const MAX_BYTES = 256 * 1024;

export interface RoutingDecision {
  ts: number;
  topic: string;
  picked: string;
  candidates: string[];
  reason: string;
  promptDigest: string;
  /** Whether the pick was personalized from the user's prior choices,
   *  vs. the static curated default.  Drives the "your usual pick" vs
   *  "mod8 default" label in /why. */
  personalized: boolean;
  /** True when this entry records a user override (manual pick or
   *  handoff) AFTER mod8 had already recommended something — strong
   *  signal that the original recommendation was wrong. */
  overrideOf?: string;
}

/** Append one decision.  Best-effort: failures are swallowed so a
 *  routing-log hiccup never blocks a turn. */
export async function appendDecision(d: RoutingDecision): Promise<void> {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const line = JSON.stringify(d) + '\n';
    await fs.appendFile(LOG_FILE, line, { mode: 0o600 });
    // Rotate when file balloons — keep the last ~half by byte count.
    const stat = await fs.stat(LOG_FILE).catch(() => null);
    if (stat && stat.size > MAX_BYTES) {
      const buf = await fs.readFile(LOG_FILE, 'utf8');
      const half = buf.slice(Math.floor(buf.length / 2));
      const trimmed = half.slice(half.indexOf('\n') + 1);
      await fs.writeFile(LOG_FILE, trimmed, { mode: 0o600 });
    }
  } catch {
    /* never block a turn */
  }
}

export async function readRecent(n = 10): Promise<RoutingDecision[]> {
  try {
    const buf = await fs.readFile(LOG_FILE, 'utf8');
    const lines = buf.split('\n').filter((l) => l.trim());
    const slice = lines.slice(-n);
    const out: RoutingDecision[] = [];
    for (const l of slice) {
      try { out.push(JSON.parse(l) as RoutingDecision); } catch { /* skip malformed */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Short opaque digest of a prompt — enough to disambiguate "this same
 *  prompt was routed twice" in /why, without storing the full text in a
 *  plain log file.  First 4 hex bytes of a non-crypto FNV-1a hash. */
export function digest(prompt: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < prompt.length; i++) {
    h ^= prompt.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const ROUTING_LOG_PATH = LOG_FILE;
