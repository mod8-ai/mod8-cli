/**
 * Policy loader + decision engine for the mod8 self-improvement loop.
 *
 * Pure, deterministic, no LLM.  Every potentially-impactful action
 * runs through `check(action, policy)` and gets back one of:
 *   - { allowed: true }
 *   - { needsApproval: true, reason }   → goes to the approval queue
 *   - { allowed: false, reason }         → blocked + audit-logged, never queued
 *
 * Phase 1 only exercises the read-only action surface
 * (sense.ingest-signal, memory.write, audit.append, spend).  Phase 2
 * extends PolicyAction with file-edit / branch-create / pr-open /
 * social-post variants and adds the corresponding branches in check();
 * the API shape does not change.
 *
 * Schema validation uses Zod for the same reason the rest of the
 * codebase does — clean error messages + type narrowing.  YAML
 * parsing uses js-yaml (already a runtime dep).
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { z } from 'zod';
import type { PolicyAction, PolicyConfig, PolicyDecision } from './types.js';
import { productFiles } from '../memory/paths.js';
import type { ProductContext } from './types.js';

/** Default for missing/optional fields.  When a policy.yaml is
 *  partially written we fill these in — never silently expand
 *  capability (autonomy stays L1, budgets stay tight, lists stay
 *  empty).  Conservative defaults are correct defaults here. */
const DEFAULTS = {
  autonomy: 1 as const,
  budget: {
    monthly_usd: 50,
    per_tick_usd: 1.5,
    // MUST exceed the build phase's pre-flight estimate or the loop can never
    // finish a tick.  runPhase.estimateCostUsd assumes 4k input and defaults
    // runLlmToolsPhase to 8k output, so on sonnet that is
    // (4000*3 + 8000*15)/1e6 = $0.1320 — which the old 0.10 cap rejected on
    // every stock install.  0.60 leaves headroom for a pricier model.
    per_phase_usd: 0.60,
    per_proposal_usd: 2,
    per_campaign_usd: 0,
  },
  tests: { cmd: 'npm test' },
  cadence: {
    sense_every_minutes: 60,
    ideate_every_hours: 6,
    measure_wait_hours: 168,
  },
  concurrent_worktrees: 3,
} as const;

const ChannelPolicy = z.object({
  handle: z.string().optional(),
  post: z.enum(['never', 'with-approval', 'auto-low-risk']),
});

const PolicyConfigSchema = z.object({
  schemaVersion: z.literal(1),
  autonomy: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  budget: z.object({
    monthly_usd: z.number().nonnegative(),
    per_tick_usd: z.number().nonnegative(),
    per_phase_usd: z.number().nonnegative(),
    per_proposal_usd: z.number().nonnegative(),
    per_campaign_usd: z.number().nonnegative(),
  }),
  repos: z.object({
    allowed: z.array(z.string()),
    branches: z.object({
      protected: z.array(z.string()),
      auto_pr_allowed: z.boolean(),
      auto_merge_allowed: z.boolean(),
    }),
  }),
  files: z.object({
    protected: z.array(z.string()),
    off_limits: z.array(z.string()),
  }),
  website: z
    .object({
      allowed_paths: z.array(z.string()),
      off_limits: z.array(z.string()),
    })
    .optional(),
  social: z
    .object({
      channels: z.record(z.string(), ChannelPolicy),
      rate_limit: z.record(z.string(), z.object({ per_day: z.number().int().nonnegative() })),
    })
    .optional(),
  support: z
    .object({
      inbox: z.string().optional(),
      reply_mode: z.enum(['draft-only', 'auto-reply-low-risk', 'never']),
    })
    .optional(),
  ads: z
    .object({
      accounts: z.array(z.string()),
      daily_cap_usd: z.number().nonnegative(),
    })
    .optional(),
  voice: z
    .object({
      brand_voice_file: z.string().optional(),
      banned_phrases: z.array(z.string()),
      legal_claims: z.enum(['forbidden', 'approval-required', 'allowed']),
      pricing_claims: z.enum(['forbidden', 'approval-required', 'allowed']),
    })
    .optional(),
  tests: z.object({
    cmd: z.string().min(1),
    secret_scan_cmd: z.string().optional(),
  }),
  cadence: z.object({
    sense_every_minutes: z.number().int().positive(),
    ideate_every_hours: z.number().int().positive(),
    measure_wait_hours: z.number().int().positive(),
  }),
  concurrent_worktrees: z.number().int().positive(),
  kill_switch_file: z.string().optional(),
  inherit_from: z.string().optional(),
  paused_until: z.string().optional(),
});

