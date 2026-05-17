import { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useApp, useInput, Static } from 'ink';
import TextInput from 'ink-text-input';
import chalk from 'chalk';
import { promises as fs } from 'node:fs';
import { resolve as resolvePath, isAbsolute } from 'node:path';
import { createPatch } from 'diff';
import { streamProviderChat } from '../providers/genericChat.js';
import { runAgent } from '../runtime/runAgent.js';
import { getProviderClient } from '../providers/index.js';
import { readAuth } from '../storage/auth.js';
import { PROXY_PROVIDER_IDS } from '../providers/proxy.js';
import {
  buildProviderModel,
  type ResolvedModel,
  type ProviderKind,
} from '../agent/providerModel.js';
import { buildInkTools, buildHostInkTools } from '../agent/inkTools.js';
import { getProjectInfo } from '../agent/projectInfo.js';
import {
  detectImagePaste,
  formatImageBytes,
  type PastedImage,
} from '../util/imagePaste.js';
import { contextWindowFor } from '../agent/contextWindows.js';
import { WriteLedger } from '../agent/writeLedger.js';
import {
  classifyTopic,
  comparisonFor,
  renderComparison,
  isRideAlong,
  type Topic,
} from '../agent/topicRouter.js';
import {
  loadPrefs,
  recordPick,
  type RoutingPrefs,
} from '../agent/routingPrefs.js';
import { buildAgentSystemPrompt } from '../agent/systemPrompt.js';
import { readProjectContext } from '../agent/projectContext.js';
import { shapeProjectContextForProvider } from '../agent/contextShaping.js';
import {
  resolveConfigured,
  resolveProviderHint,
  strictResolveProviderHint,
  configuredProviderIds,
  saveKeyPreservingEntry,
  fuzzyResolveProviderHint,
  type ProviderEntry,
  type FuzzyMatch,
} from '../storage/providers.js';
import { templateById } from '../providers/registry.js';
import { buildHostSystem, readHostContext } from '../providers/hostSystem.js';
import { buildWorkSystem } from '../providers/workSystem.js';
import { workerNameFor } from '../providers/displayName.js';
import { classifyError } from '../util/errors.js';
import { formatCost } from '../providers/pricing.js';
import type { StreamUsage } from '../providers/types.js';
import {
  type Session,
  type SessionMessage,
  createSession,
  getMostRecentSession,
  loadSession,
  saveSession,
  clearSessionHistory,
  generateTitle,
} from '../storage/sessions.js';
import { humanTimeAgo } from '../util/time.js';
import { openInBrowser } from '../util/browser.js';
import {
  parseProviderRoute,
  parseHostBack,
  parseHandoff,
  parseBareProviderHint,
  isCompareCommand,
  parseCompareWithPrompt,
  parseOpenBrowser,
  findRecentUrl,
  parsePasteKeyIntent,
  isPasteConfirmAffirmative,
  isAffirmative,
  isNegative,
  fallbackDecision,
  AUTO_FALLBACK_THRESHOLD,
} from './intentRouting.js';
import { findApiKey, sanitizeKeys, maskApiKey } from '../util/secrets.js';
import { explainError } from '../providers/errorHints.js';
import type { ProviderTemplate } from '../providers/registry.js';

// Host (planning side) is always mod8 = Anthropic Sonnet.  Don't generalize
// the host — that's the brand.  Only the work side is provider-pluggable.
const HOST_PROVIDER_ID = 'anthropic';
const HOST_MODEL = process.env.MOD8_HOST_MODEL ?? 'claude-sonnet-4-6';
const DEFAULT_WORK_PROVIDER_ID = 'anthropic';
const DEFAULT_WORK_MODEL = process.env.MOD8_WORK_MODEL ?? 'claude-opus-4-7';

// Provider ids that have a Vercel AI SDK client (anthropic/openai/google/deepseek).
// In work mode, calls for these providers route through the agent runtime
// (streamText + tools).  Other providers (mistral/groq/xai/openrouter/custom)
// still work in work mode via the legacy text-only path.
const SDK_PROVIDER_IDS: readonly string[] = ['anthropic', 'openai', 'google', 'deepseek'];
const MAX_AGENT_STEPS = 20;

const HOST_COLOR = '#6EE7B7'; // mint — the mod8 brand color (distinct from any provider)
const HOST_ICON = '✻';
const WORK_ICON = '◆';

// HOST_SYSTEM is built dynamically per-session in runChat() with live data
// about the user's configured providers. See providers/hostSystem.ts.

// Switch-back triggers all live in parseHostBack (intentRouting.ts) now.

type Mode = 'host' | 'work';

interface Speaker {
  icon: string;
  name: string;
  color: string;
  verb: string;
}

const HOST_SPEAKER: Speaker = {
  icon: HOST_ICON,
  name: 'mod8',
  color: HOST_COLOR,
  verb: 'thinking',
};

function workSpeakerFromEntry(id: string, entry: ProviderEntry | undefined): Speaker {
  if (!entry) {
    return { icon: WORK_ICON, name: id, color: '#A78BFA', verb: 'working' };
  }
  return {
    icon: WORK_ICON,
    name: workerNameFor(id, entry.name),
    color: entry.color,
    verb: 'working',
  };
}

/** Short, human-readable summary of a tool call's args.  Shown next to the
 *  tool name in the call banner (◆ codex → edit_file path/to/file). */
function makeToolSummary(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  switch (toolName) {
    case 'read_file':
    case 'list_dir':
    case 'write_file':
    case 'edit_file':
      return typeof o.path === 'string' ? o.path : '';
    case 'grep': {
      const pat = typeof o.pattern === 'string' ? o.pattern : '';
      const path = typeof o.path === 'string' ? ` in ${o.path}` : '';
      return `${pat}${path}`;
    }
    case 'bash':
      return ''; // command body goes in the dedicated colored block
    default: {
      const s = JSON.stringify(o);
      return s.length > 60 ? s.slice(0, 57) + '...' : s;
    }
  }
}

/** Compute a tool-call AppendItem from the model's tool-call args.  For
 *  edit_file / write_file we read the current file contents and produce a
 *  unified diff inline so the user sees the change BEFORE the tool runs
 *  (same visual style as the rest of mod8). */
async function computeToolCallItem(
  toolName: string,
  input: unknown,
  speaker: Speaker,
  cwd: string
): Promise<AppendItem> {
  const summary = makeToolSummary(toolName, input);
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  if (toolName === 'bash' && typeof o.command === 'string') {
    return { kind: 'tool-call', speaker, toolName, summary, command: o.command };
  }

  if (toolName === 'edit_file' && typeof o.path === 'string' && typeof o.before === 'string' && typeof o.after === 'string') {
    try {
      const full = isAbsolute(o.path) ? o.path : resolvePath(cwd, o.path);
      const original = await fs.readFile(full, 'utf8');
      if (original.includes(o.before)) {
        const updated = original.replace(o.before, o.after);
        const diff = createPatch(o.path, original, updated, undefined, undefined, { context: 3 });
        return { kind: 'tool-call', speaker, toolName, summary, diff };
      }
    } catch {
      // Fall through — show without diff
    }
  }

  if (toolName === 'write_file' && typeof o.path === 'string' && typeof o.contents === 'string') {
    try {
      const full = isAbsolute(o.path) ? o.path : resolvePath(cwd, o.path);
      const before = await fs.readFile(full, 'utf8').catch(() => '');
      const diff = createPatch(o.path, before, o.contents, undefined, undefined, { context: 3 });
      return { kind: 'tool-call', speaker, toolName, summary, diff };
    } catch {
      // Fall through
    }
  }

  return { kind: 'tool-call', speaker, toolName, summary };
}

/** First line / short slice of the tool's output, for the dim ✓/✗ tag.
 *  The `ok` flag is computed by the runtime — this helper only formats. */
function previewToolOutput(output: unknown): string {
  const raw = typeof output === 'string' ? output : JSON.stringify(output);
  const firstLine = raw.split('\n')[0] ?? '';
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
}

/** Tool name → present-tense verb shown WHILE the tool is running
 *  (e.g. "Reading hello.py" in the active indicator), and past-tense verb
 *  shown AFTER it finishes (e.g. "✓ Read · 245 lines" in the transcript).
 *  Claude-Code-style: verbs read better than tool names. */
const TOOL_VERBS: Record<string, { present: string; past: string }> = {
  read_file:  { present: 'Reading',   past: 'Read' },
  list_dir:   { present: 'Listing',   past: 'Listed' },
  grep:       { present: 'Searching', past: 'Searched' },
  write_file: { present: 'Writing',   past: 'Wrote' },
  edit_file:  { present: 'Editing',   past: 'Edited' },
  bash:       { present: 'Running',   past: 'Bash' },
};

function toolVerb(toolName: string, tense: 'present' | 'past'): string {
  const entry = TOOL_VERBS[toolName];
  if (entry) return entry[tense];
  // Unknown tool — fall back to the raw name so we never lose information.
  return toolName;
}

/** Compute a one-line result summary tailored to the tool that just ran.
 *  These are the trailing labels on `✓ Read · 245 lines`. */
function summarizeToolResult(toolName: string, output: unknown): string {
  if (output == null) return '';
  const raw = typeof output === 'string' ? output : JSON.stringify(output);
  if (raw.startsWith('Error:')) {
    // Errors get their first line verbatim — same as previewToolOutput.
    return previewToolOutput(raw);
  }
  switch (toolName) {
    case 'read_file': {
      const lines = raw.split('\n').length;
      return `${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'}`;
    }
    case 'list_dir': {
      if (raw.trim() === '(empty)') return 'empty';
      const entries = raw.split('\n').filter((l) => l.trim()).length;
      return `${entries.toLocaleString()} ${entries === 1 ? 'entry' : 'entries'}`;
    }
    case 'grep': {
      if (raw.trim() === 'No matches.') return 'no matches';
      const matches = raw.split('\n').filter((l) => l.trim()).length;
      return `${matches.toLocaleString()} ${matches === 1 ? 'match' : 'matches'}`;
    }
    case 'write_file': {
      // tool returns "Wrote path (NN bytes)." — extract the byte count.
      const m = raw.match(/\((\d+)\s*bytes?\)/);
      return m ? `${Number(m[1]).toLocaleString()} bytes` : 'done';
    }
    case 'edit_file':
      return 'edited';
    case 'bash': {
      // tool returns "exit code N\n<stdout>" — extract the exit code.
      const m = raw.match(/^exit code (\S+)/);
      return m ? `exit ${m[1]}` : 'done';
    }
    default:
      return previewToolOutput(raw);
  }
}

