/**
 * Billing client — calls the mod8 proxy for balance + Stripe Checkout.
 *
 * Expected proxy endpoints (must be implemented on the proxy side; see
 * docs/PROXY_BILLING_CONTRACT.md):
 *
 *   GET /v1/me
 *     Authorization: Bearer <sk-mod8-...>
 *     → 200 { email, availableMicros }
 *
 *   POST /v1/billing/checkout
 *     Authorization: Bearer <sk-mod8-...>
 *     Body: { amountUsd: number }   // dollars, integer ≥ 5
 *     → 200 { url: string, sessionId: string }     // Stripe Checkout URL
 *     → 404 / 501 when billing is not yet enabled on this proxy
 *
 * When the proxy returns 404/501 for /v1/billing/checkout (because the
 * mod8-proxy deployment is older than the CLI), surface a clear "upgrade
 * mod8-proxy" message instead of a stack trace.
 */

import chalk from 'chalk';
import { readAuth, effectiveProxyUrl } from '../storage/auth.js';
import { openInBrowser } from '../util/browser.js';

export const LOW_BALANCE_THRESHOLD_MICROS = 2_000_000; // $2.00
export const TOPUP_AMOUNTS_USD = [10, 25, 50, 100, 200] as const;

export interface BalanceInfo {
  email?: string;
  availableMicros: number;
}

export interface CheckoutInfo {
  url: string;
  sessionId: string;
}

export class BillingNotConfigured extends Error {
  constructor(public readonly endpoint: string) {
    super(`Billing endpoint ${endpoint} is not deployed on this proxy yet. Upgrade mod8-proxy to enable Stripe top-ups.`);
    this.name = 'BillingNotConfigured';
  }
}

export class NotLoggedIn extends Error {
  constructor() {
    super('Not logged in to mod8. Run `mod8 login` first.');
    this.name = 'NotLoggedIn';
  }
}

async function authedRequestContext(): Promise<{ headers: Record<string, string>; baseUrl: string }> {
  const auth = await readAuth();
  if (!auth) throw new NotLoggedIn();
  return {
    headers: { Authorization: `Bearer ${auth.mod8Key}` },
    baseUrl: effectiveProxyUrl(auth),
  };
}

export async function getBalance(): Promise<BalanceInfo> {
  const { headers, baseUrl } = await authedRequestContext();
  const resp = await fetch(`${baseUrl}/v1/me`, { headers });
  if (resp.status === 404 || resp.status === 501) {
    throw new BillingNotConfigured('/v1/me');
  }
  if (resp.status === 401) {
    throw new Error('Bearer token rejected. Try `mod8 logout` then `mod8 login` again.');
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`/v1/me failed: ${resp.status} ${detail.slice(0, 160)}`);
  }
  const body = (await resp.json()) as { email?: string; availableMicros?: number };
  const availableMicros = typeof body.availableMicros === 'number' ? body.availableMicros : 0;
  return { ...(body.email ? { email: body.email } : {}), availableMicros };
}

export async function createCheckout(amountUsd: number): Promise<CheckoutInfo> {
  if (!Number.isFinite(amountUsd) || amountUsd < 5) {
    throw new Error(`Top-up amount must be at least $5 (got ${amountUsd}).`);
  }
  const ctx = await authedRequestContext();
  const resp = await fetch(`${ctx.baseUrl}/v1/billing/checkout`, {
    method: 'POST',
    headers: { ...ctx.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountUsd: Math.round(amountUsd) }),
  });
  if (resp.status === 404 || resp.status === 501) {
    throw new BillingNotConfigured('/v1/billing/checkout');
  }
  if (resp.status === 401) {
    throw new Error('Bearer token rejected. Try `mod8 logout` then `mod8 login` again.');
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`/v1/billing/checkout failed: ${resp.status} ${detail.slice(0, 160)}`);
  }
  const body = (await resp.json()) as { url?: string; sessionId?: string };
  if (!body.url || !body.sessionId) {
    throw new Error('Proxy returned a malformed checkout response (missing url or sessionId).');
  }
  return { url: body.url, sessionId: body.sessionId };
}

/** Open a Stripe Checkout session for the given amount.  Handles the
 *  full UX: prints what's happening, opens the browser, prints the URL
 *  as fallback for headless terminals. */
export async function openTopupCheckout(amountUsd: number): Promise<void> {
  const info = await createCheckout(amountUsd);
  process.stdout.write(
    chalk.bold(`mod8 top-up — $${amountUsd}\n`) +
    chalk.dim(`Opening Stripe Checkout in your browser…\n`) +
    chalk.dim(`If it doesn't open: ${chalk.cyan(info.url)}\n`)
  );
  const opened = await openInBrowser(info.url);
  if (!opened.ok) {
    process.stdout.write(chalk.yellow(`(couldn't auto-open — copy the URL above)\n`));
  }
}

/** Format a micros amount as a USD string ($X.YZ). */
export function formatUsdMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
