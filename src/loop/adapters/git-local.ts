/**
 * Local git adapter.  Pulls signals from the on-disk git history of
 * the product's repoRoot.  No remote calls, no auth.
 *
 * Phase 1 signal kinds:
 *   - git-local.commit          one signal per commit since `since`
 *   - git-local.branch-created  (Phase 2+)
 *
 * Self-loop guard: commits whose body contains the loop's
 * `selfCommitTrailer` (e.g. `mod8-loop: mod8/<proposal-id>`) are
 * filtered out so the loop doesn't react to its own work.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Adapter, AdapterCredsBase } from './types.js';
import { register } from './registry.js';
import type { ProductContext, Signal } from '../types.js';

const execFileP = promisify(execFile);

interface GitLocalCreds extends AdapterCredsBase {
  authType: 'none';
}

export const gitLocalAdapter: Adapter<GitLocalCreds> = {
  id: 'git-local',
  kind: 'source',
  label: 'Local git history',

  async validate() {
    return { ok: true };
  },

  async *poll(ctx: ProductContext, _creds: GitLocalCreds | null, since: Date): AsyncIterable<Signal> {
    const sinceIso = since.toISOString();
    let stdout: string;
    try {
      const r = await execFileP(
        'git',
        [
          'log',
          `--since=${sinceIso}`,
          '--no-merges',
          // %x1f = unit separator (between fields); %x1e = record separator (between commits)
          '--pretty=format:%H%x1f%ct%x1f%an%x1f%ae%x1f%s%x1f%b%x1e',
        ],
        { cwd: ctx.repoRoot, maxBuffer: 16 * 1024 * 1024 }
      );
      stdout = r.stdout;
    } catch {
      return;
    }

    for (const record of stdout.split('\x1e')) {
      const rec = record.trim();
      if (!rec) continue;
      const fields = rec.split('\x1f');
      if (fields.length < 6) continue;
      const [sha, ctStr, authorName, authorEmail, subject, body] = fields as [string, string, string, string, string, string];

      // Self-loop guard.
      if (body.includes(ctx.selfCommitTrailer)) continue;

      const ts = Number(ctStr) * 1000;
      if (!Number.isFinite(ts)) continue;

      yield {
        schemaVersion: 1,
        source: 'git-local',
        digest: sha.slice(0, 16),
        ts,
        kind: 'git-local.commit',
        title: subject,
        body: body.length > 0 ? body : undefined,
        raw: {
          sha,
          author: { name: authorName, email: authorEmail },
        },
      };
    }
  },
};

register(gitLocalAdapter as Adapter<AdapterCredsBase>);
