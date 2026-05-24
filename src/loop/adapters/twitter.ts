/**
 * Twitter (X) adapter — read mentions + post tweets via API v2.
 *
 * Auth: OAuth 2.0 Bearer token with tweet.read + tweet.write +
 * users.read scopes.  Stored at products/<slug>/connectors/twitter.json.
 *
 * Phase 4 scope:
 *   - poll(): recent mentions of the configured handle (signals)
 *   - apply(type='social-post'): post a tweet (or reply when inReplyTo set)
 *   - rollback(): delete the tweet by id
 *
 * Rate limiting: enforced upstream by policy.social.rate_limit.twitter.per_day;
 * adapter just makes the call.  Brand-voice filter enforced by policy.check.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface TwitterCreds extends AdapterCredsBase {
  authType: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  /** Twitter handle without the @ — used to fetch the user id once. */
  handle: string;
  /** Cached numeric user id, populated on first poll. */
  userId?: string;
}

const API = 'https://api.twitter.com/2';

export const twitterAdapter: Adapter<TwitterCreds> = {
  id: 'twitter',
  kind: 'both',
  label: 'Twitter / X',

  async validate(_ctx, creds) {
    const r = await fetch(`${API}/users/me`, { headers: bearer(creds.accessToken) });
    return r.ok ? { ok: true } : { ok: false, detail: `Twitter /users/me returned ${r.status}` };
  },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.accessToken || !c.handle) return;
    // Resolve user id once.
    let userId = c.userId;
    if (!userId) {
      try {
        const r = await fetch(`${API}/users/by/username/${encodeURIComponent(c.handle)}`, { headers: bearer(c.accessToken) });
        if (r.ok) {
          const j = (await r.json()) as { data?: { id?: string } };
          userId = j.data?.id;
          if (userId) {
            // Cache for next poll.
            c.userId = userId;
            try { await fs.writeFile(connectorPath(ctx, 'twitter'), JSON.stringify(c, null, 2), { mode: 0o600 }); } catch { /* tolerate */ }
          }
        }
      } catch { return; }
    }
    if (!userId) return;
    const startTime = since.toISOString();
    try {
      const r = await fetch(
        `${API}/users/${encodeURIComponent(userId)}/mentions?start_time=${encodeURIComponent(startTime)}&tweet.fields=created_at,public_metrics,author_id&max_results=50`,
        { headers: bearer(c.accessToken) }
      );
      if (!r.ok) return;
      const j = (await r.json()) as { data?: Array<{ id: string; text: string; created_at?: string; author_id?: string }> };
      for (const tw of j.data ?? []) {
        const ts = tw.created_at ? Date.parse(tw.created_at) : Date.now();
        yield {
          schemaVersion: 1,
          source: 'twitter',
          digest: `twitter-mention-${tw.id}`,
          ts,
          kind: 'twitter.mention',
          title: tw.text.slice(0, 120),
          body: tw.text,
          url: `https://twitter.com/i/web/status/${tw.id}`,
          raw: { id: tw.id, authorId: tw.author_id },
        };
      }
    } catch { /* tolerate */ }
  },

  async apply(ctx, creds, action): Promise<ActionResult> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.accessToken) throw new Error('Twitter creds missing');
    if (action.type !== 'social-post') throw new Error(`twitter.apply: unsupported type ${action.type}`);
    const body: Record<string, unknown> = { text: action.text };
    if (action.inReplyTo) body.reply = { in_reply_to_tweet_id: action.inReplyTo };
    const r = await fetch(`${API}/tweets`, {
      method: 'POST',
      headers: { ...bearer(c.accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Twitter POST /tweets returned ${r.status}`);
    const j = (await r.json()) as { data?: { id?: string } };
    const tweetId = j.data?.id;
    return {
      schemaVersion: 1,
      adapter: 'twitter',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: { tweetId, url: tweetId ? `https://twitter.com/${c.handle}/status/${tweetId}` : null },
      rollbackRecipe: {
        description: tweetId ? `delete tweet ${tweetId}` : 'no tweet id returned — manual delete required',
        payload: { tweetId },
      },
    };
  },

  async rollback(_ctx, creds, result): Promise<{ ok: boolean; detail?: string }> {
    if (!creds?.accessToken) return { ok: false, detail: 'no creds' };
    const id = result.rollbackRecipe.payload?.tweetId as string | undefined;
    if (!id) return { ok: false, detail: 'no tweetId in rollback payload' };
    const r = await fetch(`${API}/tweets/${encodeURIComponent(id)}`, { method: 'DELETE', headers: bearer(creds.accessToken) });
    return r.ok ? { ok: true } : { ok: false, detail: `Twitter DELETE returned ${r.status}` };
  },
};

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

export async function readCreds(ctx: ProductContext): Promise<TwitterCreds | null> {
  const path = connectorPath(ctx, 'twitter');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as TwitterCreds; } catch { return null; }
}

register(twitterAdapter as Adapter<AdapterCredsBase>);
