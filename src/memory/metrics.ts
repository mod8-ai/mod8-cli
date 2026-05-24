/**
 * Metrics memory — per-product daily snapshots.
 *
 * Format: products/<slug>/memory/metrics/daily.jsonl, one entry per
 * day per source.  Entries are point-in-time numeric snapshots; the
 * measure phase reads these to compute deltas.
 *
 * Sources are adapter-defined (plausible/posthog/ga4/stripe).  Memory
 * stays adapter-agnostic — adapters call append() with their data.
 */

import { promises as fs } from 'node:fs';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { productPath } from './paths.js';
import type { ProductContext } from '../loop/types.js';

const MAX_BYTES = 512 * 1024;

export interface MetricEntry {
  schemaVersion: 1;
  ts: number;
  source: string;                            // 'plausible' | 'posthog' | …
  /** ISO date (YYYY-MM-DD) the metric covers. */
  day: string;
  /** Free-form numeric metric map.  Common keys: pageviews, visitors,
   *  signups, weekly_active, mrr_usd.  Adapter-defined. */
  values: Record<string, number>;
  /** Adapter-specific tags. */
  tags?: Record<string, string>;
}

function metricsPath(ctx: ProductContext, source: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(source)) {
    throw new Error(`invalid metric source "${source}"`);
  }
  return productPath(ctx, 'memory', 'metrics', `${source}.jsonl`);
}

export async function append(ctx: ProductContext, source: string, entry: Omit<MetricEntry, 'schemaVersion' | 'source'>): Promise<void> {
  const full: MetricEntry = {
    schemaVersion: 1,
    source,
    ...entry,
  };
  const path = metricsPath(ctx, source);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.appendFile(path, JSON.stringify(full) + '\n', { mode: 0o600 });
  rotateIfNeeded(path);
}

/** Read all entries for a source, newest first, optional limit. */
export async function readAll(ctx: ProductContext, source: string, limit?: number): Promise<MetricEntry[]> {
  const path = metricsPath(ctx, source);
  if (!existsSync(path)) return [];
  const buf = await fs.readFile(path, 'utf8');
  const out: MetricEntry[] = [];
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as MetricEntry); } catch { /* skip */ }
  }
  out.sort((a, b) => b.ts - a.ts);
  return limit ? out.slice(0, limit) : out;
}

/** Compute per-key delta vs the snapshot at `comparisonTs` (or the
 *  earliest entry if absent).  Returns signed %-change values. */
export async function computeDelta(
  ctx: ProductContext,
  source: string,
  comparisonTs: number,
): Promise<Record<string, number>> {
  const all = await readAll(ctx, source);
  if (all.length === 0) return {};
  const latest = all[0]!;
  // Find the closest entry at or before comparisonTs.
  let baseline: MetricEntry | undefined;
  for (const e of all) {
    if (e.ts <= comparisonTs) { baseline = e; break; }
  }
  baseline ??= all[all.length - 1];
  if (!baseline) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(latest.values)) {
    const prior = baseline.values[k];
    if (typeof prior !== 'number' || prior === 0) continue;
    out[k] = ((v - prior) / prior) * 100;
  }
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
