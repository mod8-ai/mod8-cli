/**
 * Hot-paths ranking — files most-touched in the last N days of git
 * history.  Output drives ideate (Phase 2) — proposals targeted at
 * cold files have lower prior weight than ones targeted at active
 * ones.
 *
 * Implementation: shell out to `git log --since=<N>.days --name-only`
 * in the product's repo, count per-file occurrences, rank.  Write to
 * products/<slug>/memory/codebase/hotpaths.json.
 *
 * Refresh strategy: phase 1 just regenerates on every sense run if
 * the file is older than `policy.cadence.sense_every_minutes`.  Phase
 * 2 may add a smarter "dirty when ≥5% of tracked files changed" rule.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { productFiles } from '../paths.js';
import type { ProductContext } from '../../loop/types.js';

const execFileP = promisify(execFile);

export interface HotpathEntry {
  path: string;
  touchedCount: number;
  /** Most-recent commit ts (epoch ms) that touched this file. */
  lastTouchedAt: number | null;
}

export interface HotpathsSnapshot {
  schemaVersion: 1;
  productSlug: string;
  generatedAt: number;
  sinceDays: number;
  totalCommits: number;
  /** Sorted descending by touchedCount, capped at MAX_ENTRIES. */
  entries: HotpathEntry[];
}

const DEFAULT_SINCE_DAYS = 90;
const MAX_ENTRIES = 200;

/** Generate (or regenerate) the hotpaths snapshot. */
export async function generate(ctx: ProductContext, sinceDays: number = DEFAULT_SINCE_DAYS): Promise<HotpathsSnapshot> {
  const counts = new Map<string, number>();
  const lastTouched = new Map<string, number>();
  let totalCommits = 0;

  // git log --since=Xdays --name-only --pretty='format:%H %ct'
  // Each commit block: header line (sha ts), blank-or-files, blank.
  let stdout: string;
  try {
    const r = await execFileP(
      'git',
      ['log', `--since=${sinceDays}.days`, '--name-only', '--pretty=format:%H %ct', '--no-merges'],
      { cwd: ctx.repoRoot, maxBuffer: 16 * 1024 * 1024 }
    );
    stdout = r.stdout;
  } catch (err) {
    // Not a git repo, or git not installed — return an empty snapshot.
    // Sense.ts will surface this in the SignalBundle.memoryUpdates list
    // as a no-op without erroring the whole tick.
    return {
      schemaVersion: 1,
      productSlug: ctx.slug,
      generatedAt: Date.now(),
      sinceDays,
      totalCommits: 0,
      entries: [],
    };
  }

  let currentCommitTs: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    // Commit header: "<sha> <unix-ts>"
    const headerMatch = line.match(/^([0-9a-f]{7,40})\s+(\d+)$/);
    if (headerMatch) {
      totalCommits++;
      currentCommitTs = Number(headerMatch[2]) * 1000;
      continue;
    }
    // Otherwise a file path.
    const path = line.trim();
    if (!path) continue;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (currentCommitTs !== null) {
      const prior = lastTouched.get(path) ?? 0;
      if (currentCommitTs > prior) lastTouched.set(path, currentCommitTs);
    }
  }

  const entries: HotpathEntry[] = Array.from(counts.entries())
    .map(([path, touchedCount]) => ({
      path,
      touchedCount,
      lastTouchedAt: lastTouched.get(path) ?? null,
    }))
    .sort((a, b) => b.touchedCount - a.touchedCount)
    .slice(0, MAX_ENTRIES);

  const snap: HotpathsSnapshot = {
    schemaVersion: 1,
    productSlug: ctx.slug,
    generatedAt: Date.now(),
    sinceDays,
    totalCommits,
    entries,
  };
  await write(ctx, snap);
  return snap;
}

export async function read(ctx: ProductContext): Promise<HotpathsSnapshot | null> {
  const path = productFiles.hotpathsJson(ctx);
  if (!existsSync(path)) return null;
  try {
    const buf = await fs.readFile(path, 'utf8');
    return JSON.parse(buf) as HotpathsSnapshot;
  } catch {
    return null;
  }
}

async function write(ctx: ProductContext, snap: HotpathsSnapshot): Promise<void> {
  const path = productFiles.hotpathsJson(ctx);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, JSON.stringify(snap, null, 2), { mode: 0o600 });
}

/** True when hotpaths.json is older than `maxAgeMs` (or missing).
 *  Used by sense.ts to decide whether to regenerate this tick. */
export function isStale(snap: HotpathsSnapshot | null, maxAgeMs: number, now: number = Date.now()): boolean {
  if (!snap) return true;
  return now - snap.generatedAt > maxAgeMs;
}
