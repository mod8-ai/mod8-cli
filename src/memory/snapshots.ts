/**
 * Per-proposal metric snapshots — captured at act-time so the measure
 * phase has a baseline to compare against.
 *
 * One file per proposal: products/<slug>/memory/snapshots/<proposal-id>.json.
 * Contains a copy of the latest entries from each connected metrics
 * source.  Measure phase reads the snapshot + queries the same sources
 * for live values, computes per-key deltas.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { productPath } from './paths.js';
import * as metrics from './metrics.js';
import type { ProductContext } from '../loop/types.js';
import type { MetricEntry } from './metrics.js';

export interface MetricSnapshot {
  schemaVersion: 1;
  proposalId: string;
  capturedAt: number;
  /** Per-source latest entry at capture time. */
  bySource: Record<string, MetricEntry | null>;
  /** Optional success-criteria string from the proposal — for measure
   *  to know what to look for. */
  successCriteria?: string;
}

const DIR = 'memory/snapshots';
const METRIC_SOURCES = ['plausible', 'posthog', 'ga4', 'stripe'];

export async function capture(ctx: ProductContext, proposalId: string, successCriteria?: string): Promise<MetricSnapshot> {
  const bySource: Record<string, MetricEntry | null> = {};
  for (const src of METRIC_SOURCES) {
    const recent = await metrics.readAll(ctx, src, 1);
    bySource[src] = recent[0] ?? null;
  }
  const snap: MetricSnapshot = {
    schemaVersion: 1,
    proposalId,
    capturedAt: Date.now(),
    bySource,
    ...(successCriteria ? { successCriteria } : {}),
  };
  const path = productPath(ctx, DIR, `${proposalId}.json`);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, JSON.stringify(snap, null, 2), { mode: 0o600 });
  return snap;
}

export async function read(ctx: ProductContext, proposalId: string): Promise<MetricSnapshot | null> {
  const path = productPath(ctx, DIR, `${proposalId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as MetricSnapshot;
  } catch { return null; }
}
