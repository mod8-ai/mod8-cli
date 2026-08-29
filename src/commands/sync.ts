/**
 * `mod8 sync [--slug X] [--dry-run] [--json]` — push the company brain to
 * the mod8 web dashboard and apply decisions made there.  Same code as
 * `/sync` in the REPL (company/sync.ts).
 */

import chalk from 'chalk';
import { NotLoggedInForSync, buildSyncPayload, renderSync, runSync } from '../company/sync.js';

export interface SyncCommandOptions { slug?: string; dryRun?: boolean; json?: boolean }

export async function syncCommand(opts: SyncCommandOptions): Promise<void> {
  try {
    const r = await runSync({ slug: opts.slug, dryRun: opts.dryRun });
    if (opts.json) {
      const payload = opts.dryRun ? await buildSyncPayload(opts.slug) : undefined;
      process.stdout.write(JSON.stringify({ ...r, ...(payload ? { payload } : {}) }, null, 2) + '\n');
    } else {
      process.stdout.write(renderSync(r));
    }
    if (r.decisionsFailed > 0) process.exitCode = 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(chalk.red('mod8 sync: ') + msg + '\n');
    process.exitCode = err instanceof NotLoggedInForSync ? 2 : 1;
  }
}
