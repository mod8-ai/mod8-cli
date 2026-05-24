/**
 * Bluesky adapter — atproto/XRPC.  Read mentions + post records.
 *
 * Auth: app password (stored in creds) → POST /xrpc/com.atproto.server.createSession
 *       on first poll → caches accessJwt + refreshJwt.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface BlueskyCreds extends AdapterCredsBase {
  authType: 'pat';
  /** Handle like 'mod8.bsky.social'. */
  handle: string;
  /** App password (NOT the account password). */
  appPassword: string;
  /** Cached session tokens. */
  accessJwt?: string;
  refreshJwt?: string;
  did?: string;
}

const SERVICE = 'https://bsky.social';

async function ensureSession(ctx: ProductContext, c: BlueskyCreds): Promise<BlueskyCreds> {
  if (c.accessJwt) return c;
  const r = await fetch(`${SERVICE}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: c.handle, password: c.appPassword }),
  });
  if (!r.ok) throw new Error(`Bluesky session create returned ${r.status}`);
  const j = (await r.json()) as { accessJwt?: string; refreshJwt?: string; did?: string };
  const updated: BlueskyCreds = {
    ...c,
    ...(j.accessJwt ? { accessJwt: j.accessJwt } : {}),
    ...(j.refreshJwt ? { refreshJwt: j.refreshJwt } : {}),
    ...(j.did ? { did: j.did } : {}),
  };
  try { await fs.writeFile(connectorPath(ctx, 'bluesky'), JSON.stringify(updated, null, 2), { mode: 0o600 }); } catch { /* tolerate */ }
  return updated;
}

export const blueskyAdapter: Adapter<BlueskyCreds> = {
  id: 'bluesky',
  kind: 'both',
  label: 'Bluesky (atproto)',

  async validate(ctx, creds) {
    try {
      await ensureSession(ctx, creds);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const raw = creds ?? (await readCreds(ctx));
    if (!raw?.handle) return;
    let c: BlueskyCreds;
    try { c = await ensureSession(ctx, raw); } catch { return; }
    if (!c.accessJwt) return;
    // Get notifications (mentions live there).
    try {
      const r = await fetch(`${SERVICE}/xrpc/app.bsky.notification.listNotifications?limit=50`, {
        headers: { Authorization: `Bearer ${c.accessJwt}` },
      });
      if (!r.ok) return;
      const j = (await r.json()) as { notifications?: Array<{ uri: string; reason: string; record?: { text?: string; createdAt?: string }; indexedAt?: string }> };
      for (const n of j.notifications ?? []) {
        const ts = n.indexedAt ? Date.parse(n.indexedAt) : Date.now();
        if (ts < since.getTime()) continue;
        if (n.reason !== 'mention' && n.reason !== 'reply') continue;
        yield {
          schemaVersion: 1,
          source: 'bluesky',
          digest: `bluesky-${n.uri}`,
          ts,
          kind: `bluesky.${n.reason}`,
          title: (n.record?.text ?? n.reason).slice(0, 120),
          body: n.record?.text,
          url: n.uri,
          raw: { uri: n.uri, reason: n.reason },
        };
      }
    } catch { /* tolerate */ }
  },

  async apply(ctx, creds, action): Promise<ActionResult> {
    const raw = creds ?? (await readCreds(ctx));
    if (!raw) throw new Error('Bluesky creds missing');
    if (action.type !== 'social-post') throw new Error(`bluesky.apply: unsupported type ${action.type}`);
    const c = await ensureSession(ctx, raw);
    if (!c.accessJwt || !c.did) throw new Error('Bluesky session unavailable');
    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text: action.text,
      createdAt: new Date().toISOString(),
    };
    if (action.inReplyTo) record.reply = { root: { uri: action.inReplyTo, cid: '' }, parent: { uri: action.inReplyTo, cid: '' } };
    const r = await fetch(`${SERVICE}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.accessJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: c.did, collection: 'app.bsky.feed.post', record }),
    });
    if (!r.ok) throw new Error(`Bluesky createRecord returned ${r.status}`);
    const j = (await r.json()) as { uri?: string; cid?: string };
    return {
      schemaVersion: 1,
      adapter: 'bluesky',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: { uri: j.uri, cid: j.cid },
      rollbackRecipe: {
        description: j.uri ? `delete Bluesky record ${j.uri}` : 'manual delete required',
        payload: { uri: j.uri, did: c.did },
      },
    };
  },

  async rollback(ctx, creds, result): Promise<{ ok: boolean; detail?: string }> {
    if (!creds) return { ok: false, detail: 'no creds' };
    const uri = result.rollbackRecipe.payload?.uri as string | undefined;
    if (!uri) return { ok: false, detail: 'no uri in rollback payload' };
    const c = await ensureSession(ctx, creds);
    // Parse rkey + collection from at:// URI.
    const m = uri.match(/^at:\/\/(.+?)\/(.+?)\/(.+)$/);
    if (!m || !c.accessJwt) return { ok: false, detail: 'malformed uri or no session' };
    const [, repo, collection, rkey] = m;
    const r = await fetch(`${SERVICE}/xrpc/com.atproto.repo.deleteRecord`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.accessJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, collection, rkey }),
    });
    return r.ok ? { ok: true } : { ok: false, detail: `Bluesky deleteRecord returned ${r.status}` };
  },
};

export async function readCreds(ctx: ProductContext): Promise<BlueskyCreds | null> {
  const path = connectorPath(ctx, 'bluesky');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as BlueskyCreds; } catch { return null; }
}

register(blueskyAdapter as Adapter<AdapterCredsBase>);
