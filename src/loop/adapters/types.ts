/**
 * Adapter interface — one TypeScript module per external system.
 *
 * The loop only knows about the interface; adapters do the dirty work
 * of authentication, polling, marshaling, and rollback.
 *
 * Adapters are split into source / sink / both:
 *   - source: produces signals (poll()) — read-only
 *   - sink:   takes actions (preview() + apply() + rollback())
 *   - both:   does both (e.g. github: read issues + write PRs)
 *
 * Phase 1 only exercises source methods.  Sink methods exist in the
 * interface so Phase 2's build/act phases have a stable contract to
 * implement against.
 */

import type { ProductContext, Signal } from '../types.js';

/** Adapter-specific auth state, persisted at
 *  products/<slug>/connectors/<adapter>.json (0o600).  Adapter base
 *  doesn't know the shape — each adapter exports its own AdapterCreds
 *  subtype.  We only require schemaVersion + adapter + authType for
 *  the registry's bookkeeping. */
export interface AdapterCredsBase {
  schemaVersion: 1;
  adapter: string;
  authType: 'oauth' | 'pat' | 'env' | 'none';
  /** ISO timestamp the creds were last successfully validated against
   *  the remote service.  Adapter base helpers use this to drive
   *  "refresh if older than 24h" behavior. */
  lastValidatedAt?: string;
  /** ISO timestamp the creds were first written. */
  createdAt?: string;
}

/** Proposed action shape — re-exported from the approval module so
 *  adapters reference a single source of truth.  Discriminated by
 *  `type` (file-edit | git-pr | social-post | user-reply |
 *  website-copy | experiment | ad-spend | npm-publish). */
export type { ProposedAction } from '../../approval/types.js';

/** Approved variant — same shape plus dispatch metadata. */
export type ApprovedAction = import('../../approval/types.js').ProposedAction & {
  approvalId: string;
  approvedBy: string;
  approvedAt: number;
};

/** Result of sink.apply().  Mandatory `rollbackRecipe` per the safety
 *  rules — every action carries its own undo before it executes. */
export interface ActionResult {
  schemaVersion: 1;
  adapter: string;
  approvalId: string;
  appliedAt: number;
  /** Adapter-specific result payload (tweet id, PR url, sha, etc). */
  payload: Record<string, unknown>;
  rollbackRecipe: {
    /** Human-readable description.  Shown in /approvals when the user
     *  hits `[u]ndo`. */
    description: string;
    /** Adapter-specific payload that the adapter's rollback() needs
     *  to undo the action.  Opaque to the loop. */
    payload: Record<string, unknown>;
  };
}

/** Preview of a proposed action, surfaced in /approvals before
 *  approval.  Adapter computes it lazily so we don't pay the cost
 *  until the user opens the approval. */
export interface ActionPreview {
  /** Short summary for the Panel one-liner. */
  summary: string;
  /** Multi-line detail for the [w]hy expansion. */
  detail: string;
  /** Optional resources the action will touch (URLs, file paths). */
  affected: string[];
}

export interface Adapter<Creds extends AdapterCredsBase = AdapterCredsBase> {
  /** Stable kebab-case id used in the registry, the connector
   *  filename, policy.yaml references, and audit log payloads. */
  id: string;
  kind: 'source' | 'sink' | 'both';
  /** Human-readable label for `mod8 connect list`. */
  label: string;
  /** Initial connect / re-authenticate flow.  Returns the creds object
   *  to be persisted at connectors/<adapter>.json.  Phase 1: only
   *  git-local + github implement this. */
  connect?(ctx: ProductContext): Promise<Creds>;
  /** Validate creds without poking the remote service hard.  Called
   *  by `mod8 connect status` and lazily before sink actions. */
  validate?(ctx: ProductContext, creds: Creds): Promise<{ ok: boolean; detail?: string }>;
  /** Pull signals since the given timestamp.  Adapters MUST be
   *  idempotent — same window should produce the same signals (with
   *  the same digests) so feedback.append() dedupes cleanly. */
  poll?(ctx: ProductContext, creds: Creds | null, since: Date): AsyncIterable<Signal>;
  /** Preview a proposed action without executing.  Used by the
   *  approval Panel.  Phase 2+. */
  preview?(ctx: ProductContext, creds: Creds, action: import('../../approval/types.js').ProposedAction): Promise<ActionPreview>;
  /** Apply an approved action.  MUST return an ActionResult with a
   *  populated rollbackRecipe; adapters that can't produce a rollback
   *  must throw and downgrade the action to needs-approval at L+1
   *  (caller's responsibility — see policy.ts). */
  apply?(ctx: ProductContext, creds: Creds, action: ApprovedAction): Promise<ActionResult>;
  /** Undo an applied action using its rollback recipe.  Best-effort —
   *  some actions can't be perfectly undone (e.g. a sent email);
   *  adapter returns ok:false with a reason and the loop audit-logs. */
  rollback?(ctx: ProductContext, creds: Creds, result: ActionResult): Promise<{ ok: boolean; detail?: string }>;
  /** Lazy token refresh on 401.  Returns updated creds. */
  refresh?(ctx: ProductContext, creds: Creds): Promise<Creds>;
}

/** Convenience type for `as const` adapter exports. */
export type SourceAdapter = Adapter & { kind: 'source' | 'both' };
export type SinkAdapter = Adapter & { kind: 'sink' | 'both' };
