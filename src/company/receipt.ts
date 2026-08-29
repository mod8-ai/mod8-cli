/**
 * company/receipt.ts — the Friday receipt.
 *
 * What the founder pays for is not diffs; it is outcomes and a hit rate:
 * how many ticks ran, what the Harness proposed, what he approved, what
 * merged, what was measured, what it cost, and what still needs him.
 *
 * `buildReceiptDigest` is deterministic (no LLM) and reads only the
 * per-product files under products/<slug>/ (audit, proposals index,
 * approval index + archive, spend, marketing questions).  `renderReceipt`
 * turns it into markdown; `writeReceipt` files it under receipts/;
 * `narrateReceipt` optionally puts a short plain narrative on top using
 * the same provider selection as `mod8 standup`.
 *
 * Markers used (verified against a real products/mod8/ on 2026-08-28):
 *   · ticks         audit.jsonl  kind 'tick.start'
 *   · measurements  audit.jsonl  kind 'measure.complete' payload.intendedOutcomeMet
 *   · proposals     proposals/index.jsonl (latest entry per id)
 *   · cards         approvals/index.jsonl (latest state per id) + store.load
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, buildProductContext, productFiles } from '../memory/paths.js';
import * as approvalStore from '../approval/store.js';
import * as proposals from '../loop/proposal.js';
import { listProductSlugs } from './brain.js';
import { answerHint, openMarketingQuestions } from './marketing.js';
import { streamProviderChat } from '../providers/genericChat.js';
import { readAuth } from '../storage/auth.js';
import { configuredProviderIds, resolveConfigured } from '../storage/providers.js';
import { classifyError } from '../util/errors.js';
import type { ApprovalItem } from '../approval/types.js';

const DAY = 86_400_000;
const STALE_AFTER_MS = 3 * DAY;
const HOST_PROVIDER_ID = 'anthropic';

export interface ReceiptCard {
  id: string;
  title: string;
  kind: string;
  state: string;
  createdAt: number;
  decidedAt?: number;
  appliedAt?: number;
  /** sha7 when the applied result carried a newSha. */
  sha?: string;
}

export interface ReceiptCardCounts {
  created: number;
  approved: number;
  rejected: number;
  applied: number;
  failed: number;
  pending: number;
}

export interface ReceiptMeasurements {
  /** measure.complete audit entries in the window. */
  total: number;
  met: number;
  notMet: number;
  inconclusive: number;
}

export interface ProductReceipt {
  slug: string;
  name: string;
  ticks: number;
  proposals: number;
  cards: ReceiptCardCounts;
  /** approved / (approved + rejected), null when nothing was decided. */
  hitRate: number | null;
  merges: ReceiptCard[];
  marketingPosts: ReceiptCard[];
  measurements: ReceiptMeasurements | null;
  spendUsd: number;
  openQuestions: string[];
  pendingCards: ReceiptCard[];
  /** Pending for more than 3 days. */
  staleCards: ReceiptCard[];
}

export interface ReceiptDigest {
  days: number;
  sinceMs: number;
  now: number;
  /** Set when the digest was restricted to one project (`--slug`). */
  slug?: string;
  /** True when `--slug` named a project that is not connected. */
  unknownSlug?: boolean;
  products: ProductReceipt[];
  totals: {
    ticks: number;
    proposals: number;
    cards: ReceiptCardCounts;
    hitRate: number | null;
    merges: number;
    marketingPosts: number;
    spendUsd: number;
    openQuestions: number;
    staleCards: number;
  };
}

export interface ReceiptOptions {
  /** Window in days, default 7. */
  days?: number;
  /** Only this product. */
  slug?: string;
  /** Clock, default Date.now() — pass a fixed value in specs. */
  now?: number;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  let buf: string;
  try { buf = await fs.readFile(path, 'utf8'); } catch { return out; }
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* skip bad line */ }
  }
  return out;
}

function inWindow(ts: number | undefined, since: number, now: number): boolean {
  return typeof ts === 'number' && ts >= since && ts <= now;
}

