/**
 * Intent routing helpers — parse user input from the chat REPL into structured
 * actions (provider switch, compare-all, etc.) before any LLM call happens.
 *
 * Lives outside chat.tsx so it can be unit-tested via the dev:resolve command
 * without booting the Ink UI.
 */
import { looksLikeKeyNoun } from '../util/text.js';

/**
 * Match a request to switch the work-mode provider, with optional remainder
 * after a colon, dash, comma, or whitespace.  Returns { id, rest } or null.
 *
 * Generous on phrasing — it must catch the way real users actually speak.
 * The matched id may be a real provider id, a display name, or a synonym
 * ("gpt", "claude", etc.).  resolveProviderHint() does the lookup later.
 *
 * Phrasings handled (case-insensitive):
 *   /use <id>          /ask <id>             use <id>            ask <id>
 *   switch to <id>     switch over to <id>
 *   talk to <id>       talk with <id>        chat to <id>        chat with <id>
 *   speak to <id>      speak with <id>
 *   let me talk to <id>          let's chat with <id>            (and combos)
 *   i want to talk with <id>     i wanna chat with <id>
 *   i'd like to talk to <id>     i need to talk with <id>
 *
 * Examples:
 *   "use deepseek"                    → { id: 'deepseek' }
 *   "ask grok: what's the weather"    → { id: 'grok', rest: "what's the weather" }
 *   "i want to talk with codex"       → { id: 'codex' }
 *   "let's chat with gpt"             → { id: 'gpt' }
 */
const VERB_PATTERN = [
  '\\/(?:use|ask)',
  'use',
  'ask',
  'switch(?:\\s+over)?\\s+to',
  // Optional preamble ("i want to", "i wanna", "i'd like to", "let me",
  // "let's", "lets me" — typo-tolerant) followed by a talk/chat/speak verb
  // + to/with.  Note: "wanna" already encodes "to", so no trailing "to".
  '(?:' +
    '(?:i\'d\\s+like|i\\s+(?:want|need|would\\s+like))\\s+to\\s+' +
    '|i\\s+wanna\\s+' +
  ')?' +
    // "let'?s?" tolerates "let's", "lets", "let'", and bare "let " — followed
    // by an optional "me" (matches "let's me"/"lets me"/"let me").
    '(?:let\'?s?\\s+(?:me\\s+)?)?' +
    '(?:talk|chat|speak)\\s+(?:to|with)',
].join('|');

const PROVIDER_ROUTE_RE = new RegExp(
  `^\\s*(?:${VERB_PATTERN})\\s+([a-z][a-z0-9_.-]{0,30})\\b\\s*[:,-]?\\s*([\\s\\S]*?)\\s*$`,
  'i'
);

export function parseProviderRoute(input: string): { id: string; rest: string } | null {
  const m = input.match(PROVIDER_ROUTE_RE);
  if (!m) return null;
  return { id: m[1]!.toLowerCase(), rest: (m[2] ?? '').trim() };
}

/**
 * Match a request to switch BACK to host (mod8) from work mode.  Runs
 * BEFORE any provider call when the user is in work mode, so they're never
 * stuck if the current work provider is failing — typing "mod8" is always
 * an escape hatch.
 *
 * Returns { rest } where rest is the optional inline message after the
 * trigger (e.g. "back to mod8, what's the weather?" → rest: "what's the
 * weather?").  Null = no host-back intent.
 *
 * Phrasings handled (case-insensitive, must match the WHOLE leading intent):
 *   /mod8   @mod8   mod8
 *   back            back to mod8           switch back
 *   switch to mod8  go back                go back to mod8
 *   return to mod8  talk to mod8           let me talk to mod8
 *   change to mod8  back to host           change to host
 */
