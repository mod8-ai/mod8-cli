/**
 * Meta adapter — Facebook Pages + Instagram Business posting via the Graph API.
 *
 * Auth: a long-lived PAGE access token (and, for IG, the linked Instagram
 * Business account id) obtained through the mod8 "connect facebook" flow against
 * the mod8-owned Meta app.  Stored at products/<slug>/connectors/meta.json (0o600).
 *
 * Phase 4 scope:
 *   - poll(): recent posts on the Page (engagement signals)
 *   - apply(type='social-post', channel='facebook'|'instagram'|'meta'): publish a
 *     post.  Text/link → Page feed; {kind:'photo'} → /photos; {kind:'video'} →
 *     /videos (by public file_url); channel='instagram' → IG container + publish.
 *   - rollback(): delete the created post/media by id.
 *
 * IMPORTANT: media.source must be a PUBLIC https URL Meta can fetch (IG requires
 * it; FB video-by-file_url too).  Local files are hosted first by the caller
 * (mod8 static hosting) — this adapter deals only in URLs.
 *
 * Publishing is LIVE here; the "draft/review" step is the mod8 approval Panel that
 * gates the social-post action BEFORE apply() ever runs (see approval/policy).
 * Rate limiting + brand-voice are enforced upstream by policy.check.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface MetaCreds extends AdapterCredsBase {
  authType: 'oauth';
  /** Long-lived Page access token (posts to the Page + reads its IG account). */
  accessToken: string;
  /** Facebook Page id this token belongs to. */
  pageId: string;
  /** Human-readable Page name (for labels / post urls). */
  pageName?: string;
  /** Linked Instagram Business account id — required only for channel=instagram. */
  igUserId?: string;
  /** mod8 Meta app id the token was issued under (audit/debug only). */
  appId?: string;
}

const API = 'https://graph.facebook.com/v21.0';

