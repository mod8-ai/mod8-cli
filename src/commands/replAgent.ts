/**
 * Interactive agent REPL — the unified mod8 experience.
 *
 * Default for `mod8` (no args).  You type, the AI answers; if your
 * message wants files written / commands run / code changed, the agent
 * uses tools (read_file, write_file, edit_file, list_dir, grep, bash) —
 * same surface as `mod8 agent "..."`, just multi-turn.
 *
 * Slash commands:
 *   /exit                 quit (also: Ctrl+D, /quit)
 *   /clear                wipe the conversation, keep tools + cwd
 *   /model <id>           switch the underlying model mid-session
 *   /help                 show this list
 *
 * Plain natural-language switches also work:
 *   "use gpt-4o" / "switch to gemini" / "talk to deepseek"  — the user
 *   message is intercepted before being sent to the model.
 */

import chalk from 'chalk';
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import {
  buildProviderModel,
  resolveModel,
  DEFAULT_MODEL,
  type ProviderConnection,
  type ResolvedModel,
} from '../agent/providerModel.js';
import { buildAgentTools } from '../agent/tools.js';
import { buildAgentSystemPrompt } from '../agent/systemPrompt.js';
import { readAuth } from '../storage/auth.js';

export interface ReplAgentOptions {
  /** Override the starting model (claude-sonnet-4-6 default). */
  model?: string;
  /** Skip per-tool y/N approvals.  Same semantic as `mod8 agent --yes`. */
  yes?: boolean;
  /** Maximum steps per user-turn before the agent stops on its own. */
  maxSteps?: number;
}

export async function runAgentRepl(opts: ReplAgentOptions = {}): Promise<void> {
  // 1. Resolve initial model.
  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(opts.model ?? DEFAULT_MODEL);
  } catch (err) {
    console.error(chalk.red('mod8: ') + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  let connection: ProviderConnection;
  try {
    connection = await buildProviderModel(resolved);
  } catch (err) {
    console.error(chalk.red('mod8: ') + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const cwd = process.cwd();
  const autoApprove = !!opts.yes;
  const maxSteps = opts.maxSteps ?? 20;
  const tools = buildAgentTools({ cwd, autoApprove });
  const auth = await readAuth();
  let system = buildAgentSystemPrompt({
    cwd,
    model: resolved.modelId,
    providerLabel: resolved.label,
  });

  printBanner(resolved, connection, autoApprove, cwd, auth?.email);

  // 2. Conversation state.
  const messages: ModelMessage[] = [];
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('› '),
    terminal: true,
  });

  // 3. Graceful exit on Ctrl+C / Ctrl+D.
  let aborter: AbortController | null = null;
  process.on('SIGINT', () => {
    if (aborter) {
      aborter.abort();
      aborter = null;
      return;
    }
    process.stderr.write('\n' + chalk.dim('(press /exit or Ctrl+D to quit)\n'));
    rl.prompt();
  });

  // 4. Main loop — readline is async via async iteration.
  rl.prompt();
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) {
      rl.prompt();
      continue;
    }

    if (line === '/exit' || line === '/quit') break;
    if (line === '/help' || line === '/?') {
      printHelp();
      rl.prompt();
      continue;
    }
    if (line === '/clear') {
      messages.length = 0;
      process.stderr.write(chalk.dim('  conversation cleared\n'));
      rl.prompt();
      continue;
    }

    // Slash + natural-language model switches.
    const switched = await maybeSwitchModel(line, async (newModel) => {
      const newResolved = resolveModel(newModel);
      const newConnection = await buildProviderModel(newResolved);
      resolved = newResolved;
      connection = newConnection;
      system = buildAgentSystemPrompt({
        cwd,
        model: resolved.modelId,
        providerLabel: resolved.label,
      });
      process.stderr.write(
        chalk.dim(`  switched → ${resolved.label} (${resolved.modelId}) · ${connection.source}\n`)
      );
    });
    if (switched) {
      rl.prompt();
      continue;
    }

    // 5. Run one agent turn.
    messages.push({ role: 'user', content: line });
    aborter = new AbortController();

    try {
      const result = streamText({
        model: connection.model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: aborter.signal,
        onError({ error }) {
          process.stderr.write(
            '\n' +
              chalk.red('error: ') +
              (error instanceof Error ? error.message : String(error)) +
              '\n'
          );
        },
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            process.stdout.write((part as { text: string }).text);
            break;
          case 'tool-call':
            process.stderr.write(
              '\n' +
                chalk.cyan('→ ') +
                chalk.bold(part.toolName) +
                chalk.dim('(' + summariseArgs((part as { input?: unknown }).input) + ')\n')
            );
            break;
          case 'tool-result':
            // Tool's own preview is on stderr already.
            break;
        }
      }

      // Append the assistant turn (text + tool calls/results) so the
      // next user prompt has full context.
      try {
        const responseMessages = (await result.response).messages;
        for (const m of responseMessages) messages.push(m as ModelMessage);
      } catch {
        // result.response can reject if the stream errored; ignore.
      }

      // Final newline if the model didn't emit one.
      let finalText = '';
      try { finalText = await result.text; } catch { /* stream errored */ }
      if (finalText && !finalText.endsWith('\n')) process.stdout.write('\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('abort')) {
        process.stderr.write(chalk.dim('  (interrupted)\n'));
      } else {
        process.stderr.write('\n' + chalk.red('mod8 agent: ') + msg + '\n');
      }
      // On error, drop the last user message so the user can retry.
      if (messages.at(-1)?.role === 'user') messages.pop();
    } finally {
      aborter = null;
    }

    rl.prompt();
  }

  rl.close();
  process.stderr.write(chalk.dim('  bye\n'));
}

