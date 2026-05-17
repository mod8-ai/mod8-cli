/**
 * `mod8 agent "<task>"` — one-shot agent (non-interactive).  Same
 * harness as the REPL (`mod8` no args), just a single user turn that
 * the agent loops to completion.
 *
 * For multi-turn / interactive use, run `mod8` (no args) — it drops you
 * into the same agent with a chat prompt.
 *
 * Architecture:
 *   - Proxy mode (requires `mod8 login`): every LLM call routed through
 *     the mod8 proxy at /v1/{provider}/* so master keys never touch the
 *     user's machine.  Billed to mod8 balance.
 *   - BYOK fallback (when not logged in): direct provider API with the
 *     user's local key.
 *
 * Tool surface (see ../agent/tools.ts): read_file, list_dir, grep,
 * write_file, edit_file, bash.  Destructive tools prompt before running
 * (unless --yes).
 */

import chalk from 'chalk';
import { buildAgentSystemPrompt } from '../agent/systemPrompt.js';
import { buildAgentTools } from '../agent/tools.js';
import { readProjectContext } from '../agent/projectContext.js';
import { shapeProjectContextForProvider } from '../agent/contextShaping.js';
import { getProjectInfo } from '../agent/projectInfo.js';
import { classifyTopic, isRideAlong } from '../agent/topicRouter.js';
import { runAgent as runtimeStream } from '../runtime/runAgent.js';
import {
  buildProviderModel,
  resolveModel,
  DEFAULT_MODEL,
  type ResolvedModel,
  type ProviderConnection,
} from '../agent/providerModel.js';

export interface AgentCommandOptions {
  model?: string;
  yes?: boolean;
  maxSteps?: number;
}