export class PolicyMissing extends Error {
  constructor(public readonly path: string) {
    super(`policy.yaml missing at ${path} — create one before running the loop`);
    this.name = 'PolicyMissing';
  }
}

export class PolicyInvalid extends Error {
  constructor(public readonly path: string, public readonly issues: string) {
    super(`policy.yaml at ${path} failed validation:\n${issues}`);
    this.name = 'PolicyInvalid';
  }
}

/** Load + validate the policy for a given product.  Resolves
 *  `inherit_from` chains by merging the parent _defaults policy in
 *  first, then overlaying the product's own keys.  Phase 1 refuses
 *  to run the loop without a policy file — surfacing the missing-file
 *  error is itself the safety boundary, not a default. */
export async function loadPolicy(ctx: ProductContext): Promise<PolicyConfig> {
  const path = productFiles.policyYaml(ctx);
  if (!existsSync(path)) {
    throw new PolicyMissing(path);
  }
  const raw = await fs.readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new PolicyInvalid(path, err instanceof Error ? err.message : String(err));
  }
  // Resolve inheritance.  Cycle guard via visited set.
  const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const visited = new Set<string>([ctx.slug]);
  const inheritChain: Array<Record<string, unknown>> = [];
  let cursor: Record<string, unknown> | null = obj;
  while (cursor && typeof cursor.inherit_from === 'string') {
    const parentSlug = cursor.inherit_from;
    if (visited.has(parentSlug)) break;
    visited.add(parentSlug);
    const parentPath = `${productFiles.policyYaml({ ...ctx, productDir: ctx.productDir.replace(`/${ctx.slug}`, `/${parentSlug}`) })}`;
    if (!existsSync(parentPath)) break;
    try {
      const parentRaw = await fs.readFile(parentPath, 'utf8');
      const parentObj = (yaml.load(parentRaw) ?? {}) as Record<string, unknown>;
      inheritChain.unshift(parentObj);
      cursor = parentObj;
    } catch { break; }
  }
  // Merge parent → child (child wins on conflicting keys).
  const merged = mergeDefaults(inheritChain.reduce((acc, p) => deepMerge(acc, p), obj));
  const result = PolicyConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new PolicyInvalid(path, issues);
  }
  return result.data as PolicyConfig;
}

/** Shallow merge of two policy-like objects — child overrides parent
 *  at the top level; nested objects (budget, files, etc.) deep-merge
 *  one level so child can override individual keys without retyping
 *  the whole nested block. */