export const metaAdapter: Adapter<MetaCreds> = {
  id: 'meta',
  kind: 'both',
  label: 'Facebook / Instagram',

  async validate(_ctx, creds) {
    if (!creds?.accessToken || !creds.pageId) return { ok: false, detail: 'missing page token / pageId' };
    const r = await fetch(`${API}/${encodeURIComponent(creds.pageId)}?fields=name&access_token=${encodeURIComponent(creds.accessToken)}`);
    return r.ok ? { ok: true } : { ok: false, detail: `Meta GET /${creds.pageId} returned ${r.status}` };
  },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.accessToken || !c.pageId) return;
    const sinceUnix = Math.floor(since.getTime() / 1000);
    try {
      const r = await fetch(
        `${API}/${encodeURIComponent(c.pageId)}/feed?since=${sinceUnix}&fields=message,created_time,permalink_url&limit=25&access_token=${encodeURIComponent(c.accessToken)}`,
      );
      if (!r.ok) return;
      const j = (await r.json()) as { data?: Array<{ id: string; message?: string; created_time?: string; permalink_url?: string }> };
      for (const p of j.data ?? []) {
        const ts = p.created_time ? Date.parse(p.created_time) : Date.now();
        const text = p.message ?? '(no text)';
        yield {
          schemaVersion: 1,
          source: 'meta',
          digest: `meta-post-${p.id}`,
          ts,
          kind: 'meta.page_post',
          title: text.slice(0, 120),
          body: text,
          url: p.permalink_url ?? `https://facebook.com/${p.id}`,
          raw: { id: p.id, pageId: c.pageId },
        };
      }
    } catch { /* tolerate */ }
  },

  async apply(ctx, creds, action): Promise<ActionResult> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.accessToken) throw new Error('Meta creds missing');
    if (action.type !== 'social-post') throw new Error(`meta.apply: unsupported type ${action.type}`);

    const media = action.media?.[0];
    const isInstagram = action.channel === 'instagram';

    if (isInstagram) {
      if (!c.igUserId) throw new Error('meta.apply: channel=instagram but no linked Instagram account (igUserId)');
      if (!media?.source) throw new Error('meta.apply: Instagram posts require a public media URL');
      const isVideo = media.kind === 'video' || media.kind === 'reel';
      // 1) create a media container
      const containerBody = new URLSearchParams({ access_token: c.accessToken, caption: action.text });
      if (isVideo) { containerBody.set('media_type', 'REELS'); containerBody.set('video_url', media.source); }
      else containerBody.set('image_url', media.source);
      const cr = await postForm(`${API}/${encodeURIComponent(c.igUserId)}/media`, containerBody);
      const creationId = (cr as { id?: string }).id;
      if (!creationId) throw new Error('meta.apply: IG container creation returned no id');
      // 2) publish the container
      const pub = await postForm(`${API}/${encodeURIComponent(c.igUserId)}/media_publish`, new URLSearchParams({ access_token: c.accessToken, creation_id: creationId }));
      const mediaId = (pub as { id?: string }).id;
      return result('meta', action, { mediaId, channel: 'instagram', creationId }, {
        description: mediaId ? `delete Instagram media ${mediaId}` : 'no media id returned — manual delete required',
        payload: { postId: mediaId },
      });
    }

    // Facebook Page
    let endpoint = 'feed';
    const body = new URLSearchParams({ access_token: c.accessToken });
    if (media?.kind === 'photo' && media.source) {
      endpoint = 'photos';
      body.set('url', media.source);
      body.set('caption', action.text);
    } else if ((media?.kind === 'video' || media?.kind === 'reel') && media.source) {
      endpoint = 'videos';
      body.set('file_url', media.source);
      body.set('description', action.text);
    } else {
      body.set('message', action.text);
      if (media?.kind === 'link' && media.source) body.set('link', media.source);
    }
    const posted = await postForm(`${API}/${encodeURIComponent(c.pageId)}/${endpoint}`, body);
    // /photos returns {id, post_id}; /videos returns {id}; /feed returns {id}
    const postId = (posted as { post_id?: string; id?: string }).post_id ?? (posted as { id?: string }).id;
    return result('meta', action, { postId, channel: 'facebook', endpoint }, {
      description: postId ? `delete Facebook post ${postId}` : 'no post id returned — manual delete required',
      payload: { postId },
    });
  },

  async rollback(_ctx, creds, res): Promise<{ ok: boolean; detail?: string }> {
    if (!creds?.accessToken) return { ok: false, detail: 'no creds' };
    const id = res.rollbackRecipe.payload?.postId as string | undefined;
    if (!id) return { ok: false, detail: 'no postId in rollback payload' };
    const r = await fetch(`${API}/${encodeURIComponent(id)}?access_token=${encodeURIComponent(creds.accessToken)}`, { method: 'DELETE' });
    return r.ok ? { ok: true } : { ok: false, detail: `Meta DELETE /${id} returned ${r.status}` };
  },
};

async function postForm(url: string, body: URLSearchParams): Promise<unknown> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json error body */ }
  if (!r.ok) {
    const detail = (json as { error?: { message?: string } })?.error?.message ?? `HTTP ${r.status}`;
    throw new Error(`Meta POST ${url.replace(/access_token=[^&]+/, 'access_token=***')} failed: ${detail}`);
  }
  return json;
}

function result(
  adapter: string,
  action: import('../../approval/types.js').ProposedAction,
  payload: Record<string, unknown>,
  rollbackRecipe: ActionResult['rollbackRecipe'],
): ActionResult {
  return {
    schemaVersion: 1,
    adapter,
    approvalId: (action as ApprovedAction).approvalId,
    appliedAt: Date.now(),
    payload,
    rollbackRecipe,
  };
}

export async function readCreds(ctx: ProductContext): Promise<MetaCreds | null> {
  const path = connectorPath(ctx, 'meta');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as MetaCreds; } catch { return null; }
}

register(metaAdapter as Adapter<AdapterCredsBase>);
