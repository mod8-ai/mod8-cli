/**
 * architecture.md generator.
 *
 * Phase 1 ships a deterministic, no-LLM scan that produces a single
 * markdown file summarizing the codebase shape:
 *   - top-level layout (one-line per src/ subdirectory)
 *   - file count + LOC per subdirectory
 *   - hottest files (top 20 by churn — sourced from hotpaths.ts)
 *   - language/build hints (package.json scripts, key deps)
 *
 * Phase 2+ may layer an LLM-summarization pass on top to produce
 * "what each subsystem does" prose — but that's not required to prove
 * the foundation, and a deterministic scan ships zero LLM cost.
 *
 * Output: products/<slug>/memory/codebase/architecture.md.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { productFiles } from '../paths.js';
import type { ProductContext } from '../../loop/types.js';
import { generate as generateHotpaths, type HotpathEntry } from './hotpaths.js';
import { generate as generateDeps } from './deps.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', '__pycache__',
  '.mod8-worktrees',
]);

interface DirStats {
  relPath: string;
  fileCount: number;
  loc: number;
  firstFewFiles: string[];
}

/** Generate architecture.md from a single sense run.  Always
 *  refreshes hotpaths + deps as part of the same call so the produced
 *  markdown is consistent with the snapshots it references. */
export async function generate(ctx: ProductContext): Promise<{ path: string; sizeBytes: number }> {
  const hot = await generateHotpaths(ctx);
  const deps = await generateDeps(ctx);
  const dirs = await scanDirs(ctx.repoRoot, ctx.repoRoot, 3);
  const md = renderMarkdown(ctx, dirs, hot.entries.slice(0, 20), deps);
  const path = productFiles.architectureMd(ctx);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, md, { mode: 0o600 });
  return { path, sizeBytes: Buffer.byteLength(md) };
}

/** Recursive scan up to maxDepth, collecting per-directory stats.
 *  Skips ignored dirs and binary-looking files.  O(N) in the file
 *  tree — for a 50K-file repo this is sub-second; acceptable since
 *  sense runs hourly at most. */
async function scanDirs(repoRoot: string, current: string, maxDepth: number): Promise<DirStats[]> {
  const out: DirStats[] = [];
  if (maxDepth < 0) return out;
  let entries: { name: string; isDir: boolean }[];
  try {
    const raw = await fs.readdir(current, { withFileTypes: true });
    entries = raw
      .filter((e) => !e.name.startsWith('.'))
      .filter((e) => !IGNORE_DIRS.has(e.name))
      .map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return out;
  }
  let fileCount = 0;
  let loc = 0;
  const firstFewFiles: string[] = [];
  for (const e of entries) {
    if (e.isDir) continue;
    fileCount++;
    if (firstFewFiles.length < 8) firstFewFiles.push(e.name);
    const full = join(current, e.name);
    try {
      const st = await fs.stat(full);
      if (st.size > 1024 * 1024) continue; // skip files >1MB (binaries / generated)
      const buf = await fs.readFile(full, 'utf8');
      loc += buf.split('\n').length;
    } catch { /* skip unreadable */ }
  }
  out.push({
    relPath: relative(repoRoot, current) || '.',
    fileCount,
    loc,
    firstFewFiles,
  });
  for (const e of entries) {
    if (e.isDir) {
      const sub = await scanDirs(repoRoot, join(current, e.name), maxDepth - 1);
      out.push(...sub);
    }
  }
  return out;
}

function renderMarkdown(
  ctx: ProductContext,
  dirs: DirStats[],
  hottest: HotpathEntry[],
  deps: { projectName?: string; projectVersion?: string; dependencies: Record<string, string>; lockfileName: string | null }
): string {
  const lines: string[] = [];
  lines.push(`# Architecture — ${ctx.slug}`);
  lines.push('');
  lines.push(`_Generated ${new Date().toISOString()} by mod8 loop sense.  This file is auto-maintained; edits are overwritten._`);
  lines.push('');
  lines.push(`**Repo root:** ${ctx.repoRoot}`);
  if (deps.projectName) lines.push(`**Project:** ${deps.projectName}${deps.projectVersion ? `@${deps.projectVersion}` : ''}`);
  if (deps.lockfileName) lines.push(`**Lockfile:** ${deps.lockfileName}`);
  lines.push('');

  lines.push('## Directory layout');
  lines.push('');
  lines.push('| Path | Files | LOC | Sample |');
  lines.push('|---|---|---|---|');
  for (const d of dirs.slice(0, 40)) {
    if (d.fileCount === 0 && d.relPath !== '.') continue;
    const sample = d.firstFewFiles.slice(0, 3).join(', ');
    lines.push(`| \`${d.relPath}\` | ${d.fileCount} | ${d.loc} | ${sample} |`);
  }
  lines.push('');

  lines.push('## Hottest files (last 90 days of churn)');
  lines.push('');
  if (hottest.length === 0) {
    lines.push('_No git history available (not a git repo or empty)._');
  } else {
    for (const h of hottest) {
      const when = h.lastTouchedAt
        ? new Date(h.lastTouchedAt).toISOString().slice(0, 10)
        : '?';
      lines.push(`- \`${h.path}\` — ${h.touchedCount} commits (last: ${when})`);
    }
  }
  lines.push('');

  lines.push('## Top dependencies');
  lines.push('');
  const depKeys = Object.keys(deps.dependencies).slice(0, 20);
  if (depKeys.length === 0) {
    lines.push('_No package.json dependencies found._');
  } else {
    for (const k of depKeys) {
      lines.push(`- \`${k}\` — ${deps.dependencies[k]}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

export async function read(ctx: ProductContext): Promise<string | null> {
  const path = productFiles.architectureMd(ctx);
  if (!existsSync(path)) return null;
  try {
    return fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}
