type ProviderId = string;

/**
 * Structured error kinds.  Driven by HTTP status when we can extract one,
 * otherwise by message-text heuristics that match SDK error formats.
 */
export type ErrorKind =
  | 'auth' // 401 / invalid key
  | 'forbidden' // 403 / project denied
  | 'rate-limit' // 429
  | 'no-credit' // 402 / insufficient balance / quota
  | 'server' // 5xx
  | 'network' // ECONN* / fetch failed
  | 'timeout' // request timed out
  | 'model' // model not found / unsupported
  | 'other';

export interface DiagnosedError {
  kind: ErrorKind;
  /** Trimmed, single-line raw message from the provider — preserved verbatim
   *  so the user can copy/paste it into a search if our diagnosis is wrong. */
  rawMessage: string;
  /** Extracted HTTP code if available. */
  code?: number;
  /** Extracted retry-after hint in seconds if the message exposes one. */
  retryDelaySeconds?: number;
}

/**
 * Pull a sensible short text out of the SDK error, stripping prefix noise
 * (so we don't double-print the HTTP code) and provider-SDK wrapper text
 * (e.g. `[GoogleGenerativeAI Error]: Error fetching from <url>:`).
 */
function extractRawMessage(err: Error): string {
  let cleaned = err.message
    // SDK wrapper prefixes
    .replace(/^\s*\[GoogleGenerativeAI Error\]:\s*/i, '')
    .replace(/^\s*Error fetching from\s+\S+\s*:\s*/i, '')
    // HTTP status prefixes
    .replace(/^\s*\[\d{3}[^\]]*\]\s*/, '') // [403 Forbidden]
    .replace(/^\s*Status:?\s*\d{3}[\s,:-]*/i, '') // Status: 403
    .replace(/^\s*\d{3}\s+(?=[A-Z])/, '') // bare "403 Forbidden..."
    .replace(/^\s*Error:?\s+/i, '');
  cleaned = cleaned.split('\n')[0]!.trim();
  // Google SDK errors stuff structured detail JSON onto the same line —
  // strip that tail so the user sees just the human-readable summary.
  cleaned = cleaned.replace(/\s*\[?\{["']@type["'].*$/, '').trim();
  return cleaned.slice(0, 240);
}

function extractCode(err: Error): number | undefined {
  const e = err as unknown as Record<string, unknown>;
  if (typeof e['status'] === 'number') return e['status'] as number;
  if (typeof e['statusCode'] === 'number') return e['statusCode'] as number;
  // Fall back to scanning the message — most SDK errors include the code in
  // brackets or as a leading token.
  const m = err.message.match(/\b(\d{3})\b/);
  if (m) {
    const code = Number.parseInt(m[1]!, 10);
    if (code >= 400 && code < 600) return code;
  }
  return undefined;
}

function extractRetryDelay(msg: string): number | undefined {
  const m1 = msg.match(/retry[\s-]*after\s*:?\s*(\d+)/i);
  if (m1) return Number.parseInt(m1[1]!, 10);
  const m2 = msg.match(/try\s+again\s+in\s+(\d+)\s*(?:seconds?|s)\b/i);
  if (m2) return Number.parseInt(m2[1]!, 10);
  const m3 = msg.match(/wait\s+(\d+)\s*(?:seconds?|s)\b/i);
  if (m3) return Number.parseInt(m3[1]!, 10);
  return undefined;
}

function detectKind(err: Error, code: number | undefined): ErrorKind {
  const msg = err.message;
  // Network/timeout get evaluated FIRST because their messages also often
  // contain digits that look like codes.
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(msg)) {
    return 'network';
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return 'timeout';

  if (code === 401) return 'auth';
  if (code === 403) return 'forbidden';
  if (code === 429) return 'rate-limit';
  if (code === 402) return 'no-credit';
  if (code !== undefined && code >= 500 && code < 600) return 'server';

  if (
    /\bunauthor/i.test(msg) ||
    /\bauthentication[_ -]?(?:failed|error)/i.test(msg) ||
    /\binvalid[_ -]?api[_ -]?key\b/i.test(msg) ||
    /\bapi[_ -]?key[_ -]?invalid\b/i.test(msg) || // Google's API_KEY_INVALID
    /\bapi\s+key\s+(?:is\s+)?(?:not\s+valid|invalid)/i.test(msg) || // "API key not valid"
    /\bincorrect[_ -]?api[_ -]?key\b/i.test(msg)
  ) {
    return 'auth';
  }
  if (/\bforbidden\b|\bdenied\b|\baccess\s+(?:has\s+been\s+)?denied\b|\bblocked\b|\bnot[_ -]?authorized\b/i.test(msg)) {
    return 'forbidden';
  }
  if (/\brate[_ -]?limit|\btoo[_ -]many[_ -]requests\b|\brate_limit_exceeded\b/i.test(msg)) {
    return 'rate-limit';
  }
  if (/\binsufficient[_ -](?:balance|credit|funds)\b|\bout[_ -]of[_ -](?:credit|balance)\b|\bpayment[_ -]required\b|\bno[_ -]balance\b|\bbilling[_ -]not[_ -]active\b|\bfree.*tier.*exceed/i.test(msg)) {
    return 'no-credit';
  }
  if (/\bquota\b|\bbilling\b/i.test(msg)) return 'no-credit';
  // Tightened: word boundary on "model" (so "models/<name>" in URLs DOESN'T
  // match), bounded gap (no 200-char .* spans), and no "invalid" — too
  // generic; was over-matching against "API key not valid" elsewhere in
  // the same message.
  if (/\bmodel\b[^.\n]{0,80}\b(?:not\s+found|does\s+not\s+exist|unsupported|not\s+supported|deprecated|no\s+longer\s+available)\b/i.test(msg)) {
    return 'model';
  }
  if (/\b(?:not\s+found|does\s+not\s+exist|unsupported|deprecated|no\s+longer\s+available)\b[^.\n]{0,80}\bmodel\b/i.test(msg)) {
    return 'model';
  }
  return 'other';
}

export function diagnose(err: unknown): DiagnosedError {
  if (!(err instanceof Error)) {
    return { kind: 'other', rawMessage: String(err).slice(0, 240) };
  }
  const code = extractCode(err);
  const kind = detectKind(err, code);
  const rawMessage = extractRawMessage(err);
  const retryDelaySeconds =
    kind === 'rate-limit' ? extractRetryDelay(err.message) : undefined;
  const result: DiagnosedError = { kind, rawMessage };
  if (code !== undefined) result.code = code;
  if (retryDelaySeconds !== undefined) result.retryDelaySeconds = retryDelaySeconds;
  return result;
}

/**
 * Map a raw provider error into a short human-readable description.
 * Backwards-compat shim used by the --all parallel path (which displays a
 * single line per block, no room for the multi-line explainError output).
 *
 * If `provider` is supplied, the "invalid API key" path can append a
 * `Run: mod8 keys set <provider>` remedy hint.
 */
export function classifyError(err: unknown, provider?: ProviderId): string {
  if (!(err instanceof Error)) return String(err);
  const msg = err.message;

  // Already-friendly errors from our own code (e.g. getKey)
  if (msg.startsWith('No ') && /key configured/.test(msg)) return msg;

  const diag = diagnose(err);
  switch (diag.kind) {
    case 'auth':
      return provider
        ? `invalid API key. Run: mod8 keys set ${provider}`
        : 'invalid API key';
    case 'forbidden': {
      const tail = diag.rawMessage ? ` — ${diag.rawMessage}` : '';
      return `forbidden (HTTP ${diag.code ?? 403})${tail}`;
    }
    case 'rate-limit':
      return diag.retryDelaySeconds
        ? `rate limited — try again in ${diag.retryDelaySeconds}s`
        : 'rate limited — try again shortly';
    case 'no-credit':
      return 'quota or billing issue — check your provider dashboard';
    case 'server':
      return `provider server error (HTTP ${diag.code ?? '5xx'}) — try again shortly`;
    case 'network':
      return 'network error — check your connection';
    case 'timeout':
      return 'request timed out — try again';
    case 'model':
      return `model not available — set MOD8_${(provider ?? '').toUpperCase()}_MODEL to override`;
    default:
      return diag.rawMessage || msg.split('\n')[0]!.slice(0, 240);
  }
}
