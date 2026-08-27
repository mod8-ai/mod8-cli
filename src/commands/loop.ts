/**
 * `mod8 loop` subcommand group.  Phase 1: tick / status / logs / audit.
 * Phase 2 adds start / stop (daemon).
 *
 * Each subcommand prints to stdout and exits via process.exit on
 * error (matches the existing `mod8 balance` / `mod8 topup` pattern in
 * src/cli.ts).  No exceptions thrown to the commander layer.
 */

import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { tick } from '../loop/tick.js';
import * as events from '../loop/events.js';
import * as state from '../loop/state.js';
import * as audit from '../loop/audit.js';
import * as feedback from '../memory/feedback.js';
import * as kill from '../loop/kill.js';
import * as product from '../memory/product.js';
import * as daemon from '../loop/daemon.js';
import { loadPolicy, PolicyMissing, effectiveAutonomy } from '../loop/policy.js';
import { buildProductContext, GLOBAL_PATHS } from '../memory/paths.js';
import { snapshot as budgetSnapshot } from '../loop/budget.js';
import { loadAllAdapters } from '../loop/adapters/registry.js';
import type { PhaseEvent, PhaseId } from '../loop/types.js';

/** Slug resolution.  Phase 1 only operates on mod8 itself; the
 *  default product is `mod8` running on cwd.  Phase 4's `mod8 connect`
 *  wizard registers other products. */
const DEFAULT_SLUG = 'mod8';

export async function loopTick(opts: { slug?: string; unsafeNoLock?: boolean; force?: boolean }): Promise<void> {
  await loadAllAdapters().catch(() => { /* already loaded */ });
  const slug = opts.slug ?? DEFAULT_SLUG;
  const result = await tick({
    slug,
    repoRoot: process.cwd(),
    ...(opts.unsafeNoLock ? { unsafeNoLock: true } : {}),
    ...(opts.force ? { force: true } : {}),
  });

  if (!result.ok) {
    process.stderr.write(chalk.yellow(`mod8 loop tick: ${result.reason}\n`));
    if (result.phaseOutcomes.length > 0) {
      printOutcomes(result.phaseOutcomes);
    }
    process.exit(1);
  }

  process.stdout.write(chalk.bold(`mod8 loop tick ${result.tickId} — ${slug}\n`));
  printOutcomes(result.phaseOutcomes);
  process.stdout.write(chalk.dim(`\nrun  ${chalk.bold('mod8 loop status')}  for current state · ${chalk.bold('mod8 loop logs')}  for the event tail\n`));
}

function printOutcomes(outcomes: Array<{ phase: string; ran: boolean; ok: boolean; durationMs: number; reason?: string }>): void {
  for (const o of outcomes) {
    if (o.ran) {
      const tag = o.ok ? chalk.green('✓') : chalk.red('✗');
      process.stdout.write(`  ${tag} ${o.phase.padEnd(12)} ${o.durationMs}ms${o.reason ? chalk.dim(` — ${o.reason}`) : ''}\n`);
    } else {
      process.stdout.write(`  ${chalk.dim('·')} ${o.phase.padEnd(12)} ${chalk.dim(o.reason ?? 'skipped')}\n`);
    }
  }
}

