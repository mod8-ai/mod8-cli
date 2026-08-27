/**
 * Shared types for the mod8 Harness self-improvement loop.
 *
 * Every persisted type carries `schemaVersion`.  Migrations live in
 * loop/migrate.ts (Phase 2) and are pure functions chained on read; the
 * archive is never deleted, so old shapes must remain readable.
 *
 * Phase 1 ships: ProductContext, PhaseEvent, SignalBundle, Signal,
 *                PolicyConfig, AuditEntry, BudgetEntry, LoopState.
 * Phase 2 fills: Proposal, ApprovalItem, ActionResult, Measurement,
 *                PolicyAction (the discriminated-union surface that
 *                policy.check() acts on).
 */

/** Where this loop is running.  Passed explicitly into every phase,
 *  adapter, and memory call — never read from a module-level singleton
 *  or env var.  This is how we enforce per-product isolation by the
 *  type system rather than by code review. */
export interface ProductContext {
  /** Stable slug under products/<slug>/ — `mod8` for the harness itself. */
  slug: string;
  /** Absolute path to ~/.config/mod8/products/<slug>/. */
  productDir: string;
  /** Absolute path to the source repo this product operates on
   *  (typically process.cwd() for self-mode). */
  repoRoot: string;
  /** Monotonic tick number, increments once per scheduler.decidePhases call. */
  tickId: number;
  /** Loop-author commit trailer — `mod8-loop: <slug>/<proposal-id>` —
   *  used by sense.ts to filter out the loop's own commits and prevent
   *  self-loop oscillation. */
  selfCommitTrailer: string;
}

/** Coarse phase identifiers.  10 conceptual phases collapse into 7 code
 *  files (see plan §"Phase model"); these are the *file-level* phase
 *  ids that appear in events.jsonl and audit entries. */
export type PhaseId =
  | 'sense'         // sense + understand + compare
  | 'ideate'
  | 'prioritize'
  | 'build'         // build + stage
  | 'act'
  | 'measure'
  | 'learn';

/** One emitted event from a phase.  Written to events.jsonl, consumed
 *  by `mod8 loop logs` and `mod8 loop status`. */
export interface PhaseEvent {
  schemaVersion: 1;
  ts: number;
  tickId: number;
  productSlug: string;
  phase: PhaseId;
  /** Lifecycle marker.  start/complete bracket every real run;
   *  not-implemented is emitted by Phase 1 stubs; skipped is emitted
   *  by scheduler when a phase is gated out this tick. */
  kind: 'start' | 'complete' | 'error' | 'skipped' | 'not-implemented' | 'budget-exhausted' | 'kill-switch' | 'auto-commit' | 'no-diff';
  /** Free-form structured payload — phase-specific. */
  payload?: Record<string, unknown>;
  durationMs?: number;
  costUsd?: number;
}

/** One sensed input from an adapter.  Sense.ts ingests these and
 *  writes them to feedback corpora; later phases consult them via
 *  memory/feedback.ts.  Source-typed for provenance + per-source prior
 *  weighting (learn phase). */
export interface Signal {
  schemaVersion: 1;
  /** Adapter id that produced this signal (e.g. 'github', 'git-local'). */
  source: string;
  /** Stable opaque digest of the signal content — used to dedupe across
   *  ticks so a poll covering the same window doesn't re-record. */
  digest: string;
  ts: number;
  kind: string;     // adapter-defined (e.g. 'github.issue.opened', 'git-local.commit')
  title: string;
  body?: string;
  url?: string;
  /** Adapter-specific raw payload, retained so later phases (ideate,
   *  measure) can re-inspect without re-fetching. */
  raw?: Record<string, unknown>;
}

/** Output of one sense phase run — handed to ideate (Phase 2) and
 *  also persisted as a sense.complete event payload. */
export interface SignalBundle {
  schemaVersion: 1;
  productSlug: string;
  tickId: number;
  newSignals: Signal[];
  /** Per-source counts (for /loop status quick view). */
  countsBySource: Record<string, number>;
  /** Memory deltas this sense run produced (file paths that changed
   *  under products/<slug>/memory/). */
  memoryUpdates: string[];
}

/** Policy file shape.  Loaded from products/<slug>/policy.yaml by
 *  loop/policy.ts; validated with Zod (see loop/policy.ts for the
 *  source-of-truth schema).  This interface mirrors that schema. */
