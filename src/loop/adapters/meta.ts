/**
 * Meta adapter — Facebook Pages + Instagram Business posting via the Graph API.
 *
 * Auth, either or both:
 *   - a long-lived PAGE access token (+ linked IG Business id) from the mod8
 *     "connect facebook" flow → graph.facebook.com;
 *   - an Instagram-Login token (mod8 Social-IG app, no Facebook Page needed)
 *     → graph.instagram.com.  This is what our own brands use.  It lives 60
 *     days; poll()/apply() refresh it once fewer than 30 days remain and raise a
 *     meta.token_expiring signal if that fails inside the last 10 days.
 * Stored at products/<slug>/connectors/meta.json (0o600).
 *
 * Phase 4 scope:
 *   - poll(): recent posts on the Page (engagement signals)
 *   - apply(type='social-post', channel='facebook'|'instagram'|'meta'): publish a
 *     post.  Text/link → Page feed; {kind:'photo'} → /photos; {kind:'video'} →
 *     /videos (by public file_url); channel='instagram' → IG container + publish:
 *     photo, reel ({kind:'video'|'reel'}), story ({kind:'story'}, photo or video
 *     by URL), carousel (2-10 media).  Video containers are waited on until
 *     Instagram finishes processing.
 *   - rollback(): delete the created Facebook post by id.  The Instagram API
 *     cannot delete media, so IG rollback is manual (in the app).
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

export interface MetaCreds extends AdapterCredsBase {
  authType: 'oauth';
  /** Long-lived Page access token (posts to the Page + reads its IG account). */
  accessToken?: string;
  /** Facebook Page id this token belongs to. */
  pageId?: string;
  /** Human-readable Page name (for labels / post urls). */
  pageName?: string;
  /** Linked Instagram Business account id — required only for channel=instagram. */
  igUserId?: string;
  /** mod8 Meta app id the token was issued under (audit/debug only). */
  appId?: string;
  /** Instagram-Login token (graph.instagram.com).  When set, Instagram posts use it. */
  igAccessToken?: string;
  /** ms epoch the IG token expires; unknown → refreshed on next use. */
  igTokenExpiresAt?: number;
  /** IG username (labels only). */
  igUsername?: string;
}

const API = 'https://graph.facebook.com/v21.0';
const IG_API = 'https://graph.instagram.com/v21.0';
const DAY = 24 * 60 * 60 * 1000;
/** Tunable for tests. */
export const igTiming = { pollMs: 5000, maxPolls: 60 };

export const metaAdapter: Adapter<MetaCreds> = {
  id: 'meta',
  kind: 'both',
  label: 'Facebook / Instagram',

  async validate(_ctx, creds) {
    if (creds?.igAccessToken) {
      const r = await fetch(`${IG_API}/me?fields=user_id,username&access_token=${encodeURIComponent(creds.igAccessToken)}`);
      return r.ok ? { ok: true } : { ok: false, detail: `Instagram GET /me returned ${r.status}` };
    }
    if (!creds?.accessToken || !creds.pageId) return { ok: false, detail: 'missing page token / pageId' };
    const r = await fetch(`${API}/${encodeURIComponent(creds.pageId)}?fields=name&access_token=${encodeURIComponent(creds.accessToken)}`);
    return r.ok ? { ok: true } : { ok: false, detail: `Meta GET /${creds.pageId} returned ${r.status}` };
  },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c) return;
    if (c.igAccessToken) {
      const warn = await ensureFreshIgToken(ctx, c);
      if (warn) yield warn;
      yield* pollInstagram(c, since);
    }
    if (!c.accessToken || !c.pageId) return;
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
    if (!c?.accessToken && !c?.igAccessToken) throw new Error('Meta creds missing');
    if (action.type !== 'social-post') throw new Error(`meta.apply: unsupported type ${action.type}`);

    const media = action.media?.[0];

    if (action.channel === 'instagram') {
      if (c.igAccessToken) await ensureFreshIgToken(ctx, c);
      return publishInstagram(c, action);
    }

    if (!c.accessToken || !c.pageId) throw new Error('meta.apply: Facebook posts need a Page token + pageId');
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
    if (res.payload?.channel === 'instagram') return { ok: false, detail: `Instagram API cannot delete media ${id}; delete it in the Instagram app` };
    const r = await fetch(`${API}/${encodeURIComponent(id)}?access_token=${encodeURIComponent(creds.accessToken)}`, { method: 'DELETE' });
    return r.ok ? { ok: true } : { ok: false, detail: `Meta DELETE /${id} returned ${r.status}` };
  },
};