function toReceiptCard(it: ApprovalItem): ReceiptCard {
  const newSha = it.appliedResult?.newSha;
  return {
    id: it.id,
    title: it.title,
    kind: it.kind,
    state: it.state,
    createdAt: it.createdAt,
    ...(it.decidedAt !== undefined ? { decidedAt: it.decidedAt } : {}),
    ...(it.appliedAt !== undefined ? { appliedAt: it.appliedAt } : {}),
    ...(typeof newSha === 'string' && newSha ? { sha: newSha.slice(0, 7) } : {}),
  };
}

function emptyCounts(): ReceiptCardCounts {
  return { created: 0, approved: 0, rejected: 0, applied: 0, failed: 0, pending: 0 };
}

function hitRateOf(c: ReceiptCardCounts): number | null {
  const decided = c.approved + c.rejected;
  return decided === 0 ? null : c.approved / decided;
}

async function readProduct(slug: string, since: number, now: number): Promise<ProductReceipt> {
  const ctx = buildProductContext(slug, process.cwd(), 0);

  let name = slug;
  try {
    const md = await fs.readFile(productFiles.productMd(ctx), 'utf8');
    name = md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
  } catch { /* no charter */ }

  // Ticks + measurements from the audit chain.
  const audit = await readJsonl<{ ts?: number; kind?: string; payload?: Record<string, unknown> }>(productFiles.audit(ctx));
  let ticks = 0;
  let measurements: ReceiptMeasurements | null = null;
  for (const e of audit) {
    if (!inWindow(e.ts, since, now)) continue;
    if (e.kind === 'tick.start') ticks++;
    if (e.kind === 'measure.complete') {
      measurements ??= { total: 0, met: 0, notMet: 0, inconclusive: 0 };
      measurements.total++;
      const met = e.payload?.intendedOutcomeMet;
      if (met === true) measurements.met++;
      else if (met === false) measurements.notMet++;
      else measurements.inconclusive++;
    }
  }

  // Proposals created in the window.
  let proposalCount = 0;
  try {
    proposalCount = (await proposals.list(ctx)).filter((p) => inWindow(p.createdAt, since, now)).length;
  } catch { /* none */ }

  // Cards: index gives the latest state per id; load each card that was
  // created or decided in the window for decidedAt / appliedAt / sha.
  const cards = emptyCounts();
  const merges: ReceiptCard[] = [];
  const marketingPosts: ReceiptCard[] = [];
  const pendingCards: ReceiptCard[] = [];
  const staleCards: ReceiptCard[] = [];
  let index: Awaited<ReturnType<typeof approvalStore.readIndex>> = [];
  try { index = await approvalStore.readIndex(ctx); } catch { /* none */ }
  for (const entry of index) {
    const isPending = entry.state === 'pending' || entry.state === 'pending-revalidation' || entry.state === 'revalidation-failed';
    // Skip cards clearly outside the window: created after now, or created
    // before the window and not pending (their decision could still be in
    // the window, so load to check).
    if (entry.createdAt > now) continue;
    let item: ApprovalItem | null = null;
    try { item = await approvalStore.load(ctx, entry.id); } catch { /* skip */ }
    if (!item) continue;
    const card = toReceiptCard(item);
    if (inWindow(item.createdAt, since, now)) cards.created++;

    if (isPending) {
      cards.pending++;
      pendingCards.push(card);
      if (now - item.createdAt > STALE_AFTER_MS) staleCards.push(card);
      continue;
    }
    if (!inWindow(item.decidedAt ?? item.appliedAt, since, now)) continue;

    switch (item.state) {
      case 'rejected':
        cards.rejected++;
        break;
      case 'approved':
        cards.approved++;
        break;
      case 'applied':
      case 'rolled-back':
        cards.approved++;
        cards.applied++;
        if (card.sha) merges.push(card);
        if (item.kind === 'marketing') marketingPosts.push(card);
        break;
      case 'failed':
        cards.approved++;
        cards.failed++;
        break;
      default:
        break; // stale etc. — not a decision
    }
  }
  pendingCards.sort((a, b) => a.createdAt - b.createdAt);
  merges.sort((a, b) => (a.appliedAt ?? 0) - (b.appliedAt ?? 0));

  // Spend in window.
  let spendUsd = 0;
  for (const e of await readJsonl<{ ts?: number; costUsd?: number }>(productFiles.spend(ctx))) {
    if (inWindow(e.ts, since, now)) spendUsd += e.costUsd ?? 0;
  }

  // Open marketing questions (latest entry per question unanswered), in
  // the same order `mod8 marketing status` numbers them.
  let openQuestions: string[] = [];
  try { openQuestions = await openMarketingQuestions(slug); } catch { /* none */ }

  return {
    slug,
    name,
    ticks,
    proposals: proposalCount,
    cards,
    hitRate: hitRateOf(cards),
    merges,
    marketingPosts,
    measurements,
    spendUsd,
    openQuestions,
    pendingCards,
    staleCards,
  };
}

