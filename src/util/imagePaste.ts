/**
 * Image-paste detection for the chat REPL.
 *
 * macOS terminals paste screenshots as a file PATH (not the image bytes
 * themselves).  When the user pastes a screenshot and hits enter, mod8
 * sees something like:
 *
 *   /var/folders/.../NSIRD_screencaptureui_pbUxjV/Screenshot\ 2026-05-14\ at\ 10.56.55.png
 *
 * — escaped spaces, a real file on disk.  This helper detects that
 * shape, reads the file, base64-encodes it, and hands back enough info
 * for chat.tsx to attach the image to the next API message as a
 * multimodal content part.
 */

import { promises as fs } from 'node:fs';
import { extname, basename, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export interface PastedImage {
  path: string;
  base64: string;
  mediaType: string;
  bytes: number;
  name: string;
}

/** Unescape shell-style spaces / backslashes and expand `~`.  Terminals
 *  produce paths like `/path/with\ space.png`; the on-disk path has a
 *  real space, so we have to unescape before fs.readFile.  Strips
 *  optional surrounding quotes and the optional `file://` scheme. */
function normalizePath(raw: string, cwd: string): string {
  let s = raw.trim();
  // Strip wrapping quotes (single or double).
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  // Strip file:// URI prefix (some terminals paste this form).
  if (s.startsWith('file://')) s = s.slice('file://'.length);
  // Unescape shell-style spaces + backslashes.
  s = s.replace(/\\ /g, ' ').replace(/\\\\/g, '\\');
  // Expand ~.
  if (s.startsWith('~/') || s === '~') {
    s = s.replace(/^~/, homedir());
  }
  // Resolve relative to cwd.
  if (!isAbsolute(s)) s = resolve(cwd, s);
  return s;
}

/** Returns the PastedImage for an input that's ONLY an image file path
 *  (no surrounding prose), or null otherwise.  Rejects multi-line input
 *  with embedded text — "look at this /tmp/foo.png and tell me what's
 *  wrong" is NOT an image paste.  This is by design — we only intercept
 *  when the path is the whole message, so accidental matches don't
 *  swallow real questions. */
export async function detectImagePaste(
  raw: string,
  cwd: string
): Promise<PastedImage | null> {
  // Multi-line input → almost certainly the user typed real prose with
  // a path mixed in.  Don't intercept.
  if (raw.includes('\n')) return null;

  const candidate = normalizePath(raw, cwd);
  const ext = extname(candidate).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;

  let buf: Buffer;
  try {
    buf = await fs.readFile(candidate);
  } catch {
    return null;
  }
  if (buf.length === 0) return null;

  const mediaType =
    ext === '.png'
      ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.gif'
      ? 'image/gif'
      : ext === '.webp'
      ? 'image/webp'
      : 'image/bmp';

  return {
    path: candidate,
    base64: buf.toString('base64'),
    mediaType,
    bytes: buf.length,
    name: basename(candidate),
  };
}

export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
