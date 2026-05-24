/**
 * ApprovalItem Zod schema.  Single source of truth for what the
 * approval queue stores.  Migrations in approval/migrate.ts (chained
 * pure functions on read) keep this stable across versions.
 */

import { z } from 'zod';

export const APPROVAL_KINDS = [
  'code',           // file edits, branch + PR
  'doc',            // markdown / README changes
  'website-copy',   // text on the marketing site
  'marketing',      // social posts, blog drafts
  'user-reply',     // support / GitHub-issue replies
  'experiment',     // feature flag toggles, A/B variants
  'paid-campaign',  // ad spend
  'roadmap',        // changes to roadmap.md
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** Discriminated proposed-action union — what will actually happen
 *  if the user approves.  Phase 2 covers file-edit + git-pr.  Phase
 *  3+ extends with social-post, user-reply, experiment, ad-spend. */
export const ProposedActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('file-edit'),
    files: z.array(z.string()),
    /** Unified diff (patch) — the visual surface in /approvals. */
    diff: z.string(),
    diffStats: z.object({
      added: z.number(),
      removed: z.number(),
      files: z.number(),
    }),
  }),
  z.object({
    type: z.literal('git-pr'),
    repo: z.string(),                  // owner/repo
    baseBranch: z.string(),
    headBranch: z.string(),
    title: z.string(),
    body: z.string(),
    /** Bundled file-edit info shown in the same Panel row. */
    files: z.array(z.string()),
    diff: z.string(),
    diffStats: z.object({
      added: z.number(),
      removed: z.number(),
      files: z.number(),
    }),
  }),
  z.object({
    type: z.literal('social-post'),
    channel: z.string(),                // 'twitter' | 'bluesky' | 'hn' | 'reddit'
    text: z.string(),
    /** Optional reply target (e.g. tweet id, post slug). */
    inReplyTo: z.string().optional(),
    /** Media uploads (Phase 4+). */
    media: z.array(z.object({ kind: z.string(), source: z.string() })).optional(),
  }),
  z.object({
    type: z.literal('user-reply'),
    channel: z.string(),                // 'intercom' | 'crisp' | 'front' | 'email' | 'github-issue'
    threadId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('website-copy'),
    path: z.string(),
    diff: z.string(),
  }),
  z.object({
    type: z.literal('experiment'),
    flag: z.string(),
    variant: z.string(),
    rolloutPct: z.number().min(0).max(100),
  }),
  z.object({
    type: z.literal('ad-spend'),
    accountId: z.string(),
    platform: z.string(),               // 'google' | 'meta' | …
    campaignId: z.string().optional(),
    amountUsd: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal('npm-publish'),
    packageName: z.string(),
    version: z.string(),
    tag: z.string().default('latest'),
  }),
]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const ApprovalStateSchema = z.enum([
  'pending',                // newly created, waiting for human
  'pending-revalidation',   // user edited; daemon re-runs tests
  'revalidation-failed',    // tests failed after edit; needs user attention
  'approved',               // user approved; act phase will run
  'applied',                // act phase succeeded
  'failed',                 // act phase failed
  'rejected',               // user rejected
  'rolled-back',            // applied then rolled back
  'stale',                  // auto-archived after 14 days untouched
]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const SignalReferenceSchema = z.object({
  source: z.string(),
  digest: z.string(),
  ts: z.number(),
});

export const RollbackRecipeSchema = z.object({
  description: z.string(),
  recipe: z.string(),                     // human-readable command
  /** Adapter-opaque payload, populated by adapter.apply()'s
   *  ActionResult.  Used by adapter.rollback(). */
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const ApprovalEvidenceSchema = z.object({
  testsPassed: z.boolean().optional(),
  testOutput: z.string().optional(),
  secretScanPassed: z.boolean().optional(),
  voiceFilterPassed: z.boolean().optional(),
  diffStats: z.object({ added: z.number(), removed: z.number(), files: z.number() }).optional(),
  buildCycles: z.number().optional(),
});

export const ApprovalItemSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),                         // apr_<YYYY-MM-DD>_<8hex>
  productSlug: z.string(),
  createdAt: z.number(),
  /** Proposal that birthed this approval (build phase). */
  proposalId: z.string(),
  /** Tick id when this approval was created. */
  originTickId: z.number(),
  kind: z.enum(APPROVAL_KINDS),
  title: z.string().max(120),
  /** Why-trail surfaced in /approvals [w]hy. */
  reason: z.string(),
  signals: z.array(SignalReferenceSchema),
  proposedAction: ProposedActionSchema,
  risk: z.enum(['low', 'medium', 'high']),
  impact: z.enum(['low', 'medium', 'high']),
  rollback: RollbackRecipeSchema,
  evidence: ApprovalEvidenceSchema,
  state: ApprovalStateSchema,
  /** Worktree path while state ∈ {pending, pending-revalidation,
   *  approved}.  Disposed once state moves to applied/rejected/rolled-back. */
  worktreePath: z.string().optional(),
  /** Set on approve/reject by the human or the daemon. */
  decidedAt: z.number().optional(),
  decidedBy: z.string().optional(),
  /** Filled by act phase. */
  appliedAt: z.number().optional(),
  appliedResult: z.record(z.string(), z.unknown()).optional(),
  /** L3+ auto-applied without user approval. */
  autoApplied: z.boolean().optional(),
  /** Number of edit→revalidate cycles user has done. */
  editCount: z.number().optional(),
});
export type ApprovalItem = z.infer<typeof ApprovalItemSchema>;

/** Index entry — cheap listing surface, kept tiny so reading 50 items
 *  doesn't require loading 50 full files. */
export const ApprovalIndexEntrySchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  kind: z.enum(APPROVAL_KINDS),
  title: z.string(),
  state: ApprovalStateSchema,
  risk: z.enum(['low', 'medium', 'high']),
});
export type ApprovalIndexEntry = z.infer<typeof ApprovalIndexEntrySchema>;

/** Generate a fresh approval id. */
export function newApprovalId(now: number = Date.now()): string {
  const d = new Date(now);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `apr_${date}_${hex}`;
}
