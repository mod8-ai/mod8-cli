/**
 * PostHog adapter — read product analytics (events, retention).
 *
 * Phase 3 scope: source only.  Persists daily snapshots via
 * memory/metrics.ts under source='posthog'.
 *
 * Auth: PostHog Personal API Key (paste).  Stored at
 * products/<slug>/connectors/posthog.json.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import * as metrics from '../../memory/metrics.js';
import type { Adapter, AdapterCredsBase } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface PosthogCreds extends AdapterCredsBase {
  authType: 'pat';
  token: string;
  /** Numeric project id from the PostHog UI. */
  projectId: string;
  /** Optional host for self-hosted instances. */
  host?: string;
}

const DEFAULT_HOST = 'https://us.posthog.com';

export const posthogAdapter: Adapter<PosthogCreds> = {
  id: 'posthog',
  kind: 'source',
  label: 'PostHog analytics',

  async validate(_ctx, creds) {
    const host = creds.host ?? DEFAULT_HOST;
    const r = await fetch(`${host}/api/projects/${encodeURIComponent(creds.projectId)}/`, {
      headers: { Authorization: `Bearer ${creds.token}` },
    });
    return r.ok ? { ok: true } : { ok: false, detail: `PostHog project lookup returned ${r.status}` };
  },

  async *poll(ctx, creds): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.token || !c.projectId) return;
    const host = c.host ?? DEFAULT_HOST;
    const headers = { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' };
    const trendsBody = {
      events: [{ id: 'pageview', math: 'total' }, { id: '$pageview', math: 'dau' }],
      date_from: '-1d',
      interval: 'day',
    };
    let trends: Response;
    try {
      trends = await fetch(`${host}/api/projects/${encodeURIComponent(c.projectId)}/insights/trend/`, {
        method: 'POST',
        headers,
        body: JSON.stringify(trendsBody),
      });
    } catch { return; }
    if (!trends.ok) return;
    const trendBody = (await trends.json()) as { result?: Array<{ count?: number; label?: string }> };
    const values: Record<string, number> = {};
    for (const r of trendBody.result ?? []) {
      if (typeof r.count === 'number' && typeof r.label === 'string') values[r.label] = r.count;
    }
    const today = new Date().toISOString().slice(0, 10);
    try {
      await metrics.append(ctx, 'posthog', { ts: Date.now(), day: today, values, tags: { projectId: c.projectId } });
    } catch { /* tolerate */ }

    yield {
      schemaVersion: 1,
      source: 'posthog',
      digest: `posthog-${c.projectId}-${today}`,
      ts: Date.now(),
      kind: 'posthog.daily-snapshot',
      title: `PostHog daily snapshot — project ${c.projectId}`,
      raw: { values },
    };
  },
};

export async function readCreds(ctx: ProductContext): Promise<PosthogCreds | null> {
  const path = connectorPath(ctx, 'posthog');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as PosthogCreds; } catch { return null; }
}

register(posthogAdapter as Adapter<AdapterCredsBase>);
