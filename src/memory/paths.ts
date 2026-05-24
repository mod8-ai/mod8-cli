/**
 * Single source of truth for the mod8 loop's filesystem layout.
 *
 * Every read/write under products/<slug>/ MUST resolve through one of
 * the helpers in this module.  `assertWithinProduct` runs at the
 * boundary of every write so a bug in adapter code can't cross product
 * boundaries — isolation is enforced by `node:path.relative`, not by
 * code review.
 *
 * Mirrors the existing CONFIG_DIR pattern used by storage/auth.ts,
 * storage/keys.ts, storage/sessions.ts — env override via
 * MOD8_CONFIG_DIR, default ~/.config/mod8.
 */

import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { ProductContext } from '../loop/types.js';

export const CONFIG_DIR =
  process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8');

export const PRODUCTS_ROOT = join(CONFIG_DIR, 'products');

/** Reserved slug for the default-inheritance policy chain (Phase 4).
 *  Phase 1 doesn't read it, but we block it from being used as a real
 *  product slug now to avoid a future collision. */
export const RESERVED_PRODUCT_SLUGS: readonly string[] = ['_defaults'];

/** Globally-scoped paths — not per-product.  Used by the daemon
 *  (Phase 2) and the kill switch (Phase 1). */
export const GLOBAL_PATHS = {
  killSwitch: join(CONFIG_DIR, 'STOP'),
  tickLock: join(CONFIG_DIR, 'loop.tick.lock'),
  daemonPid: join(CONFIG_DIR, 'loop.pid'),
} as const;

/** Validate a product slug.  Lowercase letters, digits, dashes; 1-40
 *  chars; not in the reserved list.  Anything else throws — keep the
 *  filesystem layout predictable. */
export function validateProductSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) {
    throw new Error(
      `invalid product slug "${slug}" — must match [a-z0-9][a-z0-9-]{0,39}`
    );
  }
  if (RESERVED_PRODUCT_SLUGS.includes(slug)) {
    throw new Error(`product slug "${slug}" is reserved`);
  }
}

/** Resolve an absolute path inside a product's directory.  Pass the
 *  ProductContext (not the slug) so any caller already proved it owns
 *  the context.  The returned path is checked to actually live under
 *  ctx.productDir — refuses path traversal attempts. */
export function productPath(ctx: ProductContext, ...segments: string[]): string {
  const full = resolve(ctx.productDir, ...segments);
  assertWithinProduct(ctx, full);
  return full;
}

/** Throws unless `target` is `ctx.productDir` itself or a descendant.
 *  This is the runtime boundary that enforces per-product isolation —
 *  every write under products/<slug>/ goes through productPath() which
 *  calls this.  Mis-routed writes fail loud rather than silently
 *  corrupting another product's state. */
export function assertWithinProduct(ctx: ProductContext, target: string): void {
  const rel = relative(ctx.productDir, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `path escape: ${target} is not within product dir ${ctx.productDir}`
    );
  }
}

/** Absolute path to a per-product file under products/<slug>/.  Used
 *  by the daemon to walk every product on startup (Phase 2). */
export function productDirFor(slug: string): string {
  validateProductSlug(slug);
  return join(PRODUCTS_ROOT, slug);
}

/** Absolute path to an adapter credential file under
 *  products/<slug>/connectors/<adapter>.json.  Auth files are created
 *  by adapter `connect()` impls; the dir is created 0o700 on demand. */
export function connectorPath(ctx: ProductContext, adapterId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(adapterId)) {
    throw new Error(`invalid adapter id "${adapterId}"`);
  }
  return productPath(ctx, 'connectors', `${adapterId}.json`);
}

/** Build a ProductContext for a given slug, with the repo root the
 *  caller passes (typically process.cwd()).  Phase 1 only ever builds
 *  ctx for slug='mod8'; Phase 4 adds the `mod8 connect` wizard that
 *  builds ctx for arbitrary slugs. */
export function buildProductContext(
  slug: string,
  repoRoot: string,
  tickId: number
): ProductContext {
  validateProductSlug(slug);
  const productDir = productDirFor(slug);
  return {
    slug,
    productDir,
    repoRoot: resolve(repoRoot),
    tickId,
    selfCommitTrailer: `mod8-loop: ${slug}`,
  };
}

/** Quick-lookup helpers — every well-known per-product file lives
 *  behind a named accessor so refactors are localized to this module. */
export const productFiles = {
  productMd: (ctx: ProductContext) => productPath(ctx, 'product.md'),
  policyYaml: (ctx: ProductContext) => productPath(ctx, 'policy.yaml'),
  state: (ctx: ProductContext) => productPath(ctx, 'state.json'),
  events: (ctx: ProductContext) => productPath(ctx, 'events.jsonl'),
  audit: (ctx: ProductContext) => productPath(ctx, 'audit.jsonl'),
  spend: (ctx: ProductContext) => productPath(ctx, 'spend.jsonl'),
  queueLock: (ctx: ProductContext) => productPath(ctx, 'queue.lock'),
  worktrees: (ctx: ProductContext) => productPath(ctx, 'worktrees.jsonl'),
  priors: (ctx: ProductContext) => productPath(ctx, 'memory', 'priors.json'),
  architectureMd: (ctx: ProductContext) =>
    productPath(ctx, 'memory', 'codebase', 'architecture.md'),
  hotpathsJson: (ctx: ProductContext) =>
    productPath(ctx, 'memory', 'codebase', 'hotpaths.json'),
  depsJson: (ctx: ProductContext) =>
    productPath(ctx, 'memory', 'codebase', 'deps.json'),
  ownersMd: (ctx: ProductContext) =>
    productPath(ctx, 'memory', 'codebase', 'owners.md'),
  feedbackJsonl: (ctx: ProductContext, source: string) => {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(source)) {
      throw new Error(`invalid feedback source "${source}"`);
    }
    return productPath(ctx, 'memory', 'feedback', `${source}.jsonl`);
  },
} as const;