function printBanner(
  resolved: ResolvedModel,
  connection: ProviderConnection,
  autoApprove: boolean,
  cwd: string,
  email?: string
): void {
  const who = email ? chalk.bold(email) : 'mod8 account';
  process.stderr.write(
    chalk.dim(
      `Logged in as ${who} — ${connection.source} mode\n` +
        `mod8 · ${resolved.label} (${resolved.modelId}) · cwd ${cwd}\n` +
        '  type anything.  files / shell / code — the agent uses tools as needed.\n' +
        (autoApprove
          ? chalk.yellow('  --yes: tool calls auto-approved\n')
          : '  destructive tool calls ask first.\n') +
        '  /help · /model <id> · /clear · /exit · Ctrl+C interrupts a turn\n\n'
    )
  );
}

function printHelp(): void {
  process.stderr.write(
    chalk.dim(
      '\n  /exit, /quit, Ctrl+D       quit\n' +
        '  /clear                     wipe conversation\n' +
        '  /model <id>                switch model (claude-sonnet-4-6 · gpt-4o · gemini-2.5-flash · deepseek-chat)\n' +
        '  /help                      this list\n' +
        '\n  Natural-language switches: "use gemini", "switch to gpt", "talk to deepseek"\n' +
        '  Ctrl+C                     interrupt the current turn (the next Ctrl+C exits)\n\n'
    )
  );
}

async function maybeSwitchModel(
  line: string,
  doSwitch: (model: string) => Promise<void>
): Promise<boolean> {
  // Slash form: /model <id>
  const slashMatch = /^\/model\s+(.+)$/i.exec(line);
  if (slashMatch) {
    try {
      await doSwitch(slashMatch[1]!.trim());
    } catch (err) {
      process.stderr.write(
        chalk.red('  ') + (err instanceof Error ? err.message : String(err)) + '\n'
      );
    }
    return true;
  }

  // Natural-language form: "use X" / "switch to X" / "talk to X"
  const nlMatch = /^(?:use|switch to|talk to)\s+([a-z0-9._-]+)\s*$/i.exec(line);
  if (nlMatch) {
    const candidate = nlMatch[1]!.toLowerCase();
    try {
      // resolveModel will throw for unknown ids — silently fall through
      // if it doesn't look like a model so "use deepseek for ..." isn't
      // hijacked.
      resolveModel(candidate);
      await doSwitch(candidate);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function summariseArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  return Object.entries(obj)
    .map(([k, v]) => {
      if (typeof v === 'string') {
        const preview = v.length > 60 ? v.slice(0, 57) + '...' : v;
        return `${k}=${JSON.stringify(preview)}`;
      }
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(', ');
}
