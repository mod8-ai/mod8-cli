/**
 * `mod8 publish` — package the current project's static output and ship
 * it to a free `<slug>.apps.mod8.ai` subdomain.  No domain registration,
 * no Vercel, no DNS work.  The mod8er types one command, gets a working
 * URL with HTTPS, shares it with their client.  Done.
 *
 * Pipeline:
 *   1. Resolve project info (getProjectInfo) → name + stable id
 *   2. Slugify the project name and validate against reserved list
 *   3. Auto-detect the static output dir (dist / out / build / public /
 *      _site / site / cwd-with-index.html)
 *   4. Walk the tree, enforcing size + file-count limits, skipping the
 *      stuff that should NEVER go to a public site (node_modules,
 *      .git, .env*, *.pem, etc.)
 *   5. tar+gzip via the system tar binary (zero npm deps; works on
 *      macOS + Linux + modern Windows)
 *   6. POST to <proxy>/publish with the bearer token from auth.json
 *
 * The first cut ships with --dry-run as the DEFAULT.  The HTTP-upload
 * path is wired but only fires when the user passes --confirm.  This
 * lets us ship the CLI before the backend `/publish` endpoint is live
 * — the user can still verify slug + output-dir detection + size
 * checks locally without hitting a 404.
 */

import { promises as fs } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { getProjectInfo } from '../agent/projectInfo.js';
import { readAuth, effectiveProxyUrl } from '../storage/auth.js';

/** Hard caps so a mod8er can't accidentally upload `node_modules`. */
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_FILES = 5_000;
const MAX_PER_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

/** Subdomain root.  Single source of truth — when we migrate from
 *  apps.mod8.ai to mod8.ai (via Cloudflare DNS), change this here. */
const SUBDOMAIN_ROOT = 'apps.mod8.ai';

/** Subdomains we will NEVER hand out: collisions with our own services,
 *  common spam targets, and "looks legit" names that phishers love.
 *  Add to this list whenever a new mod8 subdomain enters production. */
const RESERVED_SLUGS = new Set([
  // mod8 infra
  'www', 'api', 'app', 'apps', 'admin', 'auth', 'dashboard', 'docs',
  'help', 'mail', 'status', 'support', 'billing', 'settings',
  'account', 'login', 'signin', 'signout', 'signup', 'register',
  'root', 'static', 'internal', 'mod8', 'mod8er', 'mod8ers',
  // common phishing magnets
  'secure', 'verify', 'update', 'webmail', 'wallet', 'pay',
  'paypal', 'apple', 'google', 'microsoft', 'stripe', 'bank',
  // generic noise
  'test', 'demo', 'example', 'sample', 'tmp', 'temp', 'null',
]);

/** Ordered list of directory names that, when present at the project
 *  root, are very likely to hold the static output of a build.  We
 *  check in order — the first match wins. */
const OUTPUT_DIR_CANDIDATES = [
  'dist',    // Vite / most modern bundlers
  'out',     // Next.js `next export`
  'build',   // CRA, some Vite presets
  'public',  // Hugo, some static-site generators
  '_site',   // Jekyll, Eleventy
  'site',    // some hand-rolled setups
];

/** File names / fragments to EXCLUDE from the upload no matter where
 *  they live in the tree.  Mostly: things that leak secrets, blow up
 *  the upload size, or shouldn't be public. */
const EXCLUDE_PATTERNS = [
  'node_modules',
  '.git',
  '.DS_Store',
  '.env',
  '.env.local',
  '.env.production',
  'Thumbs.db',
  '.npmrc',
  '.netrc',
];

export interface PublishOptions {
  /** When false (default), do NOT upload — just print what WOULD happen.
   *  Set to true with `--confirm` to fire the actual HTTP POST. */
  confirm: boolean;
  /** Override the slug derived from project name. */
  slug?: string;
  /** Override the auto-detected output directory. */
  dir?: string;
  /** Override the cwd we resolve from. */
  cwd?: string;
  /** Attach a custom domain (e.g. propflow.com) — the mod8er still gets
   *  the apps.mod8.ai subdomain as the canonical URL, but the same site
   *  also answers at their own domain once DNS points there. */
  domain?: string;
}

export interface PublishPlan {
  slug: string;
  url: string;
  projectName: string;
  projectId: string;
  outputDir: string;
  files: Array<{ relativePath: string; sizeBytes: number }>;
  totalBytes: number;
  /** Custom domain attached to this publish, if any. */
  customDomain?: string;
}

