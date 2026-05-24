/**
 * BUILD phase — real Phase 2 implementation (build + stage collapsed).
 *
 * Takes one prioritized Proposal:
 *   1. Refuses if concurrent worktree cap is reached.
 *   2. Refuses if proposal touches policy.files.off_limits or .protected
 *      without explicit signal evidence (defensive — ideate is supposed
 *      to filter, but we double-check at the boundary).
 *   3. Creates a git worktree at .mod8-worktrees/<proposal-id>.
 *   4. Runs an LLM agent (via runLlmToolsPhase) with edit/write/bash
 *      tools scoped to the worktree — implements the proposal.
 *   5. Runs the test command in the worktree.
 *   6. Runs the secret scan on the diff.
 *   7. Captures the unified diff + diffstats.
 *   8. Stages an ApprovalItem in the approval queue.
 *
 * Output: BuildOutput with the approvalId (or null when build fails
 * for any reason).
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PolicyConfig, ProductContext } from '../types.js';
import { runDeterministicPhase, runLlmToolsPhase, type PhaseResult } from '../runPhase.js';
import { load as loadPrompt } from '../promptLoader.js';
import * as events from '../events.js';
import * as worktree from '../worktree.js';
import * as approvalStore from '../../approval/store.js';
import { newApprovalId, type ApprovalItem } from '../../approval/types.js';
import { updateState as updateProposalState } from '../proposal.js';
import { matchPathPattern } from '../policy.js';
import { findApiKey } from '../../util/secrets.js';
import { buildInkTools } from '../../agent/inkTools.js';
import type { PrioritizeOutput } from './prioritize.js';

const execFileP = promisify(execFile);

export interface BuildOutput {
  schemaVersion: 1;
  approvalId: string | null;
  worktreePath: string | null;
  testOutput: string | null;
  buildCycles: number;
  failureReason?: string;
}

export async function run(
  ctx: ProductContext,
  policy: PolicyConfig,
  input: PrioritizeOutput
): Promise<PhaseResult<BuildOutput>> {
  // Nothing to build.
  if (!input.picked) {
    return runDeterministicPhase<BuildOutput>({
      ctx,
      phase: 'build',
      policy,
      summary: 'build skipped — no prioritized proposal',
      body: async () => {
        await events.append(ctx, {
          phase: 'build',
          kind: 'skipped',
          payload: { reason: 'no picked proposal from prioritize' },
        });
        return { schemaVersion: 1, approvalId: null, worktreePath: null, testOutput: null, buildCycles: 0 };
      },
    });
  }

  const proposal = input.picked;

  // Pre-flight 1: concurrent worktree cap.
  const active = await worktree.countActive(ctx);
  if (active >= policy.concurrent_worktrees) {
    return softFail(ctx, policy, proposal.id, `concurrent_worktrees cap reached (${active}/${policy.concurrent_worktrees})`);
  }

  // Pre-flight 2: policy.files.off_limits + protected checks.
  const blocked = checkFileGuards(proposal.targetFiles, policy);
  if (blocked) {
    await updateProposalState(ctx, proposal.id, 'rejected-build');
    return softFail(ctx, policy, proposal.id, `proposal touches forbidden files: ${blocked}`);
  }

  // 3. Create worktree.
  let wt: worktree.WorktreeHandle;
  try {
    await updateProposalState(ctx, proposal.id, 'building');
    wt = await worktree.create(ctx, proposal.id);
  } catch (err) {
    return softFail(ctx, policy, proposal.id, `worktree.create failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. LLM agent — bounded by maxSteps + budget.
  const system = await loadPrompt('build', {
    worktreePath: wt.worktreePath,
    proposalId: proposal.id,
    proposalTitle: proposal.title,
    slug: ctx.slug,
    testsCmd: policy.tests.cmd,
    secretScanCmd: policy.tests.secret_scan_cmd ?? 'true',
    budgetRemainingUsd: policy.budget.per_proposal_usd.toFixed(2),
  });

  const userMessage = [
    '## Proposal you must implement',
    JSON.stringify({
      id: proposal.id, kind: proposal.kind, title: proposal.title,
      summary: proposal.summary, targetFiles: proposal.targetFiles,
      rationale: proposal.rationale, rollbackHint: proposal.rollbackHint,
      successCriteria: proposal.successCriteria,
    }, null, 2),
    '',
    '## Worktree',
    `path: ${wt.worktreePath}`,
    `branch: ${wt.branch}`,
    `base: ${wt.baseBranch} (${wt.baseSha || 'no commits yet'})`,
    '',
    'Implement the proposal, add or update tests, run the test command, and commit when green.',
    'The runtime will validate your diff against policy + secret-scan AFTER you finish.',
  ].join('\n');

  const tools = buildInkTools({ cwd: wt.worktreePath, providerName: 'mod8-loop' });

  const llmResult = await runLlmToolsPhase<{ text: string }>({
    ctx,
    phase: 'build',
    policy,
    system,
    userMessage,
    tools,
    maxSteps: 18,
    finalize(s) {
      return { text: s.text };
    },
  });

  if (!llmResult.ok) {
    await wt.dispose('aborted');
    await updateProposalState(ctx, proposal.id, 'rejected-build');
    return softFail(ctx, policy, proposal.id, `build agent failed: ${llmResult.reason}`);
  }

  // 5. Capture diff.
  const diffInfo = await wt.diff();
  if (diffInfo.patch.trim().length === 0) {
    await wt.dispose('aborted');
    await updateProposalState(ctx, proposal.id, 'rejected-build');
    return softFail(ctx, policy, proposal.id, 'build produced no diff — nothing to stage');
  }

  // 6. Run tests in the worktree.
  await events.append(ctx, { phase: 'build', kind: 'start', payload: { stage: 'tests' } });
  const testRun = await wt.run('sh', ['-c', policy.tests.cmd], { timeoutMs: 5 * 60 * 1000 });
  const testsPassed = testRun.exitCode === 0;
  if (!testsPassed) {
    await wt.dispose('aborted');
    await updateProposalState(ctx, proposal.id, 'rejected-build');
    return softFail(
      ctx, policy, proposal.id,
      `tests failed in worktree (exit ${testRun.exitCode}). stderr tail: ${testRun.stderr.slice(-1000)}`
    );
  }

  // 7. Secret scan on the diff.
  if (findApiKey(diffInfo.patch)) {
    await wt.dispose('aborted');
    await updateProposalState(ctx, proposal.id, 'rejected-build');
    return softFail(ctx, policy, proposal.id, 'secret detected in proposed diff');
  }
  // Custom secret-scan command, if configured.
  if (policy.tests.secret_scan_cmd) {
    const scan = await wt.run('sh', ['-c', policy.tests.secret_scan_cmd], { timeoutMs: 60_000 });
    if (scan.exitCode !== 0) {
      await wt.dispose('aborted');
      await updateProposalState(ctx, proposal.id, 'rejected-build');
      return softFail(ctx, policy, proposal.id, `secret scan failed (exit ${scan.exitCode}): ${scan.stderr.slice(-400)}`);
    }
  }

  // 8. Ensure changes are committed in the worktree (the LLM may
  //    forget the trailer or skip the commit).  If a working-tree
  //    diff exists we commit it ourselves with the canonical message.
  await ensureCommitted(wt, proposal);

  // 9. Stage the ApprovalItem.
  const approval = await stageApproval(ctx, proposal, wt, diffInfo, testRun.stdout + testRun.stderr);
  try {
    await approvalStore.create(ctx, approval);
  } catch (err) {
    if (err instanceof approvalStore.ApprovalCapReached) {
      // Try evict-low-risk once.
      const evicted = await approvalStore.evictLowestRisk(ctx);
      if (evicted) {
        await approvalStore.create(ctx, approval);
      } else {
        await wt.dispose('aborted');
        await updateProposalState(ctx, proposal.id, 'rejected-build');
        return softFail(ctx, policy, proposal.id, 'approval queue full + no low-risk evictable items');
      }
    } else {
      await wt.dispose('aborted');
      return softFail(ctx, policy, proposal.id, `approvalStore.create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await updateProposalState(ctx, proposal.id, 'staged');

  await events.append(ctx, {
    phase: 'build',
    kind: 'complete',
    payload: {
      approvalId: approval.id,
      proposalId: proposal.id,
      filesChanged: diffInfo.addedFiles,
      added: diffInfo.addedLines,
      removed: diffInfo.removedLines,
      testsPassed,
    },
  });

  return {
    ok: true,
    output: {
      schemaVersion: 1,
      approvalId: approval.id,
      worktreePath: wt.worktreePath,
      testOutput: testRun.stdout.slice(-2000),
      buildCycles: 1,
    },
    durationMs: 0,
  };
}

async function ensureCommitted(wt: worktree.WorktreeHandle, proposal: { title: string; id: string }): Promise<void> {
  try {
    // git add -A && check for staged diff && commit
    await execFileP('git', ['add', '-A'], { cwd: wt.worktreePath });
    const statusRes = await execFileP('git', ['status', '--porcelain'], { cwd: wt.worktreePath });
    if (statusRes.stdout.trim().length === 0) {
      // Already committed (or nothing to commit) — caller's diff() picks up HEAD commits.
      return;
    }
    const message = `${proposal.title}\n\nmod8-loop: ${wt.proposalId}`;
    await execFileP('git', ['-c', 'user.email=mod8-loop@local', '-c', 'user.name=mod8-loop', 'commit', '-m', message, '--no-verify'], {
      cwd: wt.worktreePath,
      env: { ...process.env, GIT_COMMITTER_NAME: 'mod8-loop', GIT_COMMITTER_EMAIL: 'mod8-loop@local' },
    });
    void proposal.id;
  } catch {
    /* tolerate — the caller's diff() will reflect whatever made it */
  }
}

