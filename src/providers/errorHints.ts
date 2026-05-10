/**
 * Per-error-kind diagnostic explainer.
 *
 * Old design: one generic provider hint regardless of error.  Result was
 * misleading guidance — a 403 "project denied" for Google was followed by
 * the generic "free-tier quota / billing / regions" tip, which doesn't
 * match what's actually wrong.
 *
 * New design: combine the structured ErrorKind from `diagnose()` with the
 * provider's id to produce three pieces:
 *
 *   - short      — single-line summary used as the error transcript entry
 *                  (always quotes the raw provider message + HTTP code)
 *   - long       — explanation + provider-specific fix bullets
 *   - suggestion — short tip used by the warn / auto-fallback banners
 *
 * The raw provider message is ALWAYS preserved so the user can search for
 * it if our diagnosis is wrong.  We never replace a structured message
 * with a generic blanket — generic only fires for kind='other' (truly
 * unknown errors).
 */

import { diagnose, type ErrorKind, type DiagnosedError } from '../util/errors.js';

interface ProviderUrls {
  /** Where the user manages billing / credit. */
  billing: string;
  /** Where the user manages API keys. */
  keys: string;
}

const PROVIDER_URLS: Record<string, ProviderUrls> = {
  anthropic: {
    billing: 'https://console.anthropic.com/settings/billing',
    keys: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    billing: 'https://platform.openai.com/billing',
    keys: 'https://platform.openai.com/api-keys',
  },
  google: {
    billing: 'https://console.cloud.google.com/billing',
    keys: 'https://aistudio.google.com/app/apikey',
  },
  groq: {
    billing: 'https://console.groq.com/settings/billing',
    keys: 'https://console.groq.com/keys',
  },
  xai: {
    billing: 'https://console.x.ai/team/default',
    keys: 'https://console.x.ai/team/default/api-keys',
  },
  deepseek: {
    billing: 'https://platform.deepseek.com/usage',
    keys: 'https://platform.deepseek.com/api_keys',
  },
  mistral: {
    billing: 'https://console.mistral.ai/billing',
    keys: 'https://console.mistral.ai/api-keys',
  },
  openrouter: {
    billing: 'https://openrouter.ai/credits',
    keys: 'https://openrouter.ai/keys',
  },
  together: {
    billing: 'https://api.together.ai/settings/billing',
    keys: 'https://api.together.ai/settings/api-keys',
  },
};

function urlsFor(providerId: string): ProviderUrls {
  return PROVIDER_URLS[providerId] ?? { billing: '(provider dashboard)', keys: '(provider dashboard)' };
}

export interface ErrorExplanation {
  /** Diagnosis kind — exposed so the auto-fallback path can route on it. */
  kind: ErrorKind;
  /** Short, single-line summary.  Always quotes the raw provider message. */
  short: string;
  /** Multi-line explanation + fix bullets.  Empty for kind='other' when we
   *  have nothing useful to add beyond the short line. */
  long: string;
  /** One-liner the warn / auto-fallback banners use. */
  suggestion: string;
}

function quote(text: string): string {
  return text ? `'${text}'` : '';
}

function rejectionLine(providerId: string, diag: DiagnosedError, verb: string): string {
  const code = diag.code ? ` (HTTP ${diag.code})` : '';
  const tail = diag.rawMessage ? `: ${quote(diag.rawMessage)}` : '';
  return `${providerId} ${verb}${code}${tail}`;
}