export async function loopStatus(opts: { slug?: string }): Promise<void> {
  const slug = opts.slug ?? DEFAULT_SLUG;
  const ctx = buildProductContext(slug, process.cwd(), 0);

  // Header.
  process.stdout.write(chalk.bold(`mod8 loop status — ${slug}\n\n`));

  // Kill switch.
  const ks = kill.check();
  if (ks.active) {
    process.stdout.write(chalk.red(`  ⚠ kill switch ACTIVE — ${ks.reason}\n`) +
      chalk.dim(`    ticks are no-ops until the STOP file is removed: rm ${GLOBAL_PATHS.killSwitch}\n\n`));
  }

  // Product charter.
  const hasMd = await product.exists(ctx);
  process.stdout.write(`  product.md:   ${hasMd ? chalk.green('present') : chalk.yellow('missing — `mod8 loop tick` will scaffold a template')}\n`);

  // Policy.
  let policyLine = chalk.yellow('missing');
  try {
    const policy = await loadPolicy(ctx);
    const autonomy = effectiveAutonomy(policy);
    policyLine = `L${autonomy}${policy.paused_until ? chalk.dim(` (paused until ${policy.paused_until})`) : ''}`;
  } catch (err) {
    if (err instanceof PolicyMissing) {
      policyLine = chalk.yellow(`missing — write one before running the loop`);
    } else {
      policyLine = chalk.red(`invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.stdout.write(`  policy.yaml:  ${policyLine}\n`);

  // FSM state.
  const s = await state.load(ctx);
  process.stdout.write(`  last tick:    ${s.lastTickAt ? `#${s.lastTickId} at ${new Date(s.lastTickAt).toISOString()}` : chalk.dim('never')}\n`);
  if (s.currentProposalId) {
    process.stdout.write(`  in-flight:    proposal ${s.currentProposalId}\n`);
  }
  if (s.waitUntilTs) {
    process.stdout.write(`  waiting:      until ${new Date(s.waitUntilTs).toISOString()} (for measure)\n`);
  }

  // Per-phase last-run snapshot.
  process.stdout.write(`\n  per-phase last run:\n`);
  for (const p of ['sense', 'ideate', 'prioritize', 'build', 'act', 'measure', 'learn'] as PhaseId[]) {
    const lr = s.lastRunByPhase[p];
    process.stdout.write(`    ${p.padEnd(12)} ${lr ? new Date(lr).toISOString() : chalk.dim('—')}\n`);
  }

  // Feedback corpora counts.
  const sources = ['inbox-folder', 'github', 'git-local'];
  process.stdout.write(`\n  feedback signals (all-time):\n`);
  for (const src of sources) {
    const n = await feedback.countAll(ctx, src);
    process.stdout.write(`    ${src.padEnd(14)} ${n}\n`);
  }

  // Spend.
  try {
    const snap = await budgetSnapshot(ctx);
    process.stdout.write(`\n  spend:        today $${snap.daySpentUsd.toFixed(4)} · this month $${snap.monthSpentUsd.toFixed(4)}\n`);
  } catch { /* tolerate */ }

  // Last event of each phase.
  process.stdout.write(`\n  recent events (last 10):\n`);
  const tail = await events.readTail(ctx, 10);
  if (tail.length === 0) {
    process.stdout.write(chalk.dim(`    (none yet — run \`mod8 loop tick\` to start)\n`));
  } else {
    for (const ev of tail) {
      process.stdout.write(`    ${formatEvent(ev)}\n`);
    }
  }
}

export async function loopLogs(opts: { slug?: string; tail?: string }): Promise<void> {
  const slug = opts.slug ?? DEFAULT_SLUG;
  const ctx = buildProductContext(slug, process.cwd(), 0);
  const n = opts.tail ? Math.max(1, Math.min(1000, Number(opts.tail) || 50)) : 50;
  const tail = await events.readTail(ctx, n);
  if (tail.length === 0) {
    process.stdout.write(chalk.dim(`(no events yet — run \`mod8 loop tick\` first)\n`));
    return;
  }
  for (const ev of tail) {
    process.stdout.write(formatEvent(ev) + '\n');
  }
}

export async function loopStart(opts: { slug?: string; foreground?: boolean; intervalMinutes?: number }): Promise<void> {
  const slug = opts.slug ?? DEFAULT_SLUG;
  const existing = await daemon.readPid();
  if (existing && daemon.isPidAlive(existing)) {
    process.stderr.write(chalk.yellow(`mod8 loop start: daemon already running (pid ${existing}).\n`) +
      chalk.dim('  use `mod8 loop stop` first to restart it.\n'));
    process.exit(1);
  }

  if (opts.foreground) {
    process.stdout.write(chalk.bold(`mod8 loop daemon — ${slug} (foreground)\n`));
    process.stdout.write(chalk.dim(`pid: ${process.pid} · stop: SIGINT (Ctrl+C) or SIGTERM\n\n`));
    await daemon.startInline({
      slug,
      repoRoot: process.cwd(),
      ...(opts.intervalMinutes ? { intervalMs: opts.intervalMinutes * 60_000 } : {}),
    });
    return;
  }

  // Background: respawn this process with --foreground and detach.
  const child = spawn(process.execPath, [process.argv[1]!, 'loop', 'start', '--foreground', '--slug', slug, ...(opts.intervalMinutes ? ['--interval-minutes', String(opts.intervalMinutes)] : [])], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();
  // Wait briefly to confirm PID file appears.
  await new Promise((r) => setTimeout(r, 600));
  const pid = await daemon.readPid();
  if (pid && daemon.isPidAlive(pid)) {
    process.stdout.write(chalk.green(`✓ mod8 loop daemon started`) + chalk.dim(`  pid ${pid} · slug ${slug}\n`));
    process.stdout.write(chalk.dim('  status: mod8 loop status · logs: mod8 loop logs · stop: mod8 loop stop\n'));
  } else {
    process.stderr.write(chalk.red('mod8 loop start: daemon did not write a pid file within 600ms.\n') +
      chalk.dim('  try `mod8 loop start --foreground` to see startup errors.\n'));
    process.exit(1);
  }
}

export async function loopStop(): Promise<void> {
  const r = await daemon.stopRunning();
  if (!r.pid) {
    process.stdout.write(chalk.dim('mod8 loop stop: no daemon running.\n'));
    return;
  }
  if (!r.stopped) {
    process.stderr.write(chalk.yellow(`mod8 loop stop: pid ${r.pid} was stale — pid file cleaned up.\n`));
    return;
  }
  process.stdout.write(chalk.green(`✓ sent SIGTERM to daemon pid ${r.pid}.\n`));
}

export async function loopHalt(): Promise<void> {
  const path = await kill.activate();
  process.stdout.write(
    chalk.yellow(`⚠ kill switch activated\n`) +
    chalk.dim(`  STOP file: ${path}\n`) +
    chalk.dim('  every subsequent tick is a no-op until you remove it.\n') +
    chalk.dim('  resume:  mod8 loop resume\n')
  );
}

export async function loopResume(): Promise<void> {
  await kill.clear();
  process.stdout.write(chalk.green(`✓ kill switch cleared — loop will resume on next tick.\n`));
}

export async function loopAuditVerify(opts: { slug?: string }): Promise<void> {
  const slug = opts.slug ?? DEFAULT_SLUG;
  const ctx = buildProductContext(slug, process.cwd(), 0);
  const result = await audit.verifyChain(ctx);
  if (result.ok) {
    process.stdout.write(chalk.green(`✓ audit chain valid — ${result.entries} entr${result.entries === 1 ? 'y' : 'ies'}\n`));
    return;
  }
  process.stderr.write(
    chalk.red(`✗ audit chain BROKEN at index ${result.brokenIndex}\n`) +
    chalk.dim(`  ${result.reason}\n`)
  );
  process.exit(1);
}

function formatEvent(ev: PhaseEvent): string {
  const ts = new Date(ev.ts).toISOString().slice(11, 19);
  const tag = ev.kind === 'complete' ? chalk.green('✓')
    : ev.kind === 'error' ? chalk.red('✗')
    : ev.kind === 'start' ? chalk.cyan('→')
    : ev.kind === 'skipped' ? chalk.dim('·')
    : ev.kind === 'kill-switch' ? chalk.red('⚠')
    : ev.kind === 'not-implemented' ? chalk.dim('∅')
    : ev.kind === 'budget-exhausted' ? chalk.yellow('$')
    : chalk.dim('?');
  const dur = ev.durationMs ? chalk.dim(` ${ev.durationMs}ms`) : '';
  const payload = ev.payload && Object.keys(ev.payload).length > 0
    ? chalk.dim(`  ${JSON.stringify(ev.payload).slice(0, 120)}`)
    : '';
  return `  ${ts}  tick#${ev.tickId}  ${tag} ${ev.phase.padEnd(11)} ${ev.kind.padEnd(18)}${dur}${payload}`;
}
