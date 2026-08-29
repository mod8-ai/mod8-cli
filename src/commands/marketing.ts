/**
 * `mod8 marketing <plan|status>` — the marketing role from the shell.
 *
 *   mod8 marketing status --slug X   what the role knows: plan, channels,
 *                                    posts waiting, open questions, next step
 *   mod8 marketing plan   --slug X   run the role once: plan.md + one
 *                                    approval card per post
 *   mod8 marketing answer --slug X <n> <text…>
 *                                    answer open question #n (a fact the next
 *                                    plan uses; prohibitions go to `mod8 rule`)
 *
 * --slug defaults to the connected product whose charter points at cwd.
 * Never publishes: every post is a card the founder approves with [a].
 */

import chalk from 'chalk';
import { answerHint, answerMarketingQuestion, renderMarketingStatus, runMarketingPlan, slugForCwd } from '../company/marketing.js';

export interface MarketingCommandOptions { slug?: string; provider?: string; args?: string[] }

export type MarketingSub = 'plan' | 'status' | 'answer';

export async function marketingCommand(sub: MarketingSub, opts: MarketingCommandOptions): Promise<void> {
  const slug = opts.slug ?? (await slugForCwd());
  if (!slug) {
    process.stderr.write(chalk.red('mod8 marketing: ') + 'this folder is not a connected product — pass --slug <slug> (see `mod8 projects`)\n');
    process.exitCode = 1;
    return;
  }

  if (sub === 'status') {
    process.stdout.write(await renderMarketingStatus(slug));
    return;
  }

  if (sub === 'answer') {
    const [nRaw, ...rest] = opts.args ?? [];
    const n = Number(nRaw);
    const text = rest.join(' ').trim();
    if (!Number.isInteger(n) || !text) {
      process.stderr.write(chalk.red('mod8 marketing answer: ') + `usage: ${answerHint(slug)}\n`);
      process.exitCode = 2;
      return;
    }
    const r = await answerMarketingQuestion(slug, n, text);
    if (!r.ok) {
      process.stderr.write(chalk.red('mod8 marketing answer: ') + r.message + '\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(chalk.green('✓ ') + r.message + '\n');
    return;
  }

  process.stderr.write(chalk.dim(`marketing: planning ${slug}${opts.provider ? ` via ${opts.provider}` : ''}…\n`));
  const r = await runMarketingPlan(slug, opts.provider ? { modelOverride: opts.provider } : {});
  if (!r.ok) {
    process.stderr.write(chalk.red('mod8 marketing: ') + r.message + '\n');
    process.exitCode = 1;
    return;
  }
  const out: string[] = [];
  out.push(chalk.green('✓ ') + r.message);
  out.push(`  plan: ${r.planPath}`);
  if (r.cards.length) {
    out.push(`  cards (${r.cards.length}):`);
    for (const id of r.cards) out.push(`    ${id}`);
    out.push(`  approve with /approve <id>  (or: mod8 approvals --slug ${slug})`);
    if (r.blocked) out.push(`  blocked: Meta not connected — approving now fails; first: mod8 connect add-adapter ${slug} meta`);
  } else {
    out.push(r.reused ? '  cards: none new (identical posts already waiting)' : '  cards: none created (the plan has no posts, or the approval queue is full)');
  }
  if (r.questions.length) {
    out.push(`  questions for you (${r.questions.length}):`);
    r.questions.forEach((q, i) => out.push(`    ${i + 1}. ${q}`));
    out.push(`  answer with: ${answerHint(slug)}`);
    out.push(`  (numbering = open questions in \`mod8 marketing status --slug ${slug}\`)`);
  }
  process.stdout.write(out.join('\n') + '\n');
}
