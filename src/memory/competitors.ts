/**
 * Competitors memory — snapshots of competitor public pages.
 *
 * Per-host markdown snapshots at products/<slug>/memory/competitors/<host>.md
 * with an accompanying index entry per snapshot.  Comparing the
 * latest snapshot against the previous one produces a "competitor
 * shipped X" signal that sense can ingest.
 *
 * Fetching happens via the existing web_fetch surface (HTML→markdown).
 * This module is just the persistence + diff layer.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { productPath } from './paths.js';
import type { ProductContext } from '../loop/types.js';

const DIR = 'memory/competitors';

export interface CompetitorSnapshot {
  schemaVersion: 1;
  host: string;
  url: string;
  ts: number;
  /** sha256 of body — quick "did this change" check before doing a
   *  word-diff. */
  bodyHash: string;
  /** Truncated markdown body — first 32 KB. */
  body: string;
}

export interface CompetitorDiff {
  host: string;
  url: string;
  fromTs: number;
  toTs: number;
  added: string[];
  removed: string[];
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/[^a-z0-9.-]/gi, '_').toLowerCase();
  } catch {
    return 'unknown';
  }
}

export async function record(ctx: ProductContext, url: string, markdownBody: string): Promise<CompetitorSnapshot> {
  const host = safeHost(url);
  const body = markdownBody.slice(0, 32 * 1024);
  const snap: CompetitorSnapshot = {
    schemaVersion: 1,
    host,
    url,
    ts: Date.now(),
    bodyHash: createHash('sha256').update(body).digest('hex'),
    body,
  };
  const dir = productPath(ctx, DIR, host);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const fname = `${snap.ts}.json`;
  await fs.writeFile(join(dir, fname), JSON.stringify(snap), { mode: 0o600 });
  // Index entry (md form, human-readable).
  await fs.writeFile(
    productPath(ctx, DIR, `${host}.md`),
    `# ${host}\n\n${snap.body}\n\n_snapshot ${new Date(snap.ts).toISOString()}_\n`,
    { mode: 0o600 },
  );
  return snap;
}

/** Read the two most-recent snapshots for a host and produce a diff
 *  (line-level added/removed).  Returns null if only one snapshot
 *  exists. */
export async function latestDiff(ctx: ProductContext, host: string): Promise<CompetitorDiff | null> {
  const dir = productPath(ctx, DIR, host);
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch { return null; }
  if (entries.length < 2) return null;
  const latest = entries[entries.length - 1]!;
  const prior = entries[entries.length - 2]!;
  const latestSnap = JSON.parse(await fs.readFile(join(dir, latest), 'utf8')) as CompetitorSnapshot;
  const priorSnap = JSON.parse(await fs.readFile(join(dir, prior), 'utf8')) as CompetitorSnapshot;
  if (latestSnap.bodyHash === priorSnap.bodyHash) {
    return {
      host,
      url: latestSnap.url,
      fromTs: priorSnap.ts,
      toTs: latestSnap.ts,
      added: [],
      removed: [],
    };
  }
  const latestLines = new Set(latestSnap.body.split('\n').map((l) => l.trim()).filter(Boolean));
  const priorLines = new Set(priorSnap.body.split('\n').map((l) => l.trim()).filter(Boolean));
  const added: string[] = [];
  for (const l of latestLines) if (!priorLines.has(l)) added.push(l);
  const removed: string[] = [];
  for (const l of priorLines) if (!latestLines.has(l)) removed.push(l);
  return {
    host,
    url: latestSnap.url,
    fromTs: priorSnap.ts,
    toTs: latestSnap.ts,
    added: added.slice(0, 50),
    removed: removed.slice(0, 50),
  };
}

void dirname;