function deepMerge(child: Record<string, unknown>, parent: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parent };
  for (const [k, v] of Object.entries(child)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof parent[k] === 'object' && parent[k] !== null && !Array.isArray(parent[k])) {
      out[k] = { ...(parent[k] as object), ...(v as object) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Best-effort fill-in for omitted/optional fields.  Conservative:
 *  every default narrows capability rather than widens it. */
function mergeDefaults(raw: unknown): Record<string, unknown> {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    schemaVersion: 1,
    autonomy: obj.autonomy ?? DEFAULTS.autonomy,
    budget: { ...DEFAULTS.budget, ...(obj.budget as object | undefined) },
    repos: obj.repos ?? {
      allowed: [],
      branches: { protected: ['main', 'master'], auto_pr_allowed: false, auto_merge_allowed: false },
    },
    files: obj.files ?? { protected: [], off_limits: ['.env*', '**/*.pem', '**/secrets/*'] },
    website: obj.website,
    social: obj.social,
    support: obj.support,
    ads: obj.ads,
    voice: obj.voice,
    tests: { ...DEFAULTS.tests, ...(obj.tests as object | undefined) },
    cadence: { ...DEFAULTS.cadence, ...(obj.cadence as object | undefined) },
    concurrent_worktrees: obj.concurrent_worktrees ?? DEFAULTS.concurrent_worktrees,
    kill_switch_file: obj.kill_switch_file,
    inherit_from: obj.inherit_from,
    // YAML auto-parses ISO date literals into Date objects; coerce so
    // the Zod schema (which expects an ISO string) accepts them.
    paused_until: obj.paused_until instanceof Date
      ? obj.paused_until.toISOString()
      : obj.paused_until,
  };
}

/** Effective autonomy after vacation/pause window.  Caller-side helper
 *  — phases that gate on autonomy should read this, not policy.autonomy
 *  directly.  Phase 1 doesn't read autonomy yet (everything is L1
 *  read-only), but Phase 2+ does and this is where the pause logic
 *  lives. */
export function effectiveAutonomy(policy: PolicyConfig, now: number = Date.now()): 1 | 2 | 3 | 4 | 5 {
  if (policy.paused_until) {
    const until = Date.parse(policy.paused_until);
    if (Number.isFinite(until) && until > now) {
      return 1;
    }
  }
  return policy.autonomy;
}

/** The decision engine.  Pure, no I/O.  Add new branches as Phase 2+
 *  extends PolicyAction; never relax existing branches.
 *
 *  Invariants this function enforces (in order):
 *    1. files.off_limits ALWAYS wins (highest priority — overrides every level)
 *    2. files.protected requires explicit approval at every level
 *    3. autonomy-level gating for the action's class
 *    4. budget pre-flight (spend actions only)
 */
export function check(action: PolicyAction, policy: PolicyConfig, now: number = Date.now()): PolicyDecision {
  const autonomy = effectiveAutonomy(policy, now);

  switch (action.kind) {
    // ── Phase 1 actions: universally allowed (read-only side effects only) ──
    case 'sense.ingest-signal':
      return { allowed: true };
    case 'memory.write':
      // Memory writes are scoped to products/<slug>/memory/ by paths.ts
      // (the runtime assertion is the real boundary).  No autonomy
      // gating — memory updates aren't user-visible actions.
      return { allowed: true };
    case 'audit.append':
      return { allowed: true };

    case 'spend': {
      if (action.estimatedUsd > policy.budget.per_phase_usd) {
        return {
          allowed: false,
          reason: `spend $${action.estimatedUsd.toFixed(4)} for phase ${action.phase} exceeds per_phase_usd cap $${policy.budget.per_phase_usd}`,
        };
      }
      return { allowed: true };
    }

    // ── Phase 2+ actions ─────────────────────────────────────────────
    case 'file-edit': {
      // Always allowed inside a worktree — the worktree is the
      // sandbox.  Off-limits files are checked at file-write time
      // (see check below for `auto-apply` where we enforce against
      // the actual diff).  For ideate/build proposing edits, we
      // double-check off_limits here as a defensive layer.
      for (const f of action.files) {
        for (const pat of policy.files.off_limits) {
          if (matchPathPattern(f, pat).matches) {
            return { allowed: false, reason: `${f} is off_limits (matches ${pat})` };
          }
        }
      }
      return { allowed: true };
    }

    case 'git-push': {
      // Never push to a protected branch — even at L5.
      for (const pat of policy.repos.branches.protected) {
        if (matchPathPattern(action.branch, pat).matches) {
          return { allowed: false, reason: `push to protected branch ${action.branch} is forbidden` };
        }
      }
      if (!policy.repos.branches.auto_pr_allowed && autonomy < 5) {
        return { needsApproval: true, reason: `git-push requires auto_pr_allowed in policy or L5 autonomy (current: L${autonomy})` };
      }
      return { allowed: true };
    }

    // ── Phase 3+: auto-apply (L3 gate) ───────────────────────────────
    case 'auto-apply': {
      // L1/L2 never auto-apply.
      if (autonomy < 3) {
        return { needsApproval: true, reason: `auto-apply requires L3+; current autonomy L${autonomy}` };
      }
      // Protected/off-limits files are always a manual decision.
      for (const f of action.touchedFiles) {
        for (const pat of policy.files.off_limits) {
          if (matchPathPattern(f, pat).matches) {
            return { allowed: false, reason: `auto-apply forbidden: ${f} is off_limits` };
          }
        }
        for (const pat of policy.files.protected) {
          if (matchPathPattern(f, pat).matches) {
            return { needsApproval: true, reason: `auto-apply blocked: ${f} is protected (matches ${pat})` };
          }
        }
      }
      // L3: only docs auto-apply.
      if (autonomy === 3) {
        const allDocs = action.touchedFiles.every((f) => f.startsWith('docs/') || f === 'README.md' || f.startsWith('docs\\'));
        if (!allDocs) {
          return { needsApproval: true, reason: 'L3 only auto-applies changes touching only /docs/** or README.md' };
        }
        // Restricted approval kinds at L3.
        if (action.approvalKind !== 'doc' && action.approvalKind !== 'website-copy') {
          return { needsApproval: true, reason: `L3 only auto-applies doc/website-copy kinds; got ${action.approvalKind}` };
        }
      }
      // L4: doc + small website + experiment toggles.
      if (autonomy === 4) {
        if (action.approvalKind === 'code' || action.approvalKind === 'roadmap' || action.approvalKind === 'paid-campaign') {
          return { needsApproval: true, reason: `L4 does not auto-apply ${action.approvalKind}` };
        }
      }
      // L5: everything except explicitly-protected.
      return { allowed: true };
    }

    case 'social-post': {
      const channel = policy.social?.channels[action.channel];
      if (!channel || channel.post === 'never') {
        return { allowed: false, reason: `policy.social.channels.${action.channel} = never (or undefined)` };
      }
      // Voice filter: any banned phrase in the text is a hard block.
      const banned = policy.voice?.banned_phrases ?? [];
      for (const phrase of banned) {
        if (action.text.toLowerCase().includes(phrase.toLowerCase())) {
          return { allowed: false, reason: `text contains banned phrase: "${phrase}"` };
        }
      }
      if (channel.post === 'auto-low-risk' && autonomy >= 4) return { allowed: true };
      return { needsApproval: true, reason: `policy.social.channels.${action.channel} requires approval` };
    }

    case 'user-reply': {
      const mode = policy.support?.reply_mode ?? 'never';
      if (mode === 'never') return { allowed: false, reason: 'policy.support.reply_mode = never' };
      if (mode === 'draft-only') return { needsApproval: true, reason: 'policy.support.reply_mode = draft-only' };
      if (mode === 'auto-reply-low-risk' && autonomy >= 5) return { allowed: true };
      return { needsApproval: true, reason: `${action.channel} reply requires approval (autonomy L${autonomy})` };
    }

    case 'ad-spend': {
      const cap = policy.ads?.daily_cap_usd ?? 0;
      if (cap === 0) return { allowed: false, reason: 'policy.ads.daily_cap_usd = 0 (ads disabled)' };
      if (action.amountUsd > cap) return { allowed: false, reason: `ad-spend $${action.amountUsd} > daily_cap_usd $${cap}` };
      if (autonomy >= 5) return { allowed: true };
      return { needsApproval: true, reason: `ad-spend requires L5; current L${autonomy}` };
    }

    case 'npm-publish': {
      // npm publish ALWAYS requires explicit approval, regardless of autonomy.
      return { needsApproval: true, reason: `npm publish ${action.packageName}@${action.version} requires explicit human approval` };
    }

    default: {
      const _exhaustive: never = action;
      return {
        allowed: false,
        reason: `unknown action kind: ${JSON.stringify(_exhaustive)}`,
      };
    }
  }
}

/** Match a file path against a list of glob-ish patterns from
 *  policy.files.{protected,off_limits}.  Supports `*`, `**`, and the
 *  special `path:fragment` form (used for `package.json:version`) that
 *  matches when the path matches AND the proposal touches the named
 *  JSON key (caller is responsible for the key check — this util only
 *  reports the path match + the key fragment if present).
 *
 *  Exported because Phase 2's build phase needs the same matcher when
 *  checking proposed file edits against protected/off_limits lists. */
export function matchPathPattern(path: string, pattern: string): { matches: boolean; keyFragment?: string } {
  const [filePart, keyPart] = pattern.split(':') as [string, string | undefined];
  // Translate glob to RegExp — minimal subset (** = any-segments,
  // * = any-non-slash, ? = single-non-slash, anything else literal).
  const re = new RegExp(
    '^' +
    filePart
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '__DOUBLESTAR__')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/__DOUBLESTAR__/g, '.*') +
    '$'
  );
  if (!re.test(path)) return { matches: false };
  return keyPart ? { matches: true, keyFragment: keyPart } : { matches: true };
}
