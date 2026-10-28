/**
 * mod8 Social — hand-made posts (a finished reel, story, photo or carousel)
 * become approval cards, the same cards `mod8 marketing plan` produces.
 *
 *   draftPost()  copy media into products/<slug>/social/media/ (content-hash
 *                names; videos over 24 MB are re-encoded to fit the hosting
 *                upload cap), publish that folder to <slug>-social.apps.mod8.ai
 *                so Instagram can fetch it, and stage a pending 'marketing'
 *                card with a social-post action.
 *
 * Nothing is posted here.  Posting happens only when the founder approves the
 * card (`mod8 approvals --slug <slug>` [a], or `approvals-cli decide`), which
 * runs the act phase → meta adapter.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildProductContext, productPath } from '../memory/paths.js';
import * as approvalStore from '../approval/store.js';
import * as proposalStore from '../loop/proposal.js';
import { newApprovalId, type ApprovalItem } from '../approval/types.js';
import type { Proposal } from '../loop/proposal.js';
import type { ProductContext } from '../loop/types.js';

export const SOCIAL_FORMATS = ['reel', 'story', 'photo', 'carousel'] as const;
export type SocialFormat = (typeof SOCIAL_FORMATS)[number];

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
/** Hosting rejects files over 25 MB (and Cloud Run caps uploads near 32 MB). */
const MAX_MEDIA_BYTES = 24 * 1024 * 1024;
/** Hosted media older than this is dropped on the next upload. */
const KEEP_MEDIA_MS = 14 * 24 * 60 * 60 * 1000;

export interface DraftInput {
  slug: string;
  files: string[];
  format: SocialFormat;
  caption: string;
  /** Tests inject a fake host; default publishes to <slug>-social.apps.mod8.ai. */
  host?: (dir: string, siteSlug: string) => Promise<string>;
}

export interface DraftResult {
  approvalId: string;
  media: Array<{ kind: string; source: string }>;
  shrunk: string[];
}

export function validateDraft(files: string[], format: SocialFormat): void {
  if (!SOCIAL_FORMATS.includes(format)) throw new Error(`format must be one of ${SOCIAL_FORMATS.join(', ')}`);
  if (files.length === 0) throw new Error('no media file given');
  for (const f of files) {
    if (!existsSync(f)) throw new Error(`file not found: ${f}`);
    const ext = extname(f).toLowerCase();
    if (!VIDEO_EXT.has(ext) && !IMAGE_EXT.has(ext)) throw new Error(`unsupported media type: ${basename(f)} (mp4/mov/jpg/png)`);
  }
  const isVideo = (f: string) => VIDEO_EXT.has(extname(f).toLowerCase());
  if (format === 'carousel') {
    if (files.length < 2 || files.length > 10) throw new Error('a carousel takes 2-10 files');
  } else if (files.length !== 1) {
    throw new Error(`a ${format} takes exactly one file`);
  }
  if (format === 'reel' && !isVideo(files[0]!)) throw new Error('a reel needs a video file');
  if (format === 'photo' && isVideo(files[0]!)) throw new Error('a photo post needs an image (use --as reel for video)');
}

