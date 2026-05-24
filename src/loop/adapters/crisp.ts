/**
 * Crisp adapter — inbound conversations + outbound replies.
 *
 * Auth: Crisp Plugin tokens (identifier + key + tier).  HTTP Basic.
 * Stored at products/<slug>/connectors/crisp.json.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface CrispCreds extends AdapterCredsBase {
  authType: 'pat';
  identifier: string;
  key: string;
  websiteId: string;
  tier?: 'plugin' | 'user';
}

const API = 'https://api.crisp.chat/v1';

export const crispAdapter: Adapter<CrispCreds> = {
  id: 'crisp',
  kind: 'both',
  label: 'Crisp (chat conversations in, replies out)',

  async validate(_ctx, creds) {
    const r = await fetch(`${API}/website/${encodeURIComponent(creds.websiteId)}`, { headers: authHeaders(creds) });
    return r.ok ? { ok: true } : { ok: false, detail: `Crisp website lookup returned ${r.status}` };
  },

  async *poll(ctx, creds): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.identifier || !c.key || !c.websiteId) return;
    let r: Response;
    try {
      r = await fetch(`${API}/website/${encodeURIComponent(c.websiteId)}/conversations/1`, { headers: authHeaders(c) });
    } catch { return; }
    if (!r.ok) return;
    const j = (await r.json()) as { data?: Array<Record<string, unknown>> };
    for (const conv of j.data ?? []) {
      const sessionId = String(conv.session_id ?? '');
      if (!sessionId) continue;
      const updatedAt = typeof conv.updated_at === 'number' ? conv.updated_at : Date.now();
      const last = conv.last_message as Record<string, unknown> | undefined;
      yield {
        schemaVersion: 1,
        source: 'crisp',
        digest: `crisp-${sessionId}-${updatedAt}`,
        ts: updatedAt,
        kind: `crisp.conversation.${conv.state ?? 'unresolved'}`,
        title: String(last?.content ?? 'Crisp conversation').slice(0, 120),
        body: String(last?.content ?? '').slice(0, 4000),
        raw: { sessionId, state: conv.state, status: conv.status },
      };
    }
  },

  async apply(ctx, creds, action): Promise<ActionResult> {
    const c = creds ?? (await readCreds(ctx));
    if (!c) throw new Error('Crisp creds missing');
    if (action.type !== 'user-reply') throw new Error(`crisp.apply: unsupported type ${action.type}`);
    const r = await fetch(`${API}/website/${encodeURIComponent(c.websiteId)}/conversation/${encodeURIComponent(action.threadId)}/message`, {
      method: 'POST',
      headers: { ...authHeaders(c), 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'text', from: 'operator', origin: 'chat', content: action.text }),
    });
    if (!r.ok) throw new Error(`Crisp send returned ${r.status}`);
    const j = (await r.json()) as { data?: { fingerprint?: string | number } };
    return {
      schemaVersion: 1,
      adapter: 'crisp',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: { fingerprint: j.data?.fingerprint, sessionId: action.threadId },
      rollbackRecipe: {
        description: 'Crisp operator messages cannot be deleted via API — manual cleanup from the dashboard required.',
        payload: { manual: true, sessionId: action.threadId, fingerprint: j.data?.fingerprint },
      },
    };
  },
};

function authHeaders(creds: CrispCreds): Record<string, string> {
  const enc = Buffer.from(`${creds.identifier}:${creds.key}`).toString('base64');
  return { Authorization: `Basic ${enc}`, 'X-Crisp-Tier': creds.tier ?? 'plugin', Accept: 'application/json' };
}

export async function readCreds(ctx: ProductContext): Promise<CrispCreds | null> {
  const path = connectorPath(ctx, 'crisp');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as CrispCreds; } catch { return null; }
}

register(crispAdapter as Adapter<AdapterCredsBase>);