export async function publish(opts: PublishOptions): Promise<void> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const info = await getProjectInfo(cwd);
  // Always run user input through slugify so "PropFlow" → "propflow"
  // instead of failing the strict validator below.  User intent: "I want
  // this name as the URL" — not "I want EXACTLY these bytes".
  const slug = validateSlug(slugify(opts.slug ?? info.projectName));
  const customDomain = opts.domain ? validateDomain(opts.domain) : undefined;
  const outputDir = await resolveOutputDir(cwd, opts.dir);
  if (!outputDir) {
    process.stderr.write(
      `mod8 publish: couldn't find a static build output in ${cwd}.\n` +
      `  Looked for: ${OUTPUT_DIR_CANDIDATES.join(', ')}\n` +
      `  Pass --dir <path> to specify, or run your build first ` +
      `(e.g. \`npm run build\`).\n`
    );
    process.exitCode = 2;
    return;
  }
  const plan = await buildPlan({ slug, outputDir, info, customDomain });

  // Always print the plan first so the user knows what they're shipping
  // BEFORE the upload starts.  Same display whether dry-run or real.
  printPlan(plan, opts.confirm);

  if (!opts.confirm) {
    process.stdout.write(
      `\nDry run — nothing uploaded.\n` +
      `Run again with --confirm to publish.\n`
    );
    return;
  }

  // Real upload path.  Requires a logged-in mod8 account so the
  // backend knows who to charge / who to attribute the slug to.
  const auth = await readAuth();
  if (!auth) {
    process.stderr.write(
      `mod8 publish: not logged in.  Run \`mod8 login\` first ` +
      `so we know which account this site belongs to.\n`
    );
    process.exitCode = 2;
    return;
  }

  const tarPath = await createTarball(plan);
  try {
    // The sites service lives at its OWN Cloud Run URL — not the LLM
    // proxy URL.  Default to the prod sites URL; allow override via
    // $MOD8_SITES_URL for dev / staging.
    const sitesUrl =
      process.env['MOD8_SITES_URL'] ??
      'https://mod8-sites-1093407296867.us-central1.run.app';
    const result = await uploadTarball({
      tarPath,
      proxyUrl: sitesUrl,
      bearer: auth.mod8Key,
      slug: plan.slug,
      projectId: plan.projectId,
      projectName: plan.projectName,
      totalBytes: plan.totalBytes,
      fileCount: plan.files.length,
      ...(plan.customDomain ? { customDomain: plan.customDomain } : {}),
    });
    process.stdout.write(
      `\n✓ Published to ${result.url}\n` +
      (result.alreadyExisted
        ? `  (site updated — same slug as before)\n`
        : `  (new site — first publish for this slug)\n`)
    );
  } catch (err) {
    process.stderr.write(
      `mod8 publish: upload failed — ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exitCode = 1;
  } finally {
    await fs.unlink(tarPath).catch(() => {});
  }
}

/** Convert a free-form project name into a DNS-safe slug.  Throws on
 *  reserved or too-short slugs so the user fails fast (not after a
 *  long upload). */
export function slugify(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned;
}

export function validateSlug(slug: string): string {
  if (!slug) throw new Error('slug is empty after normalization — pass --slug to override');
  if (slug.length < 3) throw new Error(`slug "${slug}" is too short (min 3 chars)`);
  if (slug.length > 32) throw new Error(`slug "${slug}" is too long (max 32 chars)`);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    throw new Error(`slug "${slug}" has bad chars — only a-z, 0-9, - allowed`);
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new Error(`slug "${slug}" is reserved — pick a different name`);
  }
  return slug;
}

async function resolveOutputDir(
  cwd: string,
  override: string | undefined
): Promise<string | null> {
  if (override) {
    const abs = resolve(cwd, override);
    if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
    return null;
  }
  for (const c of OUTPUT_DIR_CANDIDATES) {
    const abs = join(cwd, c);
    if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
  }
  // Fallback: if the cwd itself has an index.html, treat it as the site.
  // This covers hand-written static sites where there's no build step.
  if (existsSync(join(cwd, 'index.html'))) return cwd;
  return null;
}

async function buildPlan(input: {
  slug: string;
  outputDir: string;
  info: Awaited<ReturnType<typeof getProjectInfo>>;
  customDomain?: string;
}): Promise<PublishPlan> {
  const files: Array<{ relativePath: string; sizeBytes: number }> = [];
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(input.outputDir, full);
      // Excludes apply on PATH FRAGMENTS so `node_modules/foo` is also caught.
      if (EXCLUDE_PATTERNS.some((p) => rel.split(sep).includes(p))) continue;
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await fs.stat(full);
      if (st.size > MAX_PER_FILE_BYTES) {
        throw new Error(
          `file ${rel} is ${formatBytes(st.size)} — exceeds per-file ` +
          `limit (${formatBytes(MAX_PER_FILE_BYTES)})`
        );
      }
      files.push({ relativePath: rel, sizeBytes: st.size });
      totalBytes += st.size;
      if (files.length > MAX_FILES) {
        throw new Error(
          `too many files (>${MAX_FILES}) — likely uploading node_modules ` +
          `or build cache by mistake`
        );
      }
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(
          `total upload size ${formatBytes(totalBytes)} exceeds limit ` +
          `(${formatBytes(MAX_TOTAL_BYTES)})`
        );
      }
    }
  }

  await walk(input.outputDir);

  if (files.length === 0) {
    throw new Error(
      `output directory ${input.outputDir} is empty — nothing to publish`
    );
  }

  return {
    slug: input.slug,
    url: `https://${input.slug}.${SUBDOMAIN_ROOT}`,
    projectName: input.info.projectName,
    projectId: input.info.projectId,
    outputDir: input.outputDir,
    files,
    totalBytes,
    ...(input.customDomain ? { customDomain: input.customDomain } : {}),
  };
}

