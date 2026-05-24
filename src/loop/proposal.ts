/**
 * Proposal — the unit of currency between ideate and build phases.
 *
 * A Proposal is what ideate produces (one to many per ideate run) and
 * what prioritize picks from.  After build succeeds, the Proposal
 * becomes the basis for an ApprovalItem.  Rejected/dropped Proposals
 * are persisted briefly for /why context but garbage-collected after
 * 14 days.
 *
 * Storage: products/<slug>/proposals/prop_<id>.json + an index.jsonl
 * for fast listing.  JSON-per-item (not JSONL) because Proposal body
 * can be large (target file lists, evidence digests) and we want to
 * delete individual items cleanly.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { productPath } from '../memory/paths.js';
import type { ProductContext } from './types.js';

/** Proposal kinds — extensible enum; new kinds need a priors entry but
 *  don't need code changes elsewhere.  Curated list seeds the Beta
 *  priors at α=β=1 when first encountered.
 *
 *  Coverage is deliberately PRODUCT-WIDE: code, docs, UI/UX,
 *  onboarding, error copy, reliability, growth copy, and product
 *  strategy all flow through the same loop.  The split exists so the
 *  learn phase can track acceptance rates per category — UI/UX
 *  proposals are NOT a special feature, they are just one kind among
 *  many. */
