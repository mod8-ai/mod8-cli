/**
 * ACT phase — real Phase 3 implementation.
 *
 * Triggered out-of-band by the approval Panel after the user picks
 * [a]pprove (NOT scheduled by the scheduler).  Dispatches the
 * approved action to the right adapter, captures the ActionResult,
 * sets state.waitUntilTs based on policy.cadence.measure_wait_hours.
 *
 * Deterministic — no LLM call.  Snapshot capture (via
 * memory/snapshots.ts) happens BEFORE the action so measure has a
 * proper baseline.
 *
 * Adapter dispatch by action type:
 *   file-edit / git-pr → github adapter (via apply branch + open PR)
 *                        OR git-local for non-GitHub-bound merges
 *   social-post        → twitter/bluesky/hn/reddit (Phase 4)
 *   user-reply         → intercom/crisp/front/email-imap (Phase 4)
 *   website-copy       → vercel deploy adapter (Phase 4 wiring)
 *   experiment         → posthog/launchdarkly (Phase 4)
 *   ad-spend           → google-ads/meta-ads (Phase 4)
 *   npm-publish        → npm adapter (Phase 4 — extra approval gate)
 *
 * Phase 3 wires the file-edit / git-pr path fully; other types
 * delegate to their stub adapters and return ok=true with an empty
 * rollback recipe (which the policy enforces as needing approval at
 * L+1 in Phase 4 when those adapters land for real).
 */

import { runDeterministicPhase, type PhaseResult } from '../runPhase.js';
import { load as loadApproval, recordOutcome } from '../../approval/store.js';
import { capture as captureSnapshot } from '../../memory/snapshots.js';
import * as worktree from '../worktree.js';
import * as state from '../state.js';
import * as events from '../events.js';
import * as audit from '../audit.js';
import { get as getAdapter, loadAllAdapters } from '../adapters/registry.js';
import { effectiveAutonomy } from '../policy.js';
import type { PolicyConfig, ProductContext } from '../types.js';
import type { ActionResult } from '../adapters/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ActInput {
  approvalId: string;
}

export interface ActOutput {
  schemaVersion: 1;
  result: ActionResult | null;
  waitUntilTs: number | null;
}

export async function run(
  ctx: ProductContext,
  policy: PolicyConfig,
  input: ActInput
): Promise<PhaseResult<ActOutput>> {
  // Approvals from the REPL / approvals-cli reach act without a tick having
  // run loadAllAdapters(); make sure every sink (github, meta, …) is
  // registered before dispatch.  Idempotent — re-imports are no-ops.
  await loadAllAdapters();
  return runDeterministicPhase<ActOutput>({
    ctx,
    phase: 'act',
    policy,
    summary: `act on approval ${input.approvalId}`,
    body: async () => {
      const approval = await loadApproval(ctx, input.approvalId);
      if (!approval) {
        return softNull(ctx, `approval ${input.approvalId} not found`);
      }
      if (approval.state !== 'approved') {
        return softNull(ctx, `approval ${input.approvalId} is in state ${approval.state}, not 'approved'`);
      }

      // 1. Capture metric snapshot for measure phase.
      try {
        await captureSnapshot(ctx, approval.proposalId, approval.evidence.testOutput);
      } catch { /* tolerate */ }

      const action = approval.proposedAction;
      let result: ActionResult | null = null;
      let failureReason: string | undefined;

      try {
        switch (action.type) {
          case 'file-edit': {
            // Local merge: cherry-pick or fast-forward merge the loop
            // branch into base (default: main).  Phase 3 uses git-local
            // for in-repo merges; Phase 4 wires github adapter for
            // PR-based merges when policy.repos.branches.auto_pr_allowed.
            result = await mergeLocally(ctx, approval);
            break;
          }
          case 'git-pr': {
            const adapter = getAdapter('github');
            if (!adapter?.apply) {
              failureReason = 'github adapter does not implement apply() yet (Phase 4)';
              break;
            }
            result = await adapter.apply(ctx, await loadCreds(ctx, 'github'), {
              ...action,
              approvalId: approval.id,
              approvedBy: approval.decidedBy ?? 'user',
              approvedAt: approval.decidedAt ?? Date.now(),
            });
            break;
          }
          case 'social-post':
          case 'user-reply':
          case 'website-copy':
          case 'experiment':
          case 'ad-spend':
          case 'npm-publish': {
            const adapterId = adapterForActionType(action.type, 'channel' in action ? action.channel : undefined);
            const adapter = getAdapter(adapterId);
            if (!adapter?.apply) {
              failureReason = `${adapterId} adapter does not implement apply() yet`;
              break;
            }
            result = await adapter.apply(ctx, await loadCreds(ctx, adapterId), {
              ...action,
              approvalId: approval.id,
              approvedBy: approval.decidedBy ?? 'user',
              approvedAt: approval.decidedAt ?? Date.now(),
            });
            break;
          }
        }
      } catch (err) {
        failureReason = err instanceof Error ? err.message : String(err);
      }

      if (!result || failureReason) {
        // Roll the approval back to a failed state.
        try {
          await recordOutcome(ctx, approval.id, {
            state: 'failed',
            decidedBy: 'act-phase',
            appliedResult: { error: failureReason ?? 'no result returned' },
          });
        } catch { /* tolerate */ }
        await events.append(ctx, {
          phase: 'act',
          kind: 'error',
          payload: { approvalId: approval.id, reason: failureReason ?? 'no result' },
        });
        return { schemaVersion: 1, result: null, waitUntilTs: null };
      }

      // Mandatory rollback recipe check.  Per safety rule 10 — if the
      // adapter couldn't produce one, downgrade.  At Phase 3 we
      // hard-fail; Phase 4 wiring will downgrade-to-approval-at-L+1.
      if (!result.rollbackRecipe?.description || !result.rollbackRecipe?.payload) {
        failureReason = `adapter ${result.adapter} returned no rollback recipe`;
        await recordOutcome(ctx, approval.id, {
          state: 'failed',
          decidedBy: 'act-phase',
          appliedResult: { error: failureReason },
        });
        await events.append(ctx, {
          phase: 'act',
          kind: 'error',
          payload: { approvalId: approval.id, reason: failureReason },
        });
        return { schemaVersion: 1, result: null, waitUntilTs: null };
      }

      // 3. Mark approval applied + set waitUntilTs for measure.
      const waitUntilTs = Date.now() + policy.cadence.measure_wait_hours * 60 * 60 * 1000;
      await recordOutcome(ctx, approval.id, {
        state: 'applied',
        decidedBy: 'act-phase',
        appliedResult: { ...result.payload, rollback: result.rollbackRecipe },
      });

      // Persist waitUntilTs into per-product state so scheduler fires
      // measure later.
      try {
        const cur = await state.load(ctx);
        await state.save(ctx, {
          ...cur,
          currentProposalId: approval.proposalId,
          waitUntilTs,
        });
      } catch { /* tolerate */ }

      // Audit the action.
      await audit.append(ctx, 'act.applied', {
        approvalId: approval.id,
        proposalId: approval.proposalId,
        adapter: result.adapter,
        autonomy: effectiveAutonomy(policy),
        autoApplied: approval.autoApplied ?? false,
      });

      // Dispose worktree (it's been merged or its branch lives on the
      // remote — local sandbox is no longer needed).
      if (approval.worktreePath) {
        try {
          const handle = await worktree.attach(ctx, approval.proposalId);
          if (handle) await handle.dispose('merged');
        } catch { /* tolerate */ }
      }

      await events.append(ctx, {
        phase: 'act',
        kind: 'complete',
        payload: {
          approvalId: approval.id,
          proposalId: approval.proposalId,
          adapter: result.adapter,
          waitUntilTs,
        },
      });

      return { schemaVersion: 1, result, waitUntilTs };
    },
  });
}

