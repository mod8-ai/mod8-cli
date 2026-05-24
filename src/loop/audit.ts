/**
 * Hash-chained, append-only audit log.
 *
 * Each entry includes:
 *   - index: monotonic, 0 for genesis
 *   - prevDigest: digest of the previous entry, or null for genesis
 *   - digest: sha256(prevDigest || stableStringify(rest of entry))
 *
 * Tampering with any field of any past entry invalidates that entry's
 * digest AND every entry after it.  `verifyChain()` re-walks the file
 * and reports the first broken index — a single integer + a short
 * message is enough to surface the breach to a security review.
 *
 * Unlike events.jsonl (best-effort, rotated), the audit log is the
 * compliance surface.  We do NOT rotate it — the user manually
 * archives or migrates when it grows large.  Phase 5+ may add
 * cryptographic signing on top; the hash chain alone is enough for
 * Phase 1-4.
 *
 * Reused by:
 *   - loop/tick.ts (tick.start, tick.complete, kill-switch, policy.block)
 *   - loop/phases/* (phase.start, phase.complete)
 *   - Phase 2's act phase (action.applied, rollback.fired)
 *   - approval Panel (approval.approved, approval.rejected, approval.edited)
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { productFiles } from '../memory/paths.js';
import type { AuditEntry, ProductContext } from './types.js';

/** Append one audit entry.  Reads the previous entry to chain off
 *  its digest.  O(file size) in the worst case (cold start) but
 *  cached after the first append via `lastDigestCache`.
 *
 *  IMPORTANT: serialized — concurrent callers will race on the chain
 *  without the per-product mutex held by tick.ts's tick lock.  Phase
 *  1 only writes from a single tick body so this is fine; Phase 2's
 *  daemon must hold the queue lock around any append. */
export async function append(
  ctx: ProductContext,
  kind: string,
  payload: Record<string, unknown>
): Promise<AuditEntry> {
  const path = productFiles.audit(ctx);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const { lastIndex, lastDigest } = await readChainTail(path);
  const entry: AuditEntry = {
    schemaVersion: 1,
    index: lastIndex + 1,
    ts: Date.now(),
    productSlug: ctx.slug,
    prevDigest: lastDigest,
    digest: '',
    kind,
    payload,
  };
  entry.digest = computeDigest(entry);
  await fs.appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return entry;
}

/** Re-walk the chain, return the first broken index (or null when
 *  the chain is fully valid).  Used by `mod8 loop audit verify`. */
export async function verifyChain(ctx: ProductContext): Promise<{ ok: true; entries: number } | { ok: false; brokenIndex: number; reason: string }> {
  const path = productFiles.audit(ctx);
  if (!existsSync(path)) return { ok: true, entries: 0 };
  const buf = await fs.readFile(path, 'utf8');
  const lines = buf.split('\n').filter((l) => l.trim());
  let expectedPrev: string | null = null;
  let expectedIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]!) as AuditEntry;
    } catch {
      return { ok: false, brokenIndex: i, reason: `line ${i + 1} is not valid JSON` };
    }
    if (entry.index !== expectedIndex) {
      return { ok: false, brokenIndex: i, reason: `expected index ${expectedIndex}, got ${entry.index}` };
    }
    if (entry.prevDigest !== expectedPrev) {
      return { ok: false, brokenIndex: i, reason: `prevDigest mismatch at index ${entry.index}: expected ${expectedPrev}, got ${entry.prevDigest}` };
    }
    const recomputed = computeDigest(entry);
    if (recomputed !== entry.digest) {
      return { ok: false, brokenIndex: i, reason: `digest mismatch at index ${entry.index}: entry has been tampered with or written incorrectly` };
    }
    expectedPrev = entry.digest;
    expectedIndex++;
  }
  return { ok: true, entries: lines.length };
}

/** Read the chain tail to find the last index + digest for the next
 *  append.  Returns genesis values when the file is missing or empty. */
async function readChainTail(path: string): Promise<{ lastIndex: number; lastDigest: string | null }> {
  if (!existsSync(path)) return { lastIndex: -1, lastDigest: null };
  const buf = await fs.readFile(path, 'utf8');
  const lines = buf.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return { lastIndex: -1, lastDigest: null };
  const last = lines[lines.length - 1]!;
  try {
    const entry = JSON.parse(last) as AuditEntry;
    return { lastIndex: entry.index, lastDigest: entry.digest };
  } catch {
    // Last line malformed — refuse to silently continue past corruption.
    throw new Error(`audit chain tail is corrupted (last line not valid JSON) — manual recovery required at ${path}`);
  }
}

/** Compute sha256(prevDigest || stableStringify(entry minus digest)).
 *  Stable stringify uses sorted keys at every level so reorderings
 *  during JSON.stringify (insertion order) don't invalidate the chain
 *  across implementations. */
function computeDigest(entry: AuditEntry): string {
  const stable = stableStringify({
    schemaVersion: entry.schemaVersion,
    index: entry.index,
    ts: entry.ts,
    productSlug: entry.productSlug,
    prevDigest: entry.prevDigest,
    kind: entry.kind,
    payload: entry.payload,
  });
  return createHash('sha256').update((entry.prevDigest ?? '') + stable).digest('hex');
}

/** Recursive sorted-key stringify — deterministic across runtimes. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
