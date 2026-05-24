/**
 * Plausible adapter — read traffic metrics, emit metric-delta signals
 * + persist daily snapshots via memory/metrics.ts.
 *
 * Auth: Plausible Stats API key (paste).  Stored at
 * products/<slug>/connectors/plausible.json.
 *
 * Phase 2 scope: source only.  No sink methods — Plausible is read-only
 * for the loop.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import * as metrics from '../../memory/metrics.js';
import type { Adapter, AdapterCredsBase } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface PlausibleCreds extends AdapterCredsBase {
  authType: 'pat';
  token: string;
  /** Plausible site id (e.g. "mod8.ai"). */
  siteId: string;
  /** Optional custom Plausible host for self-hosted instances. */
  host?: string;
}

const DEFAULT_HOST = 'https://plausible.io';

export const plausibleAdapter: Adapter<PlausibleCreds> = {
  id: 'plausible',
  kind: 'source',
  label: 'Plausible analytics',

  async validate(_ctx, creds) {
    const host = creds.host ?? DEFAULT_HOST;
    const r = await fetch(`${host}/api/v1/stats/aggregate?site_id=${encodeURIComponent(creds.siteId)}&period=day&metrics=visitors`, {
      headers: { Authorization: `Bearer ${creds.token}` },
    });
    return r.ok ? { ok: true } : { ok: false, detail: `Plausible aggregate returned ${r.status}` };
  },

  async *poll(ctx, creds, _since): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.token || !c.siteId) return;
    const host = c.host ?? DEFAULT_HOST;
    const headers = { Authorization: `Bearer ${c.token}` };
    let aggResp: Response;
    try {
      aggResp = await fetch(
        `${host}/api/v1/stats/aggregate?site_id=${encodeURIComponent(c.siteId)}&period=day&metrics=visitors,pageviews,visit_duration,bounce_rate`,
        { headers }
      );
    } catch { return; }
    if (!aggResp.ok) return;
    const aggBody = (await aggResp.json()) as { results?: Record<string, { value?: number }> };
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(aggBody.results ?? {})) {
      if (typeof v?.value === 'number') values[k] = v.value;
    }
    const today = new Date().toISOString().slice(0, 10);
    try {
      await metrics.append(ctx, 'plausible', { ts: Date.now(), day: today, values, tags: { siteId: c.siteId } });
    } catch { /* tolerate */ }

    // Emit a daily snapshot signal so ideate sees that metrics were
    // refreshed (deltas are picked up by the measure phase, not here).
    yield {
      schemaVersion: 1,
      source: 'plausible',
      digest: `plausible-${c.siteId}-${today}`,
      ts: Date.now(),
      kind: 'plausible.daily-snapshot',
      title: `Plausible daily snapshot — ${c.siteId}`,
      raw: { values },
    };
  },
};

export async function readCreds(ctx: ProductContext): Promise<PlausibleCreds | null> {
  const path = connectorPath(ctx, 'plausible');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as PlausibleCreds; } catch { return null; }
}

register(plausibleAdapter as Adapter<AdapterCredsBase>);
