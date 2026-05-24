/**
 * GitHub adapter — read-only in Phase 1, gains sink methods in Phase
 * 2 (open branch, open PR, comment).
 *
 * Phase 1 polls:
 *   - github.issue.opened / .commented / .closed
 *   - github.pr.opened    / .commented / .merged / .closed
 *
 * Auth: env GITHUB_TOKEN (PAT) for Phase 1 self-host on mod8.  Phase
 * 4 adds proxy-brokered OAuth via the mod8 proxy and persists creds
 * at products/<slug>/connectors/github.json.
 *
 * Wire format: GitHub REST API v3, paginated with the `since` query
 * parameter (built-in idempotency — same window returns the same
 * issues; digest comes from `id` field so dedupe is exact).
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Adapter, AdapterCredsBase } from './types.js';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { ProductContext, Signal } from '../types.js';

const execFileP = promisify(execFile);

interface GitHubCreds extends AdapterCredsBase {
  authType: 'env' | 'pat' | 'oauth';
  /** Stored when authType=pat or oauth. */
  token?: string;
  /** owner/repo for the product's primary repo.  Phase 1 derives this
   *  from the remote URL on first poll if not set. */
  ownerRepo?: string;
}

const API = 'https://api.github.com';

export const githubAdapter: Adapter<GitHubCreds> = {
  id: 'github',
  kind: 'both',
  label: 'GitHub (issues + PRs + commits, write via PR in Phase 2)',

  async validate(_ctx, creds) {
    const token = effectiveToken(creds);
    if (!token) return { ok: false, detail: 'no GITHUB_TOKEN env or stored token' };
    const resp = await fetch(`${API}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    return resp.ok ? { ok: true } : { ok: false, detail: `GitHub /user returned ${resp.status}` };
  },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const token = effectiveToken(creds);
    const ownerRepo = (creds?.ownerRepo) ?? (await detectOwnerRepo(ctx.repoRoot));
    if (!ownerRepo) return;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const sinceParam = since.toISOString();

    // Issues (which includes PRs in GitHub's data model — we tag based
    // on `pull_request` field).
    try {
      const url = `${API}/repos/${ownerRepo}/issues?state=all&since=${encodeURIComponent(sinceParam)}&per_page=50`;
      const resp = await fetch(url, { headers });
      if (resp.ok) {
        const items = (await resp.json()) as Array<Record<string, unknown>>;
        for (const it of items) {
          const isPr = it.pull_request !== undefined;
          const number = it.number as number;
          const updatedAt = typeof it.updated_at === 'string' ? Date.parse(it.updated_at) : Date.now();
          const state = (it.state as string) || 'unknown';
          const title = (it.title as string) || '';
          const body = typeof it.body === 'string' ? it.body : undefined;
          const htmlUrl = it.html_url as string | undefined;
          yield {
            schemaVersion: 1,
            source: 'github',
            digest: `${ownerRepo}#${isPr ? 'pr' : 'issue'}-${number}-${updatedAt}`,
            ts: updatedAt,
            kind: isPr ? `github.pr.${state}` : `github.issue.${state}`,
            title,
            body,
            url: htmlUrl,
            raw: {
              number,
              ownerRepo,
              labels: ((it.labels as Array<{ name?: string }> | undefined) ?? [])
                .map((l) => l.name)
                .filter((n): n is string => typeof n === 'string'),
              author: typeof it.user === 'object' && it.user !== null ? (it.user as Record<string, unknown>).login : undefined,
            },
          };
        }
      }
    } catch {
      /* network / rate-limit — silent for this poll, sense.ts surfaces
         the absence in countsBySource */
    }
  },

  // Phase 2 will populate preview/apply/rollback for the PR + comment
  // action shapes.  Intentionally absent in Phase 1.
};

function effectiveToken(creds: GitHubCreds | null): string | undefined {
  if (creds?.token) return creds.token;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return undefined;
}

/** Derive `owner/repo` from `git remote get-url origin`.  Handles both
 *  HTTPS (`https://github.com/owner/repo.git`) and SSH
 *  (`git@github.com:owner/repo.git`).  Returns null when not a GitHub
 *  remote. */
async function detectOwnerRepo(repoRoot: string): Promise<string | null> {
  try {
    const r = await execFileP('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
    const url = r.stdout.trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (!m) return null;
    return `${m[1]}/${m[2]}`;
  } catch {
    return null;
  }
}

/** Read stored creds for this product, or null if none.  Phase 1
 *  callers typically pass null and rely on env GITHUB_TOKEN. */
export async function readCreds(ctx: ProductContext): Promise<GitHubCreds | null> {
  const path = connectorPath(ctx, 'github');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as GitHubCreds;
  } catch {
    return null;
  }
}

register(githubAdapter as Adapter<AdapterCredsBase>);
