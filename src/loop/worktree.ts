/**
 * Git worktree manager for build-phase patch sandboxing.
 *
 * Every proposal that reaches build gets its own worktree at
 * `<repoRoot>/.mod8-worktrees/<proposal-id>/` on branch
 * `loop/<proposal-id>` based on policy-defined base (default: main).
 * The worktree is the ONLY place the loop ever edits files — the
 * live working tree is never touched.
 *
 * `.mod8-worktrees/` is auto-appended to .gitignore on first use so
 * the host repo doesn't see worktrees as untracked files.
 *
 * Registry: products/<slug>/worktrees.jsonl — appended on create,
 * mutated-via-append on status change.  Daemon startup walks this to
 * recover in-flight worktrees after a crash.
 */

import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { productFiles, productPath } from '../memory/paths.js';
import type { ProductContext } from './types.js';

const execFileP = promisify(execFile);

export type WorktreeStatus = 'building' | 'staged' | 'merged' | 'rejected' | 'aborted' | 'aborted-crash' | 'aborted-stale';

export interface WorktreeRecord {
  schemaVersion: 1;
  proposalId: string;
  productSlug: string;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  createdAt: number;
  status: WorktreeStatus;
  /** sha of the base commit at create-time, for diff + revert. */
  baseSha?: string;
}

export interface WorktreeHandle {
  proposalId: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  baseSha: string;
  /** Run a command inside the worktree.  Combined stdout+stderr is
   *  returned; exit code via .exitCode.  Used by build phase for
   *  `npm test` etc. */
  run(cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }>;
  /** Stage + commit any uncommitted work in the worktree.  Returns true
   *  if a commit was made.  Called by build before diff() so agent edits
   *  are never lost. */
  commitAll(message: string): Promise<boolean>;
  /** Dispose the worktree (and its branch) — called after merge,
   *  rejection, or abort.  Updates the registry. */
  dispose(status: 'merged' | 'rejected' | 'aborted'): Promise<void>;
  /** Capture the current diff vs baseSha as a unified patch (for
   *  ApprovalItem preview). */
  diff(): Promise<{ patch: string; addedFiles: number; removedFiles: number; addedLines: number; removedLines: number }>;
}

const WORKTREE_DIR_NAME = '.mod8-worktrees';
const GITIGNORE_LINE = `${WORKTREE_DIR_NAME}/`;
const STALE_DAYS = 7;

async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    const r = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
    const b = r.stdout.trim();
    return b && b !== 'HEAD' ? b : null;
  } catch { return null; }
}

/** Create a new worktree for a proposal.  Refuses if a worktree
 *  already exists for this proposal id (the loop should never
 *  re-build without first aborting the prior). */
export async function create(ctx: ProductContext, proposalId: string, opts?: { baseBranch?: string }): Promise<WorktreeHandle> {
  // Default base = whatever the repo currently has checked out.  'main'
  // was wrong on every repo that works on a feature branch: the agent
  // built against stale code and its proposal no longer matched reality.
  const baseBranch = opts?.baseBranch ?? (await currentBranch(ctx.repoRoot)) ?? 'main';
  await ensureGitignoreEntry(ctx.repoRoot);

  const worktreePath = resolve(ctx.repoRoot, WORKTREE_DIR_NAME, proposalId);
  if (existsSync(worktreePath)) {
    throw new Error(`worktree already exists for proposal ${proposalId} at ${worktreePath} — abort it first`);
  }

  const branch = `loop/${proposalId}`;
  // Resolve baseBranch → sha so the record is robust even if baseBranch moves.
  const baseSha = await rev(ctx.repoRoot, baseBranch);

  await execFileP('git', ['worktree', 'add', worktreePath, '-b', branch, baseBranch], {
    cwd: ctx.repoRoot,
    maxBuffer: 4 * 1024 * 1024,
  });

  const record: WorktreeRecord = {
    schemaVersion: 1,
    proposalId,
    productSlug: ctx.slug,
    branch,
    baseBranch,
    worktreePath,
    createdAt: Date.now(),
    status: 'building',
    baseSha,
  };
  await appendRecord(ctx, record);

  return buildHandle(ctx, record);
}

