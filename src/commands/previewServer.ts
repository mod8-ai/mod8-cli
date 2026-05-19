/**
 * `mod8 /preview` — auto-detect the project's dev-server script, launch it
 * in the background, watch its output for the first localhost URL, and
 * hand that URL to `openInBrowser` so it ends up in the user's browser.
 *
 * Why this lives outside the chat.tsx file: the dev-server lifecycle is
 * non-trivial — we need a long-lived child process, a stdout/stderr
 * watcher, a URL extractor, and a tear-down hook the chat can call when
 * the session ends.  Keeping it in its own module keeps chat.tsx focused
 * on UI / streaming logic.
 *
 * The agent's `bash` tool could in principle do this, but every provider
 * refusal we've seen this week proves we cannot rely on model behavior
 * for "just run the server".  Client-side intercept is the only path
 * that's bulletproof across Claude / GPT / Gemini / DeepSeek.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openInBrowser } from '../util/browser.js';

/** Process handles we keep alive across turns so the dev server keeps
 *  serving while the user iterates.  Keyed by cwd so a second
 *  `/preview` from the same directory reuses the running process
 *  instead of orphaning it.  Cleaned up on /clear or shell exit. */
const previewProcs = new Map<string, ChildProcess>();

/** Hook for the chat layer's /clear and exit paths to kill every
 *  preview process this session spawned. */
export function killAllPreviewProcs(): void {
  for (const proc of previewProcs.values()) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore — child may already be dead */
    }
  }
  previewProcs.clear();
}

/** Read package.json scripts (best-effort).  Returns an empty map when
 *  there's no package.json or it's malformed — caller decides what to
 *  do with that. */
async function readPackageScripts(cwd: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(cwd, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts && typeof parsed.scripts === 'object'
      ? parsed.scripts
      : {};
  } catch {
    return {};
  }
}

/** Order to probe for an auto-pick.  Most projects use `dev`, falling
 *  back to `start` (CRA / many Node servers) or `serve` (static
 *  hosting).  Bias toward the dev-mode entries first because the user
 *  said `/preview` (implying iteration, not production). */
const AUTO_SCRIPT_CANDIDATES = ['dev', 'start', 'serve', 'watch'];

export interface PreviewResult {
  /** One-line summary to show in the transcript. */
  message: string;
  /** True when a new process was spawned this call (false on no-op or
   *  when an existing process for this cwd was reused). */
  spawned: boolean;
}

export async function runPreview(input: {
  cwd: string;
  scriptOverride: string | null;
  /** Max seconds to wait for the dev server to print a localhost URL
   *  before giving up + telling the user to open it manually.  The
   *  dev server keeps running either way — this is just for the
   *  auto-open-in-browser part. */
  urlTimeoutSec?: number;
}): Promise<PreviewResult> {
  const scripts = await readPackageScripts(input.cwd);
  if (Object.keys(scripts).length === 0) {
    return {
      spawned: false,
      message:
        `/preview: no package.json with scripts found in ${input.cwd}.\n` +
        `  Static-only? Run \`mod8 publish --confirm\` instead, or open ` +
        `index.html directly.`,
    };
  }

  let scriptName = input.scriptOverride;
  if (!scriptName) {
    scriptName = AUTO_SCRIPT_CANDIDATES.find((c) => scripts[c]) ?? null;
  }
  if (!scriptName) {
    return {
      spawned: false,
      message:
        `/preview: couldn't find a likely dev script in package.json.\n` +
        `  Tried: ${AUTO_SCRIPT_CANDIDATES.join(', ')}.\n` +
        `  Available: ${Object.keys(scripts).join(', ') || '(none)'}.\n` +
        `  Pass an explicit name, e.g. \`/preview <script-name>\`.`,
    };
  }
  if (!scripts[scriptName]) {
    return {
      spawned: false,
      message:
        `/preview: package.json has no "${scriptName}" script.\n` +
        `  Available: ${Object.keys(scripts).join(', ')}.`,
    };
  }

  // Reuse existing process if we already started one for this cwd.
  // Otherwise spawn a fresh one detached from the parent's stdio so the
  // dev server's output doesn't fight the Ink REPL.
  const existing = previewProcs.get(input.cwd);
  if (existing && existing.exitCode === null && !existing.killed) {
    return {
      spawned: false,
      message:
        `/preview: dev server already running for this directory ` +
        `(npm run ${scriptName}).  Opening browser if a URL was captured.`,
    };
  }

  const proc = spawn('npm', ['run', scriptName], {
    cwd: input.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  previewProcs.set(input.cwd, proc);

  // Watch combined stdout+stderr for the first localhost URL.  Most dev
  // servers print one within ~3 seconds (Vite, Next, CRA, Webpack,
  // Astro, etc.).  As soon as we see one, fire the browser opener.
  // Anything after the first URL is ignored — we don't want to bounce
  // tabs every time the server logs.
  const urlPromise = new Promise<string | null>((resolveUrl) => {
    const onChunk = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const m = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?[^\s'"<>]*/);
      if (m) resolveUrl(m[0]);
    };
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    setTimeout(() => resolveUrl(null), (input.urlTimeoutSec ?? 8) * 1000);
  });

  const url = await urlPromise;
  if (url) {
    const opened = await openInBrowser(url);
    return {
      spawned: true,
      message:
        `/preview: started \`npm run ${scriptName}\` and opened ${url} in your browser.\n` +
        (opened.ok ? '' : `  (browser open hint: ${opened.msg})`),
    };
  }
  return {
    spawned: true,
    message:
      `/preview: started \`npm run ${scriptName}\` but didn't see a localhost URL ` +
      `within ${input.urlTimeoutSec ?? 8}s.  The server is still running — ` +
      `check its logs for the URL and open it yourself.`,
  };
}
