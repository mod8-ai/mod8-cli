// mod8 social draft: media staged + card created, nothing posted. Fake host, no network.
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sandbox = await fs.mkdtemp(join(tmpdir(), 'mod8-social-test-'));
process.env.MOD8_CONFIG_DIR = sandbox;
const { draftPost, listDrafts, validateDraft } = await import('../dist/company/social.js');

let pass = 0, fail = 0;
const ok = (label) => { pass++; console.log(`  ✓ ${label}`); };
const bad = (label, err) => { fail++; console.error(`  ✗ ${label} — ${err}`); };
const check = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));
const throws = (fn, label) => { try { fn(); bad(label, 'did not throw'); } catch { ok(label); } };

const media = join(sandbox, 'in');
await fs.mkdir(media);
const vid = join(media, 'clip.mp4'); await fs.writeFile(vid, 'fake-video');
const img1 = join(media, 'a.png'); await fs.writeFile(img1, 'fake-png-1');
const img2 = join(media, 'b.jpg'); await fs.writeFile(img2, 'fake-jpg-2');

let fetched = 0;
globalThis.fetch = async () => { fetched++; throw new Error('no network in tests'); };
let hosted = [];
const host = async (dir, slug) => { hosted.push({ files: await fs.readdir(dir), slug }); return `https://${slug}.apps.mod8.ai/`; };

throws(() => validateDraft([img1], 'reel'), 'reel rejects an image');
throws(() => validateDraft([vid], 'photo'), 'photo rejects a video');
throws(() => validateDraft([img1], 'carousel'), 'carousel needs 2+ files');
throws(() => validateDraft([join(media, 'x.gif')], 'story'), 'missing file rejected');

{
  const r = await draftPost({ slug: 'brand', files: [vid], format: 'reel', caption: 'Pick your safe word.\nTell your circle.', host });
  const items = await listDrafts('brand');
  const card = items.find((i) => i.id === r.approvalId);
  const a = card?.proposedAction;
  check(card?.state === 'pending' && card.kind === 'marketing', 'reel card is pending marketing', card?.state);
  check(a?.type === 'social-post' && a.channel === 'instagram' && a.text.startsWith('Pick your safe word.'), 'social-post to instagram with caption', JSON.stringify(a));
  check(a?.media?.[0]?.kind === 'reel' && /^https:\/\/brand-social\.apps\.mod8\.ai\/[0-9a-f]{16}\.mp4$/.test(a.media[0].source), 'media hosted under brand-social with hash name', a?.media?.[0]?.source);
  check(hosted[0].files.includes('index.html') && hosted[0].files.some((f) => f.endsWith('.mp4')), 'hosted folder has the video + index', hosted[0].files.join(','));
  check(card.title.startsWith('[instagram reel] Pick your safe word. Tell'), 'title readable', card.title);
}
{
  const r = await draftPost({ slug: 'brand', files: [img1], format: 'story', caption: 'ignored', host });
  const a = (await listDrafts('brand')).find((i) => i.id === r.approvalId).proposedAction;
  check(a.media[0].kind === 'story' && a.text === '', 'story has no caption', JSON.stringify(a));
}
{
  const r = await draftPost({ slug: 'brand', files: [img1, img2], format: 'carousel', caption: 'two', host });
  check(r.media.length === 2 && r.media.every((m) => m.kind === 'photo') && r.media[1].source.endsWith('.jpg'), 'carousel has both photos', JSON.stringify(r.media));
}
{
  let threw = false;
  try { await draftPost({ slug: 'brand', files: [vid], format: 'reel', caption: '  ', host }); } catch { threw = true; }
  check(threw, 'empty reel caption refused', '');
}
check(fetched === 0, 'no network call while drafting (nothing posted)', fetched);
check((await listDrafts('brand')).length === 3, 'three drafts listed', (await listDrafts('brand')).length);

console.log(`\n${pass} passed, ${fail} failed`);
await fs.rm(sandbox, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
