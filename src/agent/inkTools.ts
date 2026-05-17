/**
 * Ink-safe agent tools — same surface as `tools.ts` but **no readline**
 * confirmations and **no stderr writes**.  Used inside the chat.tsx Ink
 * REPL where Ink owns stdout and a competing readline prompt would
 * deadlock the UI.
 *
 * Visual previews (diffs, command bodies, etc.) are returned as part of
 * a TranscriptItem and rendered by the Ink layer; tools themselves are
 * silent.  Auto-approval is the default — the user sees what just
 * happened in the transcript and can press esc to abort the next turn.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import * as diffLib from 'diff';
import { WriteLedger, formatAgo } from './writeLedger.js';

export interface InkToolContext {
  cwd: string;
  /** Side-channel notifier: called with a TranscriptItem-ready preview
   *  payload right before each destructive action runs.  The chat layer
   *  uses this to render the diff / command in its own visual style.
   *  No confirmation gate — auto-approve by design. */
  onPreview?: (preview: ToolPreview) => void;
  /** Session-scoped write tracker.  When present, `write_file` refuses
   *  silent re-overwrites within the lockout window — the protection
   *  that stops agents from looping over their own freshly-built files
   *  after context compression. */
  ledger?: WriteLedger;
  /** Display name of the agent currently using the tools — recorded in
   *  the ledger so a duplicate-write warning can name which provider
   *  did the previous write. */
  providerName?: string;
}

export type ToolPreview =
  | { kind: 'write_file'; path: string; existed: boolean; bytes: number; diff?: string }
  | { kind: 'edit_file'; path: string; diff: string }
  | { kind: 'bash'; command: string };

function resolvePath(ctx: InkToolContext, path: string): string {
  return isAbsolute(path) ? path : resolve(ctx.cwd, path);
}

/** Detect `cmd &` (bare backgrounding) at the end of a command WITHOUT
 *  stdio redirection, and rewrite to release the pipes the bash tool
 *  waits on.  Otherwise the spawned shell exits but the backgrounded
 *  child inherits stdout/stderr and the tool hangs forever.
 *
 *  Returns the rewritten command (or the original, unchanged) plus a
 *  reason string when a rewrite happened — surfaced to the model in
 *  the tool result so it knows what actually ran. */
function detachIfBareBackground(cmd: string): {
  command: string;
  rewroteForDetach: boolean;
} {
  const trimmed = cmd.trimEnd();
  // Bare `&` at end (not `&&` which is logical-and).
  if (!trimmed.endsWith('&') || trimmed.endsWith('&&')) {
    return { command: cmd, rewroteForDetach: false };
  }
  // Look only at the last segment — `;` and `&&` and `|` reset our context.
  const lastSep = Math.max(
    trimmed.lastIndexOf('&&'),
    trimmed.lastIndexOf(';'),
    trimmed.lastIndexOf('||'),
    trimmed.lastIndexOf('|')
  );
  const lastSegment = trimmed.slice(lastSep + 1, -1); // strip trailing &
  // Already redirects stdout/stderr/stdin? Leave alone — user knows what they're doing.
  if (/[<>]/.test(lastSegment)) {
    return { command: cmd, rewroteForDetach: false };
  }
  // Common explicit detach forms — don't double-wrap.
  if (/\bdisown\b/.test(lastSegment) || /\bnohup\b/.test(lastSegment)) {
    return { command: cmd, rewroteForDetach: false };
  }
  const inner = lastSegment.trimEnd();
  const head = trimmed.slice(0, lastSep + 1);
  const rewritten = `${head}${inner} >/dev/null 2>&1 </dev/null &`;
  return { command: rewritten, rewroteForDetach: true };
}

/** Read-only subset of the agent tools for HOST mode (mod8 itself).
 *  Lets mod8 answer "show me the folder" / "what's in this file" /
 *  "find where X is used" directly, without the theatrical handoff
 *  to claude that the user complained about.  Excludes write_file,
 *  edit_file, bash, and plan — host doesn't write code or run shells,
 *  and doesn't need a goal banner for short read queries. */
export function buildHostInkTools(ctx: InkToolContext) {
  const work = buildInkTools(ctx);
  return {
    read_file: work.read_file,
    list_dir: work.list_dir,
    grep: work.grep,
    // open_url is safe in host mode too — it just hands the URL to
    // macOS/Linux/Windows.  Without it host kept refusing simple
    // "open the browser" requests with "I'm read-only", which is wrong:
    // opening a URL doesn't write anything in the user's project.
    open_url: work.open_url,
  };
}

