/**
 * Reads `.mod8/context.md` (the per-project brief that every model sees).
 *
 * Walk-up rules:
 *   - Start at the given cwd.
 *   - Walk up parent directories looking for `.mod8/context.md`.
 *   - Stop at the first match (nearest wins — monorepo-friendly).
 *   - Stop at `$HOME` without reading any context file there (too easy
 *     to accidentally affect everything).
 *   - Stop after MAX_WALKUP levels.
 *
 * Size policy:
 *   - Files up to MAX_BYTES are returned verbatim.
 *   - Larger files are truncated with a trailing marker.  We never refuse
 *     to load — the user always gets *something*.
 *
 * This module is intentionally pure: no Ink, no chalk, no logging.  Both
 * the REPL and the one-shot agent share it, and the `mod8 context` debug
 * command introspects the same result shape.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

/** Normalize a path through realpath when possible (so `/var/folders/X`
 *  and `/private/var/folders/X` compare equal on macOS).  Falls back to
 *  `resolve()` when the path doesn't exist yet. */
async function canonicalize(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return resolve(path);
  }
}

export const MAX_BYTES = 16 * 1024;
export const MAX_WALKUP = 8;
export const CONTEXT_FILE = join('.mod8', 'context.md');

export interface RawProjectContext {
  /** The (possibly truncated) text content of the file. */
  content: string;
  /** Absolute path to the file we loaded. */
  foundAt: string;
  /** Original byte size on disk (before truncation). */
  bytes: number;
  /** True iff content was trimmed to fit MAX_BYTES. */
  truncated: boolean;
  /** Absolute path we started searching from. */
  startedAt: string;
  /** How many parent levels we climbed before matching (0 = cwd). */
  levelsClimbed: number;
}

export interface ProjectContextMiss {
  /** Absolute path we started searching from. */
  startedAt: string;
  /** Highest directory we examined before giving up. */
  stoppedAt: string;
  /** How many parent levels we examined in total (including the start dir). */
  levelsChecked: number;
  /** Why we stopped: hit $HOME, hit filesystem root, or hit MAX_WALKUP. */
  reason: 'home' | 'root' | 'limit';
}

export type ProjectContextResult =
  | { kind: 'found'; ctx: RawProjectContext }
  | { kind: 'miss'; miss: ProjectContextMiss };

/** Approximate token count from byte size.  ~4 chars per token is a
 *  reasonable middle-ground across Anthropic / OpenAI / Google tokenizers
 *  for English-heavy text.  Not exact — but the `mod8 context` debug
 *  command just needs an order-of-magnitude. */
export function approximateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

export async function readProjectContext(
  cwd: string
): Promise<ProjectContextResult> {
  // Canonicalize so /var/folders/X and /private/var/folders/X compare
  // equal on macOS — the $HOME boundary check relies on string equality.
  const startedAt = await canonicalize(cwd);
  const home = await canonicalize(homedir());

  let dir = startedAt;
  let levels = 0;

  while (levels < MAX_WALKUP) {
    // Don't read context out of $HOME — too easy to accidentally affect
    // every project at once.  Stop the climb without examining HOME.
    if (dir === home) {
      return {
        kind: 'miss',
        miss: { startedAt, stoppedAt: dir, levelsChecked: levels, reason: 'home' },
      };
    }

    const candidate = join(dir, CONTEXT_FILE);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        const raw = await fs.readFile(candidate);
        const bytes = raw.length;
        const truncated = bytes > MAX_BYTES;
        const content = truncated
          ? raw.slice(0, MAX_BYTES).toString('utf8') +
            `\n\n... (truncated — original was ${bytes} bytes; cap is ${MAX_BYTES})`
          : raw.toString('utf8');
        return {
          kind: 'found',
          ctx: {
            content,
            foundAt: candidate,
            bytes,
            truncated,
            startedAt,
            levelsClimbed: levels,
          },
        };
      }
    } catch {
      // ENOENT or unreadable — keep climbing.
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Filesystem root.  Examined this level, no match.
      return {
        kind: 'miss',
        miss: {
          startedAt,
          stoppedAt: dir,
          levelsChecked: levels + 1,
          reason: 'root',
        },
      };
    }
    dir = parent;
    levels += 1;
  }

  return {
    kind: 'miss',
    miss: { startedAt, stoppedAt: dir, levelsChecked: levels, reason: 'limit' },
  };
}
