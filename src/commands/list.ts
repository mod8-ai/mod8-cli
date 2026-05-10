import chalk from 'chalk';
import { listSessions, fallbackTitle, loadSession } from '../storage/sessions.js';
import { humanTimeAgo } from '../util/time.js';

export async function listCommand(): Promise<void> {
  const summaries = await listSessions(20);
  if (summaries.length === 0) {
    console.log();
    console.log(chalk.dim('  no sessions yet — run `mod8` to start one'));
    console.log();
    return;
  }

  console.log();
  for (const s of summaries) {
    let title = s.title;
    if (!title) {
      // Title not yet generated — fall back to first message.
      const session = await loadSession(s.id);
      title = session ? fallbackTitle(session) : '(no title)';
    }
    const ago = humanTimeAgo(s.lastActivity);
    const turns = s.turnCount === 1 ? '1 turn' : `${s.turnCount} turns`;
    console.log(
      `  ${chalk.dim(s.id)}  ${chalk.bold(title)}  ${chalk.dim(`· ${ago} · ${turns}`)}`
    );
  }
  console.log();
  console.log(chalk.dim('  resume any with: mod8 resume <id>'));
  console.log();
}
