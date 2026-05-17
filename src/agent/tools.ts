/**
 * Tools the agent can call.  All paths are interpreted relative to the
 * cwd the agent was started in.  Destructive tools (write_file,
 * edit_file, bash) trigger a confirmation prompt before executing —
 * unless the user passed --yes (auto-approve).
 *
 * Each tool returns a plain string the model reads back in its next
 * turn.  Errors are returned as strings prefixed with "Error: " rather
 * than thrown — the model can usually recover from a tool error and
 * continue.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import * as diffLib from 'diff';

export interface AgentToolContext {
  cwd: string;
  /** When true, skip confirmation prompts (--yes mode). */
  autoApprove: boolean;
}

/** Resolve a tool-provided path against the agent's cwd.  Reject paths
 *  that try to escape via `..` if we can detect it. */
function resolvePath(ctx: AgentToolContext, path: string): string {
  return isAbsolute(path) ? path : resolve(ctx.cwd, path);
}

/** Auto-detach bare `&` backgrounding so the bash tool doesn't hang.
 *  Mirrored from inkTools.ts — see that file for the full rationale. */
function detachIfBareBackground(cmd: string): {
  command: string;
  rewroteForDetach: boolean;
} {
  const trimmed = cmd.trimEnd();
  if (!trimmed.endsWith('&') || trimmed.endsWith('&&')) {
    return { command: cmd, rewroteForDetach: false };
  }
  const lastSep = Math.max(
    trimmed.lastIndexOf('&&'),
    trimmed.lastIndexOf(';'),
    trimmed.lastIndexOf('||'),
    trimmed.lastIndexOf('|')
  );
  const lastSegment = trimmed.slice(lastSep + 1, -1);
  if (/[<>]/.test(lastSegment)) {
    return { command: cmd, rewroteForDetach: false };
  }
  if (/\bdisown\b/.test(lastSegment) || /\bnohup\b/.test(lastSegment)) {
    return { command: cmd, rewroteForDetach: false };
  }
  const inner = lastSegment.trimEnd();
  const head = trimmed.slice(0, lastSep + 1);
  return {
    command: `${head}${inner} >/dev/null 2>&1 </dev/null &`,
    rewroteForDetach: true,
  };
}

/** Confirm a destructive action interactively.  Returns true to proceed. */
async function confirm(prompt: string, ctx: AgentToolContext): Promise<boolean> {
  if (ctx.autoApprove) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write(
      chalk.yellow(`mod8 agent: destructive action needs --yes when stdin is piped — refusing.\n`)
    );
    return false;
  }
  process.stderr.write('\n' + chalk.yellow(prompt) + ' ' + chalk.dim('[y/N] '));
  return new Promise((resolveBool) => {
    const rl = createInterface({ input: process.stdin });
    rl.once('line', (line) => {
      rl.close();
      const a = line.trim().toLowerCase();
      resolveBool(a === 'y' || a === 'yes');
    });
  });
}

function previewMultiline(s: string, maxLines = 20): string {
  const lines = s.split('\n');
  if (lines.length <= maxLines) return s;
  return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
}

export function buildAgentTools(ctx: AgentToolContext) {
  return {
    read_file: tool({
      description:
        'Read the contents of a file.  Use this before editing to see current contents.  Returns the file text or "Error: ..." on failure.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file (relative to cwd or absolute)'),
      }),
      execute: async ({ path }) => {
        try {
          const full = resolvePath(ctx, path);
          const content = await fs.readFile(full, 'utf8');
          return content;
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
        'Search for a regex pattern in files under cwd.  Returns matching lines with file:line prefix.  Use this to find symbols, callers, or text.',
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
                // grep exits non-zero with no output when no matches found.
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

    write_file: tool({
      description:
        'Create a new file or completely replace an existing one.  Use edit_file instead when you only need to change part of a file — it shows a clearer diff.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file (relative to cwd or absolute)'),
        contents: z.string().describe('The full new contents of the file'),
      }),
      execute: async ({ path, contents }) => {
        try {
          const full = resolvePath(ctx, path);
          const existed = await fs.access(full).then(() => true).catch(() => false);
          if (existed) {
            const before = await fs.readFile(full, 'utf8').catch(() => '');
            const d = diffLib.createPatch(path, before, contents, undefined, undefined, { context: 3 });
            process.stderr.write(chalk.dim('\n— write_file diff —\n'));
            process.stderr.write(colorizeDiff(d));
            const ok = await confirm(`Apply write_file to ${path}?`, ctx);
            if (!ok) return 'User declined the write_file edit.';
          } else {
            process.stderr.write(
              chalk.dim('\n— write_file (new) ') +
                chalk.cyan(path) +
                chalk.dim(' —\n')
            );
            process.stderr.write(previewMultiline(contents, 30) + '\n');
            const ok = await confirm(`Create ${path}?`, ctx);
            if (!ok) return 'User declined to create the file.';
          }
          await fs.mkdir(dirname(full), { recursive: true });
          await fs.writeFile(full, contents);
          return `Wrote ${path} (${contents.length} bytes).`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    edit_file: tool({
      description:
        'Replace a specific block of text in a file.  The before block must match EXACTLY (whitespace + indentation included).  Use this for targeted edits — it shows a diff and is harder to corrupt than write_file.',
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
            return `Error: 'before' block matches ${occurrences} times in ${path}.  Make it more specific so it matches exactly once.`;
          }
          const updated = original.replace(before, after);
          const d = diffLib.createPatch(path, original, updated, undefined, undefined, { context: 3 });
          process.stderr.write(chalk.dim('\n— edit_file diff —\n'));
          process.stderr.write(colorizeDiff(d));
          const ok = await confirm(`Apply edit_file to ${path}?`, ctx);
          if (!ok) return 'User declined the edit.';
          await fs.writeFile(full, updated);
          return `Edited ${path}.`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    bash: tool({
      description:
        'Run a shell command in the cwd.  Returns combined stdout+stderr (truncated at 16k bytes).  Use this for tests, installs, git operations.  The user sees the command and approves before it runs.',
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
        process.stderr.write(chalk.dim('\n— bash —\n'));
        process.stderr.write('  ' + chalk.cyan(finalCommand) + '\n');
        if (rewroteForDetach) {
          process.stderr.write(
            chalk.dim('  (mod8 added `>/dev/null 2>&1 </dev/null` to release stdio)\n')
          );
        }
        const ok = await confirm(`Run command?`, ctx);
        if (!ok) return 'User declined to run the command.';
        return new Promise<string>((resolveStr) => {
          // See inkTools.ts bash for the rationale on detached + 'exit'
          // (vs 'close') + force-destroy.  Same hang fix; same shape.
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
            setTimeout(
              () => settle(`exit code timeout\n${out.trim() || '(no output)'}`),
              200
            );
          }, timeout_seconds * 1000);
          child.on('exit', (code) => {
            clearTimeout(killer);
            setTimeout(
              () => settle(`exit code ${code ?? 'unknown'}\n${out.trim() || '(no output)'}`),
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

function colorizeDiff(patch: string): string {
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return chalk.dim(line);
      if (line.startsWith('@@')) return chalk.cyan(line);
      if (line.startsWith('+')) return chalk.green(line);
      if (line.startsWith('-')) return chalk.red(line);
      return line;
    })
    .join('\n') + '\n';
}