type TranscriptItem =
  | { kind: 'user'; id: number; text: string; mode: Mode; speaker: Speaker }
  | {
      kind: 'assistant';
      id: number;
      text: string;
      mode: Mode;
      speaker: Speaker;
      stats?: StreamUsage;
      aborted?: boolean;
    }
  | { kind: 'mode-switch'; id: number; targetMode: Mode; speaker: Speaker; subtitle: string }
  | { kind: 'compare'; id: number; results: CompareBlock[] }
  | {
      kind: 'tool-call';
      id: number;
      speaker: Speaker;
      toolName: string;
      summary: string;
      diff?: string;
      command?: string;
    }
  | { kind: 'tool-result'; id: number; speaker: Speaker; toolName: string; ok: boolean; preview: string }
  | { kind: 'error'; id: number; text: string }
  | { kind: 'info'; id: number; text: string };

interface CompareBlock {
  id: string;
  name: string;
  color: string;
  ok: boolean;
  text?: string;
  stats?: StreamUsage;
  error?: string;
}

type AppendItem =
  | { kind: 'user'; text: string; mode: Mode; speaker: Speaker }
  | {
      kind: 'assistant';
      text: string;
      mode: Mode;
      speaker: Speaker;
      stats?: StreamUsage;
      aborted?: boolean;
    }
  | { kind: 'mode-switch'; targetMode: Mode; speaker: Speaker; subtitle: string }
  | { kind: 'compare'; results: CompareBlock[] }
  | {
      kind: 'tool-call';
      speaker: Speaker;
      toolName: string;
      summary: string;
      diff?: string;
      command?: string;
    }
  | { kind: 'tool-result'; speaker: Speaker; toolName: string; ok: boolean; preview: string }
  | { kind: 'error'; text: string }
  | { kind: 'info'; text: string };

let nextId = 0;

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  return (
    e.name === 'AbortError' ||
    e.name === 'APIUserAbortError' ||
    /abort/i.test(e.message ?? '')
  );
}

const SWITCH_TOKENS = ['<SWITCH_TO_WORK>', '<SWITCH_TO_HOST>'];

function stripSwitchTokens(text: string): string {
  let cleaned = text.replace(/<SWITCH_TO_(WORK|HOST)>/gi, '');
  for (let i = Math.min(cleaned.length, 16); i > 0; i--) {
    const tail = cleaned.slice(-i);
    if (SWITCH_TOKENS.some((t) => t.startsWith(tail))) {
      cleaned = cleaned.slice(0, -i);
      break;
    }
  }
  return cleaned.trimEnd();
}

function detectSwitch(text: string, currentMode: Mode): Mode | null {
  if (currentMode === 'host' && /<SWITCH_TO_WORK>/i.test(text)) return 'work';
  if (currentMode === 'work' && /<SWITCH_TO_HOST>/i.test(text)) return 'host';
  return null;
}


function Welcome() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={HOST_COLOR} bold>{`${HOST_ICON} mod8`}</Text>
      </Box>
      <Text dimColor>{`  switch to claude:  ask naturally — "go", "let's work", "let me talk to claude"`}</Text>
      <Text dimColor>{`  use any provider:  "use deepseek", "ask grok", "switch to mistral"`}</Text>
      <Text dimColor>{`  side-by-side:      "compare all" or /compare`}</Text>
      <Text dimColor>{`  list providers:    /providers      ·  back to mod8: /mod8 or @mod8`}</Text>
      <Text dimColor>{`  clear history:     /clear          ·  quit: /exit · cancel: esc`}</Text>
    </Box>
  );
}

