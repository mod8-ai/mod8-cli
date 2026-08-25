/**
 * Deterministic checks between ideate and prioritize.
 *
 * `targetFiles` is a plain `z.array(z.string())` — the model writes whatever
 * paths it likes and nothing has ever checked them.  The only path logic
 * downstream is `checkFileGuards` in build.ts, which matches against the
 * policy's off_limits patterns; it never asks whether a file exists.  So a
 * proposal citing `src/auth/session.ts` in a repo with no `src/auth/` passes
 * ideate, passes prioritize, and reaches build — where a git worktree is
 * created and an agent starts an 18-step edit against a codebase that does
 * not look the way the proposal thinks it does.
 *
 * This costs nothing: no model call, no network.  It just reads the disk.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, dirname, relative } from 'node:path';
import type { Proposal } from './proposal.js';

export interface GateDrop {
  proposalId: string;
  title: string;
  reason: string;
}

export interface GateResult {
  kept: Proposal[];
  dropped: GateDrop[];
}

/** Kinds that must edit something that already exists.  A feature-add may
 *  legitimately create a new file, so for those we require only that the
 *  parent directory is real — which still catches an invented subtree. */
const MUST_EXIST = new Set(['bug-fix', 'refactor', 'doc', 'error-copy', 'code']);

function escapesRepo(repoRoot: string, target: string): boolean {
  const rel = relative(repoRoot, target);
  return rel.startsWith('..') || isAbsolute(rel);
}

export function gateProposals(proposals: Proposal[], repoRoot: string): GateResult {
  const kept: Proposal[] = [];
  const dropped: GateDrop[] = [];

  for (const p of proposals) {
    let reason: string | null = null;

    if (!p.targetFiles || p.targetFiles.length === 0) {
      reason = 'names no target files';
    } else {
      for (const f of p.targetFiles) {
        const abs = isAbsolute(f) ? f : resolve(repoRoot, f);
        // An absolute path or a ../ escape is not a mistake we should
        // "helpfully" resolve — it means the model is not describing this repo.
        if (escapesRepo(repoRoot, abs)) {
          reason = `target file "${f}" is outside the repo`;
          break;
        }
        const needsFile = MUST_EXIST.has(p.kind);
        if (needsFile ? !existsSync(abs) : !existsSync(dirname(abs))) {
          reason = needsFile
            ? `target file "${f}" does not exist`
            : `target directory for "${f}" does not exist`;
          break;
        }
      }
    }

    if (reason) dropped.push({ proposalId: p.id, title: p.title, reason });
    else kept.push(p);
  }

  return { kept, dropped };
}
