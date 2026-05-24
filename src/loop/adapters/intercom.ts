/**
 * Intercom adapter — inbound conversations as signals, outbound
 * replies as actions.
 *
 * Auth: Intercom Access Token (paste).  Stored at
 * products/<slug>/connectors/intercom.json.
 *
 * Phase 4 scope:
 *   - poll(): recent conversations updated since `since` → signals
 *   - apply(): reply to a conversation (action.type='user-reply',
 *     channel='intercom').  Requires approval per policy.support.reply_mode.
 *   - rollback(): delete the reply (Intercom soft-deletes via DELETE
 *     /conversations/<id>/parts/<part_id>).
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface IntercomCreds extends AdapterCredsBase {
  authType: 'pat';
  token: string;
  /** Optional Intercom workspace id. */
  workspaceId?: string;
  /** Admin id used as the author for outbound replies. */
  adminId: string;
}

const API = 'https://api.intercom.io';

export const intercomAdapter: Adapter<IntercomCreds> = {
  id: 'intercom',
  kind: 'both',
  label: 'Intercom (conversations in, replies out)',

  async validate(_ctx, creds) {
    const r = await fetch(`${API}/me`, { headers: authHeader(creds.token) });
    return r.ok ? { ok: true } : { ok: false, detail: `Intercom /me returned ${r.status}` };
  },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.token) return;
    // Search for conversations updated since timestamp.
    const body = {
      query: {
        operator: 'AND',
        value: [
          { field: 'updated_at', operator: '>', value: Math.floor(since.getTime() / 1000) },
        ],
      },
    };
    let r: Response;
    try {
      r = await fetch(`${API}/conversations/search`, {
        method: 'POST',
        headers: { ...authHeader(c.token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch { return; }
    if (!r.ok) return;
    const j = (await r.json()) as { conversations?: Array<Record<string, unknown>> };
    for (const conv of j.conversations ?? []) {
      const id = String(conv.id ?? '');
      if (!id) continue;
      const updatedAt = typeof conv.updated_at === 'number' ? conv.updated_at * 1000 : Date.now();
      const sourceObj = (conv.source as Record<string, unknown> | undefined);
      const subject = String(sourceObj?.subject ?? 'Intercom conversation');
      const body = String(sourceObj?.body ?? '').replace(/<[^>]+>/g, '');
      yield {
        schemaVersion: 1,
        source: 'intercom',
        digest: `intercom-${id}-${updatedAt}`,
        ts: updatedAt,
        kind: `intercom.conversation.${conv.state ?? 'open'}`,
        title: subject.slice(0, 120),
        body: body.slice(0, 4000),
        raw: { id, state: conv.state, priority: conv.priority, assignee_id: conv.assignee_id },
      };
    }
  },

  async apply(ctx, creds, action): Promise<ActionResult> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.token) throw new Error('Intercom creds missing');
    if (action.type !== 'user-reply') {
      throw new Error(`intercom.apply: unsupported action type ${action.type}`);
    }
    const r = await fetch(`${API}/conversations/${encodeURIComponent(action.threadId)}/reply`, {
      method: 'POST',
      headers: { ...authHeader(c.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_type: 'comment',
        type: 'admin',
        admin_id: c.adminId,
        body: action.text,
      }),
    });
    if (!r.ok) throw new Error(`Intercom reply returned ${r.status}`);
    const j = (await r.json()) as { conversation_parts?: { conversation_parts?: Array<{ id: string }> } };
    const partId = j.conversation_parts?.conversation_parts?.slice(-1)?.[0]?.id;
    return {
      schemaVersion: 1,
      adapter: 'intercom',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: { conversationId: action.threadId, partId },
      rollbackRecipe: {
        description: partId ? `delete Intercom conversation part ${partId}` : 'manual conversation cleanup required',
        payload: { conversationId: action.threadId, partId },
      },
    };
  },

  async rollback(_ctx, creds, result): Promise<{ ok: boolean; detail?: string }> {
    if (!creds?.token) return { ok: false, detail: 'no creds' };
    const partId = result.rollbackRecipe.payload?.partId as string | undefined;
    const convId = result.rollbackRecipe.payload?.conversationId as string | undefined;
    if (!partId || !convId) return { ok: false, detail: 'missing part/conversation id' };
    const r = await fetch(`${API}/conversations/${encodeURIComponent(convId)}/conversation_parts/${encodeURIComponent(partId)}`, {
      method: 'DELETE',
      headers: authHeader(creds.token),
    });
    return r.ok ? { ok: true } : { ok: false, detail: `Intercom DELETE returned ${r.status}` };
  },
};

function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Intercom-Version': '2.10' };
}

export async function readCreds(ctx: ProductContext): Promise<IntercomCreds | null> {
  const path = connectorPath(ctx, 'intercom');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as IntercomCreds; } catch { return null; }
}

register(intercomAdapter as Adapter<AdapterCredsBase>);
