/**
 * Per-source feedback corpora at
 * products/<slug>/memory/feedback/<source>.jsonl.
 *
 * One JSONL file per adapter that contributes signals.  Append-only
 * with dedupe-by-digest — adapters may re-poll an overlapping window
 * and we drop duplicates rather than re-appending.  Rotation uses the
 * same byte-cap pattern as routingLog/crashLog but at 1 MB per source
 * (feedback corpora are the durable record of customer signal — we
 * keep more history than the operational logs).
 *
 * Phase 1 source: `inbox-folder` (`~/.config/mod8/products/<slug>/inbox/*`
 * — any file the user drops in becomes a signal; mod8 reads + archives
 * to `memory/feedback/inbox-folder.jsonl`).  Phase 1 also wires
 * `github` issues via the github adapter.  Phase 4 adds the rest.
 */

import { promises as fs } from 'node:fs';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { productFiles, productPath } from './paths.js';
import type { ProductContext, Signal } from '../loop/types.js';

const MAX_BYTES = 1024 * 1024;

/** Append a batch of signals to the named source.  Returns how many
 *  were actually new (after digest-dedupe).  Caller passes pre-built
 *  Signal objects so dedupe sees a stable digest. */
export async function append(ctx: ProductContext, source: string, signals: Signal[]): Promise<number> {
  if (signals.length === 0) return 0;
  const path = productFiles.feedbackJsonl(ctx, source);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await readDigests(path);
  let appended = 0;
  for (const s of signals) {
    if (existing.has(s.digest)) continue;
    try {
      await fs.appendFile(path, JSON.stringify(s) + '\n', { mode: 0o600 });
      existing.add(s.digest);
      appended++;
    } catch {
      /* skip individual failed write; don't fail the whole batch */
    }
  }
  rotateIfNeeded(path);
  return appended;
}

/** Read all signals for a given source, newest first. */
export async function readAll(ctx: ProductContext, source: string, limit?: number): Promise<Signal[]> {
  const path = productFiles.feedbackJsonl(ctx, source);
  if (!existsSync(path)) return [];
  const buf = await fs.readFile(path, 'utf8');
  const out: Signal[] = [];
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as Signal); } catch { /* skip */ }
  }
  out.sort((a, b) => b.ts - a.ts);
  return limit ? out.slice(0, limit) : out;
}

/** Per-source signal count.  Cheap — used by `mod8 loop status` to
 *  build the `countsBySource` summary line. */
export async function countAll(ctx: ProductContext, source: string): Promise<number> {
  const path = productFiles.feedbackJsonl(ctx, source);
  if (!existsSync(path)) return 0;
  try {
    const buf = await fs.readFile(path, 'utf8');
    return buf.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** Drain the inbox folder — any file at
 *  products/<slug>/inbox/*.{md,txt,json} becomes one Signal,
 *  appended to `inbox-folder.jsonl`, then deleted from the inbox.
 *  Lets the user (or external scripts) drop feedback into the loop
 *  without writing an adapter.
 *
 *  Returns the count of signals ingested. */
export async function drainInbox(ctx: ProductContext): Promise<number> {
  const inboxDir = productPath(ctx, 'inbox');
  if (!existsSync(inboxDir)) return 0;
  let entries: string[];
  try {
    entries = await fs.readdir(inboxDir);
  } catch {
    return 0;
  }
  const signals: Signal[] = [];
  const toDelete: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = productPath(ctx, 'inbox', name);
    try {
      const buf = await fs.readFile(full, 'utf8');
      const ts = (await fs.stat(full)).mtimeMs;
      signals.push({
        schemaVersion: 1,
        source: 'inbox-folder',
        digest: digestFor('inbox-folder', name, buf),
        ts,
        kind: 'inbox-folder.file',
        title: name,
        body: buf.slice(0, 16 * 1024),
      });
      toDelete.push(full);
    } catch { /* skip unreadable */ }
  }
  const appended = await append(ctx, 'inbox-folder', signals);
  for (const p of toDelete) {
    try { await fs.unlink(p); } catch { /* tolerate */ }
  }
  return appended;
}

async function readDigests(path: string): Promise<Set<string>> {
  if (!existsSync(path)) return new Set();
  const out = new Set<string>();
  try {
    const buf = await fs.readFile(path, 'utf8');
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as Signal;
        if (s.digest) out.add(s.digest);
      } catch { /* skip */ }
    }
  } catch { /* tolerate */ }
  return out;
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

/** Cheap non-cryptographic FNV-1a hash → 8 hex digits.  Same shape
 *  as storage/routingLog.ts::digest.  Combine source + key + body
 *  prefix so re-polling identical content dedupes cleanly. */
function digestFor(source: string, key: string, body: string): string {
  const input = `${source}:${key}:${body.slice(0, 512)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
