/**
 * `mod8 context` — show what the agent currently knows about this project.
 *
 * Prints the result of `readProjectContext(cwd)` in human-readable form:
 *   FOUND     → path, byte size, approximate tokens, truncation flag,
 *               where we started and how many parent dirs we climbed.
 *   NOT FOUND → search start, how far we climbed, why we stopped,
 *               and a hint to run `mod8 init`.
 *
 * No LLM call.  Safe to run anywhere.  Used by behavioral specs to assert
 * the walk-up + size-cap logic.
 */

import chalk from 'chalk';
import {
  readProjectContext,
  approximateTokens,
  MAX_BYTES,
  MAX_WALKUP,
} from '../agent/projectContext.js';

export async function runContext(): Promise<void> {
  const result = await readProjectContext(process.cwd());

  if (result.kind === 'found') {
    const { ctx } = result;
    const sizeStr = ctx.bytes.toLocaleString();
    const tokenStr = approximateTokens(ctx.bytes).toLocaleString();
    process.stdout.write(
      `${chalk.bold('Project context:')} ${chalk.green('FOUND')}\n` +
        `  path:        ${ctx.foundAt}\n` +
        `  size:        ${sizeStr} bytes  (~${tokenStr} tokens)\n` +
        `  truncated:   ${ctx.truncated ? chalk.yellow(`yes (cap ${MAX_BYTES} bytes)`) : 'no'}\n` +
        `  walked from: ${ctx.startedAt}` +
        (ctx.levelsClimbed === 0
          ? `  ${chalk.dim('(found in cwd)')}\n`
          : `  ${chalk.dim(`(${ctx.levelsClimbed} ${ctx.levelsClimbed === 1 ? 'level' : 'levels'} up)`)}\n`)
    );
    return;
  }

  const { miss } = result;
  const reason =
    miss.reason === 'home'
      ? `stopped at $HOME (${miss.stoppedAt})`
      : miss.reason === 'root'
        ? `reached filesystem root (${miss.stoppedAt})`
        : `hit walk-up limit (${MAX_WALKUP} levels)`;
  process.stdout.write(
    `${chalk.bold('Project context:')} ${chalk.dim('NOT FOUND')}\n` +
      `  started at:     ${miss.startedAt}\n` +
      `  levels checked: ${miss.levelsChecked}\n` +
      `  reason:         ${reason}\n` +
      '\n' +
      `  Run ${chalk.bold('mod8 init')} to scaffold .mod8/context.md.\n`
  );
}
