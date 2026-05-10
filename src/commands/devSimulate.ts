/**
 * `mod8 dev:simulate` — read inputs from stdin (one per line) and play them
 * through the chat REPL's routing state machine.  No LLM calls; no Ink.
 * Lets behavioral specs verify long sequences of switches behave correctly:
 *   - banner targets match what would be said
 *   - workProviderId resets to default on every host transition
 *   - parseHostBack always wins (user can never get stuck)
 *   - false positives don't auto-route (no surprise switches)
 *   - paste-key flow saves to providers.json without ever leaking the key
 *   - bare-paste auto-detect (no consent first) asks then saves
 *   - fuzzy match catches typos like "gimini" → google
 *
 * Output format (one line per non-empty input):
 *   step=N input=<json> mode=<host|work> provider=<id> action=<...> rest=<json>
 *
 * Inputs are sanitized via sanitizeKeys() BEFORE being printed, so a real
 * pasted key never lands in stdout/stderr/scrollback.
 *
 * Actions: host-back, host-back-noop, route, route-bare, route-greeting,
 *          send, compare, compare-bare, slash-clear, slash-providers,
 *          paste-consent, paste-saved, paste-rejected, paste-pending,
 *          paste-cancelled, fuzzy-route, fuzzy-ask, fuzzy-multi,
 *          fuzzy-confirmed, fuzzy-cancelled, route-error
 */

import {
  parseProviderRoute,
  parseHostBack,
  parseBareProviderHint,
  parseCompareWithPrompt,
  isCompareCommand,
  parsePasteKeyIntent,
  isPasteConfirmAffirmative,
  isAffirmative,
  isNegative,
} from './intentRouting.js';
import {
  resolveProviderHint,
  strictResolveProviderHint,
  resolveConfigured,
  saveKeyPreservingEntry,
  fuzzyResolveProviderHint,
} from '../storage/providers.js';
import { findApiKey, sanitizeKeys } from '../util/secrets.js';
import type { ProviderTemplate } from '../providers/registry.js';

const DEFAULT_WORK = 'anthropic';

interface SimState {
  mode: 'host' | 'work';
  workProviderId: string;
  awaitingKey: boolean;
  pendingKey: { rawKey: string; template: ProviderTemplate } | null;
  pendingFuzzy: { id: string; rest: string } | null;
}

interface StepResult {
  action: string;
  rest: string;
}

async function persistKey(key: string, tpl: ProviderTemplate): Promise<void> {
  await saveKeyPreservingEntry(key, tpl);
}

async function tryFuzzyRoute(
  name: string,
  rest: string,
  state: SimState
): Promise<StepResult | null> {
  if (name.length < 4) return null;
  if (isAffirmative(name) || isNegative(name)) return null;
  const fuzzy = await fuzzyResolveProviderHint(name);
  if (fuzzy.length === 0) return null;
  if (fuzzy.length > 1) {
    const ids = fuzzy.map((c) => c.id).join(',');
    return { action: `fuzzy-multi ids=${ids}`, rest };
  }
  const m = fuzzy[0]!;
  const askFirst = m.distance === 2 && name.length <= 4;
  if (askFirst) {
    state.pendingFuzzy = { id: m.id, rest };
    return { action: `fuzzy-ask id=${m.id}`, rest };
  }
  const entry = await resolveConfigured(m.id);
  if (!entry) {
    return { action: `fuzzy-not-configured id=${m.id}`, rest };
  }
  state.mode = 'work';
  state.workProviderId = m.id;
  return { action: `fuzzy-route id=${m.id} distance=${m.distance}`, rest };
}

