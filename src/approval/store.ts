/**
 * Approval queue storage.
 *
 * Per-item JSON files at products/<slug>/approvals/pending/apr_<id>.json
 * + index.jsonl for fast listing + archive/YYYY-MM.jsonl for decided
 * items.
 *
 * Concurrency: protected by per-product queue.lock taken around any
 * mutation (acquired by tick.ts before invoking stage; acquired by
 * Panel.tsx before approve/reject/edit).
 *
 * Hard cap: 50 pending items per product.  Over-cap stage calls
 * coalesce (same kind + same target file set) or auto-reject the
 * lowest-risk pending item.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { productPath, productFiles } from '../memory/paths.js';
import { migrate } from './migrate.js';
import {
  ApprovalIndexEntrySchema,
  ApprovalItemSchema,
  type ApprovalIndexEntry,
  type ApprovalItem,
  type ApprovalState,
} from './types.js';
import type { ProductContext } from '../loop/types.js';

const APPROVALS_DIR = 'approvals';
const PENDING_SUBDIR = 'pending';
const ARCHIVE_SUBDIR = 'archive';
const INDEX_FILE = 'index.jsonl';
export const PENDING_CAP = 50;

export class ApprovalCapReached extends Error {
  constructor(public readonly slug: string) {
    super(`approval queue full for ${slug} (cap ${PENDING_CAP}) — reject some pending items or wait`);
    this.name = 'ApprovalCapReached';
  }
}

export class ApprovalNotFound extends Error {
  constructor(public readonly id: string) {
    super(`approval not found: ${id}`);
    this.name = 'ApprovalNotFound';
  }
}

/** Persist a new approval item.  Acquires the per-product queue.lock
 *  around the operation.  Enforces the pending cap (throws ApprovalCapReached). */
export async function create(ctx: ProductContext, item: ApprovalItem): Promise<void> {
  await ensureDirs(ctx);
  const release = await acquireQueueLock(ctx);
  try {
    const pending = await listPending(ctx);
    if (pending.length >= PENDING_CAP) {
      throw new ApprovalCapReached(ctx.slug);
    }
    const parsed = ApprovalItemSchema.parse(item);
    const itemPath = pendingPath(ctx, parsed.id);
    const tmp = `${itemPath}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    await fs.rename(tmp, itemPath);
    await appendIndex(ctx, {
      id: parsed.id,
      createdAt: parsed.createdAt,
      kind: parsed.kind,
      title: parsed.title,
      state: parsed.state,
      risk: parsed.risk,
    });
  } finally {
    await release();
  }
}

/** Load by id from either pending or archive. */
export async function load(ctx: ProductContext, id: string): Promise<ApprovalItem | null> {
  const p = pendingPath(ctx, id);
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(await fs.readFile(p, 'utf8'));
      return ApprovalItemSchema.parse(migrate(raw));
    } catch { return null; }
  }
  // Search archive months newest-to-oldest.
  const archiveDir = productPath(ctx, APPROVALS_DIR, ARCHIVE_SUBDIR);
  if (!existsSync(archiveDir)) return null;
  let entries: string[];
  try {
    entries = (await fs.readdir(archiveDir)).filter((n) => n.endsWith('.jsonl')).sort().reverse();
  } catch { return null; }
  for (const name of entries) {
    try {
      const buf = await fs.readFile(join(archiveDir, name), 'utf8');
      for (const line of buf.split('\n').reverse()) {
        if (!line.trim()) continue;
        try {
          const parsed = ApprovalItemSchema.parse(migrate(JSON.parse(line)));
          if (parsed.id === id) return parsed;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return null;
}

/** Update an existing pending item — atomic via rename, never moves
 *  to archive.  Caller uses `decide()` to transition + archive. */
export async function updatePending(ctx: ProductContext, item: ApprovalItem): Promise<void> {
  const release = await acquireQueueLock(ctx);
  try {
    const p = pendingPath(ctx, item.id);
    if (!existsSync(p)) throw new ApprovalNotFound(item.id);
    const parsed = ApprovalItemSchema.parse(item);
    const tmp = `${p}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    await fs.rename(tmp, p);
    await appendIndex(ctx, {
      id: parsed.id,
      createdAt: parsed.createdAt,
      kind: parsed.kind,
      title: parsed.title,
      state: parsed.state,
      risk: parsed.risk,
    });
  } finally {
    await release();
  }
}

/** Decide an approval — moves the pending JSON to archive/YYYY-MM.jsonl
 *  and updates the index.  Returns the decided item. */
export async function decide(ctx: ProductContext, id: string, transition: { state: ApprovalState; decidedBy: string; appliedResult?: Record<string, unknown> }): Promise<ApprovalItem> {
  const release = await acquireQueueLock(ctx);
  try {
    const p = pendingPath(ctx, id);
    if (!existsSync(p)) throw new ApprovalNotFound(id);
    const raw = JSON.parse(await fs.readFile(p, 'utf8'));
    const item = ApprovalItemSchema.parse(migrate(raw));
    const decided: ApprovalItem = {
      ...item,
      state: transition.state,
      decidedAt: Date.now(),
      decidedBy: transition.decidedBy,
      ...(transition.appliedResult ? { appliedResult: transition.appliedResult, appliedAt: Date.now() } : {}),
    };
    await archiveAppend(ctx, decided);
    await fs.unlink(p);
    await appendIndex(ctx, {
      id: decided.id,
      createdAt: decided.createdAt,
      kind: decided.kind,
      title: decided.title,
      state: decided.state,
      risk: decided.risk,
    });
    return decided;
  } finally {
    await release();
  }
}