export interface PolicyConfig {
  schemaVersion: 1;
  /** L1=suggest, L2=patch-only, L3=safe-autopilot, L4=growth-autopilot, L5=full.
   *  files.protected + files.off_limits always override autonomy. */
  autonomy: 1 | 2 | 3 | 4 | 5;
  budget: {
    monthly_usd: number;
    per_tick_usd: number;
    per_phase_usd: number;
    per_proposal_usd: number;
    per_campaign_usd: number;
  };
  repos: {
    allowed: string[];
    branches: {
      protected: string[];
      auto_pr_allowed: boolean;
      auto_merge_allowed: boolean;
    };
  };
  files: {
    protected: string[];
    off_limits: string[];
  };
  website?: { allowed_paths: string[]; off_limits: string[] };
  social?: {
    channels: Record<string, { handle?: string; post: 'never' | 'with-approval' | 'auto-low-risk' }>;
    rate_limit: Record<string, { per_day: number }>;
  };
  support?: { inbox?: string; reply_mode: 'draft-only' | 'auto-reply-low-risk' | 'never' };
  ads?: { accounts: string[]; daily_cap_usd: number };
  voice?: {
    brand_voice_file?: string;
    banned_phrases: string[];
    legal_claims: 'forbidden' | 'approval-required' | 'allowed';
    pricing_claims: 'forbidden' | 'approval-required' | 'allowed';
  };
  tests: { cmd: string; secret_scan_cmd?: string; setup_cmd?: string };
  cadence: {
    sense_every_minutes: number;
    ideate_every_hours: number;
    measure_wait_hours: number;
  };
  concurrent_worktrees: number;
  kill_switch_file?: string;
  /** Phase 4 — name of a parent policy under products/<parent>/ to
   *  inherit from.  Phase 1 ignores this. */
  inherit_from?: string;
  /** Optional pause window — when set + in the future, the loop
   *  downgrades to L1 regardless of `autonomy`.  Used by `mod8 loop
   *  pause --until <date>` (Phase 2). */
  paused_until?: string;
}

/** Discriminated union of every action policy.check() can be asked
 *  about.  Phase 1: signal-ingest + memory writes.  Phase 2+: file
 *  edits, PRs.  Phase 3+: auto-apply decision (gates L3 auto-merge).
 *  Phase 4+: social, ad-spend, npm-publish. */
export type PolicyAction =
  | { kind: 'sense.ingest-signal'; source: string }
  | { kind: 'memory.write'; relPath: string }
  | { kind: 'audit.append' }
  | { kind: 'spend'; phase: PhaseId; estimatedUsd: number }
  | { kind: 'file-edit'; files: string[] }
  | { kind: 'git-push'; branch: string }
  | { kind: 'auto-apply'; approvalKind: string; touchedFiles: string[] }
  | { kind: 'social-post'; channel: string; text: string }
  | { kind: 'user-reply'; channel: string }
  | { kind: 'ad-spend'; amountUsd: number }
  | { kind: 'npm-publish'; packageName: string; version: string };

/** Result of a policy.check() call. */
export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string }
  | { needsApproval: true; reason: string };

/** One entry in audit.jsonl — append-only, hash-chained.  Phase 1
 *  records tick lifecycle + policy decisions + kill-switch triggers;
 *  Phase 2+ adds proposal/approval/action entries. */
export interface AuditEntry {
  schemaVersion: 1;
  /** Monotonic index within the chain — verifyChain re-walks and
   *  reports the first broken index. */
  index: number;
  ts: number;
  productSlug: string;
  /** Hex sha256 of the previous entry's `digest` field; null for the
   *  genesis entry. */
  prevDigest: string | null;
  /** Hex sha256 of (prevDigest || stableJSON(rest of fields)).
   *  Tampering with any field invalidates this digest and breaks the
   *  chain at this index. */
  digest: string;
  kind: string;     // 'tick.start' | 'tick.complete' | 'phase.start' | 'phase.complete' | 'kill-switch' | 'policy.block' | …
  payload: Record<string, unknown>;
}

/** One entry in spend.jsonl — per-call cost ledger.  Used by
 *  budget.ts to enforce per-tick / per-phase / per-day caps. */
export interface BudgetEntry {
  schemaVersion: 1;
  ts: number;
  productSlug: string;
  tickId: number;
  phase: PhaseId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Per-product FSM.  Persisted at products/<slug>/state.json.  Loaded
 *  at the top of every tick; phases mutate via state.ts helpers
 *  (atomic rename-on-write). */
export interface LoopState {
  schemaVersion: 1;
  productSlug: string;
  /** Monotonic tick counter. */
  lastTickId: number;
  lastTickAt: number | null;
  /** Per-phase last-run timestamp — scheduler uses these against
   *  policy.cadence to decide what to run this tick. */
  lastRunByPhase: Partial<Record<PhaseId, number>>;
  /** Phase 2+: id of the in-flight proposal, if any.  Daemon crash
   *  recovery reads this on restart. */
  currentProposalId?: string;
  /** Phase 2+: epoch ms after which `measure` should fire for the
   *  in-flight proposal. */
  waitUntilTs?: number;
  /** Last phase that ran (any kind). */
  lastPhase?: PhaseId;
  /** Per-phase attempt counter, reset on success.  Phase 2+ uses this
   *  to back off after repeated failures. */
  phaseAttempts: Partial<Record<PhaseId, number>>;
  /** When non-null, every tick is downgraded to L1 until ts passes. */
  pausedUntil?: number;
}
