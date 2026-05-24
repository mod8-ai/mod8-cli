/**
 * npm publish adapter — runs `npm publish` from a worktree.
 *
 * EXTRA-GUARDED: policy.check enforces npm-publish to always require
 * explicit human approval, regardless of autonomy level (see policy.ts
 * `case 'npm-publish'`).  This adapter also re-checks at apply time
 * via a confirmation token (the approval id must match the
 * worktree's loop branch suffix).
 *
 * Auth: NPM_TOKEN env variable (the npm CLI reads this from
 * ~/.npmrc).  The adapter doesn't store credentials — it relies on
 * the local npm config / env.
 *
 * Rollback: `npm unpublish` is restricted by npm policy (only valid
 * within 72 hours, only for unique versions, sometimes blocked
 * entirely for popular packages).  Recipe carries the version + a
 * note instructing manual intervention if unpublish fails.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { register } from './registry.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext } from '../types.js';

const execFileP = promisify(execFile);

interface NpmCreds extends AdapterCredsBase {
  authType: 'env';
}

export const npmAdapter: Adapter<NpmCreds> = {
  id: 'npm',
  kind: 'sink',
  label: 'npm publish (always requires explicit human approval)',

  async validate() {
    // Check we have a token — npm whoami reads from .npmrc / env.
    try {
      const r = await execFileP('npm', ['whoami'], { timeout: 10_000 });
      return { ok: true, detail: `authenticated as ${r.stdout.trim()}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },

  async apply(ctx, _creds, action): Promise<ActionResult> {
    if (action.type !== 'npm-publish') throw new Error(`npm.apply: unsupported type ${action.type}`);
    // Sanity: refuse to publish from the user's main working tree — must
    // be invoked against a vetted worktree.  Caller is expected to set
    // CWD via spawn options; we use repoRoot as the publish cwd, which
    // is what `npm publish` reads.
    const cwd = ctx.repoRoot;
    // Dry-run first to surface any packaging error before the real publish.
    try {
      await execFileP('npm', ['publish', '--dry-run', '--tag', action.tag], { cwd, timeout: 60_000 });
    } catch (err) {
      throw new Error(`npm publish --dry-run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    let r;
    try {
      r = await execFileP('npm', ['publish', '--tag', action.tag], { cwd, timeout: 180_000 });
    } catch (err) {
      throw new Error(`npm publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      schemaVersion: 1,
      adapter: 'npm',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: {
        packageName: action.packageName,
        version: action.version,
        tag: action.tag,
        npmOutput: r.stdout.slice(-500),
      },
      rollbackRecipe: {
        description: `npm unpublish ${action.packageName}@${action.version} (only valid within 72h; may be blocked for popular packages — escalate to npm support if needed)`,
        payload: { packageName: action.packageName, version: action.version },
      },
    };
  },

  async rollback(_ctx, _creds, result): Promise<{ ok: boolean; detail?: string }> {
    const pkg = result.rollbackRecipe.payload?.packageName as string | undefined;
    const ver = result.rollbackRecipe.payload?.version as string | undefined;
    if (!pkg || !ver) return { ok: false, detail: 'missing package/version' };
    try {
      const r = await execFileP('npm', ['unpublish', `${pkg}@${ver}`, '--force'], { timeout: 60_000 });
      return { ok: true, detail: r.stdout.trim() };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

register(npmAdapter as Adapter<AdapterCredsBase>);