/** Re-attach to an existing worktree (e.g. on daemon restart). */
export async function attach(ctx: ProductContext, proposalId: string): Promise<WorktreeHandle | null> {
  const records = await listRecords(ctx);
  const latest = lastForProposal(records, proposalId);
  if (!latest) return null;
  if (!existsSync(latest.worktreePath)) return null;
  return buildHandle(ctx, latest);
}

function buildHandle(ctx: ProductContext, record: WorktreeRecord): WorktreeHandle {
  return {
    proposalId: record.proposalId,
    branch: record.branch,
    worktreePath: record.worktreePath,
    baseBranch: record.baseBranch,
    baseSha: record.baseSha ?? '',
    async run(cmd, args, opts) {
      const start = Date.now();
      return new Promise((resolveP) => {
        const child = spawn(cmd, args, {
          cwd: record.worktreePath,
          env: { ...process.env, ...(opts?.env ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const settle = (exitCode: number) => {
          if (settled) return;
          settled = true;
          try { child.stdout?.destroy(); } catch { /* gone */ }
          try { child.stderr?.destroy(); } catch { /* gone */ }
          resolveP({ stdout, stderr, exitCode, durationMs: Date.now() - start });
        };
        child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); if (stdout.length > 64 * 1024) stdout = stdout.slice(0, 64 * 1024) + '\n…(truncated)'; });
        child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); if (stderr.length > 64 * 1024) stderr = stderr.slice(0, 64 * 1024) + '\n…(truncated)'; });
        const killer = setTimeout(() => {
          try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
          setTimeout(() => settle(124), 200);
        }, opts?.timeoutMs ?? 120_000);
        child.on('exit', (code) => {
          clearTimeout(killer);
          setTimeout(() => settle(code ?? 1), 100);
        });
        child.on('error', () => {
          clearTimeout(killer);
          settle(1);
        });
      });
    },
    async dispose(status) {
      // Best-effort: remove worktree + delete branch.  Failures leave
      // a record with status updated to 'aborted-stale' which the
      // daemon cleanup will revisit.
      try {
        await execFileP('git', ['worktree', 'remove', '--force', record.worktreePath], { cwd: ctx.repoRoot });
      } catch { /* tolerate */ }
      try {
        await execFileP('git', ['branch', '-D', record.branch], { cwd: ctx.repoRoot });
      } catch { /* tolerate — branch may have been pushed/merged already */ }
      await appendRecord(ctx, { ...record, status });
    },
    async commitAll(message) {
      // The build agent is told to commit, but often leaves edits in the
      // working tree.  diff() only sees commits, so uncommitted work used
      // to be thrown away as "no diff".  Stage + commit anything left.
      try {
        const st = await execFileP('git', ['status', '--porcelain'], { cwd: record.worktreePath });
        if (st.stdout.trim().length === 0) return false;
        await execFileP('git', ['add', '-A'], { cwd: record.worktreePath });
        await execFileP('git', ['-c', 'user.name=mod8-loop', '-c', 'user.email=loop@mod8.ai', 'commit', '-q', '-m', message], { cwd: record.worktreePath });
        return true;
      } catch { return false; }
    },
    async diff() {
      // git diff baseSha..HEAD inside worktree.
      const baseRef = record.baseSha ?? record.baseBranch;
      let patch = '';
      try {
        const r = await execFileP('git', ['diff', `${baseRef}..HEAD`], {
          cwd: record.worktreePath,
          maxBuffer: 16 * 1024 * 1024,
        });
        patch = r.stdout;
      } catch {
        // No commits yet — diff workdir vs base.
        try {
          const r = await execFileP('git', ['diff', baseRef], {
            cwd: record.worktreePath,
            maxBuffer: 16 * 1024 * 1024,
          });
          patch = r.stdout;
        } catch { /* truly empty */ }
      }
      // Parse diff stats (very rough — counts lines starting with +/- not +++/---).
      let addedLines = 0;
      let removedLines = 0;
      const addedFiles = new Set<string>();
      const removedFiles = new Set<string>();
      for (const line of patch.split('\n')) {
        if (line.startsWith('+++ b/')) addedFiles.add(line.slice(6));
        else if (line.startsWith('--- a/')) removedFiles.add(line.slice(6));
        else if (line.startsWith('+') && !line.startsWith('+++')) addedLines++;
        else if (line.startsWith('-') && !line.startsWith('---')) removedLines++;
      }
      return {
        patch,
        addedFiles: addedFiles.size,
        removedFiles: removedFiles.size,
        addedLines,
        removedLines,
      };
    },
  };
}