function SpeakerBlock({
  speaker,
  body,
  stats,
}: {
  speaker: Speaker;
  body: string;
  stats?: StreamUsage;
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={speaker.color} bold>{`${speaker.icon} ${speaker.name}`}</Text>
      </Box>
      <Box
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={speaker.color}
        paddingLeft={1}
        flexDirection="column"
      >
        <Text color={speaker.color}>{body}</Text>
        {stats && (
          <Text color={speaker.color} dimColor>
            {`${(
              stats.inputTokens + stats.outputTokens
            ).toLocaleString()} tok · ${(stats.latencyMs / 1000).toFixed(2)}s · ${formatCost(
              stats.costUsd
            )}`}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function MessageView({ item }: { item: TranscriptItem }) {
  if (item.kind === 'user') {
    return (
      <Box marginTop={1}>
        <Text color={item.speaker.color}>{'›  '}</Text>
        <Text>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === 'assistant') {
    const body = item.text + (item.aborted ? ' …interrupted' : '');
    return (
      <Box marginTop={1}>
        <SpeakerBlock speaker={item.speaker} body={body} stats={item.stats} />
      </Box>
    );
  }
  if (item.kind === 'mode-switch') {
    const rule = '─'.repeat(60);
    return (
      <Box marginTop={1} marginBottom={1} flexDirection="column">
        <Text color={item.speaker.color} bold>{rule}</Text>
        <Text color={item.speaker.color} bold>
          {`  ${item.speaker.icon}  → switching to ${item.speaker.name}  (${item.subtitle})`}
        </Text>
        <Text color={item.speaker.color} bold>{rule}</Text>
      </Box>
    );
  }
  if (item.kind === 'compare') {
    return (
      <Box marginTop={1} flexDirection="column">
        {item.results.map((r) => (
          <Box key={r.id} flexDirection="column" marginTop={1}>
            <Box>
              <Text color={r.color} bold>{`${WORK_ICON} ${r.name}`}</Text>
              {r.ok ? null : <Text color="red">{`  ✗ ${r.error}`}</Text>}
            </Box>
            {r.ok && (
              <Box
                borderStyle="single"
                borderTop={false}
                borderRight={false}
                borderBottom={false}
                borderColor={r.color}
                paddingLeft={1}
                flexDirection="column"
              >
                <Text color={r.color}>{r.text ?? ''}</Text>
                {r.stats && (
                  <Text color={r.color} dimColor>
                    {`${(
                      r.stats.inputTokens + r.stats.outputTokens
                    ).toLocaleString()} tok · ${(r.stats.latencyMs / 1000).toFixed(2)}s · ${formatCost(
                      r.stats.costUsd
                    )}`}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        ))}
      </Box>
    );
  }
  if (item.kind === 'tool-call') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={item.speaker.color} bold>{`${item.speaker.icon} `}</Text>
          <Text color={item.speaker.color} bold>{toolVerb(item.toolName, 'present')}</Text>
          {item.summary && (
            <Text color={item.speaker.color} dimColor>{`  ${item.summary}`}</Text>
          )}
        </Box>
        {item.command && (
          <Box
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={item.speaker.color}
            paddingLeft={1}
            flexDirection="column"
          >
            <Text color={item.speaker.color}>{`$ ${item.command}`}</Text>
          </Box>
        )}
        {item.diff && (
          <Box
            borderStyle="single"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderColor={item.speaker.color}
            paddingLeft={1}
            flexDirection="column"
          >
            {item.diff.split('\n').map((line, i) => {
              let color = item.speaker.color;
              if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:') || line.startsWith('===')) {
                return <Text key={i} dimColor>{line}</Text>;
              }
              if (line.startsWith('@@')) color = 'cyan';
              else if (line.startsWith('+')) color = 'green';
              else if (line.startsWith('-')) color = 'red';
              return <Text key={i} color={color}>{line}</Text>;
            })}
          </Box>
        )}
      </Box>
    );
  }
  if (item.kind === 'tool-result') {
    return (
      <Box>
        <Text color={item.ok ? item.speaker.color : 'red'} dimColor>
          {`  ${item.ok ? '✓' : '✗'} ${toolVerb(item.toolName, 'past')}`}
          {item.preview ? `  ·  ${item.preview}` : ''}
        </Text>
      </Box>
    );
  }
  if (item.kind === 'error') {
    return (
      <Box marginTop={1}>
        <Text color="red">{`mod8: ${item.text}`}</Text>
      </Box>
    );
  }
  if (item.kind === 'info') {
    return (
      <Box marginTop={1}>
        <Text dimColor>{item.text}</Text>
      </Box>
    );
  }
  return null;
}

function ThinkingIndicator({ speaker, startedAt }: { speaker: Speaker; startedAt: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(interval);
  }, []);
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return (
    <Box marginTop={1}>
      <Text color={speaker.color}>{`${speaker.icon} `}</Text>
      <Text color={speaker.color} bold>{speaker.name}</Text>
      <Text dimColor>{` ${speaker.verb}… (${elapsed}s)`}</Text>
    </Box>
  );
}

/** Animated "currently doing X" line that lives BETWEEN the tool-call
 *  banner and its result.  Renders below the streamed text (outside the
 *  Static transcript) so it can update + tear down without leaving
 *  artifacts behind.  Claude-Code-style: gives the user a heartbeat
 *  while a tool is mid-execution.
 *
 *  After 60s a yellow "this is taking a while" hint appears so the user
 *  knows they can abort instead of staring at a frozen-looking prompt. */
/** Pinned goal banner the work agent declares via the `plan` tool at the
 *  start of a turn.  Sits above the active-tool indicator so the user
 *  always knows WHAT the agent is working toward — not just which tool
 *  is firing right now. */
function PlanBanner({
  speaker,
  plan,
}: {
  speaker: Speaker;
  plan: { goal: string; stepEstimate: number | null; stepCount: number };
}) {
  const stepLine =
    plan.stepEstimate
      ? `step ${Math.max(plan.stepCount, 1)} of ~${plan.stepEstimate}`
      : plan.stepCount > 0
      ? `step ${plan.stepCount}`
      : 'planning…';
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={speaker.color} bold>{`${speaker.icon}  `}</Text>
        <Text color={speaker.color} bold>{plan.goal}</Text>
      </Box>
      <Box>
        <Text dimColor>{`   ${stepLine}`}</Text>
      </Box>
    </Box>
  );
}

function ActiveToolIndicator({
  speaker,
  toolName,
  detail,
  startedAt,
}: {
  speaker: Speaker;
  toolName: string;
  detail: string;
  startedAt: number;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const elapsed = elapsedSec.toFixed(1);
  // 4-step dot animation — gentle, no extra deps.
  const dots = '●'.repeat((tick % 3) + 1) + '○'.repeat(2 - (tick % 3));
  const isSlow = elapsedSec > 60;
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={speaker.color} bold>{`${speaker.icon} `}</Text>
        <Text color={speaker.color} bold>{toolVerb(toolName, 'present')}</Text>
        {detail && <Text dimColor>{`  ${detail}`}</Text>}
        <Text dimColor>{`  ${elapsed}s  `}</Text>
        <Text color={isSlow ? 'yellow' : speaker.color}>{dots}</Text>
      </Box>
      {isSlow && (
        <Box>
          <Text color="yellow">
            {`  ⚠  this is taking a while — press esc to abort if it looks stuck`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function InputBox({
  speaker,
  value,
  onChange,
  onSubmit,
  busy,
}: {
  speaker: Speaker;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  /** When true, a turn is still streaming.  We KEEP the input focused so
   *  the user can keep typing — submitted messages get queued and drain
   *  automatically when the current turn ends.  Border dims to signal
   *  "queueing mode" without locking the user out. */
  busy: boolean;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={busy ? 'gray' : speaker.color}
      paddingX={1}
    >
      <Text color={speaker.color}>{'›  '}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus={true}
      />
    </Box>
  );
}

function StatusLine({ speaker, errorTag }: { speaker: Speaker; errorTag?: string | null }) {
  return (
    <Box paddingX={1}>
      <Text color={speaker.color} bold>{`${speaker.icon} ${speaker.name}`}</Text>
      {errorTag && <Text color="red">{` (${errorTag})`}</Text>}
      <Text dimColor>{` · esc to interrupt · /exit to quit`}</Text>
    </Box>
  );
}

/** Approximate context-window-fill indicator.  Shows the user how full
 *  the model's window is based on the last turn's input-token count —
 *  the lever that controls whether an agent "forgets" earlier tool calls
 *  after a long session.  Green / yellow / red zones make the warning
 *  glanceable without reading numbers. */
function ContextBar({
  usage,
}: {
  usage: { inputTokens: number; model: string };
}) {
  const window = contextWindowFor(usage.model);
  const pct = Math.min(100, Math.max(0, (usage.inputTokens / window) * 100));
  const color = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green';
  const filled = Math.round((pct / 100) * 20);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  const fmtTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
    return `${n}`;
  };
  return (
    <Box paddingX={1}>
      <Text dimColor>{`  context  `}</Text>
      <Text color={color}>{bar}</Text>
      <Text dimColor>{`  ${pct.toFixed(0)}% · ${fmtTokens(usage.inputTokens)}/${fmtTokens(window)}`}</Text>
      {pct >= 90 && (
        <Text color="red" bold>{`  ⚠ near limit — /clear or start fresh`}</Text>
      )}
      {pct >= 70 && pct < 90 && (
        <Text color="yellow">{`  · getting full`}</Text>
      )}
    </Box>
  );
}

function buildTranscript(messages: SessionMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let prev: Mode | null = null;
  for (const m of messages) {
    // Best-effort speaker reconstruction — we don't store provider id per
    // message yet, so resumed work-mode turns show the default speaker.
    const speaker = m.mode === 'host'
      ? HOST_SPEAKER
      : workSpeakerFromEntry(DEFAULT_WORK_PROVIDER_ID, undefined);
    if (prev !== null && m.mode !== prev) {
      items.push({
        kind: 'mode-switch',
        id: nextId++,
        targetMode: m.mode,
        speaker,
        subtitle: m.mode === 'host' ? 'host mode' : 'work mode',
      });
    }
    if (m.role === 'user') {
      items.push({ kind: 'user', id: nextId++, text: m.content, mode: m.mode, speaker });
    } else {
      items.push({
        kind: 'assistant',
        id: nextId++,
        text: m.content,
        mode: m.mode,
        speaker,
        stats: m.stats as StreamUsage | undefined,
        aborted: m.aborted,
      });
    }
    prev = m.mode;
  }
  return items;
}

function App({
  session: initialSession,
}: {
  session: Session;
}) {
  const { exit } = useApp();
  const sessionRef = useRef<Session>(initialSession);
  // Session-scoped write tracker — survives outside the model context so
  // the agent can't "forget" that it already built a file.  Cleared on
  // /clear; passed into every buildInkTools call.
  const ledgerRef = useRef<WriteLedger>(new WriteLedger());

  const [transcript, setTranscript] = useState<TranscriptItem[]>(() =>
    buildTranscript(initialSession.messages)
  );
  const [mode, setMode] = useState<Mode>('host');
  const [workProviderId, setWorkProviderId] = useState<string>(DEFAULT_WORK_PROVIDER_ID);
  const [workEntry, setWorkEntry] = useState<ProviderEntry | undefined>(undefined);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [streamStart, setStreamStart] = useState(0);
  // While a tool is mid-execution (between tool-call and tool-result),
  // we render an ActiveToolIndicator below the streamed text.  Cleared on
  // tool-result OR when the turn ends.
  const [activeTool, setActiveTool] = useState<
    { toolName: string; detail: string; startedAt: number } | null
  >(null);
  // Pinned goal banner — set by the work agent via the `plan` tool at the
  // start of a turn so the user sees WHAT the agent is working toward, not
  // just which tool is firing.  Cleared on turn end.  `stepEstimate` is
  // optional; `stepCount` increments per non-plan tool call.
  const [agentPlan, setAgentPlan] = useState<
    { goal: string; stepEstimate: number | null; stepCount: number } | null
  >(null);
  // Per-turn tool-call frequency map — used by the loop detector below to
  // abort + warn when an agent calls the same tool with the same args 4+
  // times in a single turn (the read-the-same-dir-forever bug).
  const toolCallCountsRef = useRef<Map<string, number>>(new Map());
  // Image queued by the most recent paste — attached to the NEXT user
  // message as a multimodal content part, then cleared.  macOS screenshot
  // copy/paste yields a file path; this lets us convert that path into a
  // proper image attachment so the LLM actually sees the picture.
  const pendingImageRef = useRef<PastedImage | null>(null);
  // Topic-aware routing state — drives the "soft nudge" UX where mod8
  // recommends a provider ONCE per topic shift instead of pestering on
  // every prompt.  See src/agent/topicRouter.ts for the full design.
  //   currentTopic     — the topic of the most recent meaningful prompt
  //   recommendedFor   — set of topics we have already shown a nudge for
  //                      (so a single shift fires once, not on every msg)
  //   userOverrode     — true once the user manually picked a provider
  //                      (use X / @X take over / /handoff X) → silent
  //                      forever this session.  Respect the user's call.
  const sessionTopicRef = useRef<{
    currentTopic: Topic | null;
    recommendedFor: Set<Topic>;
    userOverrode: boolean;
  }>({ currentTopic: null, recommendedFor: new Set(), userOverrode: false });
  // Per-user routing preferences — counts how many times each provider
  // got picked for each topic.  Loaded once on mount, refreshed after
  // every recordPick so the next comparison-panel render reflects the
  // user's latest habits.  See src/agent/routingPrefs.ts.
  const prefsRef = useRef<RoutingPrefs>({});
  // Most recent turn's token usage — used to show a context-usage bar so
  // the user can see when the conversation is filling up the model's
  // window (the root cause of agents "forgetting" earlier tool calls).
  const [lastUsage, setLastUsage] = useState<
    { inputTokens: number; model: string; mode: Mode } | null
  >(null);
  // Messages typed while a turn is mid-flight.  They drain
  // automatically when the current turn finishes — same feel as
  // chatting in Claude Code: you can keep typing, the assistant
  // catches up.
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const queuedRef = useRef<string[]>([]);
  // When the last work-mode call errored, this holds the classified error
  // ("rate limited", "invalid API key", …) so the status line can show it.
  // Cleared on the next successful turn or on switch-back to host.
  const [lastWorkError, setLastWorkError] = useState<string | null>(null);

  const aborterRef = useRef<AbortController | null>(null);
  const modeRef = useRef<Mode>('host');
  const workIdRef = useRef<string>(DEFAULT_WORK_PROVIDER_ID);
  const workEntryRef = useRef<ProviderEntry | undefined>(undefined);
  const titleGenerationStartedRef = useRef<boolean>(false);
  // Consecutive work-mode error count.  Resets on success or on switch-back.
  // After AUTO_FALLBACK_THRESHOLD, the chat auto-switches to host mode.
  const consecutiveWorkErrorsRef = useRef<number>(0);
  // Inline paste-key flow: when the user says "add a key" / "let me add
  // gemini" / etc., we set this to true and the NEXT user message is treated
  // as a key paste (or rejected if it doesn't match a known key shape).
  // One-shot — cleared after the next message either way.
  const awaitingKeyRef = useRef<boolean>(false);
  // Bare-paste auto-detect: when the user pastes a key WITHOUT saying "add
  // a key" first, we cache the raw key in memory (NEVER on disk) and ask
  // "save this as <provider>?".  The next message either confirms (save)
  // or anything else (cancel + fall through to normal dispatch).
  const pendingKeyRef = useRef<{ rawKey: string; template: ProviderTemplate } | null>(null);
  // Fuzzy-match confirm: when "gimini" is 2 edits from "gemini" and the
  // bare term is short, we ask "did you mean google?" instead of routing
  // automatically.  Yes/affirmative → switch; anything else → cancel + fall
  // through to normal dispatch.
  const pendingFuzzyRef = useRef<
    { id: string; rest: string; sourceKey?: string } | null
  >(null);
  // Set of fuzzy mappings the user has already rejected in this session
  // ("open" → "openai", "codex" → "openai", etc.).  Prevents the same
  // "did you mean openai?" prompt firing twice for the same input — the
  // bug where typing "open the browser" kept re-triggering after a
  // previous "no" answer.  Keyed by `${input.toLowerCase()}:${candidate}`.
  const rejectedFuzzyRef = useRef<Set<string>>(new Set());

  // Resolve a provider entry, falling back to a proxy-synthesized entry when
  // the user is logged in via `mod8 login` and asking for one of the four
  // built-in providers (which don't need a local key — the proxy supplies
  // one).  Without this fallback, switching to a proxy-only provider leaves
  // workEntry undefined and the REPL sends the default-work model
  // (claude-opus-4-7) to whichever provider the user picked.
  const resolveEntryWithProxyFallback = async (
    id: string
  ): Promise<ProviderEntry | undefined> => {
    const entry = await resolveConfigured(id);
    if (entry) return entry;
    const auth = await readAuth();
    if (!auth) return undefined;
    if (!(PROXY_PROVIDER_IDS as readonly string[]).includes(id)) return undefined;
    const tpl = templateById(id);
    if (!tpl) return undefined;
    return {
      name: tpl.name,
      apiType: tpl.apiType,
      apiKey: '',
      defaultModel: tpl.defaultModel,
      ...(tpl.baseUrl ? { baseUrl: tpl.baseUrl } : {}),
      color: tpl.color,
      custom: false,
    };
  };

  // Keep the work entry in sync whenever workProviderId changes.
  useEffect(() => {
    workIdRef.current = workProviderId;
    let cancelled = false;
    void resolveEntryWithProxyFallback(workProviderId).then((entry) => {
      if (cancelled) return;
      workEntryRef.current = entry;
      setWorkEntry(entry);
    });
    return () => {
      cancelled = true;
    };
  }, [workProviderId]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Hydrate routing prefs from disk on mount.  Best-effort: a missing
  // file yields {} and the comparison panel just falls back to the
  // static recommendation until the user picks something.
  useEffect(() => {
    let cancelled = false;
    void loadPrefs().then((p) => {
      if (!cancelled) prefsRef.current = p;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = () => {
    sessionRef.current.lastActivity = Date.now();
    saveSession(sessionRef.current).catch(() => {});
  };

  // Reset work-mode provider to the default (anthropic / claude) whenever
  // we transition into host mode.  This guarantees that the next
  // <SWITCH_TO_WORK> emitted by the host lands on claude — matching what
  // the host's system prompt promises ("handing you off to claude").
  // If the user wants the previous work provider back, they can re-route
  // explicitly: "use codex", "talk to grok", "deepseek", etc.
  const resetWorkToDefault = async () => {
    if (workIdRef.current === DEFAULT_WORK_PROVIDER_ID) return;
    setWorkProviderId(DEFAULT_WORK_PROVIDER_ID);
    workIdRef.current = DEFAULT_WORK_PROVIDER_ID;
    const defaultEntry = await resolveEntryWithProxyFallback(DEFAULT_WORK_PROVIDER_ID);
    workEntryRef.current = defaultEntry;
    setWorkEntry(defaultEntry);
  };

  const maybeGenerateTitle = () => {
    const session = sessionRef.current;
    if (titleGenerationStartedRef.current) return;
    if (session.title) return;
    const assistantTurns = session.messages.filter((m) => m.role === 'assistant').length;
    if (assistantTurns < 2) return;
    titleGenerationStartedRef.current = true;
    void (async () => {
      const title = await generateTitle(session.messages);
      if (title) {
        session.title = title;
        await saveSession(session).catch(() => {});
      }
    })();
  };

  useInput((_input, key) => {
    if (key.escape && aborterRef.current) {
      // Two-stage abort for snappy UX:
      //   1. Tell the SDK to unwind via the AbortController.  In a healthy
      //      stream this is enough — the catch path sets `aborted=true`
      //      and the post-stream block tears down within a tick.
      //   2. ALSO force the streaming UI to reset RIGHT NOW.  If the SDK
      //      is stalled on a dead SSE connection (the "299s thinking"
      //      bug — upstream hung, no chunks arriving) the unwind can take
      //      several more seconds.  We can't make the user wait for that.
      aborterRef.current.abort();
      aborterRef.current = null;
      append({ kind: 'info', text: '✗ aborted (esc)' });
      setStreaming(false);
      setStreamedText('');
      setActiveTool(null);
      setAgentPlan(null);
      toolCallCountsRef.current.clear();
      // Clear any sticky one-shot prompts so a Ctrl-C / esc actually
      // resets state.  Without this, "did you mean openai?" re-fires
      // on the next message even after the user aborted the flow.
      pendingFuzzyRef.current = null;
      pendingKeyRef.current = null;
      awaitingKeyRef.current = false;
    }
  });

  const append = (item: AppendItem) => {
    setTranscript((prev) => [...prev, { ...item, id: nextId++ } as TranscriptItem]);
  };

  const speakerForMode = (m: Mode, overrideId?: string, overrideEntry?: ProviderEntry): Speaker => {
    if (m === 'host') return HOST_SPEAKER;
    return workSpeakerFromEntry(overrideId ?? workIdRef.current, overrideEntry ?? workEntryRef.current);
  };

  const switchToWorkProvider = async (rawHint: string, label: string): Promise<boolean> => {
    // Map the user's hint (id, display name, or synonym like "gpt") to a
    // canonical provider id before checking whether it's configured.
    const resolvedId = await resolveProviderHint(rawHint);
    if (!resolvedId) {
      append({
        kind: 'error',
        text: `unknown provider "${rawHint}". Try: /providers, or mod8 add-provider.`,
      });
      return false;
    }
    const entry = await resolveEntryWithProxyFallback(resolvedId);
    if (!entry) {
      append({
        kind: 'error',
        text: `${resolvedId} not configured. Run: mod8 login (recommended), or mod8 keys set ${resolvedId}.`,
      });
      return false;
    }
    setWorkProviderId(resolvedId);
    workIdRef.current = resolvedId;
    workEntryRef.current = entry;
    setWorkEntry(entry);
    // User made an explicit provider choice — silence topic nudges for
    // the rest of this session.  We don't pester someone who already
    // picked their tool.  Reset on /clear.
    sessionTopicRef.current.userOverrode = true;
    const speaker = workSpeakerFromEntry(resolvedId, entry);
    // Banner: if the user's hint matches the speaker name we're showing, it's
    // just "<name> mode".  Otherwise show the mapping so they know what just
    // happened (e.g. "codex mode (gpt → codex)").
    const hintLower = rawHint.toLowerCase();
    const speakerLower = speaker.name.toLowerCase();
    const subtitle =
      hintLower === speakerLower || hintLower === resolvedId.toLowerCase()
        ? `${speaker.name} mode`
        : `${speaker.name} mode (${rawHint} → ${speaker.name})`;
    append({ kind: 'mode-switch', targetMode: 'work', speaker, subtitle });
    setMode('work');
    modeRef.current = 'work';
    return true;
  };

  // Save a detected key to providers.json and append a confirmation banner.
  // Used by both the explicit awaitingKey flow ("add a key" + paste) and the
  // bare-paste confirm flow (paste + "yes").  Preserves any existing
  // entry's customizations (defaultModel, custom name, etc.) so a key
  // update doesn't clobber the user's model choice.
  const persistKey = async (
    key: string,
    template: ProviderTemplate
  ): Promise<void> => {
    await saveKeyPreservingEntry(key, template);
    append({
      kind: 'info',
      text: `✓ saved ${template.name} (${template.id}) — key ${maskApiKey(key)}. use it: "use ${template.id}" or just "${template.id}".`,
    });
  };

  // Try fuzzy matching for a hint that didn't resolve exactly.  Returns
  // 'routed' when we either switched, asked for confirmation, or surfaced an
  // ambiguous-match message — in all three cases the caller should NOT fall
  // through to the LLM.  Returns 'noop' when no candidate is within fuzzy
  // range (so e.g. "what's up" continues to the LLM).
  const tryFuzzyRoute = async (
    name: string,
    rest: string
  ): Promise<'routed' | 'noop'> => {
    // Skip fuzzy for short inputs and common affirmative/negative tokens.
    // Threshold raised to 5 chars after a real user incident: "open" (4
    // chars) kept fuzzy-matching to "openai" every time the user typed
    // "open the browser" — pure false positive.  Real provider names
    // and aliases are all ≥5 chars (deepseek, anthropic, openai, gemini,
    // mistral, claude, codestral) so this loses nothing.
    if (name.length < 5) return 'noop';
    if (isAffirmative(name) || isNegative(name)) return 'noop';
    const fuzzy = await fuzzyResolveProviderHint(name);
    if (fuzzy.length === 0) return 'noop';
    // Session-rejected-mapping guard: if the user already said "no" to
    // "did you mean X?" for this exact input, don't ask again.  Routes
    // through to whatever the next intent parser wants.
    const rejKey = `${name.toLowerCase()}:${fuzzy.map((c: FuzzyMatch) => c.id).join(',')}`;
    if (rejectedFuzzyRef.current.has(rejKey)) return 'noop';
    if (fuzzy.length > 1) {
      const ids = fuzzy.map((c: FuzzyMatch) => c.id).join(', ');
      append({
        kind: 'info',
        text: `multiple close matches: ${ids}. type one to switch.`,
      });
      return 'routed';
    }
    const m = fuzzy[0]!;
    // Distance-2 typos on short inputs (≤5 chars) ask first to dodge
    // false-positive frustration on common typos like "openi" / "gimini".
    const askFirst = m.distance === 2 && name.length <= 5;
    if (askFirst) {
      pendingFuzzyRef.current = { id: m.id, rest, sourceKey: rejKey };
      append({
        kind: 'info',
        text: `did you mean "${m.id}"? (yes / no)`,
      });
      return 'routed';
    }
    const entry = await resolveConfigured(m.id);
    if (!entry) {
      append({
        kind: 'info',
        text: `did you mean "${m.id}"? — not configured yet (run mod8 keys set ${m.id}).`,
      });
      return 'routed';
    }
    append({
      kind: 'info',
      text: `routing to ${m.id} — did you mean that?`,
    });
    const ok = await switchToWorkProvider(m.id, `${m.id} mode`);
    if (!ok) return 'noop';
    if (rest) await sendMessage(rest, 'work');
    return 'routed';
  };

  const handleSubmit = async (rawValue: string) => {
    const raw = rawValue.trim();
    if (!raw) return;
    setInput('');

    // Image paste — if the user pasted ONLY a path to an image (typical
    // macOS screenshot copy-paste behavior), buffer the image and let
    // the user describe what they want done with it in their next msg.
    // Runs BEFORE every other parser so a pasted path doesn't accidentally
    // get routed as a provider name or a host-back trigger.
    if (!streaming) {
      const img = await detectImagePaste(raw, process.cwd());
      if (img) {
        pendingImageRef.current = img;
        append({
          kind: 'info',
          text:
            `📎 attached ${img.name} (${formatImageBytes(img.bytes)}) — ` +
            `it will be sent with your next message. Tell ${
              modeRef.current === 'host' ? 'mod8' : speakerForMode('work').name
            } what to look at.`,
        });
        return;
      }
    }

    // Mid-stream handoff: if a turn is streaming and the user types a
    // handoff gesture, abort the current provider and kick off the same
    // task on a different one.  Recognises:
    //   /handoff <provider>     ·  /switch <provider>
    //   @<provider> take over   ·  @<provider> continue
    //   handoff to <provider>
    if (streaming) {
      const handoffTarget = parseHandoff(raw);
      if (handoffTarget) {
        const resolvedId = await resolveProviderHint(handoffTarget);
        if (resolvedId) {
          // Abort the current turn — same as pressing esc, but we then
          // restart on the new provider instead of dropping back to idle.
          if (aborterRef.current) {
            aborterRef.current.abort();
            aborterRef.current = null;
          }
          setStreaming(false);
          setStreamedText('');
          setActiveTool(null);
          setAgentPlan(null);
          const previousName = speakerForMode('work').name;
          append({
            kind: 'info',
            text: `↻ handing off from ${previousName} to ${resolvedId}…`,
          });
          // Switch + auto-fire the continuation in the next microtask so
          // the abort settles cleanly before the new turn boots.
          setTimeout(() => {
            void (async () => {
              const ok = await switchToWorkProvider(resolvedId, `${resolvedId} mode`);
              if (!ok) return;
              await sendMessage(
                `You are taking over from ${previousName} mid-task. The transcript above shows their progress (tool calls, files written). Continue from where they left off — check the session write ledger before writing anything, do NOT recreate files they already produced. Use edit_file for any revisions.`,
                'work'
              );
            })();
          }, 50);
          return;
        }
        append({
          kind: 'error',
          text: `unknown handoff target "${handoffTarget}". Try /providers to see configured ones.`,
        });
        return;
      }
    }

    // Queue-while-busy: if a turn is currently streaming, capture the
    // user's message and drain it after the current turn finishes.  Two
    // exceptions that bypass the queue and run immediately:
    //   - /exit  → user wants to quit RIGHT NOW
    //   - /clear → harmless and useful as an "abort everything" gesture
    if (streaming && raw !== '/exit' && raw !== '/quit' && raw !== '/clear') {
      queuedRef.current = [...queuedRef.current, raw];
      setQueuedMessages([...queuedRef.current]);
      return;
    }

    // === STATE HANDLERS (run on RAW; key detection requires it) ===========

    // 1. Awaiting explicit paste-key — armed after "add a key" / "let me add
    //    gemini" / etc.  Next message: detect+save the key.
    if (awaitingKeyRef.current) {
      awaitingKeyRef.current = false;
      if (parseHostBack(raw)) {
        // fall through to host-back dispatch below
      } else {
        const found = findApiKey(raw);
        if (found) {
          await persistKey(found.key, found.template);
          return;
        }
        if (isNegative(raw)) {
          append({ kind: 'info', text: 'cancelled — no key saved.' });
          return;
        }
        append({
          kind: 'info',
          text:
            "that doesn't look like a known key format. want to try again, " +
            'or use `mod8 add-provider` for a custom provider?',
        });
        return;
      }
    }

    // 2. Pending bare-paste confirm — armed when the user pasted a key
    //    without the "add a key" preamble.  Confirm → save; negative →
    //    discard; anything else → discard + fall through (don't trap).
    if (pendingKeyRef.current) {
      const cached = pendingKeyRef.current;
      pendingKeyRef.current = null;
      if (isPasteConfirmAffirmative(raw)) {
        await persistKey(cached.rawKey, cached.template);
        return;
      }
      if (isNegative(raw)) {
        append({ kind: 'info', text: 'cancelled — discarded the key.' });
        return;
      }
      // Any other input (including parseHostBack matches) cancels the paste
      // silently and falls through to the regular dispatch.  No trap.
      append({ kind: 'info', text: 'cancelled — discarded the key.' });
    }

    // 3. Pending fuzzy confirm — "did you mean google?" follow-up.
    if (pendingFuzzyRef.current) {
      const cached = pendingFuzzyRef.current;
      pendingFuzzyRef.current = null;
      if (isAffirmative(raw)) {
        const ok = await switchToWorkProvider(cached.id, `${cached.id} mode`);
        if (ok && cached.rest) await sendMessage(cached.rest, 'work');
        return;
      }
      if (isNegative(raw)) {
        // Remember the rejection so we don't ask the same question again
        // for the same input → candidate pair this session.
        if (cached.sourceKey) rejectedFuzzyRef.current.add(cached.sourceKey);
        append({ kind: 'info', text: 'cancelled.' });
        return;
      }
      // Any other input cancels and falls through.
      if (cached.sourceKey) rejectedFuzzyRef.current.add(cached.sourceKey);
    }

    // === BARE-PASTE AUTO-DETECT (host mode, raw input) ====================
    // If the user pastes a recognizable key without first saying "add a key",
    // surface it as a save prompt instead of letting the host LLM lecture
    // about `mod8 keys set <id>`.  Host mode only — work mode shouldn't
    // intercept turns the user might intend for the worker.
    if (modeRef.current === 'host') {
      const found = findApiKey(raw);
      if (found) {
        pendingKeyRef.current = { rawKey: found.key, template: found.template };
        append({
          kind: 'info',
          text: `I see ${found.template.name} key ${maskApiKey(found.key)}. Save it as \`${found.template.id}\`? (yes / no)`,
        });
        return;
      }
    }

    // Sanitize from here on so an API key in the input never reaches the
    // transcript / session JSON / LLM context.  Idempotent — double-applying
    // is a no-op.
    const value = sanitizeKeys(raw);

    if (value === '/exit' || value === '/quit') {
      exit();
      return;
    }

    if (value === '/clear') {
      await clearSessionHistory(sessionRef.current);
      titleGenerationStartedRef.current = false;
      setTranscript([]);
      setLastUsage(null);
      ledgerRef.current.clear();
      toolCallCountsRef.current.clear();
      sessionTopicRef.current = {
        currentTopic: null,
        recommendedFor: new Set(),
        userOverrode: false,
      };
      return;
    }

    if (value === '/providers') {
      await listProvidersInChat(append);
      return;
    }

    // Truth-source commands — pure mechanical, NO llm call.  Designed so
    // the user can always answer "what's actually been built?" without
    // depending on an agent's possibly-stale memory.
    if (value === '/files' || value === '/built') {
      const records = ledgerRef.current.list();
      if (records.length === 0) {
        append({
          kind: 'info',
          text:
            'no files recorded in this session yet. ' +
            'use /status to scan disk for the project layout, or just look in your editor.',
        });
        return;
      }
      const now = Date.now();
      const fmtAgo = (ms: number) => {
        const s = Math.floor(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m`;
        return `${Math.floor(m / 60)}h`;
      };
      const lines = records.map((r) => {
        const ago = fmtAgo(now - r.writtenAt);
        const dup = r.count > 1 ? ` ⚠${r.count}×` : '';
        return `  ${r.path}  ${r.bytes}b  ${ago} ago  ${r.byProvider}${dup}`;
      });
      append({
        kind: 'info',
        text:
          `files written this session (${records.length} total):\n` +
          lines.join('\n'),
      });
      return;
    }

    if (value === '/status') {
      const records = ledgerRef.current.list();
      const fileSummary =
        records.length === 0
          ? 'no files written this session yet'
          : `${records.length} files written this session (use /files for the list)`;
      const turnCount = sessionRef.current.messages.length;
      const last = lastUsage
        ? ` · last turn: ${lastUsage.inputTokens.toLocaleString()} input tokens (${lastUsage.model}, ${lastUsage.mode} mode)`
        : '';
      append({
        kind: 'info',
        text:
          `mod8 status:\n` +
          `  mode: ${mode}${mode === 'work' ? ` (${workProviderId})` : ''}\n` +
          `  turns: ${turnCount}\n` +
          `  ${fileSummary}${last}\n` +
          `  cwd: ${process.cwd()}`,
      });
      return;
    }

    if (isCompareCommand(value)) {
      append({
        kind: 'info',
        text: '— compare needs a follow-up prompt. usage: "compare all: <prompt>"',
      });
      return;
    }
    const comparePayload = parseCompareWithPrompt(value);
    if (comparePayload) {
      await runCompareTurn(comparePayload);
      return;
    }

    // Client-side open-browser interceptor.  Runs BEFORE every routing
    // parser and BEFORE any LLM call.  We do this client-side because the
    // model-side open_url tool keeps getting refused across providers
    // (DeepSeek consistently, Claude/Codex/Gemini intermittently after the
    // 0.5.27 system-prompt hardening) — no amount of "use this tool" prose
    // is enough.  Pattern detection on the input is rock-solid in
    // comparison: if the user said "open the browser", we open it.
    const openIntent = parseOpenBrowser(value);
    if (openIntent) {
      const url =
        openIntent.explicitUrl ?? findRecentUrl(sessionRef.current.messages);
      if (!url) {
        append({
          kind: 'info',
          text:
            "I don't have a URL to open. Either paste one (e.g. " +
            '"open http://localhost:5173") or start your dev server first ' +
            'and try again.',
        });
        return;
      }
      const r = await openInBrowser(url);
      append({ kind: 'info', text: r.msg });
      return;
    }

    // Switch-back to host runs BEFORE provider routing AND before any LLM
    // call, so users are never trapped when the current work-mode provider
    // is failing.  In work mode it's the escape hatch; in host mode it's a
    // graceful no-op (user is already there).  Either way, parseHostBack
    // input never reaches the work provider.
    const currentMode = modeRef.current;
    const back = parseHostBack(value);
    if (back) {
      if (currentMode === 'work') {
        append({
          kind: 'mode-switch',
          targetMode: 'host',
          speaker: HOST_SPEAKER,
          subtitle: 'host mode',
        });
        setMode('host');
        modeRef.current = 'host';
        consecutiveWorkErrorsRef.current = 0;
        setLastWorkError(null);
        await resetWorkToDefault();
        if (back.rest) await sendMessage(back.rest, 'host');
        return;
      }
      // Already in host — no-op with info, but still forward any inline rest
      // ("mod8 thanks for the help" → send "thanks for the help" to host).
      if (back.rest) {
        await sendMessage(back.rest, 'host');
      } else {
        append({ kind: 'info', text: "you're already in mod8 host." });
      }
      return;
    }

    // Inline paste-key flow.  "add a key" / "let me add gemini" / "i wanna
    // paste my anthropic key" → consent line + arm awaitingKey for the next
    // turn.  Runs in host mode only — work mode is for the worker, not for
    // mod8 config (and the user should mod8-back first anyway).
    if (currentMode === 'host') {
      const paste = parsePasteKeyIntent(value);
      if (paste) {
        let resolvedHint: string | null = null;
        if (paste.providerHint) {
          resolvedHint = await resolveProviderHint(paste.providerHint);
        }
        const triggerConsent = !paste.providerHint || resolvedHint;
        if (triggerConsent) {
          awaitingKeyRef.current = true;
          const target = resolvedHint ? ` (${resolvedHint})` : '';
          // Use a fake-but-realistic sample so the user sees the actual mask
          // shape they'll get, not a hand-written approximation.
          const sample = maskApiKey('sk-ant-EXAMPLEFAKEKEYNOTREAL00000');
          append({
            kind: 'info',
            text:
              `Sure — paste your API key${target} in your next message. ` +
              `It's safe: the key is saved locally and masked in this chat ` +
              `(you'll see it as ${sample}, not the full key). Nobody else sees it.`,
          });
          return;
        }
      }
    }

    // Provider routing: "use deepseek" / "ask grok" / "switch to mistral"
    const route = parseProviderRoute(value);
    if (route) {
      // Try exact resolution first; if unknown, fuzzy-match before erroring.
      // "use gimini" → "did you mean google?" instead of "unknown provider".
      const exact = await resolveProviderHint(route.id);
      if (exact) {
        const ok = await switchToWorkProvider(route.id, `${route.id} mode`);
        if (!ok) return;
        if (route.rest) await sendMessage(route.rest, 'work');
        return;
      }
      const fuzzed = await tryFuzzyRoute(route.id, route.rest);
      if (fuzzed === 'routed') return;
      // No real provider match — "use shadcn" / "use tailwind" are library
      // references, not chat commands. Fall through to the LLM.
    }

    // Bare-name / first-word / greeting: catch "codex", "hi codex",
    // "codex tell me a joke" — anything where the user names a configured
    // provider without a "use/ask/talk" verb. Strict resolution prevents
    // false positives ("haiku", "claude alone is great" don't route).
    const bare = parseBareProviderHint(value);
    if (bare) {
      const resolved =
        bare.resolution === 'strict'
          ? await strictResolveProviderHint(bare.name)
          : await resolveProviderHint(bare.name);
      if (resolved) {
        const ok = await switchToWorkProvider(bare.name, `${bare.name} mode`);
        if (!ok) return;
        if (bare.rest) await sendMessage(bare.rest, 'work');
        return;
      }
      // Exact lookup failed — try fuzzy.  If even fuzzy returns nothing, we
      // fall through to the LLM (the bare name was probably normal English).
      const fuzzed = await tryFuzzyRoute(bare.name, bare.rest);
      if (fuzzed === 'routed') return;
      // Not a real provider, not a near-typo — fall through to LLM.
    }

    await sendMessage(value, currentMode);
  };

  const sendMessage = async (text: string, currentMode: Mode) => {
    const userSpeaker = speakerForMode(currentMode);
    sessionRef.current.messages.push({ role: 'user', content: text, mode: currentMode });
    append({ kind: 'user', text, mode: currentMode, speaker: userSpeaker });
    persist();

    // Topic-aware comparison panel — only fires in WORK mode when the
    // subject of the work genuinely shifts (not on every prompt).  Shows
    // the full 4-provider comparison (Speed / $/turn / Code / Performance
    // / Why) so the user can pick instead of guessing.  Stays silent
    // when:
    //   - user has explicitly overridden ("use X" / handoff)
    //   - new prompt is a ride-along category (bug-fix/test/docs)
    //   - new topic matches the current session topic
    //   - we've already shown the panel for this topic this session
    if (currentMode === 'work' && !sessionTopicRef.current.userOverrode) {
      const topic = classifyTopic(text);
      const prev = sessionTopicRef.current.currentTopic;
      const sameAsCurrent = prev === topic;
      if (!isRideAlong(topic) && !sameAsCurrent) {
        const alreadyShownThisTopic =
          sessionTopicRef.current.recommendedFor.has(topic);
        if (!alreadyShownThisTopic) {
          const configured = await configuredProviderIds();
          const comp = comparisonFor(topic, configured, prefsRef.current);
          if (comp) {
            append({
              kind: 'info',
              text: renderComparison(comp, workIdRef.current),
            });
            sessionTopicRef.current.recommendedFor.add(topic);
          }
        }
      }
      if (!isRideAlong(topic)) {
        sessionTopicRef.current.currentTopic = topic;
      }
    }

    setStreaming(true);
    setStreamedText('');
    setStreamStart(Date.now());

    const ctrl = new AbortController();
    aborterRef.current = ctrl;

    let collected = '';
    let usage: StreamUsage | undefined;
    let aborted = false;
    let errored = false;

    const apiMessages: Array<{ role: string; content: unknown }> =
      sessionRef.current.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

    // Splice the pending pasted image (if any) into the LATEST user
    // message as a multimodal content part.  The session file keeps the
    // text-only version (images aren't persisted across sessions yet),
    // so this only affects what gets sent to the model THIS turn.
    if (pendingImageRef.current && apiMessages.length > 0) {
      const img = pendingImageRef.current;
      for (let i = apiMessages.length - 1; i >= 0; i--) {
        if (apiMessages[i]!.role === 'user') {
          const existingText =
            typeof apiMessages[i]!.content === 'string'
              ? (apiMessages[i]!.content as string)
              : '';
          apiMessages[i]!.content = [
            { type: 'image', image: img.base64, mediaType: img.mediaType },
            ...(existingText ? [{ type: 'text', text: existingText }] : []),
          ];
          break;
        }
      }
      pendingImageRef.current = null;
    }

    const providerId = currentMode === 'host' ? HOST_PROVIDER_ID : workIdRef.current;
    const model = currentMode === 'host'
      ? HOST_MODEL
      : (workEntryRef.current?.defaultModel ?? DEFAULT_WORK_MODEL);
    const workSpeakerNow = workSpeakerFromEntry(providerId, workEntryRef.current);
    // Speaker that owns the agent loop in the CURRENT turn — host or work.
    // Used for tool-call display, ledger attribution, and error messages
    // so a host-mode list_dir doesn't show up as a "claude" action.
    const agentSpeakerNow = currentMode === 'host' ? HOST_SPEAKER : workSpeakerNow;
    // Work mode runs the agent runtime (file edit / shell / diff tools) when
    // the provider has a Vercel AI SDK client.  Other providers (groq, xai,
    // openrouter, custom) keep the legacy text-only path.  Host mode ALSO
    // uses the agent path — but with a read-only tool set (list_dir,
    // read_file, grep) so mod8 can answer "show me the folder" inline
    // instead of theatrically handing off to claude.
    const useAgent = SDK_PROVIDER_IDS.includes(providerId);
    // Re-read the project context file on every turn so edits to
    // `.mod8/context.md` mid-session take effect immediately (one tiny
    // file read per turn is negligible).
    let agentProjectContext: string | undefined;
    let agentProjectContextSource: string | undefined;
    if (useAgent) {
      const ctxResult = await readProjectContext(process.cwd());
      if (ctxResult.kind === 'found') {
        agentProjectContext = shapeProjectContextForProvider(
          ctxResult.ctx,
          providerId,
          model
        );
        agentProjectContextSource = ctxResult.ctx.foundAt;
      }
    }

    // Bug 1 fix: rebuild the host system prompt with FRESH provider context
    // on every turn.  When the user adds a key inline mid-session, the host
    // can immediately answer "do I have google configured?" correctly —
    // otherwise the prompt is frozen at startup and the host lies.
    let system = currentMode === 'host'
      ? buildHostSystem(await readHostContext())
      : useAgent
      ? buildAgentSystemPrompt({
          cwd: process.cwd(),
          model,
          providerLabel: workSpeakerNow.name,
          ...(agentProjectContext !== undefined ? { projectContext: agentProjectContext } : {}),
          ...(agentProjectContextSource ? { projectContextSource: agentProjectContextSource } : {}),
        })
      : buildWorkSystem(workSpeakerNow.name);

    // Append the session write-ledger summary to BOTH host and work
    // system prompts.  Work-mode uses it to avoid rewrite loops; host-mode
    // uses it to answer "where are we?" with evidence instead of
    // hallucinating "nothing's built" (the bug that broke user trust).
    const ledgerSummary = ledgerRef.current.summary();
    if (ledgerSummary) {
      system = `${system}\n\n# Session write ledger\n\n${ledgerSummary}`;
    }

    // Track whether the agent path appended the final assistant item itself
    // (it flushes between tool calls, so the post-stream block must skip
    // re-appending).
    let agentDidFinalize = false;

    try {
      if (useAgent) {
        // Delegate the streamText/fullStream loop to src/runtime/runAgent.ts.
        // This file's job is to TRANSLATE RuntimeEvents into TranscriptItems
        // — not to drive the AI SDK.  Keeps the UI thin and the agent loop
        // testable in isolation.
        const resolved: ResolvedModel = {
          kind: providerId as ProviderKind,
          modelId: model,
          label: workSpeakerNow.name,
        };
        // Tag every proxy call with project + topic so the Projects
        // dashboard at mod8.ai can attribute spend per cwd.  Best-effort:
        // a slow disk read shouldn't block the turn, so we fall through
        // with no attribution on failure.
        let attribution: { projectId?: string; projectName?: string; topic?: string } = {};
        try {
          const info = await getProjectInfo(process.cwd());
          attribution = {
            projectId: info.projectId,
            projectName: info.projectName,
          };
          if (sessionTopicRef.current.currentTopic) {
            attribution.topic = sessionTopicRef.current.currentTopic;
          }
        } catch {
          /* attribution skipped — telemetry never blocks a turn */
        }
        const conn = await buildProviderModel(resolved, attribution);
        // Host mode gets a READ-ONLY tool set so it can answer "list the
        // folder" / "what's in this file" without bouncing to claude.  Work
        // mode keeps the full kit (read + write + edit + bash + plan).
        const tools = currentMode === 'host'
          ? buildHostInkTools({ cwd: process.cwd() })
          : buildInkTools({
              cwd: process.cwd(),
              ledger: ledgerRef.current,
              providerName: workSpeakerNow.name,
            });

        const flushText = () => {
          const cleaned = stripSwitchTokens(collected);
          if (!cleaned.trim()) {
            collected = '';
            setStreamedText('');
            return;
          }
          sessionRef.current.messages.push({
            role: 'assistant',
            content: cleaned,
            mode: currentMode,
          });
          append({
            kind: 'assistant',
            text: cleaned,
            mode: currentMode,
            speaker: agentSpeakerNow,
          });
          collected = '';
          setStreamedText('');
        };

        const callStart = Date.now();
        for await (const ev of runAgent({
          model: conn.model,
          system,
          messages: apiMessages.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          tools,
          maxSteps: MAX_AGENT_STEPS,
          signal: ctrl.signal,
        })) {
          if (ev.type === 'text-delta') {
            collected += ev.delta;
            setStreamedText(stripSwitchTokens(collected));
          } else if (ev.type === 'tool-call') {
            // Loop detector — abort the turn when the agent calls the
            // SAME tool with the SAME args 4+ times.  This is the
            // structural defense against the "list/read the same dir
            // forever" failure mode that broke user trust.  Plan tool
            // and write_file are exempt (plan is meta; write_file is
            // protected by the ledger already).
            if (ev.toolName !== 'plan' && ev.toolName !== 'write_file') {
              const inputStr = JSON.stringify(ev.input ?? {});
              const key = `${ev.toolName}:${inputStr}`;
              const count = (toolCallCountsRef.current.get(key) ?? 0) + 1;
              toolCallCountsRef.current.set(key, count);
              if (count >= 4) {
                if (aborterRef.current) {
                  aborterRef.current.abort();
                  aborterRef.current = null;
                }
                append({
                  kind: 'error',
                  text:
                    `⚠ loop detected — ${ev.toolName}(${inputStr.slice(0, 80)}` +
                    `${inputStr.length > 80 ? '…' : ''}) called ${count}× this turn. ` +
                    `Aborted to prevent runaway. Type /files to see what's actually on disk, ` +
                    `or tell ${workSpeakerNow.name} what's missing.`,
                });
                break;
              }
            }
            // The `plan` tool is meta: it sets the pinned goal banner
            // instead of appearing as a regular tool action.  Skip the
            // transcript append + active-tool indicator for it.
            if (ev.toolName === 'plan') {
              const input = ev.input as { goal?: unknown; steps?: unknown } | undefined;
              const goal = typeof input?.goal === 'string' ? input.goal.trim() : '';
              const stepEstimate =
                typeof input?.steps === 'number' && Number.isFinite(input.steps)
                  ? Math.max(1, Math.min(50, Math.round(input.steps)))
                  : null;
              if (goal) setAgentPlan({ goal, stepEstimate, stepCount: 0 });
              continue;
            }
            // Flush any streamed prose before the tool banner so the
            // transcript reads top-to-bottom: text → tool → result → text.
            flushText();
            const item = await computeToolCallItem(
              ev.toolName,
              ev.input,
              agentSpeakerNow,
              process.cwd()
            );
            append(item);
            // Light up the active-tool indicator until tool-result lands.
            setActiveTool({
              toolName: ev.toolName,
              detail: makeToolSummary(ev.toolName, ev.input),
              startedAt: Date.now(),
            });
            // Bump the step counter inside the pinned plan banner so the
            // user can see "step 4 of ~8".
            setAgentPlan((prev) =>
              prev ? { ...prev, stepCount: prev.stepCount + 1 } : prev
            );
          } else if (ev.type === 'tool-result') {
            if (ev.toolName === 'plan') continue;
            const preview = summarizeToolResult(ev.toolName, ev.output);
            append({
              kind: 'tool-result',
              speaker: agentSpeakerNow,
              toolName: ev.toolName,
              ok: ev.ok,
              preview,
            });
            // Tool is done — tear down the active indicator.
            setActiveTool(null);
          } else if (ev.type === 'finish') {
            usage = {
              inputTokens: ev.usage.inputTokens,
              outputTokens: ev.usage.outputTokens,
              latencyMs: Date.now() - callStart,
              model,
              costUsd: 0,
            };
          } else if (ev.type === 'error') {
            // Surface the error to the existing catch block so the
            // post-stream error UI + auto-fallback both still run.
            throw ev.error;
          }
        }
        // Flush trailing text as the final assistant message.
        flushText();
        agentDidFinalize = true;
      } else {
        // Generic non-SDK path: only text turns are supported here, so we
        // strip any multimodal content parts down to their text component.
        // Image attachments are silently dropped — providers using this
        // path don't expose a multimodal API.
        const textOnlyMessages = apiMessages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content:
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
              ? m.content
                  .filter((p): p is { type: 'text'; text: string } =>
                    typeof p === 'object' &&
                    p !== null &&
                    (p as { type?: unknown }).type === 'text'
                  )
                  .map((p) => p.text)
                  .join('\n')
              : String(m.content ?? ''),
        }));
        for await (const event of streamProviderChat({
          providerId,
          system,
          messages: textOnlyMessages,
          model,
          signal: ctrl.signal,
        })) {
          if (event.type === 'text') {
            collected += event.delta;
            setStreamedText(stripSwitchTokens(collected));
          } else if (event.type === 'done') {
            usage = event.usage;
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        aborted = true;
      } else {
        errored = true;
        if (!collected) sessionRef.current.messages.pop();
        // Diagnose the error per-kind and surface a structured explanation:
        // short summary (with HTTP code + quoted raw message) → long fixes,
        // then the auto-fallback path uses the kind-aware suggestion line.
        const explained = explainError(err, providerId);
        append({ kind: 'error', text: explained.short });
        if (explained.long) append({ kind: 'info', text: explained.long });
        persist();

        // Work-mode-only: track consecutive failures, advise user, and
        // auto-fallback to host after AUTO_FALLBACK_THRESHOLD errors so the
        // user is never stuck unable to escape a broken provider.
        if (currentMode === 'work') {
          // Context-too-long is a SIZE problem, not a provider problem.
          // Don't burn a consecutive-error slot — instead, look for the
          // biggest-window configured provider and switch silently.  The
          // user re-sends the same message and it lands somewhere it
          // actually fits.  (We can't auto-replay the turn because any
          // pasted image was already consumed from pendingImageRef and
          // we don't want to fabricate a retry.)
          if (explained.kind === 'context-too-long') {
            const currentWindow = contextWindowFor(model);
            const configured = await configuredProviderIds();
            const candidates: Array<{
              id: string;
              window: number;
              entry: ProviderEntry;
            }> = [];
            for (const id of configured) {
              if (id === providerId) continue;
              const entry = await resolveEntryWithProxyFallback(id);
              if (!entry) continue;
              const w = contextWindowFor(entry.defaultModel);
              if (w <= currentWindow) continue;
              candidates.push({ id, window: w, entry });
            }
            if (candidates.length > 0) {
              candidates.sort((a, b) => b.window - a.window);
              const best = candidates[0]!;
              const speaker = workSpeakerFromEntry(best.id, best.entry);
              const fmtWindow = (n: number): string =>
                n >= 1_000_000
                  ? `${(n / 1_000_000).toFixed(1)}M`
                  : `${(n / 1000).toFixed(0)}k`;
              append({
                kind: 'info',
                text:
                  `→ Auto-handoff: this turn was too big for ${providerId} ` +
                  `(${fmtWindow(currentWindow)} window). Switched to ` +
                  `${speaker.name} (${fmtWindow(best.window)} window). ` +
                  `Re-send your last message — it'll fit.`,
              });
              setWorkProviderId(best.id);
              workIdRef.current = best.id;
              workEntryRef.current = best.entry;
              setWorkEntry(best.entry);
              append({
                kind: 'mode-switch',
                targetMode: 'work',
                speaker,
                subtitle: `${speaker.name} mode (auto-handoff: bigger window)`,
              });
              // Don't count toward consecutive errors — the user didn't
              // see a real failure, they saw a smart switch.  Skipping the
              // counter chain below lets streaming-cleanup at the function
              // tail still run normally.
              consecutiveWorkErrorsRef.current = 0;
              setLastWorkError(null);
              // Use a sentinel so the normal counter chain below is
              // skipped without skipping the UI-cleanup tail.
              (err as Record<symbol, unknown>)[Symbol.for('mod8.handed')] = true;
            }
            // No bigger-window provider configured — fall through to the
            // normal error path so the user at least sees the explanation.
          }

          if (!((err as Record<symbol, unknown>)[Symbol.for('mod8.handed')])) {
            const speakerName = workSpeakerFromEntry(providerId, workEntryRef.current).name;
            consecutiveWorkErrorsRef.current += 1;
            setLastWorkError(explained.short);

            const decision = fallbackDecision(consecutiveWorkErrorsRef.current);
            if (decision === 'fallback') {
              append({
                kind: 'info',
                text: `${speakerName} has been failing (${consecutiveWorkErrorsRef.current} errors in a row) — switching you back to mod8 host. ${explained.suggestion}`,
              });
              append({
                kind: 'mode-switch',
                targetMode: 'host',
                speaker: HOST_SPEAKER,
                subtitle: 'host mode',
              });
              setMode('host');
              modeRef.current = 'host';
              consecutiveWorkErrorsRef.current = 0;
              setLastWorkError(null);
              await resetWorkToDefault();
            } else if (decision === 'warn') {
              append({
                kind: 'info',
                text: `tip: ${explained.suggestion}`,
              });
            }
          }
        }
      }
    } finally {
      aborterRef.current = null;
    }

    if (!errored) {
      // Successful turn — reset error tracking for work mode.
      if (currentMode === 'work') {
        consecutiveWorkErrorsRef.current = 0;
        if (lastWorkError !== null) setLastWorkError(null);
        // Personalization: tally THIS (topic, provider) pick so the next
        // comparison panel reflects the user's actual habits.  We only
        // count work-mode turns on non-ride-along topics — ride-along
        // categories (bug-fix/tests/docs) don't carry a topic signal,
        // and host-mode turns aren't a "provider choice" by the user.
        const topicNow = sessionTopicRef.current.currentTopic;
        if (topicNow && !isRideAlong(topicNow)) {
          const pickedProvider = workIdRef.current;
          void recordPick(topicNow, pickedProvider).then(() =>
            loadPrefs().then((p) => {
              prefsRef.current = p;
            })
          );
        }
      }

      const switchTo = detectSwitch(collected, currentMode);
      const cleaned = stripSwitchTokens(collected);

      // Agent path already pushed + appended its assistant chunks (between
      // tool calls).  Don't re-append the same text — that would duplicate
      // the final message and break the visual flow.
      if (!agentDidFinalize) {
        if (cleaned) {
          sessionRef.current.messages.push({
            role: 'assistant',
            content: cleaned,
            mode: currentMode,
            stats: usage,
            aborted,
          });
        }
        append({
          kind: 'assistant',
          text: cleaned,
          mode: currentMode,
          speaker: speakerForMode(currentMode),
          stats: usage,
          aborted,
        });
      }

      if (switchTo && !aborted) {
        // Resetting BEFORE deriving the target speaker matters: if the host
        // emitted <SWITCH_TO_WORK>, the work mode must land on the default
        // (claude), not whatever provider was last selected.  That way the
        // host's spoken text ("handing you off to claude") matches the
        // banner ("switching to claude (work mode)") instead of contradicting
        // it (the bug where banner showed "codex").
        if (switchTo === 'work' && currentMode === 'host') {
          await resetWorkToDefault();
        }
        const targetSpeaker =
          switchTo === 'host' ? HOST_SPEAKER : workSpeakerFromEntry(workIdRef.current, workEntryRef.current);
        append({
          kind: 'mode-switch',
          targetMode: switchTo,
          speaker: targetSpeaker,
          subtitle: switchTo === 'host' ? 'host mode' : 'work mode',
        });
        setMode(switchTo);
        modeRef.current = switchTo;
        if (switchTo === 'host') {
          await resetWorkToDefault();
        }

        // Auto-kickoff work mode after a host→work handoff.  The user
        // already typed "go" (or equivalent) to mod8; without this, the
        // banner flips and then NOTHING happens — claude sits idle
        // waiting for the user to type AGAIN.  Fire a synthetic begin
        // prompt so claude reads the conversation history and starts
        // working immediately.  Skipped when the user has already queued
        // a follow-up — their explicit message wins.
        if (
          switchTo === 'work' &&
          currentMode === 'host' &&
          queuedRef.current.length === 0
        ) {
          setTimeout(() => {
            void sendMessage(
              'Begin — read the conversation above and start working. Only ask a clarifying question if absolutely necessary.',
              'work'
            );
          }, 250);
        }
      }

      persist();
      maybeGenerateTitle();
    }

    setStreaming(false);
    setStreamedText('');
    setActiveTool(null);
    setAgentPlan(null);
    toolCallCountsRef.current.clear();

    // Snapshot input-token usage so the context bar updates between turns.
    // Input tokens approximate the entire conversation + system + tools
    // sent to the model — i.e. how full the window is.
    if (usage) {
      setLastUsage({
        inputTokens: usage.inputTokens,
        model: usage.model,
        mode: currentMode,
      });
    }

    // Drain the next queued message (if any).  We hop through setTimeout
    // so React paints the "streaming=false" state first — otherwise the
    // queue indicator flickers and the new turn appears to start before
    // the previous one visibly ended.
    if (queuedRef.current.length > 0) {
      const next = queuedRef.current.shift()!;
      setQueuedMessages([...queuedRef.current]);
      setTimeout(() => void handleSubmit(next), 0);
    }
  };

  const runCompareTurn = async (prompt: string) => {
    let ids: string[];
    const auth = await readAuth();
    if (auth) {
      // Proxy mode — all four built-in providers are live, plus any local
      // custom providers that don't route through the proxy (mistral, groq,
      // openrouter, xai, custom).
      const local = await configuredProviderIds();
      const customLocal = local.filter((id) => !(PROXY_PROVIDER_IDS as readonly string[]).includes(id));
      ids = [...PROXY_PROVIDER_IDS, ...customLocal];
    } else {
      ids = await configuredProviderIds();
      // Include any legacy providers with env keys.
      for (const legacy of ['anthropic', 'openai', 'google'] as const) {
        if (!ids.includes(legacy)) {
          const env = await resolveConfigured(legacy);
          if (env) ids.push(legacy);
        }
      }
    }
    if (ids.length === 0) {
      append({
        kind: 'error',
        text: 'no providers configured — run mod8 login (recommended), or mod8 keys set <id>.',
      });
      return;
    }
    setStreaming(true);
    setStreamStart(Date.now());

    const settled = await Promise.allSettled(
      ids.map(async (id) => {
        const client = await getProviderClient(id);
        return client.call(prompt);
      })
    );

    const blocks: CompareBlock[] = await Promise.all(
      ids.map(async (id, i) => {
        const entry = await resolveConfigured(id);
        const speaker = workSpeakerFromEntry(id, entry);
        const s = settled[i]!;
        if (s.status === 'fulfilled') {
          return {
            id,
            name: speaker.name,
            color: speaker.color,
            ok: true,
            text: s.value.text.trimEnd(),
            stats: {
              inputTokens: s.value.inputTokens,
              outputTokens: s.value.outputTokens,
              latencyMs: s.value.latencyMs,
              model: s.value.model,
              costUsd: s.value.costUsd,
            },
          };
        }
        return {
          id,
          name: speaker.name,
          color: speaker.color,
          ok: false,
          error: classifyError(s.reason, id),
        };
      })
    );

    setStreaming(false);
    append({ kind: 'compare', results: blocks });
  };

  type StaticEntry = { kind: 'welcome'; id: 'welcome' } | TranscriptItem;
  const staticItems: StaticEntry[] = [
    { kind: 'welcome', id: 'welcome' },
    ...transcript,
  ];

  const inputSpeaker = mode === 'host' ? HOST_SPEAKER : workSpeakerFromEntry(workProviderId, workEntry);

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(item) =>
          item.kind === 'welcome' ? (
            <Welcome key="welcome" />
          ) : (
            <MessageView key={item.id} item={item} />
          )
        }
      </Static>

      {streaming && streamedText.length > 0 && (
        <Box marginTop={1}>
          <SpeakerBlock speaker={inputSpeaker} body={streamedText} />
        </Box>
      )}

      {streaming && agentPlan && (
        <PlanBanner speaker={inputSpeaker} plan={agentPlan} />
      )}

      {streaming && activeTool && (
        <ActiveToolIndicator
          speaker={inputSpeaker}
          toolName={activeTool.toolName}
          detail={activeTool.detail}
          startedAt={activeTool.startedAt}
        />
      )}

      {streaming && !activeTool && (
        <ThinkingIndicator speaker={inputSpeaker} startedAt={streamStart} />
      )}

      <Box marginTop={1}>
        <InputBox
          speaker={inputSpeaker}
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          busy={streaming}
        />
      </Box>

      {queuedMessages.length > 0 && (
        <Box paddingX={1} flexDirection="column">
          <Text dimColor>
            {`  ↓  ${queuedMessages.length} queued — will send when current turn finishes:`}
          </Text>
          {queuedMessages.map((msg, i) => {
            // Truncate long messages so they don't blow up the layout.
            const preview = msg.length > 100 ? msg.slice(0, 97) + '...' : msg;
            return (
              <Box key={`${i}-${msg.slice(0, 12)}`}>
                <Text dimColor>{`     ${i + 1}. `}</Text>
                <Text color={inputSpeaker.color}>{preview}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      <StatusLine
        speaker={inputSpeaker}
        errorTag={mode === 'work' ? lastWorkError : null}
      />

      {lastUsage && <ContextBar usage={lastUsage} />}
    </Box>
  );
}

async function listProvidersInChat(append: (item: AppendItem) => void): Promise<void> {
  const auth = await readAuth();
  const localIds = await configuredProviderIds();
  let ids: string[];
  if (auth) {
    const customLocal = localIds.filter(
      (id) => !(PROXY_PROVIDER_IDS as readonly string[]).includes(id)
    );
    ids = [...PROXY_PROVIDER_IDS, ...customLocal];
  } else {
    ids = localIds;
  }
  if (ids.length === 0) {
    append({
      kind: 'info',
      text: 'no providers configured. run mod8 login (recommended), or mod8 keys set <id>.',
    });
    return;
  }
  const lines = auth
    ? ['configured providers (via mod8 proxy):']
    : ['configured providers:'];
  for (const id of ids) {
    const entry = await resolveConfigured(id);
    if (!entry) {
      // Proxy-only provider with no local entry — print a stub from the
      // known templates so the user still sees the row.
      const tpl = templateById(id);
      if (tpl) {
        lines.push(`  ${id} — ${tpl.name} (${tpl.apiType}, ${tpl.defaultModel}) [proxy]`);
      }
      continue;
    }
    lines.push(`  ${id} — ${entry.name} (${entry.apiType}, ${entry.defaultModel})`);
  }
  lines.push('');
  lines.push('use one with: "use <id>" / "ask <id>" / "switch to <id>"');
  append({ kind: 'info', text: lines.join('\n') });
}

export interface RunChatOptions {
  fresh?: boolean;
  sessionId?: string;
}

export async function runChat(opts: RunChatOptions = {}): Promise<void> {
  // Resolve the session FIRST so that bad ids fail fast with a clear error,
  // even when the user hasn't configured an API key yet.
  let session: Session;
  if (opts.fresh) {
    session = await createSession();
  } else if (opts.sessionId) {
    const loaded = await loadSession(opts.sessionId);
    if (!loaded) {
      console.error(
        chalk.red('mod8: ') + `no session with id "${opts.sessionId}". try: mod8 list`
      );
      process.exit(1);
    }
    session = loaded;
  } else {
    const recent = await getMostRecentSession();
    session = recent ?? (await createSession());
  }

  // Host mode requires Anthropic — but proxy mode (mod8 login) covers it
  // through the hosted proxy, so the local-key gate only applies when not
  // logged in.  Check after session resolution so a bad id surfaces "no
  // session" instead of "missing key".
  const auth = await readAuth();
  if (!auth) {
    const hostEntry = await resolveConfigured(HOST_PROVIDER_ID);
    if (!hostEntry) {
      console.error(
        'mod8: No Anthropic key configured. Run: mod8 login (recommended), or mod8 keys set anthropic.'
      );
      process.exit(1);
    }
  }

  if (session.messages.length > 0) {
    const turnCount = session.messages.filter((m) => m.role === 'assistant').length;
    const turnLabel = turnCount === 1 ? '1 turn' : `${turnCount} turns`;
    console.log(
      chalk.dim(
        `resuming session ${session.id} from ${humanTimeAgo(session.lastActivity)} · ${turnLabel}`
      )
    );
  }

  if (process.env.MOD8_CHAT_DEBUG === '1') {
    console.error(
      `[debug] starting chat: session=${session.id}, messages=${session.messages.length}, pid=${process.pid}`
    );
  }

  render(<App session={session} />);
}
