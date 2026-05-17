/**
 * Session-scoped write ledger.
 *
 * Tracks every file an agent has written or edited in the current chat
 * session, surviving outside the LLM context window (which is the only
 * way to prevent the "claude forgot it built this file and is now
 * overwriting its own work" loop).
 *
 * The ledger is consulted by:
 *   - the `write_file` tool — refuses silent re-overwrites within the
 *     session window unless the model explicitly passes
 *     `force_overwrite: true`.
 *   - the chat layer — injects a summary into the work-mode system
 *     prompt every turn so the agent always sees what it has already
 *     produced this session.
 */

export interface WriteRecord {
  path: string;
  bytes: number;
  writtenAt: number;
  byProvider: string;
  /** How many `write_file` calls have hit this path this session.
   *  Anything above 1 is a clue we are looping. */
  count: number;
}

/** Time after which a previous write no longer triggers a refusal — i.e.
 *  the lockout window for silent overwrites.  30 min covers a typical
 *  work session; after that, a re-write is plausibly a deliberate redo. */
const LOCKOUT_MS = 30 * 60 * 1000;

export class WriteLedger {
  private entries = new Map<string, WriteRecord>();

  record(path: string, bytes: number, byProvider: string): WriteRecord {
    const existing = this.entries.get(path);
    const next: WriteRecord = {
      path,
      bytes,
      writtenAt: Date.now(),
      byProvider,
      count: (existing?.count ?? 0) + 1,
    };
    this.entries.set(path, next);
    return next;
  }

  get(path: string): WriteRecord | undefined {
    return this.entries.get(path);
  }

  /** Returns the lockout-relevant previous record, or undefined if the
   *  path was never written, or the previous write fell outside the
   *  lockout window. */
  recentRecord(path: string): WriteRecord | undefined {
    const prev = this.entries.get(path);
    if (!prev) return undefined;
    if (Date.now() - prev.writtenAt > LOCKOUT_MS) return undefined;
    return prev;
  }

  list(): WriteRecord[] {
    return Array.from(this.entries.values()).sort(
      (a, b) => b.writtenAt - a.writtenAt
    );
  }

  /** Plain-text summary for system-prompt injection.  Empty string when
   *  the ledger has no recent entries — caller checks before splicing
   *  to avoid adding a no-op header. */
  summary(): string {
    const now = Date.now();
    const recent = this.list().filter((r) => now - r.writtenAt < LOCKOUT_MS);
    if (recent.length === 0) return '';
    const lines = recent.slice(0, 30).map((r) => {
      const ago = formatAgo(now - r.writtenAt);
      const dupNote = r.count > 1 ? ` ⚠ already written ${r.count}× this session` : '';
      return `- ${r.path} (${ago} ago, by ${r.byProvider}, ${r.bytes}b)${dupNote}`;
    });
    const overflow =
      recent.length > 30 ? `\n  …and ${recent.length - 30} more` : '';
    return (
      'Files you have already created or modified this session ' +
      '(use edit_file to change them; NEVER recreate from scratch):\n' +
      lines.join('\n') +
      overflow
    );
  }

  clear(): void {
    this.entries.clear();
  }
}

function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

export { LOCKOUT_MS, formatAgo };