export function buildInkTools(ctx: InkToolContext) {
  return {
    plan: tool({
      description:
        'Declare your goal and rough step count BEFORE using any other tool. Call this first every turn. The CLI pins it above the working indicator so the user always knows what you are working toward. Call again if the goal changes mid-turn.',
      inputSchema: z.object({
        goal: z
          .string()
          .max(120)
          .describe('One short sentence: what you are working toward this turn.'),
        steps: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Rough number of tool calls you expect to make (1-50). Optional.'),
      }),
      execute: async () => {
        return 'ok';
      },
    }),

    read_file: tool({
      description:
        'Read the contents of a file.  Use this before editing to see current contents.  Returns the file text or "Error: ..." on failure.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file (relative to cwd or absolute)'),
      }),
      execute: async ({ path }) => {
        try {
          const full = resolvePath(ctx, path);
          return await fs.readFile(full, 'utf8');
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    list_dir: tool({
      description:
        'List files + subdirectories in a directory.  Returns one entry per line.  Use this to discover the project layout.',
      inputSchema: z.object({
        path: z
          .string()
          .default('.')
          .describe('Directory path (relative to cwd or absolute, default ".")'),
      }),
      execute: async ({ path }) => {
        try {
          const full = resolvePath(ctx, path);
          const entries = await fs.readdir(full, { withFileTypes: true });
          const lines = entries
            .filter((e) => !e.name.startsWith('.'))
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          lines.sort();
          if (lines.length === 0) return '(empty)';
          return lines.join('\n');
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    grep: tool({
      description:
        'Search for a regex pattern in files under cwd.  Returns matching lines with file:line prefix.',
      inputSchema: z.object({
        pattern: z.string().describe('Regex pattern (JavaScript syntax)'),
        path: z
          .string()
          .default('.')
          .describe('Directory or file to search (default ".")'),
      }),
      execute: async ({ pattern, path }) => {
        const full = resolvePath(ctx, path);
        return new Promise<string>((resolveStr) => {
          execFile(
            'grep',
            ['-rEn', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', pattern, full],
            { maxBuffer: 5 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err && stdout.length === 0) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                  resolveStr('Error: grep not found on this system');
                  return;
                }
                resolveStr('No matches.');
                return;
              }
              const output = stdout.trim();
              if (output.length === 0) {
                resolveStr(stderr.trim() || 'No matches.');
                return;
              }
              const lines = output.split('\n');
              if (lines.length > 200) {
                resolveStr(
                  lines.slice(0, 200).join('\n') +
                    `\n... (${lines.length - 200} more matches, refine your search)`
                );
                return;
              }
              resolveStr(output);
            }
          );
        });
      },
    }),

    open_url: tool({
      description:
        "Open a URL in the user's default browser. Safe and cross-platform (macOS, Linux, Windows).  Use this whenever the user says any of: 'open the browser', 'open <url>', 'launch <url>', 'show me in the browser', 'preview this'.  Available in BOTH host and work mode — never refuse a user's open-the-browser request by claiming you can't.",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe('Absolute URL (must include scheme, e.g. http:// or https://)'),
      }),
      execute: async ({ url }) => {
        // Pick the right opener for the OS.  Falls back to xdg-open on
        // unknown unix-likes.  Detached so we don't tie the agent to the
        // browser's lifetime — the agent's job is done as soon as the
        // browser starts.
        const opener =
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'start'
              : 'xdg-open';
        const args = process.platform === 'win32' ? ['', url] : [url];
        return new Promise<string>((resolveStr) => {
          execFile(opener, args, { timeout: 5000 }, (err) => {
            if (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ENOENT') {
                resolveStr(
                  `Couldn't open ${url} — '${opener}' not found on this system.`
                );
                return;
              }
              resolveStr(`Couldn't open ${url} — ${err.message}`);
              return;
            }
            resolveStr(`✓ Opened ${url} in your browser.`);
          });
        });
      },
    }),

    write_file: tool({
      description:
        'Create a new file or completely replace an existing one.  Use edit_file instead when you only need to change part of a file — it shows a clearer diff.  This tool REFUSES to silently overwrite a file you (or any agent) already wrote this session — use edit_file for revisions, or pass force_overwrite: true if the user explicitly asked you to recreate the file from scratch.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file (relative to cwd or absolute)'),
        contents: z.string().describe('The full new contents of the file'),
        force_overwrite: z
          .boolean()
          .default(false)
          .describe(
            'Set to true ONLY when the user has explicitly asked you to recreate a file you already wrote this session. Default false — the tool will refuse a silent re-overwrite.'
          ),
      }),
      execute: async ({ path, contents, force_overwrite }) => {
        try {
          const full = resolvePath(ctx, path);

          // Ledger guard: refuse silent re-overwrites within the lockout
          // window.  This is the structural protection against the
          // "claude forgot it built this file and just rewrote it" loop.
          if (ctx.ledger && !force_overwrite) {
            const prev = ctx.ledger.recentRecord(path);
            if (prev) {
              const ago = formatAgo(Date.now() - prev.writtenAt);
              return (
                `Error: refusing to silently overwrite ${path}. ` +
                `You (or ${prev.byProvider}) already wrote this file ${ago} ago ` +
                `this session (${prev.bytes} bytes, written ${prev.count}× total). ` +
                `Use edit_file to change parts of it. ` +
                `If the user EXPLICITLY asked you to recreate it from scratch, ` +
                `call write_file again with force_overwrite: true. ` +
                `Otherwise, pause and ask the user before recreating.`
              );
            }
          }

          const existed = await fs.access(full).then(() => true).catch(() => false);
          let diff: string | undefined;
          if (existed) {
            const before = await fs.readFile(full, 'utf8').catch(() => '');
            diff = diffLib.createPatch(path, before, contents, undefined, undefined, { context: 3 });
          }
          if (ctx.onPreview) {
            ctx.onPreview({
              kind: 'write_file',
              path,
              existed,
              bytes: Buffer.byteLength(contents),
              ...(diff ? { diff } : {}),
            });
          }
          await fs.mkdir(dirname(full), { recursive: true });
          await fs.writeFile(full, contents);
          if (ctx.ledger) {
            ctx.ledger.record(
              path,
              Buffer.byteLength(contents),
              ctx.providerName ?? 'unknown'
            );
          }
          return `Wrote ${path} (${contents.length} bytes).`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    edit_file: tool({
      description:
        'Replace a specific block of text in a file.  The before block must match EXACTLY (whitespace + indentation included).',
      inputSchema: z.object({
        path: z.string().describe('Path to the file (relative to cwd or absolute)'),
        before: z
          .string()
          .describe('The exact text to replace.  Must occur exactly once in the file.'),
        after: z.string().describe('The replacement text.'),
      }),
      execute: async ({ path, before, after }) => {
        try {
          const full = resolvePath(ctx, path);
          const original = await fs.readFile(full, 'utf8');
          const occurrences = original.split(before).length - 1;
          if (occurrences === 0) {
            return `Error: 'before' block not found in ${path}.  Read the file again and provide an exact match.`;
          }
          if (occurrences > 1) {
            return `Error: 'before' block matches ${occurrences} times in ${path}.  Make it more specific.`;
          }
          const updated = original.replace(before, after);
          const diff = diffLib.createPatch(path, original, updated, undefined, undefined, { context: 3 });
          if (ctx.onPreview) {
            ctx.onPreview({ kind: 'edit_file', path, diff });
          }
          await fs.writeFile(full, updated);
          if (ctx.ledger) {
            ctx.ledger.record(
              path,
              Buffer.byteLength(updated),
              ctx.providerName ?? 'unknown'
            );
          }
          return `Edited ${path}.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    bash: tool({
      description:
        'Run a shell command in the cwd.  Returns combined stdout+stderr (truncated at 16k bytes).  Use this for tests, installs, git operations.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to run'),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(120)
          .default(30)
          .describe('Max seconds to wait for the command (default 30)'),
      }),
      execute: async ({ command, timeout_seconds }) => {
        const { command: finalCommand, rewroteForDetach } =
          detachIfBareBackground(command);
        if (ctx.onPreview) {
          ctx.onPreview({ kind: 'bash', command: finalCommand });
        }
        return new Promise<string>((resolveStr) => {
          // detached: true puts the child in its own process group so a
          // SIGTERM on timeout takes out the whole tree (e.g. nested
          // `sh -c "<cmd>"` plus its children) rather than just the shell.
          // stdin is closed so commands that try to read input fail
          // fast instead of hanging.
          const child = spawn('sh', ['-c', finalCommand], {
            cwd: ctx.cwd,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,
          });
          let out = '';
          let settled = false;
          const settle = (value: string) => {
            if (settled) return;
            settled = true;
            try { child.stdout?.destroy(); } catch { /* fd already closed */ }
            try { child.stderr?.destroy(); } catch { /* fd already closed */ }
            resolveStr(value);
          };
          const onData = (chunk: Buffer) => {
            out += chunk.toString('utf8');
            if (out.length > 16 * 1024) {
              out = out.slice(0, 16 * 1024) + '\n... (truncated)';
              try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
            }
          };
          child.stdout.on('data', onData);
          child.stderr.on('data', onData);
          const killer = setTimeout(() => {
            try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* gone */ }
            // Give SIGTERM a beat to flush, then settle with whatever we
            // have — don't wait for stdio held by detached grandchildren.
            setTimeout(
              () => settle(`exit code timeout\n${out.trim() || '(no output)'}`),
              200
            );
          }, timeout_seconds * 1000);
          // 'exit' fires when the foreground sh exits — even if a
          // background process (started with `&` or `&disown`) is still
          // holding stdout/stderr open.  'close' would wait for those
          // pipes too, which is the hang we just fixed.
          child.on('exit', (code) => {
            clearTimeout(killer);
            // 200ms drain so any late writes from the foreground command
            // land in `out` before we destroy the pipes.
            setTimeout(
              () => {
                const note = rewroteForDetach
                  ? `(mod8 rewrote the command to release stdio: ${finalCommand})\n`
                  : '';
                settle(`exit code ${code ?? 'unknown'}\n${note}${out.trim() || '(no output)'}`);
              },
              200
            );
          });
          child.on('error', (err) => {
            clearTimeout(killer);
            settle(`Error: ${err.message}`);
          });
        });
      },
    }),
  };
}
