/**
 * Google Analytics 4 adapter — read traffic metrics via the GA4 Data API.
 *
 * Phase 3 scope: source only.  Persists daily snapshots via
 * memory/metrics.ts under source='ga4'.
 *
 * Auth: Service-account JSON or OAuth access token.  Stored at
 * products/<slug>/connectors/ga4.json.  Phase 4 will broker the OAuth
 * dance via the mod8 proxy; Phase 3 ships PAT (pre-acquired access
 * token).
 *
 * The GA4 Data API requires an access token bearer; this adapter
 * does not refresh tokens (refresh ships in Phase 4 with full OAuth).
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import * as metrics from '../../memory/metrics.js';
import type { Adapter, AdapterCredsBase } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface Ga4Creds extends AdapterCredsBase {
  authType: 'oauth' | 'pat';
  /** Short-lived access token (refresh externally for now). */
  accessToken: string;
  /** GA4 property id, e.g. "properties/123456789". */
  propertyId: string;
}

const API = 'https://analyticsdata.googleapis.com/v1beta';

export const ga4Adapter: Adapter<Ga4Creds> = {
  id: 'ga4',
  kind: 'source',
  label: 'Google Analytics 4',

  async validate(_ctx, creds) {
    const r = await fetch(`${API}/${encodeURI(creds.propertyId)}/metadata`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    return r.ok ? { ok: true } : { ok: false, detail: `GA4 metadata returned ${r.status}` };
  },

  async *poll(ctx, creds): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.accessToken || !c.propertyId) return;
    const body = {
      dateRanges: [{ startDate: '1daysAgo', endDate: 'today' }],
      metrics: [
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'screenPageViews' },
        { name: 'bounceRate' },
      ],
    };
    let resp: Response;
    try {
      resp = await fetch(`${API}/${encodeURI(c.propertyId)}:runReport`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch { return; }
    if (!resp.ok) return;
    const j = (await resp.json()) as { metricHeaders?: Array<{ name: string }>; rows?: Array<{ metricValues?: Array<{ value: string }> }> };
    const headers = (j.metricHeaders ?? []).map((h) => h.name);
    const row = j.rows?.[0]?.metricValues ?? [];
    const values: Record<string, number> = {};
    for (let i = 0; i < headers.length; i++) {
      const v = Number(row[i]?.value);
      if (Number.isFinite(v)) values[headers[i]!] = v;
    }
    const today = new Date().toISOString().slice(0, 10);
    try {
      await metrics.append(ctx, 'ga4', { ts: Date.now(), day: today, values, tags: { propertyId: c.propertyId } });
    } catch { /* tolerate */ }
    yield {
      schemaVersion: 1,
      source: 'ga4',
      digest: `ga4-${c.propertyId}-${today}`,
      ts: Date.now(),
      kind: 'ga4.daily-snapshot',
      title: `GA4 daily snapshot — ${c.propertyId}`,
      raw: { values },
    };
  },
};

export async function readCreds(ctx: ProductContext): Promise<Ga4Creds | null> {
  const path = connectorPath(ctx, 'ga4');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as Ga4Creds; } catch { return null; }
}

register(ga4Adapter as Adapter<AdapterCredsBase>);
