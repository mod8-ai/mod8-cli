/**
 * Cross-platform browser opener.  Shared by `inkTools.open_url` (when the
 * model calls the tool) and the chat REPL's client-side interceptor (when
 * the user says "open the browser" and we bypass the model entirely
 * because models keep refusing to use the tool reliably).
 */
import { execFile } from 'node:child_process';

export interface OpenResult {
  ok: boolean;
  msg: string;
}

export function openInBrowser(url: string): Promise<OpenResult> {
  const opener =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  // Windows `start` reads its first arg as a window title; pass empty so the
  // URL lands in the right slot.
  const args = process.platform === 'win32' ? ['', url] : [url];
  return new Promise((resolve) => {
    execFile(opener, args, { timeout: 5000 }, (err) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({
            ok: false,
            msg: `Couldn't open ${url} — '${opener}' not found on this system.`,
          });
          return;
        }
        resolve({ ok: false, msg: `Couldn't open ${url} — ${err.message}` });
        return;
      }
      resolve({ ok: true, msg: `✓ Opened ${url} in your browser.` });
    });
  });
}
