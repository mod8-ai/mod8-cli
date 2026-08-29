/**
 * company/sync.ts — `mod8 sync` / `/sync`: the CLI ↔ web bridge for the
 * company brain.
 *
 * The truth stays on disk (~/.config/mod8/products/<slug>/).  Sync mirrors
 * it to the mod8 backend so the web dashboard can show projects + cards,
 * and brings back decisions the founder made on the web:
 *
 *   1. build the payload from local products (charter, tick, spend, cards)
 *   2. POST /syncCompany  → { decisions: [...] } (web decisions not yet acked)
 *   3. apply each decision through the SAME path as /approve and /reject
 *      (brain.decideCard → store.decide → act)
 *   4. POST /ackCompanyDecisions with applied/failed per card
 *
 * Auth = the CLI's sk-mod8- key from `mod8 login`.  The API base is the
 * Cloud Functions host; override with MOD8_API_BASE (specs point it at a
 * local mock).  Never exits the process — callers print + set exit codes.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { readAuth } from '../storage/auth.js';
import { buildProductContext, productFiles } from '../memory/paths.js';
import * as approvalStore from '../approval/store.js';
import * as loopState from '../loop/state.js';
import type { ApprovalItem, ApprovalState } from '../approval/types.js';
import type { PhaseEvent } from '../loop/types.js';
import { decideCard, listProductSlugs, readProject } from './brain.js';

export const DEFAULT_API_BASE = 'https://us-central1-mod8-495901.cloudfunctions.net';

export function apiBase(): string {
  return (process.env.MOD8_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
}

export type CardStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';

export interface SyncCard {
  id: string;
  slug: string;
  kind: string;
  title: string;
  summary: string;
  risk: string;
  impact: string;
  tests: string;
  diffStats: { files: number; additions: number; deletions: number } | null;
  post: { channel: string; text: string } | null;
  status: CardStatus;
  decidedBy: 'cli' | 'web' | null;
  decidedAt: number | null;
  ackedByCli: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SyncProject {
  slug: string;
  name: string;
  charter: string;
  lastTick: { id: number; at: number | null; phase: string | null; status: string } | null;
  spend7dMicros: number;
  pendingCount: number;
  marketing: string | null;
  updatedAt: number;
  syncedFrom: 'cli';
  cards: SyncCard[];
}

export interface SyncDecision { slug: string; cardId: string; status: 'approved' | 'rejected'; decidedAt: number }
export interface AckItem { slug: string; cardId: string; result: 'applied' | 'failed'; error?: string }

const SUMMARY_MAX = 2000;
/** Decided cards younger than this ride along so the web shows history. */
const HISTORY_MS = 7 * 86_400_000;

