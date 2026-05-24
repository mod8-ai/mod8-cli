/**
 * Owners memory — captures CODEOWNERS (if present) and the
 * contributor map derived from `git shortlog`.  Used by Phase 3+ act
 * phase to mention reviewers on auto-opened PRs, and by ideate to
 * weight signals from frequent contributors higher.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { productFiles } from '../paths.js';
import type { ProductContext } from '../../loop/types.js';

const execFileP = promisify(execFile);

const CODEOWNERS_PATHS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

/** Top contributors by commit count over the last 90 days.  When the
 *  repo has no recent history we fall back to all-time. */
export interface Contributor {
  name: string;
  email: string;
  commits: number;
}

export interface OwnersSnapshot {
  schemaVersion: 1;
  productSlug: string;
  generatedAt: number;
  codeownersText: string | null;
  topContributors: Contributor[];
}

/** Generate the owners snapshot.  Writes a small markdown file at
 *  memory/codebase/owners.md alongside the JSON metadata. */
export async function generate(ctx: ProductContext): Promise<OwnersSnapshot> {
  let codeownersText: string | null = null;
  for (const rel of CODEOWNERS_PATHS) {
    const full = join(ctx.repoRoot, rel);
    if (existsSync(full)) {
      try {
        codeownersText = await fs.readFile(full, 'utf8');
        break;
      } catch { /* keep looking */ }
    }
  }

  let contribStdout = '';
  try {
    const r = await execFileP(
      'git',
      ['shortlog', '-sne', '--no-merges', '--since=90.days', 'HEAD'],
      { cwd: ctx.repoRoot, maxBuffer: 1024 * 1024 }
    );
    contribStdout = r.stdout;
    if (!contribStdout.trim()) {
      // Fallback: all-time shortlog.
      const r2 = await execFileP(
        'git',
        ['shortlog', '-sne', '--no-merges', 'HEAD'],
        { cwd: ctx.repoRoot, maxBuffer: 1024 * 1024 }
      );
      contribStdout = r2.stdout;
    }
  } catch { /* not a git repo / git missing — empty result */ }

  const topContributors: Contributor[] = [];
  for (const raw of contribStdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // shortlog -sne format: "    NN\tName <email>"
    const m = line.match(/^(\d+)\s+(.+?)\s+<([^>]+)>$/);
    if (!m) continue;
    topContributors.push({
      commits: Number(m[1]),
      name: m[2]!,
      email: m[3]!,
    });
  }
  topContributors.sort((a, b) => b.commits - a.commits);
  const top = topContributors.slice(0, 20);

  const snap: OwnersSnapshot = {
    schemaVersion: 1,
    productSlug: ctx.slug,
    generatedAt: Date.now(),
    codeownersText,
    topContributors: top,
  };

  await writeJson(ctx, snap);
  await writeMd(ctx, snap);
  return snap;
}

async function writeJson(ctx: ProductContext, snap: OwnersSnapshot): Promise<void> {
  // JSON form lives next to the .md form so consumers can pick which
  // they want.  Path: memory/codebase/owners.md → swap extension.
  const mdPath = productFiles.ownersMd(ctx);
  const jsonPath = mdPath.replace(/\.md$/, '.json');
  await fs.mkdir(dirname(jsonPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(jsonPath, JSON.stringify(snap, null, 2), { mode: 0o600 });
}

async function writeMd(ctx: ProductContext, snap: OwnersSnapshot): Promise<void> {
  const path = productFiles.ownersMd(ctx);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lines: string[] = [
    `# Owners — ${snap.productSlug}`,
    '',
    `_Generated ${new Date(snap.generatedAt).toISOString()} by mod8 loop sense._`,
    '',
  ];
  if (snap.codeownersText) {
    lines.push('## CODEOWNERS');
    lines.push('');
    lines.push('```');
    lines.push(snap.codeownersText.trim());
    lines.push('```');
    lines.push('');
  }
  lines.push('## Top contributors (last 90 days, fallback all-time)');
  lines.push('');
  if (snap.topContributors.length === 0) {
    lines.push('_No contributors found (no git history or repo not a git repo)._');
  } else {
    for (const c of snap.topContributors) {
      lines.push(`- ${c.name} — ${c.commits} commit${c.commits === 1 ? '' : 's'}`);
    }
  }
  lines.push('');
  await fs.writeFile(path, lines.join('\n'), { mode: 0o600 });
}
