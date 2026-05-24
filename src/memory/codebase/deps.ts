/**
 * Dependency snapshot — captures package.json + lockfile hashes so
 * later phases can detect "deps changed" without parsing the lockfile
 * every tick.
 *
 * Phase 1 snapshot includes:
 *   - dependencies / devDependencies / peerDependencies / optionalDependencies
 *   - package-lock.json sha256 (when present)
 *   - top-level project name + version
 *
 * Phase 3+ uses this to drive `dep-bump` proposals.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { productFiles } from '../paths.js';
import type { ProductContext } from '../../loop/types.js';

export interface DepsSnapshot {
  schemaVersion: 1;
  productSlug: string;
  generatedAt: number;
  projectName?: string;
  projectVersion?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  /** sha256 of package-lock.json when present.  null when no lockfile. */
  lockfileHash: string | null;
  lockfileName: string | null;
}

/** Generate the deps snapshot from `<repoRoot>/package.json` +
 *  the lockfile next to it.  Returns an empty-ish snapshot if there's
 *  no package.json (e.g. non-JS product). */
export async function generate(ctx: ProductContext): Promise<DepsSnapshot> {
  const pkgPath = join(ctx.repoRoot, 'package.json');
  const snap: DepsSnapshot = {
    schemaVersion: 1,
    productSlug: ctx.slug,
    generatedAt: Date.now(),
    dependencies: {},
    devDependencies: {},
    peerDependencies: {},
    optionalDependencies: {},
    lockfileHash: null,
    lockfileName: null,
  };
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as Record<string, unknown>;
      if (typeof pkg.name === 'string') snap.projectName = pkg.name;
      if (typeof pkg.version === 'string') snap.projectVersion = pkg.version;
      snap.dependencies = toStringMap(pkg.dependencies);
      snap.devDependencies = toStringMap(pkg.devDependencies);
      snap.peerDependencies = toStringMap(pkg.peerDependencies);
      snap.optionalDependencies = toStringMap(pkg.optionalDependencies);
    } catch { /* skip */ }
  }
  // Detect lockfile (npm, pnpm, yarn).
  for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    const p = join(ctx.repoRoot, name);
    if (existsSync(p)) {
      try {
        const buf = await fs.readFile(p);
        snap.lockfileHash = createHash('sha256').update(buf).digest('hex');
        snap.lockfileName = name;
        break;
      } catch { /* skip */ }
    }
  }
  await write(ctx, snap);
  return snap;
}

export async function read(ctx: ProductContext): Promise<DepsSnapshot | null> {
  const path = productFiles.depsJson(ctx);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as DepsSnapshot;
  } catch {
    return null;
  }
}

async function write(ctx: ProductContext, snap: DepsSnapshot): Promise<void> {
  const path = productFiles.depsJson(ctx);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, JSON.stringify(snap, null, 2), { mode: 0o600 });
}

function toStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