/** Deterministic company-wide digest for the window.  No LLM, no network. */
export async function buildReceiptDigest(opts: ReceiptOptions = {}): Promise<ReceiptDigest> {
  const days = opts.days ?? 7;
  const now = opts.now ?? Date.now();
  const since = now - days * DAY;
  let slugs = await listProductSlugs();
  let unknownSlug = false;
  if (opts.slug) {
    slugs = slugs.filter((s) => s === opts.slug);
    unknownSlug = slugs.length === 0;
  }
  const products: ProductReceipt[] = [];
  for (const slug of slugs) {
    try { products.push(await readProduct(slug, since, now)); } catch { /* unreadable product — leave it out */ }
  }
  const cards = emptyCounts();
  for (const p of products) for (const k of Object.keys(cards) as (keyof ReceiptCardCounts)[]) cards[k] += p.cards[k];
  return {
    days,
    sinceMs: since,
    now,
    ...(opts.slug ? { slug: opts.slug, unknownSlug } : {}),
    products,
    totals: {
      ticks: products.reduce((n, p) => n + p.ticks, 0),
      proposals: products.reduce((n, p) => n + p.proposals, 0),
      cards,
      hitRate: hitRateOf(cards),
      merges: products.reduce((n, p) => n + p.merges.length, 0),
      marketingPosts: products.reduce((n, p) => n + p.marketingPosts.length, 0),
      spendUsd: products.reduce((n, p) => n + p.spendUsd, 0),
      openQuestions: products.reduce((n, p) => n + p.openQuestions.length, 0),
      staleCards: products.reduce((n, p) => n + p.staleCards.length, 0),
    },
  };
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function pct(r: number | null): string {
  return r === null ? 'n/a' : `${Math.round(r * 100)}%`;
}

function daysPending(card: ReceiptCard, now: number): number {
  return Math.floor((now - card.createdAt) / DAY);
}

/** Markdown receipt.  Numbers only — no adjectives. */
export function renderReceipt(d: ReceiptDigest): string {
  const L: string[] = [];
  const c = d.totals.cards;
  L.push(`# Friday receipt — ${isoDate(d.sinceMs)} → ${isoDate(d.now)}`);
  L.push('');
  L.push(
    `company: ${d.products.length} projects · spend $${d.totals.spendUsd.toFixed(3)} · ticks ${d.totals.ticks} · proposals ${d.totals.proposals} · ` +
    `cards decided ${c.approved + c.rejected} (approved ${c.approved}, rejected ${c.rejected}) · hit rate ${pct(d.totals.hitRate)} · ` +
    `merges ${d.totals.merges} · posts ${d.totals.marketingPosts} · pending ${c.pending}`
  );
  if (d.products.length === 0) {
    L.push('');
    if (d.unknownSlug) L.push(`no such project "${d.slug}" — see \`mod8 projects\` for the connected ones`);
    else L.push('no projects connected — run `mod8 connect add <slug>` inside a repo');
  }
  for (const p of d.products) {
    L.push('');
    L.push(`## ${p.name}  (${p.slug})`);
    L.push(`- ticks ${p.ticks} · proposals ${p.proposals} · spend $${p.spendUsd.toFixed(3)}`);
    L.push(
      `- cards: created ${p.cards.created} · approved ${p.cards.approved} · rejected ${p.cards.rejected} · ` +
      `applied ${p.cards.applied} · failed ${p.cards.failed} · pending ${p.cards.pending} · hit rate ${pct(p.hitRate)}`
    );
    if (p.merges.length === 0) L.push('- merges: 0');
    else {
      L.push(`- merges: ${p.merges.length}`);
      for (const m of p.merges) L.push(`  - ${m.sha} ${m.title} (${m.id})`);
    }
    if (p.marketingPosts.length > 0) {
      L.push(`- posts published: ${p.marketingPosts.length}`);
      for (const m of p.marketingPosts) L.push(`  - ${m.title} (${m.id})`);
    }
    if (p.measurements) {
      const m = p.measurements;
      L.push(`- measurements: ${m.total} (met ${m.met}, not met ${m.notMet}, inconclusive ${m.inconclusive})`);
    } else {
      L.push('- measurements: no measurements yet');
    }
    if (p.staleCards.length > 0) L.push(`- stale cards (pending > 3 days): ${p.staleCards.length}`);
    if (p.openQuestions.length > 0) L.push(`- open questions: ${p.openQuestions.length}`);
  }

  const needs: string[] = [];
  for (const p of d.products) {
    for (const card of p.pendingCards) {
      const age = daysPending(card, d.now);
      needs.push(`- [a] ${card.id} · ${p.slug} · ${card.kind} · pending ${age}d${age > 3 ? ' (stale)' : ''} — ${card.title}\n    → /approve ${card.id}   or   /reject ${card.id}   (shell: mod8 approvals-cli decide ${card.id} approve --slug ${p.slug})`);
    }
    p.openQuestions.forEach((q, i) => needs.push(`- [q] ${p.slug} #${i + 1} — ${q}\n    → ${answerHint(p.slug, i + 1)}`));
  }
  L.push('');
  L.push('## Needs you:');
  if (needs.length === 0) L.push('- nothing');
  else L.push(...needs);
  return L.join('\n') + '\n';
}

/** Save the company-wide receipt under CONFIG_DIR/receipts/<YYYY-MM-DD>.md
 *  and return the absolute path.  Same-day runs overwrite. */
export async function writeReceipt(d: ReceiptDigest, md: string): Promise<string> {
  const dir = join(CONFIG_DIR, 'receipts');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${isoDate(d.now)}.md`);
  await fs.writeFile(path, md, { encoding: 'utf8', mode: 0o600 });
  return path;
}

const NARRATE_SYSTEM = `You are mod8, running the founder's companies. Below is this week's receipt: numbers only. Write 6 to 10 short plain lines for a non-developer founder: what got done, what the hit rate says, what it cost, and what needs him now. For every item under "Needs you" quote the exact command on its "→" line (the /approve <id> or mod8 marketing answer … line) so he can copy it. Use only the numbers and commands given; never invent. No headings, no bullets, no preamble.`;

/** Pick a provider the same way `mod8 standup` does: --provider override →
 *  local Anthropic key → any local key → proxy (when logged in).  Returns
 *  null when nothing can answer. */
async function pickProvider(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  if (await resolveConfigured(HOST_PROVIDER_ID)) return HOST_PROVIDER_ID;
  const ids = await configuredProviderIds();
  if (ids.length > 0) return ids[0]!;
  return (await readAuth()) ? HOST_PROVIDER_ID : null;
}

/** Optional plain narrative on top of the markdown.  Never throws: on any
 *  failure it returns the raw receipt preceded by a one-line notice. */
export async function narrateReceipt(md: string, opts: { provider?: string } = {}): Promise<string> {
  const explicit = opts.provider ?? process.env.MOD8_RECEIPT_PROVIDER?.trim() ?? process.env.MOD8_STANDUP_PROVIDER?.trim();
  let providerId: string | null = null;
  try { providerId = await pickProvider(explicit || undefined); } catch { providerId = null; }
  if (!providerId) {
    return `(no provider key configured — showing the raw receipt; add one with \`mod8 keys set <provider>\`)\n\n${md}`;
  }
  let text = '';
  try {
    for await (const ev of streamProviderChat({ providerId, system: NARRATE_SYSTEM, maxTokens: 1_200, messages: [{ role: 'user', content: md }] })) {
      if (ev.type === 'text') text += ev.delta;
    }
  } catch (err) {
    const why = (() => { try { return classifyError(err, providerId!); } catch { return err instanceof Error ? err.message : String(err); } })();
    return `(narrative unavailable via ${providerId}: ${why} — showing the raw receipt)\n\n${md}`;
  }
  text = text.trim();
  if (!text) return `(narrative empty via ${providerId} — showing the raw receipt)\n\n${md}`;
  return `${text}\n\n${md}`;
}