/** Record the OUTCOME of an already-decided approval.
 *
 *  `decide()` archives the item and unlinks the pending file on the first
 *  transition, so calling it again — as the act phase did to mark an
 *  approval 'applied' — threw ApprovalNotFound.  The practical effect was
 *  the worst kind: the merge landed, HEAD moved, and the audit trail
 *  recorded that nothing had happened.  No approval had ever reached
 *  'applied'.
 *
 *  This appends the outcome against the archived item instead of requiring
 *  a pending file.  Returns null when the id is unknown, so a caller that
 *  has already changed the world never crashes on bookkeeping.
 */
export async function recordOutcome(
  ctx: ProductContext,
  id: string,
  transition: { state: ApprovalState; decidedBy: string; appliedResult?: Record<string, unknown> },
): Promise<ApprovalItem | null> {
  const release = await acquireQueueLock(ctx);
  try {
    const existing = await load(ctx, id);
    if (!existing) return null;
    const decided: ApprovalItem = {
      ...existing,
      state: transition.state,
      decidedBy: transition.decidedBy,
      decidedAt: existing.decidedAt ?? Date.now(),
      ...(transition.appliedResult
        ? { appliedResult: transition.appliedResult, appliedAt: Date.now() }
        : {}),
    };
    await archiveAppend(ctx, decided);
    await appendIndex(ctx, {
      id: decided.id,
      createdAt: decided.createdAt,
      kind: decided.kind,
      title: decided.title,
      state: decided.state,
      risk: decided.risk,
    });
    return decided;
  } finally {
    await release();
  }
}

export async function listPending(ctx: ProductContext): Promise<ApprovalItem[]> {
  const dir = productPath(ctx, APPROVALS_DIR, PENDING_SUBDIR);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.startsWith('apr_') && n.endsWith('.json'));
  } catch { return []; }
  const items: ApprovalItem[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await fs.readFile(join(dir, name), 'utf8'));
      items.push(ApprovalItemSchema.parse(migrate(raw)));
    } catch { /* skip malformed */ }
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}

/** Index summary read — cheap, used by /approvals header summary. */
export async function readIndex(ctx: ProductContext): Promise<ApprovalIndexEntry[]> {
  const path = productPath(ctx, APPROVALS_DIR, INDEX_FILE);
  if (!existsSync(path)) return [];
  const latest = new Map<string, ApprovalIndexEntry>();
  try {
    const buf = await fs.readFile(path, 'utf8');
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = ApprovalIndexEntrySchema.parse(JSON.parse(line));
        latest.set(entry.id, entry);
      } catch { /* skip */ }
    }
  } catch { /* tolerate */ }
  return Array.from(latest.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Coalesce candidate — caller (stage phase) checks if a similar
 *  pending item already exists.  Returns the existing id when found. */
export async function findCoalesceCandidate(
  ctx: ProductContext,
  kind: ApprovalItem['kind'],
  targetFiles: string[],
): Promise<string | null> {
  const pending = await listPending(ctx);
  const key = targetFiles.slice().sort().join('|');
  for (const item of pending) {
    if (item.kind !== kind) continue;
    const itemFiles = (item.proposedAction.type === 'file-edit' || item.proposedAction.type === 'git-pr')
      ? item.proposedAction.files
      : [];
    if (itemFiles.slice().sort().join('|') === key) return item.id;
  }
  return null;
}

/** Hard reject of the lowest-risk pending item when we'd otherwise
 *  exceed the cap.  Returns the rejected id or null when nothing was
 *  eligible (cap exists but no low-risk items — caller must throw). */
export async function evictLowestRisk(ctx: ProductContext): Promise<string | null> {
  const pending = await listPending(ctx);
  if (pending.length === 0) return null;
  const order: Record<string, number> = { low: 0, medium: 1, high: 2 };
  pending.sort((a, b) => (order[a.risk] - order[b.risk]) || (a.createdAt - b.createdAt));
  const victim = pending[0]!;
  if (victim.risk !== 'low') return null;
  await decide(ctx, victim.id, { state: 'stale', decidedBy: 'auto-evict-low-risk' });
  return victim.id;
}

async function archiveAppend(ctx: ProductContext, item: ApprovalItem): Promise<void> {
  const d = new Date(item.decidedAt ?? Date.now());
  const name = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
  const archiveDir = productPath(ctx, APPROVALS_DIR, ARCHIVE_SUBDIR);
  await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
  await fs.appendFile(join(archiveDir, name), JSON.stringify(item) + '\n', { mode: 0o600 });
}

async function appendIndex(ctx: ProductContext, entry: ApprovalIndexEntry): Promise<void> {
  const path = productPath(ctx, APPROVALS_DIR, INDEX_FILE);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

async function ensureDirs(ctx: ProductContext): Promise<void> {
  await fs.mkdir(productPath(ctx, APPROVALS_DIR, PENDING_SUBDIR), { recursive: true, mode: 0o700 });
  await fs.mkdir(productPath(ctx, APPROVALS_DIR, ARCHIVE_SUBDIR), { recursive: true, mode: 0o700 });
}

async function acquireQueueLock(ctx: ProductContext): Promise<() => Promise<void>> {
  const lock = productFiles.queueLock(ctx);
  await fs.mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  if (!existsSync(lock)) await fs.writeFile(lock, '', { mode: 0o600 });
  return lockfile.lock(lock, { stale: 30_000, retries: { retries: 5, minTimeout: 50, maxTimeout: 500 } });
}

function pendingPath(ctx: ProductContext, id: string): string {
  return productPath(ctx, APPROVALS_DIR, PENDING_SUBDIR, `${id}.json`);
}