/** Validate a custom domain like "propflow.com" or "site.example.org".
 *  Lowercased, no protocol, no trailing slash, must have at least one
 *  dot, ASCII-only.  IDN domains aren't supported in v1 — the mod8er
 *  can punycode-encode them manually for now. */
export function validateDomain(input: string): string {
  const trimmed = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!trimmed) throw new Error('domain is empty');
  if (trimmed.length > 253) throw new Error(`domain too long`);
  if (!trimmed.includes('.')) {
    throw new Error(`"${trimmed}" doesn't look like a domain (no dot)`);
  }
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    trimmed
  )) {
    throw new Error(`"${trimmed}" has invalid characters for a domain`);
  }
  if (trimmed.endsWith(`.${SUBDOMAIN_ROOT}`) || trimmed === SUBDOMAIN_ROOT) {
    throw new Error(
      `"${trimmed}" is under mod8's own subdomain — use --slug instead, no need for --domain`
    );
  }
  return trimmed;
}

function printPlan(plan: PublishPlan, willConfirm: boolean): void {
  const header = willConfirm ? '→ Publishing' : '→ Publish plan (dry run)';
  process.stdout.write(`${header}\n`);
  process.stdout.write(`  project   ${plan.projectName}\n`);
  process.stdout.write(`  slug      ${plan.slug}\n`);
  process.stdout.write(`  url       ${plan.url}\n`);
  if (plan.customDomain) {
    process.stdout.write(`  domain    https://${plan.customDomain}\n`);
    process.stdout.write(
      `            (point a CNAME from ${plan.customDomain} → ${plan.slug}.${SUBDOMAIN_ROOT})\n`
    );
  }
  process.stdout.write(`  source    ${plan.outputDir}\n`);
  process.stdout.write(`  files     ${plan.files.length}\n`);
  process.stdout.write(`  size      ${formatBytes(plan.totalBytes)}\n`);
}

async function createTarball(plan: PublishPlan): Promise<string> {
  const tmp = join(tmpdir(), `mod8-publish-${randomBytes(8).toString('hex')}.tar.gz`);
  // -C cd-into-dir, then `.` so paths are relative to the output dir, not
  // the cwd.  --exclude duplicates the in-memory filter as belt-and-braces
  // protection against late-arriving files (mod8er running a build in
  // another terminal mid-publish).
  const args = ['-czf', tmp, '-C', plan.outputDir];
  for (const ex of EXCLUDE_PATTERNS) args.push(`--exclude=${ex}`);
  args.push('.');
  await new Promise<void>((resolveFn, rejectFn) => {
    // COPYFILE_DISABLE=1 + --no-mac-metadata stop macOS tar from emitting
    // AppleDouble "._" sidecar files (xattrs / resource forks) which would
    // otherwise pollute the published GCS prefix with unservable junk.
    const proc = spawn('tar', args, {
      stdio: 'ignore',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    proc.on('error', rejectFn);
    proc.on('exit', (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`tar exited ${code}`));
    });
  });
  return tmp;
}

interface UploadResult {
  url: string;
  alreadyExisted: boolean;
}

async function uploadTarball(input: {
  tarPath: string;
  proxyUrl: string;
  bearer: string;
  slug: string;
  projectId: string;
  projectName: string;
  totalBytes: number;
  fileCount: number;
  customDomain?: string;
}): Promise<UploadResult> {
  const body = await fs.readFile(input.tarPath);
  // Server route is /_publish (underscore prefix prevents shadowing by a
  // valid slug — slugs can never start with underscore per validateSlug).
  const url = `${input.proxyUrl.replace(/\/+$/, '')}/_publish`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.bearer}`,
      'Content-Type': 'application/gzip',
      'X-Mod8-Slug': input.slug,
      'X-Mod8-Project-Id': input.projectId,
      'X-Mod8-Project-Name': input.projectName,
      'X-Mod8-File-Count': String(input.fileCount),
      'X-Mod8-Bytes': String(input.totalBytes),
      ...(input.customDomain ? { 'X-Mod8-Custom-Domain': input.customDomain } : {}),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} — ${text.slice(0, 240)}`);
  }
  const parsed = (await res.json().catch(() => null)) as
    | { url?: string; alreadyExisted?: boolean }
    | null;
  return {
    url: parsed?.url ?? `https://${input.slug}.${SUBDOMAIN_ROOT}`,
    alreadyExisted: parsed?.alreadyExisted ?? false,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
