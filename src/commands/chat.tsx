import { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useApp, useInput, Static } from 'ink';
import TextInput from 'ink-text-input';
import chalk from 'chalk';
import { streamProviderChat } from '../providers/genericChat.js';
import { getProviderClient } from '../providers/index.js';
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
import {
  parseProviderRoute,
  parseHostBack,
  parseBareProviderHint,
  isCompareCommand,
  parseCompareWithPrompt,
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

function InputBox({
  speaker,
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  speaker: Speaker;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={disabled ? 'gray' : speaker.color}
      paddingX={1}
    >
      <Text color={speaker.color}>{'›  '}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        focus={!disabled}
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
  const pendingFuzzyRef = useRef<{ id: string; rest: string } | null>(null);

  // Keep the work entry in sync whenever workProviderId changes.
  useEffect(() => {
    workIdRef.current = workProviderId;
    let cancelled = false;
    void resolveConfigured(workProviderId).then((entry) => {
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
    const defaultEntry = await resolveConfigured(DEFAULT_WORK_PROVIDER_ID);
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
      aborterRef.current.abort();
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
    const entry = await resolveConfigured(resolvedId);
    if (!entry) {
      append({
        kind: 'error',
        text: `${resolvedId} not configured. Run: mod8 keys set ${resolvedId} (or mod8 add-provider).`,
      });
      return false;
    }
    setWorkProviderId(resolvedId);
    workIdRef.current = resolvedId;
    workEntryRef.current = entry;
    setWorkEntry(entry);
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
    // Skip fuzzy for very short inputs and common affirmative/negative
    // tokens.  Without these guards, "go" / "ok" / "xyz" trigger
    // false-positive matches against built-in provider ids — too noisy.
    if (name.length < 4) return 'noop';
    if (isAffirmative(name) || isNegative(name)) return 'noop';
    const fuzzy = await fuzzyResolveProviderHint(name);
    if (fuzzy.length === 0) return 'noop';
    if (fuzzy.length > 1) {
      const ids = fuzzy.map((c: FuzzyMatch) => c.id).join(', ');
      append({
        kind: 'info',
        text: `multiple close matches: ${ids}. type one to switch.`,
      });
      return 'routed';
    }
    const m = fuzzy[0]!;
    // Distance-2 typos on short inputs (≤4 chars) ask first to dodge
    // false-positive frustration on common typos like "go" / "ok" / "no".
    const askFirst = m.distance === 2 && name.length <= 4;
    if (askFirst) {
      pendingFuzzyRef.current = { id: m.id, rest };
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
        append({ kind: 'info', text: 'cancelled.' });
        return;
      }
      // Any other input cancels and falls through.
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
      return;
    }

    if (value === '/providers') {
      await listProvidersInChat(append);
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
      if (!exact) {
        const fuzzed = await tryFuzzyRoute(route.id, route.rest);
        if (fuzzed === 'routed') return;
        // Zero fuzzy candidates — surface the original error.
        append({
          kind: 'error',
          text: `unknown provider "${route.id}". Try: /providers, or mod8 add-provider.`,
        });
        return;
      }
      const ok = await switchToWorkProvider(route.id, `${route.id} mode`);
      if (!ok) return;
      if (route.rest) await sendMessage(route.rest, 'work');
      return;
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

    setStreaming(true);
    setStreamedText('');
    setStreamStart(Date.now());

    const ctrl = new AbortController();
    aborterRef.current = ctrl;

    let collected = '';
    let usage: StreamUsage | undefined;
    let aborted = false;
    let errored = false;

    const apiMessages = sessionRef.current.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const providerId = currentMode === 'host' ? HOST_PROVIDER_ID : workIdRef.current;
    const model = currentMode === 'host'
      ? HOST_MODEL
      : (workEntryRef.current?.defaultModel ?? DEFAULT_WORK_MODEL);
    // Bug 1 fix: rebuild the host system prompt with FRESH provider context
    // on every turn.  When the user adds a key inline mid-session, the host
    // can immediately answer "do I have google configured?" correctly —
    // otherwise the prompt is frozen at startup and the host lies.
    const system = currentMode === 'host'
      ? buildHostSystem(await readHostContext())
      : buildWorkSystem(workSpeakerFromEntry(providerId, workEntryRef.current).name);

    try {
      for await (const event of streamProviderChat({
        providerId,
        system,
        messages: apiMessages,
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
    } finally {
      aborterRef.current = null;
    }

    if (!errored) {
      // Successful turn — reset error tracking for work mode.
      if (currentMode === 'work') {
        consecutiveWorkErrorsRef.current = 0;
        if (lastWorkError !== null) setLastWorkError(null);
      }

      const switchTo = detectSwitch(collected, currentMode);
      const cleaned = stripSwitchTokens(collected);

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
      }

      persist();
      maybeGenerateTitle();
    }

    setStreaming(false);
    setStreamedText('');
  };

  const runCompareTurn = async (prompt: string) => {
    const ids = await configuredProviderIds();
    // Include any legacy providers with env keys.
    for (const legacy of ['anthropic', 'openai', 'google'] as const) {
      if (!ids.includes(legacy)) {
        const env = await resolveConfigured(legacy);
        if (env) ids.push(legacy);
      }
    }
    if (ids.length === 0) {
      append({
        kind: 'error',
        text: 'no providers configured — run mod8 add-provider or mod8 keys set <id>.',
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

      {streaming && <ThinkingIndicator speaker={inputSpeaker} startedAt={streamStart} />}

      <Box marginTop={1}>
        <InputBox
          speaker={inputSpeaker}
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          disabled={streaming}
        />
      </Box>

      <StatusLine
        speaker={inputSpeaker}
        errorTag={mode === 'work' ? lastWorkError : null}
      />
    </Box>
  );
}

async function listProvidersInChat(append: (item: AppendItem) => void): Promise<void> {
  const ids = await configuredProviderIds();
  if (ids.length === 0) {
    append({
      kind: 'info',
      text: 'no providers configured. add one: mod8 add-provider, or mod8 keys set <id>.',
    });
    return;
  }
  const lines = ['configured providers:'];
  for (const id of ids) {
    const entry = await resolveConfigured(id);
    if (!entry) continue;
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

  // Host mode requires Anthropic; check after session resolution so a bad id
  // surfaces "no session" instead of "missing key".
  const hostEntry = await resolveConfigured(HOST_PROVIDER_ID);
  if (!hostEntry) {
    console.error(
      'mod8: No Anthropic key configured. Run: mod8 keys set anthropic, or set ANTHROPIC_API_KEY.'
    );
    process.exit(1);
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