export async function runAgent(
  task: string,
  opts: AgentCommandOptions = {}
): Promise<void> {
  if (!task || !task.trim()) {
    console.error(
      chalk.red('mod8: ') + 'no task given.  Try: mod8 agent "fix the failing test"'
    );
    process.exit(1);
  }

  let resolved: ResolvedModel;
  try {
    resolved = resolveModel(opts.model ?? DEFAULT_MODEL);
  } catch (err) {
    console.error(chalk.red('mod8: ') + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  let connection: ProviderConnection;
  try {
    // Tag this turn with project attribution so the mod8.ai Projects
    // dashboard records per-cwd spend AND the user's topic distribution
    // (frontend-ui / backend-api / database / ...).  Best-effort:
    // skipped on disk read failure (telemetry never breaks a real turn).
    // Topic skipped when classifyTopic returns a ride-along category
    // (bug-fix / testing / docs / general) — those layer onto whatever
    // the current work is and don't constitute their own categorization.
    let attribution: {
      projectId?: string;
      projectName?: string;
      topic?: string;
    } = {};
    try {
      const info = await getProjectInfo(process.cwd());
      attribution = { projectId: info.projectId, projectName: info.projectName };
      const topic = classifyTopic(task);
      if (!isRideAlong(topic)) attribution.topic = topic;
    } catch {
      /* silent — proceed without attribution */
    }
    connection = await buildProviderModel(resolved, attribution);
  } catch (err) {
    console.error(chalk.red('mod8: ') + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  const cwd = process.cwd();
  const autoApprove = !!opts.yes;
  const maxSteps = opts.maxSteps ?? 20;

  process.stderr.write(
    chalk.dim(
      `mod8 agent · ${resolved.label} (${resolved.modelId}) · ${connection.source} · cwd ${cwd}\n` +
        (autoApprove
          ? chalk.yellow('  --yes: tool calls auto-approved\n')
          : '  destructive tool calls will ask first.  esc/Ctrl+C to abort.\n')
    )
  );

  const tools = buildAgentTools({ cwd, autoApprove });
  const ctxResult = await readProjectContext(cwd);
  const shapedContext =
    ctxResult.kind === 'found'
      ? shapeProjectContextForProvider(ctxResult.ctx, resolved.kind, resolved.modelId)
      : undefined;
  const contextSource = ctxResult.kind === 'found' ? ctxResult.ctx.foundAt : undefined;
  if (ctxResult.kind === 'found') {
    process.stderr.write(
      chalk.dim(
        `  project context: ${ctxResult.ctx.foundAt} (${ctxResult.ctx.bytes} bytes${ctxResult.ctx.truncated ? ', truncated' : ''})\n`
      )
    );
  }
  const system = buildAgentSystemPrompt({
    cwd,
    model: resolved.modelId,
    providerLabel: resolved.label,
    ...(shapedContext !== undefined ? { projectContext: shapedContext } : {}),
    ...(contextSource ? { projectContextSource: contextSource } : {}),
  });

  let firstError: Error | null = null;
  let totalTokens = 0;
  let lastTextChar = '';
  try {
    for await (const ev of runtimeStream({
      model: connection.model,
      system,
      messages: [{ role: 'user', content: task }],
      tools,
      maxSteps,
    })) {
      if (ev.type === 'text-delta') {
        process.stdout.write(ev.delta);
        if (ev.delta) lastTextChar = ev.delta[ev.delta.length - 1] ?? lastTextChar;
      } else if (ev.type === 'tool-call') {
        process.stderr.write(
          '\n' +
            chalk.cyan('◆ ') +
            chalk.bold(verbPresent(ev.toolName)) +
            chalk.dim('  ' + summariseArgs(ev.input) + '\n')
        );
      } else if (ev.type === 'tool-result') {
        const summary = summariseResult(ev.toolName, ev.output);
        process.stderr.write(
          chalk.dim(`  ${ev.ok ? '✓' : '✗'} ${verbPast(ev.toolName)}${summary ? '  ·  ' + summary : ''}\n`)
        );
      } else if (ev.type === 'finish') {
        totalTokens = ev.usage.inputTokens + ev.usage.outputTokens;
      } else if (ev.type === 'error') {
        if (!firstError) firstError = ev.error;
      }
    }
    if (firstError) throw firstError;

    if (lastTextChar !== '\n') process.stdout.write('\n');
    process.stderr.write(
      chalk.dim(`\n— done · ${totalTokens || '?'} tokens · ${connection.source}\n`)
    );
  } catch (err) {
    const friendly = formatAgentError(err, resolved, connection.source);
    process.stderr.write('\n' + chalk.red('mod8 agent: ') + friendly + '\n');
    process.exit(1);
  }
}

function formatAgentError(
  err: unknown,
  resolved: ResolvedModel,
  source: 'proxy' | 'local'
): string {
  const raw = err instanceof Error ? err.message : String(err);
  const apiUrl =
    err && typeof err === 'object' && 'url' in err ? String((err as { url: unknown }).url) : '';
  const status =
    err && typeof err === 'object' && 'statusCode' in err
      ? Number((err as { statusCode: unknown }).statusCode)
      : NaN;

  if (status === 401) {
    return source === 'proxy'
      ? `${resolved.label} (proxy): your mod8 key was rejected.  Run \`mod8 logout\` then \`mod8 login\` again.`
      : `${resolved.label} (BYOK): your local API key was rejected.  Re-run \`mod8 keys set ${resolved.kind}\`.`;
  }
  if (status === 402) {
    return `${resolved.label} (proxy): mod8 balance too low.  Top up at https://mod8.ai/credits.`;
  }
  if (status === 404) {
    return source === 'proxy'
      ? `${resolved.label} (proxy): the agent endpoint isn't deployed on your proxy yet.  Upgrade mod8-cli or have the operator redeploy mod8-proxy.${apiUrl ? `  (got 404 from ${apiUrl})` : ''}`
      : `${resolved.label} (BYOK): model "${resolved.modelId}" not found.  Try a different --model.`;
  }
  if (status === 429) {
    return `${resolved.label}: rate limit hit upstream.  Wait a few seconds and re-run.`;
  }
  if (raw.includes('ENOTFOUND') || raw.includes('ECONNREFUSED')) {
    return `${resolved.label}: network unreachable — check your internet connection.`;
  }
  return raw;
}

const TOOL_VERB_TABLE: Record<string, { present: string; past: string }> = {
  read_file:  { present: 'Reading',   past: 'Read' },
  list_dir:   { present: 'Listing',   past: 'Listed' },
  grep:       { present: 'Searching', past: 'Searched' },
  write_file: { present: 'Writing',   past: 'Wrote' },
  edit_file:  { present: 'Editing',   past: 'Edited' },
  bash:       { present: 'Running',   past: 'Bash' },
};

function verbPresent(toolName: string): string {
  return TOOL_VERB_TABLE[toolName]?.present ?? toolName;
}

function verbPast(toolName: string): string {
  return TOOL_VERB_TABLE[toolName]?.past ?? toolName;
}

/** Compact post-execution summary for the trailing dim line.  Kept in
 *  sync with the Ink REPL's `summarizeToolResult` so both surfaces show
 *  the same shape. */
function summariseResult(toolName: string, output: unknown): string {
  if (output == null) return '';
  const raw = typeof output === 'string' ? output : JSON.stringify(output);
  if (raw.startsWith('Error:')) {
    const first = raw.split('\n')[0] ?? '';
    return first.length > 80 ? first.slice(0, 77) + '...' : first;
  }
  switch (toolName) {
    case 'read_file': {
      const lines = raw.split('\n').length;
      return `${lines} ${lines === 1 ? 'line' : 'lines'}`;
    }
    case 'list_dir': {
      if (raw.trim() === '(empty)') return 'empty';
      const entries = raw.split('\n').filter((l) => l.trim()).length;
      return `${entries} ${entries === 1 ? 'entry' : 'entries'}`;
    }
    case 'grep': {
      if (raw.trim() === 'No matches.') return 'no matches';
      const matches = raw.split('\n').filter((l) => l.trim()).length;
      return `${matches} ${matches === 1 ? 'match' : 'matches'}`;
    }
    case 'write_file': {
      const m = raw.match(/\((\d+)\s*bytes?\)/);
      return m ? `${m[1]} bytes` : 'done';
    }
    case 'edit_file':
      return 'edited';
    case 'bash': {
      const m = raw.match(/^exit code (\S+)/);
      return m ? `exit ${m[1]}` : 'done';
    }
    default:
      return '';
  }
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