export function explainError(err: unknown, providerId: string): ErrorExplanation {
  const diag = diagnose(err);
  const urls = urlsFor(providerId);

  switch (diag.kind) {
    case 'auth': {
      const code = diag.code ?? 401;
      const tail = diag.rawMessage ? `: ${quote(diag.rawMessage)}` : '';
      return {
        kind: diag.kind,
        short: `${providerId} rejected the API key (HTTP ${code})${tail}`,
        long:
          `API key rejected. Verify the key is correct, not revoked, and not for the wrong product (e.g. a ChatGPT subscription is NOT an OpenAI API key).\n` +
          `Possible fixes:\n` +
          `- Paste a new key right here ("add a key") and mod8 will save it inline\n` +
          `- Or rotate at ${urls.keys}`,
        suggestion: `Type 'mod8' to switch back, or paste a new key to replace this one.`,
      };
    }
    case 'forbidden': {
      return {
        kind: diag.kind,
        short: rejectionLine(providerId, diag, 'rejected the request'),
        long:
          `${providerId} blocked the request at the project / account level — common after rapid key creation, region restrictions, or unusual activity.\n` +
          `Possible fixes:\n` +
          `- Wait 24h for auto-review\n` +
          `- Create a new project in your provider console and a new key in it (${urls.keys})\n` +
          `- Contact ${providerId} support`,
        suggestion: `This is a project-level block, not a key issue. Switch back to mod8 with 'mod8'.`,
      };
    }
    case 'rate-limit': {
      const code = diag.code ?? 429;
      const delay = diag.retryDelaySeconds;
      const tail = diag.rawMessage ? `: ${quote(diag.rawMessage)}` : '';
      const delayHint = delay ? ` (retry in ${delay}s)` : '';
      return {
        kind: diag.kind,
        short: `${providerId} rate-limited the request (HTTP ${code})${delayHint}${tail}`,
        long: delay
          ? `Rate limited. The provider asked us to wait ${delay} seconds before retrying. ` +
            `If this persists, you may be on a low-tier limit — see ${urls.billing}.`
          : `Rate limited. Wait a few seconds and retry. ` +
            `If this persists, you may be on a free or low-tier plan with tight limits — see ${urls.billing}.`,
        suggestion: delay
          ? `Type 'mod8' to switch back, or wait ${delay}s and retry.`
          : `Type 'mod8' to switch back, or wait a few seconds and retry.`,
      };
    }
    case 'no-credit': {
      return {
        kind: diag.kind,
        short: rejectionLine(providerId, diag, 'reports insufficient credit'),
        long:
          `Out of credit / billing not active. Top up at ${urls.billing}.\n` +
          `Note: free-tier quotas can take ~10 minutes to activate after a new key is created — if you JUST created the key, wait and retry.`,
        suggestion: `Type 'mod8' to switch back, or top up at ${urls.billing}.`,
      };
    }
    case 'server': {
      return {
        kind: diag.kind,
        short: rejectionLine(providerId, diag, 'returned a server error'),
        long: `${providerId} is having issues right now. Try again in a few minutes; if it persists, check the provider's status page.`,
        suggestion: `Type 'mod8' to switch back, or retry shortly.`,
      };
    }
    case 'network': {
      const tail = diag.rawMessage ? `: ${quote(diag.rawMessage)}` : '';
      return {
        kind: diag.kind,
        short: `couldn't reach ${providerId}${tail}`,
        long: `Network error. Check your internet connection — DNS, VPN, or firewall.`,
        suggestion: `Type 'mod8' to switch back. Check your connection and retry.`,
      };
    }
    case 'timeout': {
      const tail = diag.rawMessage ? `: ${quote(diag.rawMessage)}` : '';
      return {
        kind: diag.kind,
        short: `request to ${providerId} timed out${tail}`,
        long: `The request took too long. The provider may be overloaded or your network is slow.`,
        suggestion: `Type 'mod8' to switch back, or retry shortly.`,
      };
    }
    case 'model': {
      const tail = diag.rawMessage ? `: ${quote(diag.rawMessage)}` : '';
      return {
        kind: diag.kind,
        short: `${providerId} model not available${tail}`,
        long: `The configured model isn't available for this account. Set \`MOD8_${providerId.toUpperCase()}_MODEL\` to override, or pick a different provider.`,
        suggestion: `Type 'mod8' to switch back, or switch to a different model.`,
      };
    }
    default: {
      // 'other' — generic fallback.  We do NOT pretend to diagnose; just
      // surface the raw message and give a minimal escape suggestion.
      const tail = diag.rawMessage ? `: ${quote(diag.rawMessage)}` : '';
      return {
        kind: diag.kind,
        short: `${providerId} failed${tail}`,
        long: '',
        suggestion: `Type 'mod8' to switch back.`,
      };
    }
  }
}