const HOST_BACK_PATTERNS: RegExp[] = [
  /^\s*(?:\/mod8|@mod8|mod8)\b\s*[:,-]?\s*([\s\S]*?)\s*$/i,
  /^\s*back\s+to\s+(?:mod8|host)\b\s*[:,-]?\s*([\s\S]*?)\s*$/i,
  /^\s*switch\s+(?:back|to)\s+(?:mod8|host)\b\s*[:,-]?\s*([\s\S]*?)\s*$/i,
  /^\s*go\s+back(?:\s+to\s+(?:mod8|host))?\b\s*[:,-]?\s*([\s\S]*?)\s*$/i,
  /^\s*return\s+to\s+(?:mod8|host)\b\s*[:,-]?\s*([\s\S]*?)\s*$/i,
  /^\s*change\s+to\s+(?:mod8|host)\b\s*[:,-]?\s*([\s\S]*?)\s*$/i,
  /^\s*(?:let(?:'s|\s+me)?\s+)?talk\s+to\s+mod8\b\s*[:,-]?\s*([\s\S]*?)\s*$/i,
  /^\s*back\s*$/i, // bare "back"
  /^\s*switch\s+back\s*$/i,
];

export function parseHostBack(input: string): { rest: string } | null {
  for (const re of HOST_BACK_PATTERNS) {
    const m = input.match(re);
    if (m) return { rest: (m[1] ?? '').trim() };
  }
  return null;
}

/**
 * Match a MID-STREAM handoff gesture — used by the chat REPL while a
 * provider is busy to short-circuit the queue and transfer the same task
 * to a different provider.  Distinct from parseProviderRoute (which fires
 * before a turn starts) because handoff implies "abort what's happening
 * now, switch, continue from there".
 *
 * Returns the target provider id (a string the caller still resolves via
 * resolveProviderHint), or null if no handoff intent is present.
 *
 * Phrasings handled (case-insensitive):
 *   /handoff <id>          /switch <id>
 *   handoff to <id>        switch to <id>      switch over to <id>
 *   @<id> take over        @<id> takeover      @<id> continue
 *   @<id> finish           @<id> proceed       @<id> resume
 *   give it to <id>        hand it to <id>     hand off to <id>
 *   let <id> finish        let <id> continue   let <id> proceed
 */
const HANDOFF_PATTERNS: RegExp[] = [
  /^\s*\/(?:handoff|switch)\s+([a-z][a-z0-9_.-]{0,30})\b.*$/i,
  /^\s*(?:handoff|hand\s+off|switch(?:\s+over)?)\s+to\s+([a-z][a-z0-9_.-]{0,30})\b.*$/i,
  /^\s*@([a-z][a-z0-9_.-]{0,30})\s+(?:take\s*over|takeover|continue|finish|proceed|resume|do\s+it)\b.*$/i,
  /^\s*(?:give|hand)\s+(?:it|this)\s+to\s+([a-z][a-z0-9_.-]{0,30})\b.*$/i,
  /^\s*let\s+([a-z][a-z0-9_.-]{0,30})\s+(?:take\s*over|takeover|continue|finish|proceed|do\s+it)\b.*$/i,
];

export function parseHandoff(input: string): string | null {
  for (const re of HANDOFF_PATTERNS) {
    const m = input.match(re);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Decide whether to auto-fallback from work mode to host based on the running
 * count of consecutive work-mode errors.  Pure function so behavioral specs
 * can hit it without driving the chat REPL.
 *
 *   0 errors          → 'ok'      (no banner, nothing to do)
 *   1 or 2 errors     → 'warn'    (append a tip suggesting the user switch back)
 *   3 or more errors  → 'fallback' (force-switch back to host with a banner)
 */
export type FallbackDecision = 'ok' | 'warn' | 'fallback';
export const AUTO_FALLBACK_THRESHOLD = 3;

export function fallbackDecision(consecutiveErrors: number): FallbackDecision {
  if (consecutiveErrors >= AUTO_FALLBACK_THRESHOLD) return 'fallback';
  if (consecutiveErrors >= 1) return 'warn';
  return 'ok';
}

/**
 * Recognize a provider name shaped like the user wrote it without any verb:
 *
 *   "codex"                  → switch (whole-input)
 *   "codex tell me a joke"   → switch + send "tell me a joke" (first-word)
 *   "hi codex"               → switch + send "hi" (greeting)
 *   "hey gpt how are you"    → switch + send "hey how are you" (greeting + rest)
 *
 * Returns a candidate name + remainder.  The caller resolves the name
 * (strict mode for bare/first-word — only literal ids/display-names match,
 *  so "haiku"/"claude"/etc. don't false-positive; greeting mode allows the
 *  full synonym table because the greeting itself disambiguates intent).
 */
export interface BareProviderIntent {
  name: string;
  rest: string;
  /**
   * 'strict' = resolver must match an id or configured display name (no
   * synonyms — bare words like "haiku" or "claude" must not auto-route).
   * 'full'   = resolver may also use synonyms (gpt/grok/etc.).
   */
  resolution: 'strict' | 'full';
}

const GREETINGS_RE = /^(hi|hey|hello|yo|sup|hiya|howdy)[\s,]+([a-z][a-z0-9_.-]{0,30})\b\s*[:,!?\-]?\s*([\s\S]*?)\s*$/i;
const WHOLE_NAME_RE = /^([a-z][a-z0-9_.-]{0,30})[?!,.\-]?$/i;
const FIRST_WORD_RE = /^([a-z][a-z0-9_.-]{0,30})\b\s+([\s\S]+)$/i;

export function parseBareProviderHint(input: string): BareProviderIntent | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Greeting + name (+ optional rest) — full resolution OK.
  const greet = trimmed.match(GREETINGS_RE);
  if (greet) {
    const greeting = greet[1]!;
    const name = greet[2]!.toLowerCase();
    const after = (greet[3] ?? '').trim();
    const rest = after ? `${greeting} ${after}` : greeting;
    return { name, rest, resolution: 'full' };
  }

  // Whole-input single word — strict resolution only.
  const whole = trimmed.match(WHOLE_NAME_RE);
  if (whole) {
    return { name: whole[1]!.toLowerCase(), rest: '', resolution: 'strict' };
  }

  // First word + remainder — strict resolution (so "claude alone is great"
  // doesn't route; only configured-or-built-in ids/display-names do).
  const firstWord = trimmed.match(FIRST_WORD_RE);
  if (firstWord) {
    return {
      name: firstWord[1]!.toLowerCase(),
      rest: firstWord[2]!.trim(),
      resolution: 'strict',
    };
  }

  return null;
}

/**
 * Match a user request to add an API key inline ("add a key", "i want to
 * paste a key", "let me add gemini", etc.).  Returns null if no paste-key
 * intent is detected; otherwise returns an object with an optional
 * `providerHint` (the trailing word the user named, if any).  The caller
 * resolves the hint against the configured registry — if it doesn't resolve,
 * the caller should treat the input as plain text rather than a paste-key
 * intent (this is what protects "save my work" / "register a feature" from
 * false-positiving).
 *
 * Phrasings handled (case-insensitive):
 *   add a key                      paste my key
 *   save my api key                register a key
 *   set up a key                   put in a key
 *   i want to add a key            i wanna paste a key
 *   i'd like to register a key     let me save my key
 *   let's add a key                lets paste a key
 *   add my anthropic key           paste claude
 *   let me add gemini              save my groq key
 *
 * Does NOT match:
 *   save the file                  let's add a feature
 *   set the timer                  put in a code-review
 * (because "file" / "feature" / "timer" / "code-review" are not provider
 *  hints and the trailing word doesn't say "key" / "credentials" / "secret".)
 */
// "use" is intentionally NOT here — "use codex" is a routing intent, not
// a paste-key intent.  It IS in PASTE_PRONOUN_VERB below so "use this" /
// "use it" still work when a pendingKey is in flight.
//
// Includes change/update/replace/rotate/swap so phrasings like "lets
// change the google key" route through the inline paste flow instead of
// being passed to the host LLM (which would just lecture about
// `mod8 keys set <id>`).
const PASTE_VERB = '(?:add|paste|save|register|set(?:\\s+up)?|enter|put\\s+in|drop|store|change|update|replace|swap(?:\\s+out)?|rotate|renew|regenerate|switch)';
const PASTE_PRONOUN_VERB = '(?:add|paste|save|register|set(?:\\s+up)?|enter|put\\s+in|drop|store|use|change|update|replace|swap|rotate)';
// Modify-style verbs imply the user wants to change something — and the only
// thing mod8 manages per-provider is the key.  We use this set for typo-
// tolerant matching: "change the google kew" / "update my anthropic kee"
// should all route to the inline paste flow, not the host LLM.
const PASTE_MODIFY_VERB = '(?:change|update|replace|swap(?:\\s+out)?|rotate|renew|regenerate)';
const VOLITION_PREFIX =
  "(?:i\\s+(?:want|wanna|need|would\\s+like)|i'?d\\s+like|let'?s?(?:\\s+me)?)\\s+(?:to\\s+)?";
// Articles + demonstratives + pronouns.  "this/that/these/those" are the
// fix for "add this key!" — and "it/them" lets us match "save it" /
// "register them" when the user is referring back to a key already in view.
const ARTICLE = '(?:a|an|my|the|new|another|this|that|these|those|it|them)';
const KEY_NOUN = '(?:key|credentials?|secret)s?';

// Intent A: <volition?> <verb> [article] [api/provider] key/credentials/secret
const PASTE_KEY_RE = new RegExp(
  `^\\s*(?:${VOLITION_PREFIX})?${PASTE_VERB}` +
    `(?:\\s+${ARTICLE})?` +
    `(?:\\s+(?:api|provider))?` +
    `\\s+${KEY_NOUN}\\b`,
  'i'
);

// Intent B: <volition?> <verb> [article?] <provider-token> [key]?
// Caller validates that the provider-token is a real provider hint.
const PASTE_PROVIDER_RE = new RegExp(
  `^\\s*(?:${VOLITION_PREFIX})?${PASTE_VERB}` +
    `(?:\\s+${ARTICLE})?\\s+` +
    `([a-z][a-z0-9_.-]{1,30})` +
    `(?:\\s+${KEY_NOUN})?\\s*[.,!?]?\\s*$`,
  'i'
);

// Intent C: bare pronoun forms — "save this", "save it", "use this",
// "register it", "add this".  These ONLY make sense when there is a key
// already on the screen (i.e. the user just pasted one); the chat REPL
// arms a pendingKey state in that case, which is what makes Intent C
// safe to recognize even though it has no key noun.
const PASTE_PRONOUN_RE = new RegExp(
  `^\\s*(?:${VOLITION_PREFIX})?${PASTE_PRONOUN_VERB}` +
    `\\s+(?:this|that|it|them)` +
    `(?:\\s+${KEY_NOUN})?\\s*[.,!?]?\\s*$`,
  'i'
);

// Intent D: modify-style verb + (article)? + provider + ANY trailing word.
// Catches typos of "key": "change the google kew" / "update my anthropic
// kee" / "rotate the openai keey".  Trailing word is captured so we can
// fuzzy-check it looks like "key" (otherwise we'd false-positive on
// "change google account password" etc.).
const PASTE_MODIFY_PROVIDER_TYPO_RE = new RegExp(
  `^\\s*(?:${VOLITION_PREFIX})?${PASTE_MODIFY_VERB}` +
    `(?:\\s+${ARTICLE})?\\s+` +
    `([a-z][a-z0-9_.-]{1,30})` +
    `\\s+(\\S{2,16})\\s*[.,!?]?\\s*$`,
  'i'
);

export interface PasteKeyIntent {
  /**
   * If the user named a specific provider (intent B), this is the candidate
   * hint.  Always lowercased.  Caller MUST resolve it before treating the
   * input as a paste-key intent — `null` from the resolver means the trailing
   * word wasn't actually a provider, so the input is plain text.
   */
  providerHint?: string;
  /**
   * True when the matched intent was a bare pronoun ("save this", "use it").
   * Caller should ignore the intent UNLESS a pendingKey is in flight — by
   * itself "save this" is too ambiguous to start a fresh paste flow.
   */
  pronounRef?: boolean;
}

export function parsePasteKeyIntent(input: string): PasteKeyIntent | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (PASTE_KEY_RE.test(trimmed)) return {};
  if (PASTE_PRONOUN_RE.test(trimmed)) return { pronounRef: true };
  const m = trimmed.match(PASTE_PROVIDER_RE);
  if (m) {
    const token = m[1]!.toLowerCase();
    // The "token" position can also be a typo of the key noun itself
    // ("change my kew" / "rotate the kee" — no provider, just a typo of
    // "key").  Treat these as a generic paste-key intent without a hint.
    if (looksLikeKeyNoun(token)) return {};
    return { providerHint: token };
  }
  // Typo-tolerant fallback for modify-style verbs that name a provider
  // ("change the google kew", "rotate my anthropic kee").  Accept only
  // when the trailing word fuzzy-matches "key" — otherwise "change
  // google account password" would false-positive.
  const m2 = trimmed.match(PASTE_MODIFY_PROVIDER_TYPO_RE);
  if (m2 && looksLikeKeyNoun(m2[2]!)) {
    return { providerHint: m2[1]!.toLowerCase() };
  }
  return null;
}

/**
 * Affirmative responses — "yes", "y", "sure", "go", "do it".  Used for
 * yes/no confirmation prompts (fuzzy match, paste-key, etc).  Conservative:
 * exact-shape matches only, no fuzzy reasoning.
 */
const AFFIRM_RE =
  /^\s*(?:yes|y|yeah|yep|yup|sure|ok|okay|alright|fine|please|go|do\s+it|switch|please\s+do|confirm|correct)\s*[!?.,]?\s*$/i;

/**
 * Negative responses — "no", "cancel", "skip".  Lets the chat REPL ack a
 * cancellation without sending it to the LLM.
 */
const NEGATIVE_RE =
  /^\s*(?:no|nope|nah|cancel|skip|never|forget\s+it|don'?t|dont|never\s+mind|nevermind)\s*[!?.,]?\s*$/i;

export function isAffirmative(input: string): boolean {
  return AFFIRM_RE.test(input.trim());
}

export function isNegative(input: string): boolean {
  return NEGATIVE_RE.test(input.trim());
}

/**
 * Composite affirmative for the paste-key confirm step — accepts plain
 * "yes" along with any paste-key phrasing ("save it", "save this", "use it",
 * etc.).  In pendingKey context these are unambiguous: the user just pasted
 * a key, mod8 asked "save this as X?", and "save it" means yes.
 */
export function isPasteConfirmAffirmative(input: string): boolean {
  return isAffirmative(input) || parsePasteKeyIntent(input) !== null;
}

/** Bare compare command without a payload prompt. */
export function isCompareCommand(input: string): boolean {
  const s = input.trim().toLowerCase();
  return (
    s === '/compare' ||
    s === 'compare all' ||
    s === 'ask everyone' ||
    /^compare(\s+all)?\s*[:,-]?\s*$/.test(s)
  );
}

/**
 * Match a compare command WITH a payload prompt:
 *   "compare all: write a haiku"
 *   "ask everyone: write a haiku"
 *   "/compare write a haiku"
 * Returns the payload, or null if the input isn't a compare-with-payload.
 */
export function parseCompareWithPrompt(input: string): string | null {
  const m = input.match(/^(?:\/compare|compare all|ask everyone)\s*[:,-]?\s*([\s\S]+)$/i);
  return m ? m[1]!.trim() : null;
}

/**
 * Client-side interceptor for "open the browser" / "open <url>" / "preview
 * this" intents.  Runs BEFORE any LLM call so we never depend on a model
 * (which keeps refusing the open_url tool across providers — DeepSeek
 * especially, but the regression hit Claude/Codex/Gemini too) to actually
 * fire the opener.
 *
 * Returns:
 *   - { explicitUrl: <url> }   user typed a URL — open exactly that
 *   - { explicitUrl: null }    user asked for the browser without a URL —
 *                              caller should look up the last URL from the
 *                              transcript via findRecentUrl(messages)
 *   - null                     not an open-browser intent — fall through to
 *                              the LLM (do NOT swallow plain English)
 *
 * Must NOT match:
 *   - "open the file"   "open package.json"   "open issue 42"   "open it"
 *   - "open a new tab"  "open up to feedback" "opens the door"
 *   - Anything that doesn't mention "browser" / "preview" / an explicit URL.
 *   The conservative bar matters — false positives would shadow real work.
 */
const URL_RE = /https?:\/\/[^\s<>"')]+/i;
const URL_RE_GLOBAL = /https?:\/\/[^\s<>"')]+/gi;

// "open <url>" / "launch <url>" / "preview <url>" / "show <url>" — verb +
// explicit absolute URL.  Anchored to the start to avoid matching URLs that
// happen to appear inside longer prose ("the docs at https://x.com say to
// open the file").
const OPEN_URL_RE =
  /^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|just\s+)?(?:open|launch|preview|view|show(?:\s+me)?|fire\s*up|start)\s+(?:up\s+)?(https?:\/\/[^\s<>"')]+)\s*[.!?]?\s*$/i;

// "open the browser" and its many natural phrasings.  These do NOT carry a
// URL — caller resolves the URL from recent transcript.
const OPEN_BROWSER_PATTERNS: RegExp[] = [
  // "open|launch|fire up|start (up)? (the|a)? browser" — bare or trailing
  /\b(?:open|launch|fire\s*up|start)\s+(?:up\s+)?(?:the\s+|a\s+)?browser\b/i,
  // "open|show|view|preview|see (it|this|that)? in (the )? browser"
  /\b(?:open|show|view|preview|see)\s+(?:it|this|that|the\s+page|the\s+site|the\s+app|the\s+app\s+up)?\s*in\s+(?:the\s+|a\s+)?browser\b/i,
  // "in the browser" trailing fragment ("show in the browser")
  /\bin\s+(?:the\s+|my\s+)?browser\b/i,
  // "preview this" / "preview it" / "preview the app" — browser implied
  /^\s*preview\s+(?:this|it|that|the\s+(?:app|site|page))\s*[.!?]?\s*$/i,
  // "open it up" + browser hint already covered above; this catches the
  // bare "open browser" without "the".
  /^\s*open\s+browser\s*[.!?]?\s*$/i,
];

export function parseOpenBrowser(
  input: string
): { explicitUrl: string | null } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Pattern A: explicit URL after an open/launch/preview verb — highest
  // confidence, even if the rest of the sentence doesn't say "browser".
  const explicit = trimmed.match(OPEN_URL_RE);
  if (explicit) {
    return { explicitUrl: explicit[1]! };
  }

  // Pattern B: phrase mentions the browser (or "preview this") with no URL.
  // Pull any URL that happens to be in the same sentence ("open https://x
  // in the browser" — though Pattern A usually catches that first).
  for (const re of OPEN_BROWSER_PATTERNS) {
    if (re.test(trimmed)) {
      const m = trimmed.match(URL_RE);
      return { explicitUrl: m ? cleanTrailingPunct(m[0]) : null };
    }
  }
  return null;
}

function cleanTrailingPunct(u: string): string {
  // URL regex can include trailing punctuation that wasn't part of the link
  // ("...open http://x.com.").  Strip common sentence terminators.
  return u.replace(/[.,;:!?)\]]+$/, '');
}

/**
 * Scan recent conversation for the most relevant URL to open in a browser,
 * for use after parseOpenBrowser() returned `{ explicitUrl: null }`.
 *
 * Strategy:
 *   1. Walk messages newest → oldest.
 *   2. For each, prefer localhost / 127.0.0.1 / 0.0.0.0 / [::1] URLs (dev
 *      servers — what the user almost always means).
 *   3. Fall back to the last absolute http(s) URL in the message.
 *   4. Return the first hit; null if the transcript has no URLs.
 *
 * Scans BOTH user and assistant messages — the URL might have been pasted
 * by the user ("test this: http://localhost:5173") or printed by the model
 * after starting a dev server.
 */
export function findRecentUrl(
  messages: ReadonlyArray<{ role: string; content: string }>
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m.content !== 'string') continue;
    const urls = [...m.content.matchAll(URL_RE_GLOBAL)].map((x) =>
      cleanTrailingPunct(x[0])
    );
    if (urls.length === 0) continue;
    const local = urls.find((u) =>
      /(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)/.test(u)
    );
    if (local) return local;
    return urls[urls.length - 1]!;
  }
  return null;
}

/**
 * Parse a `/goal …` command.  Returns the goal text on set, the literal
 * sentinel `'__CLEAR__'` on clear, or `null` if this isn't a /goal at all.
 * Examples:
 *   /goal ship landing page by friday  → "ship landing page by friday"
 *   /goal clear                        → '__CLEAR__'
 *   /goal                              → '__CLEAR__' (bare /goal acts as
 *                                        clear — shorter to type, common
 *                                        pattern in TUIs)
 *   anything else                      → null
 */
export const GOAL_CLEAR_SENTINEL = '__CLEAR__';
export function parseGoalCommand(input: string): string | null {
  const m = input.match(/^\s*\/goal(?:\s+([\s\S]+))?\s*$/i);
  if (!m) return null;
  const arg = (m[1] ?? '').trim();
  if (!arg || /^(clear|none|off|unset|reset)$/i.test(arg)) {
    return GOAL_CLEAR_SENTINEL;
  }
  return arg;
}

/** True when the input is exactly the `/cost` command (no args).  Surfaces
 *  this-session spend per provider + total. */
export function isCostCommand(input: string): boolean {
  return /^\s*\/cost\s*$/i.test(input);
}

/** True when the input is the `/help` or `/?` command. */
export function isHelpCommand(input: string): boolean {
  return /^\s*\/(help|\?|commands)\s*$/i.test(input);
}

/** Parse `/preview` with an optional script-name override:
 *   /preview          → auto-detect (npm run dev / start / serve)
 *   /preview dev      → run `npm run dev`
 *   /preview start    → run `npm run start`
 *   /preview <script> → run `npm run <script>`
 * Returns the override script name, the sentinel `'__AUTO__'` for the bare
 * form, or `null` when this isn't a /preview command at all. */
export const PREVIEW_AUTO_SENTINEL = '__AUTO__';
export function parsePreviewCommand(input: string): string | null {
  const m = input.match(/^\s*\/preview(?:\s+([a-z0-9:_-]{1,40}))?\s*$/i);
  if (!m) return null;
  return m[1] ? m[1].trim() : PREVIEW_AUTO_SENTINEL;
}
