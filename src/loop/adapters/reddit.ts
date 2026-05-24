/**
 * Reddit adapter — read mentions, post comments + submissions.
 *
 * Auth: OAuth script app (client_id + client_secret + username +
 * password) → access token.  Stored at
 * products/<slug>/connectors/reddit.json.
 *
 * Phase 4 scope:
 *   - poll(): subreddit search for watchTerms (signals)
 *   - apply(): post comment OR submit a self-post (depending on
 *     action shape).  Subreddit must be in policy.social.channels.reddit allowlist.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface RedditCreds extends AdapterCredsBase {
  authType: 'oauth';
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  /** Comma-separated watch terms. */
  watchTerms?: string;
  /** Cached access token. */
  accessToken?: string;
  tokenExpiresAt?: number;
}

async function ensureToken(ctx: ProductContext, c: RedditCreds): Promise<RedditCreds> {
  const now = Date.now();
  if (c.accessToken && c.tokenExpiresAt && c.tokenExpiresAt > now + 60_000) return c;
  const enc = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'password', username: c.username, password: c.password });
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${enc}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'mod8-loop/0.5 (by /u/' + c.username + ')',
    },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Reddit token endpoint returned ${r.status}`);
  const j = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('Reddit token response missing access_token');
  const updated: RedditCreds = {
    ...c,
    accessToken: j.access_token,
    tokenExpiresAt: now + (j.expires_in ?? 3600) * 1000,
  };
  try { await fs.writeFile(connectorPath(ctx, 'reddit'), JSON.stringify(updated, null, 2), { mode: 0o600 }); } catch { /* tolerate */ }
  return updated;
}

export const redditAdapter: Adapter<RedditCreds> = {
  id: 'reddit',
  kind: 'both',
  label: 'Reddit (subreddit search in, comments/posts out)',

  async validate(ctx, creds) {
    try {
      await ensureToken(ctx, creds);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const raw = creds ?? (await readCreds(ctx));
    if (!raw?.watchTerms) return;
    let c: RedditCreds;
    try { c = await ensureToken(ctx, raw); } catch { return; }
    const terms = raw.watchTerms.split(',').map((t) => t.trim()).filter(Boolean);
    for (const term of terms) {
      try {
        const r = await fetch(`https://oauth.reddit.com/search?q=${encodeURIComponent(term)}&sort=new&limit=25`, {
          headers: {
            Authorization: `Bearer ${c.accessToken}`,
            'User-Agent': 'mod8-loop/0.5 (by /u/' + c.username + ')',
          },
        });
        if (!r.ok) continue;
        const j = (await r.json()) as { data?: { children?: Array<{ data?: { id?: string; title?: string; selftext?: string; created_utc?: number; permalink?: string; subreddit?: string; author?: string } }> } };
        for (const ch of j.data?.children ?? []) {
          const d = ch.data;
          if (!d?.id) continue;
          const ts = (d.created_utc ?? Math.floor(Date.now() / 1000)) * 1000;
          if (ts < since.getTime()) continue;
          yield {
            schemaVersion: 1,
            source: 'reddit',
            digest: `reddit-${d.id}`,
            ts,
            kind: 'reddit.post',
            title: (d.title ?? '').slice(0, 120),
            body: d.selftext?.slice(0, 4000),
            url: d.permalink ? `https://reddit.com${d.permalink}` : undefined,
            raw: { id: d.id, subreddit: d.subreddit, author: d.author, term },
          };
        }
      } catch { /* tolerate */ }
    }
  },

  async apply(ctx, creds, action): Promise<ActionResult> {
    const raw = creds ?? (await readCreds(ctx));
    if (!raw) throw new Error('Reddit creds missing');
    if (action.type !== 'social-post') throw new Error(`reddit.apply: unsupported type ${action.type}`);
    const c = await ensureToken(ctx, raw);
    if (!c.accessToken) throw new Error('Reddit token unavailable');
    // If inReplyTo set → comment.  Otherwise submit (requires subreddit in action somewhere).
    const body = new URLSearchParams();
    let endpoint: string;
    if (action.inReplyTo) {
      endpoint = 'https://oauth.reddit.com/api/comment';
      body.set('api_type', 'json');
      body.set('thing_id', action.inReplyTo);
      body.set('text', action.text);
    } else {
      // action.channel is expected to encode the subreddit, e.g. "reddit:r/typescript".
      const sub = action.channel.replace(/^reddit:/, '').replace(/^r\//, '');
      endpoint = 'https://oauth.reddit.com/api/submit';
      body.set('api_type', 'json');
      body.set('kind', 'self');
      body.set('sr', sub);
      body.set('title', action.text.slice(0, 300));
      body.set('text', action.text);
    }
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'mod8-loop/0.5 (by /u/' + c.username + ')',
      },
      body: body.toString(),
    });
    if (!r.ok) throw new Error(`Reddit ${endpoint} returned ${r.status}`);
    const j = (await r.json()) as { json?: { data?: { things?: Array<{ data?: { id?: string; name?: string } }> } } };
    const item = j.json?.data?.things?.[0]?.data;
    const thingId = item?.name ?? item?.id;
    return {
      schemaVersion: 1,
      adapter: 'reddit',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: { thingId },
      rollbackRecipe: {
        description: thingId ? `delete Reddit item ${thingId}` : 'manual delete required',
        payload: { thingId },
      },
    };
  },

  async rollback(ctx, creds, result): Promise<{ ok: boolean; detail?: string }> {
    if (!creds) return { ok: false, detail: 'no creds' };
    const id = result.rollbackRecipe.payload?.thingId as string | undefined;
    if (!id) return { ok: false, detail: 'no thingId' };
    const c = await ensureToken(ctx, creds);
    const body = new URLSearchParams({ id });
    const r = await fetch('https://oauth.reddit.com/api/del', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.accessToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'mod8-loop/0.5 (by /u/' + c.username + ')',
      },
      body: body.toString(),
    });
    return r.ok ? { ok: true } : { ok: false, detail: `Reddit DELETE returned ${r.status}` };
  },
};

export async function readCreds(ctx: ProductContext): Promise<RedditCreds | null> {
  const path = connectorPath(ctx, 'reddit');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as RedditCreds; } catch { return null; }
}

register(redditAdapter as Adapter<AdapterCredsBase>);
