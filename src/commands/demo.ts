/**
 * `mod8 demo` — the 30-second pitch.  One canned prompt, fan it out
 * across every configured provider, render the side-by-side, then close
 * with the wedge sentence.  Designed for cold-running on a fresh
 * machine right after `mod8 login` — point a VP at this and the value
 * is on screen in one command.
 *
 * Reuses `runAll` so the actual streaming + cost rendering matches the
 * rest of mod8.  Only adds: a framing banner, the canned prompt, and a
 * closing line that names what just happened.
 */

import chalk from 'chalk';
import { runAll } from './all.js';
import { configuredProviderIds } from '../storage/providers.js';
import { readAuth } from '../storage/auth.js';

const DEMO_PROMPT =
  'Write a one-line shell command to find every file modified in the last 7 days that contains the word TODO. Explain it in one sentence.';

export async function demoCommand(): Promise<void> {
  const auth = await readAuth();
  const local = await configuredProviderIds();
  const hasAny = !!auth || local.length > 0;
  if (!hasAny) {
    process.stderr.write(
      chalk.yellow(`mod8 demo needs at least one provider.\n`) +
      chalk.dim(`  · mod8 login              (recommended — connects all four built-ins)\n`) +
      chalk.dim(`  · mod8 keys set <id>      (BYOK)\n`)
    );
    process.exit(1);
  }
  process.stdout.write('\n');
  process.stdout.write(chalk.bold('mod8 demo — same prompt, every model, side by side\n'));
  process.stdout.write(chalk.dim(`prompt: "${DEMO_PROMPT}"\n\n`));
  await runAll(DEMO_PROMPT);
  process.stdout.write('\n');
  process.stdout.write(
    chalk.dim(
      `─── That's the wedge ───────────────────────────────────────────\n` +
      `Same prompt, every model. Each one priced + timed.\n` +
      `mod8 picks the best one per task automatically — type ` +
      chalk.bold(`/why`) +
      ` in chat\n` +
      `to see WHICH model got picked for which kind of work, and why.\n` +
      `Start the REPL with: ` + chalk.bold(`mod8`) + `\n`
    )
  );
}
