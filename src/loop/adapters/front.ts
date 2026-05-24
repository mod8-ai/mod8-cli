/**
 * Front adapter — inbound conversations + outbound replies.
 *
 * Auth: Front API Token (paste).  Stored at
 * products/<slug>/connectors/front.json.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface FrontCreds extends AdapterCredsBase {
  authType: 'pat';
  token: string;
  /** Channel id used as the author for replies. */
  channelId?: string;
  /** Author handle for outbound (teammate id). */
  authorId?: string;
}

const API = 'https://api2.frontapp.com';

export const frontAdapter: Adapter<FrontCreds> = {
  id: 'front',
  kind: 'both',
  label: 'Front (conversations in, replies out)',

  async validate(_ctx, creds) {
    const r = await fetch(`${API}/me`, { headers: authHeaders(creds.token) });
    return r.ok ? { ok: true } : { ok: false, detail: `Front /me returned ${r.status}` };
  },

  async *poll(ctx, creds): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.token) return;
    let r: Response;
    try {
      r = await fetch(`${API}/conversations?q[statuses]=open&limit=50`, { headers: authHeaders(c.token) });
    } catch { return; }
    if (!r.ok) return;
    const j = (await r.json()) as { _results?: Array<Record<string, unknown>> };
    for (const conv of j._results ?? []) {
      const id = String(conv.id ?? '');
      if (!id) continue;
      const updatedAt = typeof conv.last_message?.toString === 'function'
        ? (typeof (conv as { last_message?: { created_at?: number } }).last_message?.created_at === 'number'
          ? ((conv as { last_message?: { created_at?: number } }).last_message!.created_at as number) * 1000
          : Date.now())
        : Date.now();
      yield {
        schemaVersion: 1,
        source: 'front',
        digest: `front-${id}-${updatedAt}`,
        ts: updatedAt,
        kind: `front.conversation.${conv.status ?? 'open'}`,
        title: String(conv.subject ?? 'Front conversation').slice(0, 120),
        raw: { id, status: conv.status, assignee: conv.assignee },
      };
    }
  },

  async apply(ctx, creds, action): Promise<ActionResult> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.token) throw new Error('Front creds missing');
    if (action.type !== 'user-reply') throw new Error(`front.apply: unsupported type ${action.type}`);
    const r = await fetch(`${API}/conversations/${encodeURIComponent(action.threadId)}/messages`, {
      method: 'POST',
      headers: { ...authHeaders(c.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: action.text,
        channel_id: c.channelId,
        author_id: c.authorId,
      }),
    });
    if (!r.ok) throw new Error(`Front reply returned ${r.status}`);
    const j = (await r.json()) as { id?: string };
    return {
      schemaVersion: 1,
      adapter: 'front',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: { messageId: j.id, conversationId: action.threadId },
      rollbackRecipe: {
        description: 'Front does not support deleting sent messages via API — manual cleanup from the Front UI required.',
        payload: { manual: true, conversationId: action.threadId, messageId: j.id },
      },
    };
  },
};

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

export async function readCreds(ctx: ProductContext): Promise<FrontCreds | null> {
  const path = connectorPath(ctx, 'front');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as FrontCreds; } catch { return null; }
}

register(frontAdapter as Adapter<AdapterCredsBase>);