async function simulateStep(input: string, state: SimState): Promise<StepResult> {
  const value = input.trim();
  if (!value) return { action: 'empty', rest: '' };

  // === STATE HANDLERS (run on RAW because key detection requires it) ====

  // 1. Awaiting explicit paste-key.
  if (state.awaitingKey) {
    state.awaitingKey = false;
    if (parseHostBack(value)) {
      // fall through to dispatch below
    } else {
      const found = findApiKey(value);
      if (found) {
        await persistKey(found.key, found.template);
        return { action: `paste-saved id=${found.template.id}`, rest: '' };
      }
      if (isNegative(value)) {
        return { action: 'paste-cancelled', rest: '' };
      }
      return { action: 'paste-rejected', rest: '' };
    }
  }

  // 2. Pending bare-paste confirm.
  if (state.pendingKey) {
    const cached = state.pendingKey;
    state.pendingKey = null;
    if (isPasteConfirmAffirmative(value)) {
      await persistKey(cached.rawKey, cached.template);
      return { action: `paste-saved id=${cached.template.id}`, rest: '' };
    }
    if (isNegative(value)) {
      return { action: 'paste-cancelled', rest: '' };
    }
    // Otherwise cancel + fall through — emit an explicit signal so specs
    // can verify the cancellation, then continue dispatching this turn.
  }

  // 3. Pending fuzzy confirm.
  if (state.pendingFuzzy) {
    const cached = state.pendingFuzzy;
    state.pendingFuzzy = null;
    if (isAffirmative(value)) {
      const entry = await resolveConfigured(cached.id);
      if (entry) {
        state.mode = 'work';
        state.workProviderId = cached.id;
        return { action: `fuzzy-confirmed id=${cached.id}`, rest: cached.rest };
      }
      return { action: `fuzzy-not-configured id=${cached.id}`, rest: '' };
    }
    if (isNegative(value)) {
      return { action: 'fuzzy-cancelled', rest: '' };
    }
    // Otherwise fall through to normal dispatch.
  }

  // === BARE-PASTE AUTO-DETECT (host mode, raw input) ====================
  if (state.mode === 'host') {
    const found = findApiKey(value);
    if (found) {
      state.pendingKey = { rawKey: found.key, template: found.template };
      return { action: `paste-pending id=${found.template.id}`, rest: '' };
    }
  }

  // Slash commands first
  if (value === '/exit' || value === '/quit') return { action: 'slash-exit', rest: '' };
  if (value === '/clear') return { action: 'slash-clear', rest: '' };
  if (value === '/providers') return { action: 'slash-providers', rest: '' };

  // Compare
  if (isCompareCommand(value)) return { action: 'compare-bare', rest: '' };
  const compare = parseCompareWithPrompt(value);
  if (compare) return { action: 'compare', rest: compare };

  // parseHostBack always wins.
  const back = parseHostBack(value);
  if (back) {
    if (state.mode === 'work') {
      state.mode = 'host';
      state.workProviderId = DEFAULT_WORK;
      return { action: 'host-back', rest: back.rest };
    }
    return { action: 'host-back-noop', rest: back.rest };
  }

  // Paste-key intent — runs BEFORE provider routing because phrases like
  // "add a key" don't look like routing but should never be sent to the LLM.
  // Only host mode triggers the consent flow.
  const paste = parsePasteKeyIntent(value);
  if (paste && state.mode === 'host') {
    if (paste.providerHint) {
      const resolved = await resolveProviderHint(paste.providerHint);
      if (resolved) {
        state.awaitingKey = true;
        return { action: `paste-consent target=${resolved}`, rest: '' };
      }
      // Trailing word wasn't a provider — fall through to LLM.
    } else if (paste.pronounRef) {
      // Bare pronoun ("save this") with no pendingKey — ambiguous, fall
      // through.  In real chat this only triggers from inside the
      // pendingKey state (handled above), so reaching here means the user
      // typed it cold.
    } else {
      state.awaitingKey = true;
      return { action: 'paste-consent', rest: '' };
    }
  }

  // Verb-based routing
  const route = parseProviderRoute(value);
  if (route) {
    const exact = await resolveProviderHint(route.id);
    if (!exact) {
      const fuzzed = await tryFuzzyRoute(route.id, route.rest, state);
      if (fuzzed) return fuzzed;
      return { action: `route-error unknown=${route.id}`, rest: route.rest };
    }
    const entry = await resolveConfigured(exact);
    if (!entry) {
      return { action: `route-error not-configured=${exact}`, rest: route.rest };
    }
    state.mode = 'work';
    state.workProviderId = exact;
    return { action: 'route', rest: route.rest };
  }

  // Bare-name / first-word / greeting matching
  const bare = parseBareProviderHint(value);
  if (bare) {
    const resolved =
      bare.resolution === 'strict'
        ? await strictResolveProviderHint(bare.name)
        : await resolveProviderHint(bare.name);
    if (resolved) {
      const entry = await resolveConfigured(resolved);
      if (entry) {
        state.mode = 'work';
        state.workProviderId = resolved;
        const action = bare.resolution === 'full' ? 'route-greeting' : 'route-bare';
        return { action, rest: bare.rest };
      }
      return { action: `route-error not-configured=${resolved}`, rest: bare.rest };
    }
    // Exact failed — try fuzzy before falling through.
    const fuzzed = await tryFuzzyRoute(bare.name, bare.rest, state);
    if (fuzzed) return fuzzed;
    // Fall through.
  }

  return { action: 'send', rest: value };
}

export async function devSimulate(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks as Uint8Array[]).toString('utf8');
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));

  const state: SimState = {
    mode: 'host',
    workProviderId: DEFAULT_WORK,
    awaitingKey: false,
    pendingKey: null,
    pendingFuzzy: null,
  };

  let stepNum = 0;
  for (const raw of lines) {
    if (raw.length === 0) continue;
    stepNum += 1;
    const result = await simulateStep(raw, state);
    const provider = state.mode === 'work' ? state.workProviderId : 'host';
    const safeInput = sanitizeKeys(raw);
    const safeRest = sanitizeKeys(result.rest);
    process.stdout.write(
      `step=${stepNum} input=${JSON.stringify(safeInput)} mode=${state.mode} provider=${provider} action=${result.action} rest=${JSON.stringify(safeRest)}\n`
    );
  }
}