/** Daemon startup helper — walks the registry, cleans up stale or
 *  orphaned worktrees, marks crashed builds as `aborted-crash`. */
export async function cleanupStale(ctx: ProductContext, now: number = Date.now()): Promise<{ cleanedUp: number; orphans: number }> {
  const records = await listRecords(ctx);
  const latestByProposal = new Map<string, WorktreeRecord>();
  for (const r of records) latestByProposal.set(r.proposalId, r);

  let cleanedUp = 0;
  let orphans = 0;
  const staleCutoff = now - STALE_DAYS * 24 * 60 * 60 * 1000;
  for (const r of latestByProposal.values()) {
    if (r.status === 'merged' || r.status === 'rejected' || r.status === 'aborted' || r.status === 'aborted-stale') continue;
    if (r.createdAt < staleCutoff) {
      try {
        await execFileP('git', ['worktree', 'remove', '--force', r.worktreePath], { cwd: ctx.repoRoot });
        await execFileP('git', ['branch', '-D', r.branch], { cwd: ctx.repoRoot });
      } catch { /* tolerate */ }
      await appendRecord(ctx, { ...r, status: 'aborted-stale' });
      cleanedUp++;
    } else if (r.status === 'building' && !existsSync(r.worktreePath)) {
      // Worktree dir vanished without the registry being updated — crash signature.
      await appendRecord(ctx, { ...r, status: 'aborted-crash' });
      orphans++;
    }
  }
  return { cleanedUp, orphans };
}

/** Count of currently-in-progress worktrees for this product — used
 *  by build phase to enforce policy.concurrent_worktrees. */
export async function countActive(ctx: ProductContext): Promise<number> {
  const records = await listRecords(ctx);
  const latest = new Map<string, WorktreeRecord>();
  for (const r of records) latest.set(r.proposalId, r);
  let n = 0;
  for (const r of latest.values()) {
    if (r.status === 'building' || r.status === 'staged') n++;
  }
  return n;
}

async function rev(repoRoot: string, ref: string): Promise<string> {
  try {
    const r = await execFileP('git', ['rev-parse', ref], { cwd: repoRoot });
    return r.stdout.trim();
  } catch {
    // ref doesn't exist — try HEAD.
    try {
      const r = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
      return r.stdout.trim();
    } catch {
      return '';
    }
  }
}

async function ensureGitignoreEntry(repoRoot: string): Promise<void> {
  const gi = join(repoRoot, '.gitignore');
  let existing = '';
  if (existsSync(gi)) {
    try { existing = await fs.readFile(gi, 'utf8'); } catch { /* tolerate */ }
  }
  if (existing.split('\n').some((l) => l.trim() === GITIGNORE_LINE || l.trim() === WORKTREE_DIR_NAME)) return;
  const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.writeFile(gi, `${existing}${sep}${GITIGNORE_LINE}\n`);
}

async function appendRecord(ctx: ProductContext, record: WorktreeRecord): Promise<void> {
  const path = productFiles.worktrees(ctx);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.appendFile(path, JSON.stringify(record) + '\n', { mode: 0o600 });
}

async function listRecords(ctx: ProductContext): Promise<WorktreeRecord[]> {
  const path = productFiles.worktrees(ctx);
  if (!existsSync(path)) return [];
  const buf = await fs.readFile(path, 'utf8');
  const out: WorktreeRecord[] = [];
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as WorktreeRecord); } catch { /* skip */ }
  }
  return out;
}

function lastForProposal(records: WorktreeRecord[], proposalId: string): WorktreeRecord | null {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.proposalId === proposalId) return records[i]!;
  }
  return null;
}

/** Public helper for diff in approval flow re-validation — avoids
 *  attach roundtrip when caller only needs the patch text. */
export async function readDiffByProposal(ctx: ProductContext, proposalId: string): Promise<string | null> {
  const handle = await attach(ctx, proposalId);
  if (!handle) return null;
  const d = await handle.diff();
  return d.patch;
}

/** Productpath helper — internal but exported so tests can locate
 *  worktrees.jsonl without re-deriving. */
export const _worktreesIndexPath = (ctx: ProductContext): string => productFiles.worktrees(ctx);
void productPath; // future use
