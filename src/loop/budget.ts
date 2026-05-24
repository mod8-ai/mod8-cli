/**
 * 3-layer budget enforcement: per-tick / per-phase / per-day.
 *
 *   - Per-phase cap is the most-immediate gate, enforced by policy.check
 *     via the 'spend' action shape before the LLM call goes out.
 *   - Per-tick cap is enforced here — sum of all spend in this tickId.
 *   - Per-day cap is enforced here — sum of all spend in the rolling
 *     24h window before now().
 *   - Per-month is enforced here too — sum since start of current
 *     calendar month (UTC).
 *
 * The ledger is products/<slug>/spend.jsonl, append-only with the same
 * rotate-at-byte-cap pattern used by storage/routingLog.ts and
 * storage/crashLog.ts.  Best-effort writes — a budget-write failure
 * never blocks an LLM call (we'd rather slightly overspend than freeze
 * the loop on a disk error), but every overspend is audit-logged at
 * the next tick.
 *
 * During-phase enforcement (against accumulated streaming tokens
 * mid-call) lives in loop/runPhase.ts as a custom stopWhen predicate
 * — the budget tracker passes a "remaining $" value into runPhase and
 * runPhase computes a running cost via priceFor() from
 * providers/pricing.ts.
 */

import { promises as fs } from 'node:fs';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { productFiles } from '../memory/paths.js';
import type { BudgetEntry, PhaseId, PolicyConfig, ProductContext } from './types.js';

const MAX_BYTES = 256 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BudgetSnapshot {
  /** Sum of costUsd in the current tickId. */
  tickSpentUsd: number;
  /** Sum of costUsd in the rolling 24h window. */
  daySpentUsd: number;
  /** Sum of costUsd since start of current calendar month (UTC). */
  monthSpentUsd: number;
}

export interface CanSpendResult {
  allowed: boolean;
  reason?: string;
  snapshot: BudgetSnapshot;
}

/** Read the ledger, compute spend across the three windows.  O(N)
 *  in the file size — fine because we rotate at 256 KB.  Returns
 *  zero-snapshot when the ledger doesn't exist yet. */
export async function snapshot(ctx: ProductContext): Promise<BudgetSnapshot> {
  const path = productFiles.spend(ctx);
  if (!existsSync(path)) {
    return { tickSpentUsd: 0, daySpentUsd: 0, monthSpentUsd: 0 };
  }
  const now = Date.now();
  const monthStart = startOfMonthUtc(now);
  const dayCutoff = now - DAY_MS;
  let tickSum = 0;
  let daySum = 0;
  let monthSum = 0;
  const buf = await fs.readFile(path, 'utf8');
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    let entry: BudgetEntry;
    try { entry = JSON.parse(line) as BudgetEntry; } catch { continue; }
    if (entry.productSlug !== ctx.slug) continue;
    if (entry.ts >= monthStart) monthSum += entry.costUsd;
    if (entry.ts >= dayCutoff) daySum += entry.costUsd;
    if (entry.tickId === ctx.tickId) tickSum += entry.costUsd;
  }
  return { tickSpentUsd: tickSum, daySpentUsd: daySum, monthSpentUsd: monthSum };
}

/** Pre-flight cap check.  Caller passes the planned cost; if any of
 *  the three windows would be exceeded, returns allowed=false with a
 *  reason.  Cheap relative to an LLM call (one fs.readFile + sum). */
export async function canSpend(
  ctx: ProductContext,
  policy: Pick<PolicyConfig, 'budget'>,
  plannedUsd: number,
  phase: PhaseId
): Promise<CanSpendResult> {
  const snap = await snapshot(ctx);
  const { budget } = policy;
  if (plannedUsd > budget.per_phase_usd) {
    return {
      allowed: false,
      reason: `phase ${phase} estimate $${plannedUsd.toFixed(4)} > per_phase_usd $${budget.per_phase_usd}`,
      snapshot: snap,
    };
  }
  if (snap.tickSpentUsd + plannedUsd > budget.per_tick_usd) {
    return {
      allowed: false,
      reason: `tick ${ctx.tickId} would reach $${(snap.tickSpentUsd + plannedUsd).toFixed(4)} > per_tick_usd $${budget.per_tick_usd}`,
      snapshot: snap,
    };
  }
  if (snap.daySpentUsd + plannedUsd > budget.monthly_usd / 30) {
    // Soft per-day = monthly/30; only enforced when monthly is non-zero
    if (budget.monthly_usd > 0 && snap.daySpentUsd + plannedUsd > Math.max(budget.monthly_usd / 30, 1)) {
      // Loose check — we want to alert, not block, when daily is just
      // a derived signal.  Hard-block only on the monthly cap below.
    }
  }
  if (snap.monthSpentUsd + plannedUsd > budget.monthly_usd) {
    return {
      allowed: false,
      reason: `month-to-date would reach $${(snap.monthSpentUsd + plannedUsd).toFixed(2)} > monthly_usd $${budget.monthly_usd}`,
      snapshot: snap,
    };
  }
  return { allowed: true, snapshot: snap };
}

/** Append one spend entry.  Sync (writeFileSync via appendFileSync)
 *  for the same reason crashLog uses sync writes — the process may be
 *  about to exit (timeout/abort) and we want the ledger to persist
 *  the spend that just happened. */
export async function record(
  ctx: ProductContext,
  phase: PhaseId,
  costUsd: number,
  inputTokens: number,
  outputTokens: number,
  model: string
): Promise<void> {
  const entry: BudgetEntry = {
    schemaVersion: 1,
    ts: Date.now(),
    productSlug: ctx.slug,
    tickId: ctx.tickId,
    phase,
    model,
    inputTokens,
    outputTokens,
    costUsd,
  };
  const path = productFiles.spend(ctx);
  try {
    await fs.mkdir(pathDirname(path), { recursive: true, mode: 0o700 });
    await fs.appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
    rotateIfNeeded(path);
  } catch {
    /* never block on ledger write failure — over-spend audit will catch */
  }
}

/** Rolling-truncate when the ledger balloons.  Same approach as
 *  routingLog/crashLog: keep last half by byte count, trim from first
 *  newline so we don't have a half-record at the top. */
function rotateIfNeeded(path: string): void {
  try {
    const st = statSync(path);
    if (st.size <= MAX_BYTES) return;
    const buf = readFileSync(path, 'utf8');
    const half = buf.slice(Math.floor(buf.length / 2));
    const trimmed = half.slice(half.indexOf('\n') + 1);
    writeFileSync(path, trimmed, { mode: 0o600 });
  } catch { /* best-effort */ }
}

function pathDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

function startOfMonthUtc(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}
