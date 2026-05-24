/**
 * Stripe adapter — read-only by default.
 *
 * Phase 3 scope: source only.  Daily MRR/sub snapshots + refund/dispute
 * signals.  Sink methods are NOT wired — money movement is a different
 * liability class and stays out of automated dispatch.
 *
 * Auth: Stripe Restricted API Key (read scopes).  Stored at
 * products/<slug>/connectors/stripe.json.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import * as metrics from '../../memory/metrics.js';
import type { Adapter, AdapterCredsBase } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface StripeCreds extends AdapterCredsBase {
  authType: 'pat';
  token: string;
}

const API = 'https://api.stripe.com/v1';

export const stripeAdapter: Adapter<StripeCreds> = {
  id: 'stripe',
  kind: 'source',
  label: 'Stripe (read-only revenue + refunds)',

  async validate(_ctx, creds) {
    const r = await fetch(`${API}/balance`, { headers: authHeader(creds.token) });
    return r.ok ? { ok: true } : { ok: false, detail: `Stripe /v1/balance returned ${r.status}` };
  },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.token) return;
    const headers = authHeader(c.token);
    try {
      const [subsResp, balResp] = await Promise.all([
        fetch(`${API}/subscriptions?status=active&limit=1`, { headers }),
        fetch(`${API}/balance`, { headers }),
      ]);
      if (subsResp.ok && balResp.ok) {
        const subsJ = (await subsResp.json()) as { data?: Array<unknown>; total_count?: number };
        const balJ = (await balResp.json()) as { available?: Array<{ amount: number; currency: string }> };
        const values: Record<string, number> = {};
        values.active_subscriptions = subsJ.total_count ?? subsJ.data?.length ?? 0;
        for (const b of balJ.available ?? []) values[`available_${b.currency}`] = b.amount / 100;
        const today = new Date().toISOString().slice(0, 10);
        await metrics.append(ctx, 'stripe', { ts: Date.now(), day: today, values });
      }
    } catch { /* tolerate */ }
    try {
      const created = Math.floor(since.getTime() / 1000);
      const r = await fetch(`${API}/refunds?created[gte]=${created}&limit=20`, { headers });
      if (r.ok) {
        const j = (await r.json()) as { data?: Array<{ id: string; amount: number; currency: string; reason?: string; created: number; charge?: string }> };
        for (const item of j.data ?? []) {
          yield {
            schemaVersion: 1, source: 'stripe',
            digest: `stripe-refund-${item.id}`, ts: item.created * 1000,
            kind: 'stripe.refund',
            title: `Refund ${item.amount / 100} ${item.currency.toUpperCase()}${item.reason ? ` (${item.reason})` : ''}`,
            raw: { id: item.id, amount: item.amount, currency: item.currency, reason: item.reason, charge: item.charge },
          };
        }
      }
    } catch { /* tolerate */ }
    try {
      const created = Math.floor(since.getTime() / 1000);
      const r = await fetch(`${API}/disputes?created[gte]=${created}&limit=20`, { headers });
      if (r.ok) {
        const j = (await r.json()) as { data?: Array<{ id: string; amount: number; currency: string; reason?: string; status?: string; created: number }> };
        for (const item of j.data ?? []) {
          yield {
            schemaVersion: 1, source: 'stripe',
            digest: `stripe-dispute-${item.id}`, ts: item.created * 1000,
            kind: 'stripe.dispute',
            title: `Dispute ${item.amount / 100} ${item.currency.toUpperCase()} (${item.status})`,
            raw: { id: item.id, amount: item.amount, currency: item.currency, reason: item.reason, status: item.status },
          };
        }
      }
    } catch { /* tolerate */ }
  },
};

function authHeader(token: string): Record<string, string> {
  const enc = Buffer.from(`${token}:`).toString('base64');
  return { Authorization: `Basic ${enc}`, 'Stripe-Version': '2024-04-10' };
}

export async function readCreds(ctx: ProductContext): Promise<StripeCreds | null> {
  const path = connectorPath(ctx, 'stripe');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as StripeCreds; } catch { return null; }
}

register(stripeAdapter as Adapter<AdapterCredsBase>);