function mapState(state: ApprovalState): CardStatus | null {
  switch (state) {
    case 'pending':
    case 'pending-revalidation':
    case 'revalidation-failed':
      return 'pending';
    case 'approved': return 'approved';
    case 'applied': return 'applied';
    case 'failed': return 'failed';
    case 'rejected': return 'rejected';
    default: return null; // rolled-back / stale: not shown
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function toSyncCard(it: ApprovalItem, now: number): SyncCard | null {
  const status = mapState(it.state);
  if (!status) return null;
  const pa = it.proposedAction;
  const ds = 'diffStats' in pa ? pa.diffStats : it.evidence.diffStats;
  const summaryParts = [it.reason];
  if (pa.type === 'git-pr' && pa.body) summaryParts.push(pa.body);
  const testsLine =
    it.evidence.testsPassed === undefined ? '' :
    it.evidence.testsPassed ? 'tests green' : 'tests RED';
  const tests = [testsLine, it.evidence.testOutput ? clip(it.evidence.testOutput, 1500) : '']
    .filter(Boolean).join('\n');
  const appliedErr = (it.appliedResult as { error?: unknown } | undefined)?.error;
  return {
    id: it.id,
    slug: it.productSlug,
    kind: it.kind,
    title: it.title,
    summary: clip(summaryParts.filter(Boolean).join('\n\n'), SUMMARY_MAX),
    risk: it.risk,
    impact: it.impact,
    tests: status === 'failed' && typeof appliedErr === 'string' ? `${tests}\nact failed: ${appliedErr}`.trim() : tests,
    diffStats: ds ? { files: ds.files, additions: ds.added, deletions: ds.removed } : null,
    post: pa.type === 'social-post' ? { channel: pa.channel, text: pa.text } : null,
    status,
    decidedBy: status === 'pending' ? null : 'cli',
    decidedAt: status === 'pending' ? null : it.decidedAt ?? null,
    ackedByCli: status !== 'pending',
    createdAt: it.createdAt,
    updatedAt: now,
  };
}

async function readTickStatus(slug: string, tickId: number): Promise<string> {
  const ctx = buildProductContext(slug, process.cwd(), 0);
  const p = productFiles.events(ctx);
  if (!existsSync(p) || tickId === 0) return 'unknown';
  let status = 'ok';
  for (const line of (await fs.readFile(p, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as PhaseEvent;
      if (e.tickId !== tickId) continue;
      if (e.kind === 'error') status = 'failed';
      else if (e.kind === 'budget-exhausted' && status === 'ok') status = 'budget-exhausted';
      else if (e.kind === 'kill-switch' && status === 'ok') status = 'halted';
    } catch { /* skip bad line */ }
  }
  return status;
}

export async function buildSyncProject(slug: string, now = Date.now()): Promise<SyncProject> {
  const p = await readProject(slug);
  const ctx = buildProductContext(slug, process.cwd(), 0);
  const cards: SyncCard[] = [];
  const seen = new Set<string>();
  for (const it of await approvalStore.listPending(ctx).catch(() => [] as ApprovalItem[])) {
    const c = toSyncCard(it, now);
    if (c) { cards.push(c); seen.add(c.id); }
  }
  // Recently decided cards (7 days) — so the web shows what happened, and so
  // a web-decided card the CLI already applied is reported back as such.
  for (const entry of await approvalStore.readIndex(ctx).catch(() => [])) {
    if (seen.has(entry.id) || entry.state === 'pending') continue;
    if (entry.createdAt < now - HISTORY_MS) continue;
    const it = await approvalStore.load(ctx, entry.id).catch(() => null);
    if (!it) continue;
    const c = toSyncCard(it, now);
    if (c) { cards.push(c); seen.add(c.id); }
  }
  let phase: string | null = null;
  try { phase = (await loopState.load(ctx)).lastPhase ?? null; } catch { /* none */ }
  return {
    slug,
    name: p.name,
    charter: p.charter,
    lastTick: p.lastTickId > 0
      ? { id: p.lastTickId, at: p.lastTickAt, phase, status: await readTickStatus(slug, p.lastTickId) }
      : null,
    spend7dMicros: Math.round(p.spend7dUsd * 1_000_000),
    pendingCount: p.pending.length,
    marketing: p.marketing.length ? p.marketing.join('\n') : null,
    updatedAt: now,
    syncedFrom: 'cli',
    cards,
  };
}

export async function buildSyncPayload(slugFilter?: string): Promise<SyncProject[]> {
  const slugs = await listProductSlugs();
  const chosen = slugFilter ? slugs.filter((s) => s === slugFilter) : slugs;
  const now = Date.now();
  const out: SyncProject[] = [];
  for (const s of chosen) out.push(await buildSyncProject(s, now));
  return out;
}

export class NotLoggedInForSync extends Error {
  constructor() { super('not logged in — run `mod8 login` first (sync needs your mod8 key)'); this.name = 'NotLoggedInForSync'; }
}

async function post<T>(path: string, bearer: string, body: unknown): Promise<T> {
  const url = `${apiBase()}/${path}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`could not reach ${url} — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (resp.status === 401) throw new Error('mod8 key not recognized by the backend — run `mod8 logout` then `mod8 login`');
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

export interface SyncProjectResult {
  slug: string;
  cardsUp: number;
  pending: number;
  decisions: Array<{ cardId: string; status: 'approved' | 'rejected'; result: 'applied' | 'failed'; message: string }>;
}

export interface SyncResult {
  dryRun: boolean;
  apiBase: string;
  projects: SyncProjectResult[];
  decisionsApplied: number;
  decisionsFailed: number;
}

export interface SyncOptions { slug?: string; dryRun?: boolean }

/** The whole round trip.  Throws NotLoggedInForSync when auth.json is absent
 *  (also for --dry-run: a dry run still tells you it would not be able to send). */
export async function runSync(opts: SyncOptions = {}): Promise<SyncResult> {
  const auth = await readAuth();
  if (!auth) throw new NotLoggedInForSync();
  const projects = await buildSyncPayload(opts.slug);
  if (opts.slug && projects.length === 0) throw new Error(`no such project: ${opts.slug} (see \`mod8 projects\`)`);

  const results: SyncProjectResult[] = projects.map((p) => ({ slug: p.slug, cardsUp: p.cards.length, pending: p.pendingCount, decisions: [] }));
  const base = apiBase();
  if (opts.dryRun) return { dryRun: true, apiBase: base, projects: results, decisionsApplied: 0, decisionsFailed: 0 };

  const synced = await post<{ decisions?: SyncDecision[] }>('syncCompany', auth.mod8Key, { projects });
  const decisions = Array.isArray(synced.decisions) ? synced.decisions : [];

  const acks: AckItem[] = [];
  let applied = 0;
  let failed = 0;
  for (const d of decisions) {
    if (d.status !== 'approved' && d.status !== 'rejected') continue;
    const r = await decideCard(d.cardId, d.status === 'approved' ? 'approve' : 'reject', d.slug);
    const result: 'applied' | 'failed' = r.ok ? 'applied' : 'failed';
    if (r.ok) applied++; else failed++;
    acks.push({ slug: d.slug, cardId: d.cardId, result, ...(r.ok ? {} : { error: r.message }) });
    let row = results.find((x) => x.slug === d.slug);
    if (!row) { row = { slug: d.slug, cardsUp: 0, pending: 0, decisions: [] }; results.push(row); }
    row.decisions.push({ cardId: d.cardId, status: d.status, result, message: r.message });
  }
  if (acks.length) await post('ackCompanyDecisions', auth.mod8Key, { items: acks });

  return { dryRun: false, apiBase: base, projects: results, decisionsApplied: applied, decisionsFailed: failed };
}

/** The short table `mod8 sync` and `/sync` print. */
export function renderSync(r: SyncResult): string {
  const out: string[] = [];
  if (r.projects.length === 0) return 'no projects connected — run `mod8 connect add <slug>` inside a repo\n';
  out.push(`${'project'.padEnd(14)} ${'cards up'.padEnd(9)} ${'waiting'.padEnd(8)} decisions applied`);
  for (const p of r.projects) {
    const dec = p.decisions.length === 0
      ? '0'
      : `${p.decisions.filter((d) => d.result === 'applied').length}/${p.decisions.length}`;
    out.push(`${p.slug.padEnd(14)} ${String(p.cardsUp).padEnd(9)} ${String(p.pending).padEnd(8)} ${dec}`);
    for (const d of p.decisions) out.push(`  ${d.result === 'applied' ? '✓' : '✗'} ${d.status} (web) ${d.message}`);
  }
  if (r.dryRun) out.push(`dry run — nothing sent to ${r.apiBase}`);
  else out.push(`synced ${r.projects.length} project${r.projects.length === 1 ? '' : 's'} → ${r.apiBase}` +
    (r.decisionsApplied + r.decisionsFailed > 0 ? ` · web decisions: ${r.decisionsApplied} applied, ${r.decisionsFailed} failed` : ' · no web decisions waiting'));
  return out.join('\n') + '\n';
}