/** Which Graph host + token Instagram calls go through. */
function igHost(c: MetaCreds): { base: string; token: string; user: string } {
  if (c.igAccessToken) return { base: IG_API, token: c.igAccessToken, user: c.igUserId ?? 'me' };
  if (!c.accessToken || !c.igUserId) throw new Error('meta.apply: channel=instagram but no Instagram login token or linked igUserId');
  return { base: API, token: c.accessToken, user: c.igUserId };
}

const isVideoUrl = (u: string) => /\.(mp4|mov|m4v)(\?|#|$)/i.test(u);

async function publishInstagram(c: MetaCreds, action: import('../../approval/types.js').ProposedAction & { type: 'social-post' }): Promise<ActionResult> {
  const h = igHost(c);
  const items = (action.media ?? []).filter((m) => m.source);
  if (items.length === 0) throw new Error('meta.apply: Instagram posts require a public media URL');
  if (items.length > 10) throw new Error('meta.apply: Instagram carousels take at most 10 items');
  const container = (p: Record<string, string>) =>
    postForm(`${h.base}/${encodeURIComponent(h.user)}/media`, new URLSearchParams({ ...p, access_token: h.token }))
      .then((r) => { const id = (r as { id?: string }).id; if (!id) throw new Error('meta.apply: IG container creation returned no id'); return id; });
  const mediaParams = (m: { kind: string; source: string }): { video: boolean; p: Record<string, string> } =>
    m.kind === 'video' || m.kind === 'reel' || isVideoUrl(m.source)
      ? { video: true, p: { video_url: m.source } }
      : { video: false, p: { image_url: m.source } };

  let creationId: string;
  let format: string;
  if (items.length > 1) {
    const children: string[] = [];
    for (const m of items) {
      const { video, p } = mediaParams(m);
      const id = await container({ ...p, is_carousel_item: 'true', ...(video ? { media_type: 'VIDEO' } : {}) });
      if (video) await waitForContainer(h, id);
      children.push(id);
    }
    creationId = await container({ media_type: 'CAROUSEL', children: children.join(','), caption: action.text });
    format = 'carousel';
  } else {
    const m = items[0]!;
    const { video, p } = mediaParams(m);
    if (m.kind === 'story') {
      creationId = await container({ ...p, media_type: 'STORIES' });
      format = 'story';
    } else if (video) {
      creationId = await container({ ...p, media_type: 'REELS', caption: action.text, share_to_feed: 'true' });
      format = 'reel';
    } else {
      creationId = await container({ ...p, caption: action.text });
      format = 'photo';
    }
  }
  await waitForContainer(h, creationId);
  const pub = await postForm(`${h.base}/${encodeURIComponent(h.user)}/media_publish`, new URLSearchParams({ access_token: h.token, creation_id: creationId }));
  const mediaId = (pub as { id?: string }).id;
  let permalink: string | undefined;
  if (mediaId) {
    try {
      const r = await fetch(`${h.base}/${encodeURIComponent(mediaId)}?fields=permalink&access_token=${encodeURIComponent(h.token)}`);
      if (r.ok) permalink = ((await r.json()) as { permalink?: string }).permalink;
    } catch { /* permalink is cosmetic */ }
  }
  return result('meta', action, { mediaId, channel: 'instagram', format, creationId, permalink }, {
    description: mediaId ? `delete Instagram ${format} ${mediaId} in the Instagram app (API cannot delete)` : 'no media id returned — manual delete required',
    payload: { postId: mediaId },
  });
}

/** Instagram processes videos (and sometimes images) asynchronously; publishing
 *  before status_code=FINISHED fails with "media not ready". */
async function waitForContainer(h: { base: string; token: string }, id: string): Promise<void> {
  for (let i = 0; i < igTiming.maxPolls; i++) {
    const r = await fetch(`${h.base}/${encodeURIComponent(id)}?fields=status_code,status&access_token=${encodeURIComponent(h.token)}`);
    const j = r.ok ? ((await r.json()) as { status_code?: string; status?: string }) : {};
    if (!j.status_code || j.status_code === 'FINISHED' || j.status_code === 'PUBLISHED') return;
    if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') throw new Error(`meta.apply: Instagram could not process media (${j.status ?? j.status_code})`);
    await new Promise((res) => setTimeout(res, igTiming.pollMs));
  }
  throw new Error('meta.apply: Instagram media still processing after waiting; try publishing again later');
}

async function* pollInstagram(c: MetaCreds, since: Date): AsyncIterable<Signal> {
  try {
    const r = await fetch(`${IG_API}/me/media?fields=id,caption,timestamp,permalink,media_type,like_count,comments_count&limit=25&access_token=${encodeURIComponent(c.igAccessToken!)}`);
    if (!r.ok) return;
    const j = (await r.json()) as { data?: Array<{ id: string; caption?: string; timestamp?: string; permalink?: string; media_type?: string; like_count?: number; comments_count?: number }> };
    for (const m of j.data ?? []) {
      const ts = m.timestamp ? Date.parse(m.timestamp) : Date.now();
      if (ts < since.getTime()) continue;
      const text = m.caption ?? '(no caption)';
      yield {
        schemaVersion: 1,
        source: 'meta',
        digest: `meta-ig-${m.id}`,
        ts,
        kind: 'meta.ig_media',
        title: text.slice(0, 120),
        body: text,
        url: m.permalink,
        raw: { id: m.id, mediaType: m.media_type, likes: m.like_count, comments: m.comments_count },
      };
    }
  } catch { /* tolerate */ }
}

/** Refresh the Instagram-Login token once fewer than 30 days remain (Instagram
 *  only refreshes tokens older than 24h, which a 30-day threshold guarantees).
 *  Mutates + persists `c`.  Returns a warning signal when refresh failed and
 *  the token dies within 10 days, else null. */
export async function ensureFreshIgToken(ctx: ProductContext, c: MetaCreds, now = Date.now()): Promise<Signal | null> {
  if (!c.igAccessToken) return null;
  const left = c.igTokenExpiresAt ? c.igTokenExpiresAt - now : 0;
  if (c.igTokenExpiresAt && left > 30 * DAY) return null;
  let error = '';
  try {
    const r = await fetch(`${IG_API.replace(/\/v[\d.]+$/, '')}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(c.igAccessToken)}`);
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: { message?: string } };
    if (r.ok && j.access_token) {
      c.igAccessToken = j.access_token;
      c.igTokenExpiresAt = now + (j.expires_in ?? 60 * 24 * 3600) * 1000;
      const path = connectorPath(ctx, 'meta');
      await fs.writeFile(path, JSON.stringify(c, null, 2), { mode: 0o600 });
      return null;
    }
    error = j.error?.message ?? `HTTP ${r.status}`;
  } catch (e) {
    error = (e as Error).message;
  }
  if (!c.igTokenExpiresAt || left > 10 * DAY) return null;
  const days = Math.max(0, Math.ceil(left / DAY));
  return {
    schemaVersion: 1,
    source: 'meta',
    digest: `meta-token-expiring-${new Date(now).toISOString().slice(0, 10)}`,
    ts: now,
    kind: 'meta.token_expiring',
    title: `Instagram login for ${c.igUsername ?? ctx.slug} expires in ${days} day${days === 1 ? '' : 's'}; reconnect it (mod8 connect meta)`,
    body: `Automatic refresh failed: ${error}`,
    raw: { expiresAt: c.igTokenExpiresAt },
  };
}

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
