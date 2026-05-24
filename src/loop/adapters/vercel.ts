/**
 * Vercel adapter — read deploy status as signals.
 *
 * Phase 2 scope: read-only.  Polls the Vercel Deployments API for
 * recent deploys matching the configured project; produces signals
 * for failed deploys, status changes, and new production rollouts.
 *
 * Auth: bearer token at products/<slug>/connectors/vercel.json
 * (manual paste — Phase 4 adds proxy-brokered OAuth).
 *
 * Phase 3 will add sink methods (trigger deploy, rollback).
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface VercelCreds extends AdapterCredsBase {
  authType: 'pat';
  token: string;
  projectId?: string;
  teamId?: string;
}

const API = 'https://api.vercel.com';

export const vercelAdapter: Adapter<VercelCreds> = {
  id: 'vercel',
  kind: 'source',
  label: 'Vercel deploy status',

  async validate(_ctx, creds) {
    const r = await fetch(`${API}/v2/user`, {
      headers: { Authorization: `Bearer ${creds.token}` },
    });
    return r.ok ? { ok: true } : { ok: false, detail: `Vercel /v2/user returned ${r.status}` };
  },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.token) return;
    const url = new URL(`${API}/v6/deployments`);
    if (c.projectId) url.searchParams.set('projectId', c.projectId);
    if (c.teamId) url.searchParams.set('teamId', c.teamId);
    url.searchParams.set('since', String(since.getTime()));
    url.searchParams.set('limit', '50');
    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${c.token}` },
      });
    } catch { return; }
    if (!resp.ok) return;
    const body = (await resp.json()) as { deployments?: Array<Record<string, unknown>> };
    for (const d of body.deployments ?? []) {
      const id = String(d.uid ?? d.id ?? '');
      if (!id) continue;
      const created = typeof d.createdAt === 'number' ? d.createdAt : Date.now();
      const state = String(d.state ?? d.readyState ?? 'unknown');
      const url = typeof d.url === 'string' ? `https://${d.url}` : undefined;
      yield {
        schemaVersion: 1,
        source: 'vercel',
        digest: `${id}-${state}`,
        ts: created,
        kind: `vercel.deploy.${state.toLowerCase()}`,
        title: `Vercel deploy ${state} — ${d.name ?? id}`,
        ...(url ? { url } : {}),
        raw: { id, state, target: d.target, meta: d.meta },
      };
    }
  },
};

export async function readCreds(ctx: ProductContext): Promise<VercelCreds | null> {
  const path = connectorPath(ctx, 'vercel');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as VercelCreds; } catch { return null; }
}

register(vercelAdapter as Adapter<AdapterCredsBase>);