function softNull(ctx: ProductContext, reason: string): ActOutput {
  void events.append(ctx, { phase: 'act', kind: 'skipped', payload: { reason } });
  return { schemaVersion: 1, result: null, waitUntilTs: null };
}

/** Merge the loop branch into base.  Phase 3: local merge only (no
 *  push); Phase 4 adds the github adapter PR-based merge path. */
async function mergeLocally(ctx: ProductContext, approval: import('../../approval/types.js').ApprovalItem): Promise<ActionResult> {
  const handle = await worktree.attach(ctx, approval.proposalId);
  if (!handle) {
    throw new Error(`worktree for proposal ${approval.proposalId} no longer exists`);
  }
  // Safe merge: refuse on a dirty tracked tree (a merge would tangle the
  // user's in-progress edits with the loop's), fast-forward when possible,
  // otherwise a real merge commit — and abort cleanly on conflict so the
  // repo is never left mid-merge.
  const dirty = (await execFileP('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ctx.repoRoot })).stdout.trim();
  if (dirty) {
    throw new Error(`repo has uncommitted tracked changes — commit or stash before approving:\n${dirty.slice(0, 400)}`);
  }
  try {
    await execFileP('git', ['merge', '--ff-only', handle.branch], { cwd: ctx.repoRoot });
  } catch {
    try {
      await execFileP('git', ['merge', '--no-ff', '--no-edit', '-m', `Merge ${handle.branch}\n\n${ctx.selfCommitTrailer}/${approval.proposalId}`, handle.branch], { cwd: ctx.repoRoot });
    } catch (err) {
      try { await execFileP('git', ['merge', '--abort'], { cwd: ctx.repoRoot }); } catch { /* nothing to abort */ }
      throw new Error(`merge of ${handle.branch} conflicted and was aborted: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
    }
  }
  // Capture the resulting sha for rollback.
  const after = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: ctx.repoRoot });
  const newSha = after.stdout.trim();
  return {
    schemaVersion: 1,
    adapter: 'git-local',
    approvalId: approval.id,
    appliedAt: Date.now(),
    payload: { mergedBranch: handle.branch, baseSha: handle.baseSha, newSha },
    rollbackRecipe: {
      description: `revert merge of ${handle.branch} (back to ${handle.baseSha})`,
      payload: { type: 'git-revert', sha: newSha, restoreSha: handle.baseSha },
    },
  };
}

function adapterForActionType(type: string, channel?: string): string {
  if (type === 'social-post') {
    if (channel === 'facebook' || channel === 'instagram' || channel === 'meta') return 'meta';
    return channel ?? 'unknown';
  }
  if (type === 'user-reply') return channel ?? 'unknown';
  if (type === 'website-copy') return 'vercel';
  if (type === 'experiment') return 'posthog';
  if (type === 'ad-spend') return 'google-ads';
  if (type === 'npm-publish') return 'npm';
  return 'unknown';
}

async function loadCreds(ctx: ProductContext, adapterId: string): Promise<import('../adapters/types.js').AdapterCredsBase> {
  // Phase 4 generalizes via a per-adapter loader registry.  For Phase
  // 3, the adapter implementations read their own credentials and
  // this is just a placeholder so the dispatch compiles.
  void ctx; void adapterId;
  return { schemaVersion: 1, adapter: adapterId, authType: 'env' };
}
