// Meta adapter, Instagram-Login path. Mocked fetch; no network, no real account.
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sandbox = await fs.mkdtemp(join(tmpdir(), 'mod8-meta-test-'));
process.env.MOD8_CONFIG_DIR = sandbox;
const { metaAdapter, ensureFreshIgToken, igTiming } = await import('../dist/loop/adapters/meta.js');
igTiming.pollMs = 1;

const productDir = join(sandbox, 'products', 'brand');
await fs.mkdir(join(productDir, 'connectors'), { recursive: true });
const ctx = { slug: 'brand', productDir, repoRoot: sandbox, tickId: 1 };

let pass = 0, fail = 0;
const ok = (label) => { pass++; console.log(`  ✓ ${label}`); };
const bad = (label, err) => { fail++; console.error(`  ✗ ${label} — ${err}`); };
const check = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));

let calls = [];
let statusSeq = [];
let refreshReply = { status: 200, body: { access_token: 'NEW', expires_in: 5184000 } };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
  calls.push({ url: u, method: init.method ?? 'GET', body });
  const json = (status, b) => new Response(JSON.stringify(b), { status });
  if (u.includes('refresh_access_token')) return json(refreshReply.status, refreshReply.body);
  if (u.endsWith('/media') && body) return json(200, { id: `c${calls.length}` });
  if (u.endsWith('/media_publish')) return json(200, { id: 'M1' });
  if (u.includes('fields=status_code')) return json(200, { status_code: statusSeq.shift() ?? 'FINISHED' });
  if (u.includes('fields=permalink')) return json(200, { permalink: 'https://instagram.com/p/X' });
  return json(404, {});
};

const far = Date.now() + 50 * 24 * 3600 * 1000;
const creds = () => ({ authType: 'oauth', igAccessToken: 'T', igUserId: '178', igTokenExpiresAt: far });
const post = (media) => ({ type: 'social-post', channel: 'instagram', text: 'hi', media, approvalId: 'a1' });

// 1. reel: waits for processing, goes to graph.instagram.com, share_to_feed
{
  calls = []; statusSeq = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
  const r = await metaAdapter.apply(ctx, creds(), post([{ kind: 'video', source: 'https://x/v.mp4' }]));
  const c = calls.find((x) => x.url.endsWith('/178/media'));
  check(c?.url.startsWith('https://graph.instagram.com/') && c.body.media_type === 'REELS' && c.body.share_to_feed === 'true', 'reel container on graph.instagram.com', JSON.stringify(c));
  check(calls.filter((x) => x.url.includes('status_code')).length === 3, 'waited until FINISHED before publish', calls.length);
  check(r.payload.mediaId === 'M1' && r.payload.format === 'reel' && r.payload.permalink, 'returns media id + permalink', JSON.stringify(r.payload));
}
// 2. story (video by URL) has no caption
{
  calls = [];
  await metaAdapter.apply(ctx, creds(), post([{ kind: 'story', source: 'https://x/s.mp4' }]));
  const c = calls.find((x) => x.url.endsWith('/178/media'));
  check(c.body.media_type === 'STORIES' && c.body.video_url && !c.body.caption, 'story container', JSON.stringify(c.body));
}
// 3. photo story uses image_url
{
  calls = [];
  await metaAdapter.apply(ctx, creds(), post([{ kind: 'story', source: 'https://x/s.png' }]));
  const c = calls.find((x) => x.url.endsWith('/178/media'));
  check(c.body.media_type === 'STORIES' && c.body.image_url, 'photo story uses image_url', JSON.stringify(c.body));
}
// 4. carousel: child containers then CAROUSEL with children
{
  calls = [];
  const r = await metaAdapter.apply(ctx, creds(), post([{ kind: 'photo', source: 'https://x/1.png' }, { kind: 'photo', source: 'https://x/2.png' }]));
  const cs = calls.filter((x) => x.url.endsWith('/178/media'));
  check(cs.length === 3 && cs[0].body.is_carousel_item === 'true' && cs[2].body.media_type === 'CAROUSEL' && cs[2].body.children.split(',').length === 2, 'carousel built from children', JSON.stringify(cs.map((x) => x.body)));
  check(r.payload.format === 'carousel', 'format=carousel', r.payload.format);
}
// 5. processing error surfaces, nothing published
{
  calls = []; statusSeq = ['ERROR'];
  let threw = false;
  try { await metaAdapter.apply(ctx, creds(), post([{ kind: 'reel', source: 'https://x/v.mp4' }])); } catch { threw = true; }
  check(threw && !calls.some((x) => x.url.endsWith('/media_publish')), 'processing ERROR → no publish', threw);
}
// 6. token with >30 days left is not refreshed
{
  calls = [];
  await ensureFreshIgToken(ctx, creds());
  check(!calls.some((x) => x.url.includes('refresh_access_token')), 'fresh token left alone', calls.length);
}
// 7. token with <30 days left refreshes and is saved 0600
{
  calls = [];
  const c = { ...creds(), igTokenExpiresAt: Date.now() + 20 * 24 * 3600 * 1000 };
  const warn = await ensureFreshIgToken(ctx, c);
  const saved = JSON.parse(await fs.readFile(join(productDir, 'connectors', 'meta.json'), 'utf8'));
  const mode = (await fs.stat(join(productDir, 'connectors', 'meta.json'))).mode & 0o777;
  check(!warn && c.igAccessToken === 'NEW' && saved.igAccessToken === 'NEW' && saved.igTokenExpiresAt > far, 'refreshed + persisted', JSON.stringify(saved));
  check(mode === 0o600, 'creds file is 0600', mode.toString(8));
}
// 8. refresh fails inside last 10 days → warning signal
{
  refreshReply = { status: 400, body: { error: { message: 'expired' } } };
  const c = { ...creds(), igUsername: 'saferglobal', igTokenExpiresAt: Date.now() + 5 * 24 * 3600 * 1000 };
  const warn = await ensureFreshIgToken(ctx, c);
  check(warn?.kind === 'meta.token_expiring' && /saferglobal expires in 5 days/.test(warn.title), 'expiry warning raised', warn?.title);
}
// 9. refresh fails with 20 days left → quiet (will retry next tick)
{
  const c = { ...creds(), igTokenExpiresAt: Date.now() + 20 * 24 * 3600 * 1000 };
  check((await ensureFreshIgToken(ctx, c)) === null, 'no warning while >10 days left', '');
}

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(sandbox, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