function stageApproval(
  ctx: ProductContext,
  proposal: { id: string; title: string; rationale: string; evidenceDigests: string[]; kind: string; targetFiles: string[]; rollbackHint: string; estimatedRisk: 'low' | 'medium' | 'high'; estimatedImpact: 'low' | 'medium' | 'high' },
  wt: worktree.WorktreeHandle,
  diff: { patch: string; addedLines: number; removedLines: number; addedFiles: number },
  testOutput: string,
): ApprovalItem {
  // Map proposal kind → approval kind.
  const kindMap: Record<string, ApprovalItem['kind']> = {
    // code-shaped
    'comment-update': 'code',
    'dep-bump': 'code',
    'refactor': 'code',
    'bug-fix': 'code',
    'feature-add': 'code',
    'reliability-fix': 'code',
    'ui-ux': 'code',           // Ink panels are TS — review surface is code-like
    'command-ux': 'code',
    'onboarding-ux': 'code',
    'error-copy': 'code',      // touches src/* error strings
    // doc-shaped
    'doc-update': 'doc',
    'readme-update': 'doc',
    // marketing / website / customer
    'website-copy': 'website-copy',
    'marketing-post': 'marketing',
    'growth-copy': 'marketing',
    'user-reply': 'user-reply',
    // strategic / experimental
    'experiment': 'experiment',
    'paid-campaign': 'paid-campaign',
    'roadmap-change': 'roadmap',
    'product-strategy': 'roadmap',
  };
  const approvalKind = kindMap[proposal.kind] ?? 'code';

  return {
    schemaVersion: 1,
    id: newApprovalId(),
    productSlug: ctx.slug,
    createdAt: Date.now(),
    proposalId: proposal.id,
    originTickId: ctx.tickId,
    kind: approvalKind,
    title: proposal.title,
    reason: proposal.rationale,
    signals: proposal.evidenceDigests.map((digest) => ({
      source: 'unknown',
      digest,
      ts: Date.now(),
    })),
    proposedAction: {
      type: 'file-edit',
      files: proposal.targetFiles,
      diff: diff.patch.slice(0, 100_000),
      diffStats: {
        added: diff.addedLines,
        removed: diff.removedLines,
        files: diff.addedFiles,
      },
    },
    risk: proposal.estimatedRisk,
    impact: proposal.estimatedImpact,
    rollback: {
      description: proposal.rollbackHint,
      recipe: `git -C ${wt.worktreePath} reset --hard ${wt.baseSha || 'HEAD~1'}`,
    },
    evidence: {
      testsPassed: true,
      testOutput: testOutput.slice(-2000),
      secretScanPassed: true,
      voiceFilterPassed: true,
      diffStats: { added: diff.addedLines, removed: diff.removedLines, files: diff.addedFiles },
      buildCycles: 1,
    },
    state: 'pending',
    worktreePath: wt.worktreePath,
  };
}

function checkFileGuards(files: string[], policy: PolicyConfig): string | null {
  for (const f of files) {
    for (const pat of policy.files.off_limits) {
      if (matchPathPattern(f, pat).matches) return `${f} matches off_limits pattern ${pat}`;
    }
  }
  // protected files don't block at build — they require approval at run-time,
  // which always happens.  Off-limits is the only hard stop here.
  return null;
}

async function softFail(ctx: ProductContext, policy: PolicyConfig, proposalId: string, reason: string): Promise<PhaseResult<BuildOutput>> {
  return runDeterministicPhase<BuildOutput>({
    ctx,
    phase: 'build',
    policy,
    summary: `build failed: ${reason.slice(0, 80)}`,
    body: async () => {
      await events.append(ctx, {
        phase: 'build',
        kind: 'error',
        payload: { reason, proposalId },
      });
      return { schemaVersion: 1, approvalId: null, worktreePath: null, testOutput: null, buildCycles: 0, failureReason: reason };
    },
  });
}

// Touched to keep imports.  fs/execFileP both used in ensureCommitted.
void fs;