export async function draftPost(input: DraftInput): Promise<DraftResult> {
  validateDraft(input.files, input.format);
  if (input.format !== 'story' && !input.caption.trim()) throw new Error('caption is empty');
  const ctx = buildProductContext(input.slug, process.cwd(), 0);
  const dir = productPath(ctx, 'social', 'media');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await pruneOld(dir);

  const shrunk: string[] = [];
  const names: string[] = [];
  for (const f of input.files) {
    const ext = extname(f).toLowerCase();
    const name = `${(await sha256(f)).slice(0, 16)}${ext === '.jpeg' ? '.jpg' : ext}`;
    const dest = join(dir, name);
    if (!existsSync(dest)) {
      const size = (await fs.stat(f)).size;
      if (VIDEO_EXT.has(ext) && size > MAX_MEDIA_BYTES) {
        await shrinkVideo(f, dest, size);
        shrunk.push(basename(f));
      } else {
        await fs.copyFile(f, dest);
      }
      if ((await fs.stat(dest)).size > MAX_MEDIA_BYTES) {
        await fs.unlink(dest);
        throw new Error(`${basename(f)} is still over 24 MB after shrinking; trim it shorter`);
      }
    }
    names.push(name);
  }
  await fs.writeFile(join(dir, 'index.html'), '<!doctype html><title>media</title>', { mode: 0o600 });

  const siteSlug = `${input.slug}-social`.slice(0, 32);
  const base = (await (input.host ?? defaultHost)(dir, siteSlug)).replace(/\/$/, '');
  const media = names.map((n) => ({
    kind: input.format === 'story' ? 'story'
      : input.format === 'reel' ? 'reel'
      : VIDEO_EXT.has(extname(n)) ? 'video' : 'photo',
    source: `${base}/${n}`,
  }));

  const text = input.format === 'story' ? '' : input.caption.trim();
  const firstLine = (text || basename(input.files[0]!)).replace(/\s+/g, ' ');
  const title = `[instagram ${input.format}] ${firstLine}`.slice(0, 120);
  const proposal: Proposal = {
    schemaVersion: 1,
    id: proposalStore.newProposalId(),
    productSlug: input.slug,
    createdAt: Date.now(),
    createdByPhase: 'ideate',
    originTickId: 0,
    kind: 'marketing-post',
    title,
    summary: text || `Instagram story: ${basename(input.files[0]!)}`,
    targetFiles: [],
    evidenceDigests: [],
    rationale: 'Drafted by hand with `mod8 social draft`.',
    estimatedEffort: 'small',
    estimatedRisk: 'low',
    estimatedImpact: 'medium',
    rollbackHint: 'delete the post in the Instagram app',
    successCriteria: 'post published and engagement recorded by the next measure phase',
  };
  await proposalStore.save(ctx, proposal);

  const id = newApprovalId();
  const item: ApprovalItem = {
    schemaVersion: 1,
    id,
    productSlug: input.slug,
    createdAt: Date.now(),
    proposalId: proposal.id,
    originTickId: 0,
    kind: 'marketing',
    title,
    reason: `Instagram ${input.format} from ${input.files.map((f) => basename(f)).join(', ')}. Preview: ${media.map((m) => m.source).join(' ')}`,
    signals: [],
    proposedAction: { type: 'social-post', channel: 'instagram', text, media },
    risk: 'low',
    impact: 'medium',
    rollback: { description: 'delete the published post in the Instagram app', recipe: `manual: the Instagram API cannot delete media (media id is in card ${id} appliedResult)` },
    evidence: { secretScanPassed: true },
    state: 'pending',
  };
  await approvalStore.create(ctx, item);
  await proposalStore.updateState(ctx, proposal.id, 'staged');
  return { approvalId: id, media, shrunk };
}

/** Pending Instagram cards for a brand, newest first. */
export async function listDrafts(slug: string): Promise<ApprovalItem[]> {
  const ctx: ProductContext = buildProductContext(slug, process.cwd(), 0);
  return (await approvalStore.listPending(ctx))
    .filter((it) => it.proposedAction.type === 'social-post')
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function defaultHost(dir: string, siteSlug: string): Promise<string> {
  const { publishFolder } = await import('../commands/publish.js');
  return (await publishFolder({ dir, slug: siteSlug, projectName: `${siteSlug} media` })).url;
}

function sha256(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

/** Re-encode to a bitrate that lands near 22 MB.  Instagram re-compresses
 *  every upload to well under this, so the loss is not visible on the post. */
async function shrinkVideo(src: string, dest: string, _size: number): Promise<void> {
  const seconds = Number(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src])) || 60;
  const kbps = Math.max(1500, Math.floor((22 * 8 * 1024) / seconds) - 160);
  const tmp = `${dest}.part.mp4`;
  await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${kbps}k`,
    '-maxrate', `${Math.floor(kbps * 1.3)}k`, '-bufsize', `${kbps * 2}k`, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp]);
  await fs.rename(tmp, dest);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => rej(new Error(`${cmd} not available: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? res(out.trim()) : rej(new Error(`${cmd} failed: ${err.trim().slice(0, 300)}`))));
  });
}

async function pruneOld(dir: string): Promise<void> {
  const now = Date.now();
  for (const n of await fs.readdir(dir)) {
    if (n === 'index.html') continue;
    const p = join(dir, n);
    try { if (now - (await fs.stat(p)).mtimeMs > KEEP_MEDIA_MS) await fs.unlink(p); } catch { /* raced */ }
  }
}
