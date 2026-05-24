/**
 * Per-product events.jsonl writer + reader.
 *
 * Events are the loop's observable surface: `mod8 loop status` reads
 * the tail to summarize current state, `mod8 loop logs` streams them.
 * Append-only with rotate-at-byte-cap (same pattern as
 * storage/routingLog.ts and storage/crashLog.ts).
 *
 * Best-effort writes — an event write failure must NEVER block a
 * phase from completing.  The audit log (loop/audit.ts) is the
 * stronger surface for compliance; events.jsonl is the operational
 * feed.
 */

import { promises as fs } from 'node:fs';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { productFiles } from '../memory/paths.js';
import type { PhaseEvent, PhaseId, ProductContext } from './types.js';

const MAX_BYTES = 512 * 1024;

/** Append one PhaseEvent.  Async + best-effort. */
export async function append(ctx: ProductContext, event: Omit<PhaseEvent, 'schemaVersion' | 'ts' | 'tickId' | 'productSlug'>): Promise<void> {
  const full: PhaseEvent = {
    schemaVersion: 1,
    ts: Date.now(),
    tickId: ctx.tickId,
    productSlug: ctx.slug,
    ...event,
  };
  const path = productFiles.events(ctx);
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.appendFile(path, JSON.stringify(full) + '\n', { mode: 0o600 });
    rotateIfNeeded(path);
  } catch {
    /* never block a phase on event-log failure */
  }
}

/** Sync variant for crash-adjacent emits (analogous to crashLog's
 *  appendFileSync pattern).  Use when the process may be about to
 *  exit. */
export function appendSync(ctx: ProductContext, event: Omit<PhaseEvent, 'schemaVersion' | 'ts' | 'tickId' | 'productSlug'>): void {
  const full: PhaseEvent = {
    schemaVersion: 1,
    ts: Date.now(),
    tickId: ctx.tickId,
    productSlug: ctx.slug,
    ...event,
  };
  const path = productFiles.events(ctx);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(full) + '\n', { mode: 0o600 });
    rotateIfNeeded(path);
  } catch { /* best-effort */ }
}

/** Tail the last N events.  Used by `mod8 loop logs` and `mod8 loop
 *  status`.  Skips malformed lines silently — never throws on a
 *  corrupted entry, since the operational log is supposed to keep
 *  working under partial-failure conditions. */
export async function readTail(ctx: ProductContext, n: number): Promise<PhaseEvent[]> {
  const path = productFiles.events(ctx);
  if (!existsSync(path)) return [];
  const buf = await fs.readFile(path, 'utf8');
  const lines = buf.split('\n').filter((l) => l.trim());
  const slice = lines.slice(-n);
  const out: PhaseEvent[] = [];
  for (const l of slice) {
    try { out.push(JSON.parse(l) as PhaseEvent); } catch { /* skip */ }
  }
  return out;
}

/** Filter helper for `mod8 loop status` — returns the most-recent
 *  event for the given phase, or undefined. */
export async function lastEventFor(ctx: ProductContext, phase: PhaseId): Promise<PhaseEvent | undefined> {
  // Read in chunks from the tail.  Phase 1 sense events are small;
  // 200 lines is plenty to find the last of any given phase.
  const tail = await readTail(ctx, 200);
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.phase === phase) return tail[i];
  }
  return undefined;
}

function rotateIfNeeded(path: string): void {
  try {
    const st = statSync(path);
    if (st.size <= MAX_BYTES) return;
    const buf = readFileSync(path, 'utf8');
    const half = buf.slice(Math.floor(buf.length / 2));
    const trimmed = half.slice(half.indexOf('\n') + 1);
    writeFileSync(path, trimmed, { mode: 0o600 });
  } catch { /* best-effort */ }
}