export const PROPOSAL_KINDS = [
  // ── code & dependencies ──────────────────────────────────────────
  'refactor',
  'bug-fix',
  'feature-add',
  'comment-update',
  'dep-bump',
  // ── docs ─────────────────────────────────────────────────────────
  'doc-update',
  'readme-update',
  // ── terminal UI / UX (Ink panels, slash commands, transcript) ────
  'ui-ux',                  // layout, color, spacing, status line, transcript formatting
  'command-ux',             // slash-command discoverability, intent routing copy, error recovery
  'onboarding-ux',          // first-run banner, login wizard, key paste flow
  'error-copy',             // clearer error messages anywhere in the product
  // ── reliability ──────────────────────────────────────────────────
  'reliability-fix',        // flaky tests, crash recovery, edge cases, race conditions
  // ── product surface ──────────────────────────────────────────────
  'website-copy',
  'marketing-post',
  'growth-copy',            // landing hero, README pitch, npm description, pricing copy
  'user-reply',
  'experiment',             // feature flags, A/B variants, onboarding experiments
  'paid-campaign',
  'roadmap-change',
  'product-strategy',       // positioning, pricing tier shape, what-to-cut decisions
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const ProposalSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),                           // prop_<yyyy-mm-dd>_<8hex>
  productSlug: z.string(),
  createdAt: z.number(),
  createdByPhase: z.literal('ideate'),
  /** Tick that originated this proposal — useful for tracing. */
  originTickId: z.number(),
  kind: z.enum(PROPOSAL_KINDS),
  title: z.string().max(120),
  summary: z.string(),
  /** Files the proposal intends to touch.  Build phase is enforced to
   *  touch ONLY these (plus their tests). */
  targetFiles: z.array(z.string()),
  /** Signal digests this proposal is responding to.  Used by /why and
   *  by the learn phase to update per-source weights. */
  evidenceDigests: z.array(z.string()),
  /** Brief justification — surfaced in /approvals [w]hy. */
  rationale: z.string(),
  estimatedEffort: z.enum(['small', 'medium', 'large']),
  /** Risk + impact — assigned by ideate, refined by build. */
  estimatedRisk: z.enum(['low', 'medium', 'high']),
  estimatedImpact: z.enum(['low', 'medium', 'high']),
  /** Required: how to undo if applied.  Rollback recipe ships with
   *  every proposal — adapters that can't produce one downgrade the
   *  action to needs-approval at L+1. */
  rollbackHint: z.string(),
  /** Concrete measurable outcome.  Read by measure phase. */
  successCriteria: z.string(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export interface ProposalIndexEntry {
  id: string;
  kind: ProposalKind;
  title: string;
  createdAt: number;
  originTickId: number;
  state: 'pending-build' | 'building' | 'staged' | 'rejected-priority' | 'rejected-build' | 'dropped';
}

const PROPOSALS_DIR = 'proposals';
const INDEX_FILE = 'index.jsonl';

/** Generate a fresh proposal id.  Format: `prop_<YYYY-MM-DD>_<8hex>`
 *  — sortable by creation date, opaque hex suffix avoids collisions. */
export function newProposalId(now: number = Date.now()): string {
  const d = new Date(now);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `prop_${date}_${hex}`;
}

/** Write a proposal + append its index entry.  Atomic per-item via
 *  rename; the index entry append is best-effort (rebuildable from
 *  the per-item files). */
export async function save(ctx: ProductContext, proposal: Proposal): Promise<void> {
  const itemPath = productPath(ctx, PROPOSALS_DIR, `${proposal.id}.json`);
  await fs.mkdir(dirname(itemPath), { recursive: true, mode: 0o700 });
  const tmp = `${itemPath}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(proposal, null, 2), { mode: 0o600 });
  await fs.rename(tmp, itemPath);
  await appendIndex(ctx, {
    id: proposal.id,
    kind: proposal.kind,
    title: proposal.title,
    createdAt: proposal.createdAt,
    originTickId: proposal.originTickId,
    state: 'pending-build',
  });
}

/** Read a proposal by id.  Returns null if missing. */
export async function load(ctx: ProductContext, id: string): Promise<Proposal | null> {
  const itemPath = productPath(ctx, PROPOSALS_DIR, `${id}.json`);
  if (!existsSync(itemPath)) return null;
  try {
    const parsed = ProposalSchema.parse(JSON.parse(await fs.readFile(itemPath, 'utf8')));
    return parsed;
  } catch {
    return null;
  }
}

/** Update an existing proposal's index state (e.g. 'building' →
 *  'staged' or 'rejected-build').  Index is append-only; latest entry
 *  wins for a given id when callers read. */
export async function updateState(ctx: ProductContext, id: string, state: ProposalIndexEntry['state']): Promise<void> {
  const existing = await load(ctx, id);
  if (!existing) return;
  await appendIndex(ctx, {
    id,
    kind: existing.kind,
    title: existing.title,
    createdAt: existing.createdAt,
    originTickId: existing.originTickId,
    state,
  });
}

/** List proposals (latest state per id) — newest first. */
export async function list(ctx: ProductContext): Promise<ProposalIndexEntry[]> {
  const indexPath = productPath(ctx, PROPOSALS_DIR, INDEX_FILE);
  if (!existsSync(indexPath)) return [];
  const buf = await fs.readFile(indexPath, 'utf8');
  const latest = new Map<string, ProposalIndexEntry>();
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ProposalIndexEntry;
      latest.set(entry.id, entry);
    } catch { /* skip */ }
  }
  return Array.from(latest.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Garbage-collect rejected proposals older than 14 days. */
export async function gc(ctx: ProductContext, now: number = Date.now()): Promise<number> {
  const cutoff = now - 14 * 24 * 60 * 60 * 1000;
  const entries = await list(ctx);
  let removed = 0;
  for (const e of entries) {
    if (e.createdAt > cutoff) continue;
    if (e.state !== 'rejected-priority' && e.state !== 'rejected-build' && e.state !== 'dropped') continue;
    try {
      await fs.unlink(productPath(ctx, PROPOSALS_DIR, `${e.id}.json`));
      removed++;
    } catch { /* tolerate */ }
  }
  return removed;
}

async function appendIndex(ctx: ProductContext, entry: ProposalIndexEntry): Promise<void> {
  const indexPath = productPath(ctx, PROPOSALS_DIR, INDEX_FILE);
  await fs.mkdir(dirname(indexPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(indexPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

/** Helper for tests / fixtures. */
export function _PROPOSALS_DIR(): string {
  return PROPOSALS_DIR;
}

void join; // satisfy unused-import lints if future code restructures
