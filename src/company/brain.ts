/**
 * company/brain.ts — the company context the chat REPL (and later the web)
 * talks from.
 *
 * Everything the Harness knows lives on disk under ~/.config/mod8/products/
 * (charter, policy, proposals, approvals, events, spend, loop state).  Until
 * now the chat never read any of it: `mod8` could answer about the folder
 * you sat in, not about your companies.  This module turns those files into
 * one prompt block plus the three verbs a founder needs in conversation:
 *
 *   · list projects + what is waiting for [a]
 *   · approve / reject a card (dispatches act exactly like the panel)
 *   · state a rule in plain English → it lands in the charter
 *
 * Read-only except addCharterRule (appends one bullet) and decide (goes
 * through the approval store, same as approvals-cli).
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCTS_ROOT, RESERVED_PRODUCT_SLUGS, buildProductContext, productFiles } from '../memory/paths.js';
import * as approvalStore from '../approval/store.js';
import * as loopState from '../loop/state.js';
import { loadPolicy } from '../loop/policy.js';
import { run as runAct } from '../loop/phases/act.js';
import type { ApprovalItem } from '../approval/types.js';

export interface PendingCard {
  id: string;
  title: string;
  kind: string;
  risk: string;
  impact: string;
  testsPassed?: boolean;
  files?: number;
  added?: number;
  removed?: number;
  createdAt: number;
}

export interface ProjectBrain {
  slug: string;
  /** First heading of product.md, e.g. "Hotel-Agents.ai (Aira)". */
  name: string;
  charter: string;
  hasCharter: boolean;
  lastTickId: number;
  lastTickAt: number | null;
  spend7dUsd: number;
  pending: PendingCard[];
}

export interface CompanyBrain {
  projects: ProjectBrain[];
  readAt: number;
}

/** Connected product slugs (directories under products/ minus reserved). */
export async function listProductSlugs(): Promise<string[]> {
  if (!existsSync(PRODUCTS_ROOT)) return [];
  const entries = await fs.readdir(PRODUCTS_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !RESERVED_PRODUCT_SLUGS.includes(e.name))
    .map((e) => e.name)
    .sort();
}

async function readSpend7d(slug: string): Promise<number> {
  const p = join(PRODUCTS_ROOT, slug, 'spend.jsonl');
  if (!existsSync(p)) return 0;
  const since = Date.now() - 7 * 86_400_000;
  let total = 0;
  for (const line of (await fs.readFile(p, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { ts?: number; costUsd?: number };
      if ((e.ts ?? 0) >= since) total += e.costUsd ?? 0;
    } catch { /* skip bad line */ }
  }
  return total;
}

function toCard(it: ApprovalItem): PendingCard {
  return {
    id: it.id,
    title: it.title,
    kind: it.kind,
    risk: it.risk,
    impact: it.impact,
    createdAt: it.createdAt,
    ...(it.evidence.testsPassed !== undefined ? { testsPassed: it.evidence.testsPassed } : {}),
    ...(it.evidence.diffStats
      ? { files: it.evidence.diffStats.files, added: it.evidence.diffStats.added, removed: it.evidence.diffStats.removed }
      : {}),
  };
}

export async function readProject(slug: string): Promise<ProjectBrain> {
  const ctx = buildProductContext(slug, process.cwd(), 0);
  const charterPath = productFiles.productMd(ctx);
  const hasCharter = existsSync(charterPath);
  const charter = hasCharter ? await fs.readFile(charterPath, 'utf8') : '';
  const name = charter.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
  let lastTickId = 0;
  let lastTickAt: number | null = null;
  try {
    const st = await loopState.load(ctx);
    lastTickId = st.lastTickId;
    lastTickAt = st.lastTickAt;
  } catch { /* no state yet */ }
  let pending: PendingCard[] = [];
  try { pending = (await approvalStore.listPending(ctx)).map(toCard); } catch { /* none */ }
  return { slug, name, charter, hasCharter, lastTickId, lastTickAt, spend7dUsd: await readSpend7d(slug), pending };
}

export async function readCompanyBrain(): Promise<CompanyBrain> {
  const slugs = await listProductSlugs();
  const projects = await Promise.all(slugs.map(readProject));
  return { projects, readAt: Date.now() };
}

function ago(ts: number | null, now: number): string {
  if (!ts) return 'never';
  const m = Math.round((now - ts) / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const CHARTER_CHARS = 1800;

/** The block appended to the chat system prompt.  Charters are truncated so
 *  six projects stay well under ~4k tokens; the model can ask for
 *  `read_file` on the full charter path when it needs more. */
export function buildCompanyBlock(brain: CompanyBrain): string {
  if (brain.projects.length === 0) {
    return (
      '\n\n# Company brain\n\nNo projects are connected yet.  The user can connect one by running ' +
      '`mod8 connect add <slug>` inside that project\'s repo, then editing the charter it scaffolds.\n'
    );
  }
  const now = brain.readAt;
  const totalPending = brain.projects.reduce((n, p) => n + p.pending.length, 0);
  const lines: string[] = [];
  lines.push('\n\n# Company brain — the user\'s projects (read from ~/.config/mod8/products/)');
  lines.push(
    `You are the operating brain of these ${brain.projects.length} projects.  When the user asks about a project, ` +
    'answer from the charter and cards below — never say you have no information about their companies.  ' +
    `Cards waiting for the user right now: ${totalPending}.`
  );
  lines.push('');
  lines.push('Conversation verbs (tell the user these exist when relevant; they are real slash commands):');
  lines.push('  /projects              — list projects, last tick, cards waiting');
  lines.push('  /approvals <slug>      — open the review panel for one project');
  lines.push('  /approve <apr_id>      — approve a card (merges / publishes via the act phase)');
  lines.push('  /reject <apr_id>       — reject a card');
  lines.push('  /rule <slug>: <text>   — add a plain-English rule to that project\'s charter (Non-goals)');
  lines.push('When the user states a rule for a project in conversation ("for hotel-agents, never touch billing routes"), ');
  lines.push('confirm the exact wording and tell them to run /rule so it lands in the charter — you cannot write files yourself.');
  lines.push('When the user says "approve"/"reject" for a card, answer with the exact /approve or /reject line to run.');
  lines.push('');
  for (const p of brain.projects) {
    lines.push(`## ${p.name}  (slug: ${p.slug})`);
    lines.push(`last tick: #${p.lastTickId} ${ago(p.lastTickAt, now)} · spend 7d: $${p.spend7dUsd.toFixed(3)} · charter: ${p.hasCharter ? 'present' : 'MISSING'}`);
    if (p.pending.length === 0) lines.push('cards waiting: none');
    else {
      lines.push(`cards waiting (${p.pending.length}):`);
      for (const c of p.pending) {
        const ev = [
          c.testsPassed === undefined ? null : c.testsPassed ? 'tests green' : 'tests RED',
          c.files !== undefined ? `${c.files} files +${c.added}/−${c.removed}` : null,
        ].filter(Boolean).join(', ');
        lines.push(`  - ${c.id} · ${c.kind} · risk ${c.risk} · impact ${c.impact}${ev ? ' · ' + ev : ''}`);
        lines.push(`    ${c.title}`);
      }
    }
    if (p.hasCharter) {
      const body = p.charter.length > CHARTER_CHARS ? p.charter.slice(0, CHARTER_CHARS) + '\n…(truncated)' : p.charter;
      lines.push('charter:');
      lines.push(body.split('\n').map((l) => '  ' + l).join('\n'));
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Find which project a card belongs to (ids are unique across products). */
export async function findApprovalSlug(id: string): Promise<string | null> {
  for (const slug of await listProductSlugs()) {
    const ctx = buildProductContext(slug, process.cwd(), 0);
    try {
      const it = await approvalStore.load(ctx, id);
      if (it) return slug;
    } catch { /* keep looking */ }
  }
  return null;
}

export interface DecideResult { ok: boolean; message: string }

/** The [a]/[r] keypress from conversation.  Same path as approvals-cli and the
 *  panel: store.decide → act phase on approve.  Never exits the process. */
export async function decideCard(id: string, verdict: 'approve' | 'reject', slugHint?: string): Promise<DecideResult> {
  const slug = slugHint ?? (await findApprovalSlug(id));
  if (!slug) return { ok: false, message: `no card ${id} in any connected project` };
  const ctx = buildProductContext(slug, process.cwd(), 0);
  const state = verdict === 'approve' ? 'approved' : 'rejected';
  let decided: ApprovalItem;
  try {
    decided = await approvalStore.decide(ctx, id, { state, decidedBy: process.env.USER ?? 'user' });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (state === 'rejected') return { ok: true, message: `rejected ${decided.id} — ${decided.title}` };
  const policy = await loadPolicy(ctx);
  const result = await runAct(ctx, policy, { approvalId: decided.id });
  if (!result.ok || !result.output?.result) {
    return { ok: false, message: `approved ${decided.id} but act failed: ${result.reason ?? 'no result'}` };
  }
  const payload = result.output.result.payload as Record<string, unknown>;
  const sha = typeof payload.newSha === 'string' ? ` → ${payload.newSha.slice(0, 7)}` : '';
  return { ok: true, message: `approved + applied ${decided.id} — ${decided.title}${sha}` };
}

/** Append a rule bullet to the charter's "## Non-goals" section (created if
 *  missing).  One line in, one line out — the user's words, not ours. */
export async function addCharterRule(slug: string, rule: string): Promise<{ ok: boolean; message: string }> {
  const text = rule.trim().replace(/^[-*]\s*/, '');
  if (!text) return { ok: false, message: 'empty rule' };
  const ctx = buildProductContext(slug, process.cwd(), 0);
  const path = productFiles.productMd(ctx);
  if (!existsSync(path)) return { ok: false, message: `${slug}: no charter (product.md) — run \`mod8 connect add ${slug}\` first` };
  let md = await fs.readFile(path, 'utf8');
  const bullet = `- ${text}`;
  if (md.includes(bullet)) return { ok: true, message: `${slug}: rule already in charter` };
  const heading = /^## Non-goals\s*$/m;
  const m = heading.exec(md);
  if (!m) {
    md = md.replace(/\s*$/, '') + `\n\n## Non-goals\n\n${bullet}\n`;
  } else {
    // Insert before the next "## " heading after Non-goals (or at EOF).
    const start = m.index + m[0].length;
    const next = md.slice(start).search(/^## /m);
    const end = next === -1 ? md.length : start + next;
    const section = md.slice(start, end).replace(/\s*$/, '');
    md = md.slice(0, start) + section + `\n${bullet}\n\n` + md.slice(end);
  }
  await fs.writeFile(path, md, 'utf8');
  return { ok: true, message: `${slug}: added to charter Non-goals — "${text}"` };
}

/** Plain-text project list for /projects and `mod8 projects`. */
export function renderProjects(brain: CompanyBrain): string {
  if (brain.projects.length === 0) return 'no projects connected — run `mod8 connect add <slug>` inside a repo\n';
  const out: string[] = [];
  for (const p of brain.projects) {
    const wait = p.pending.length === 0 ? 'nothing waiting' : `${p.pending.length} waiting for you`;
    out.push(`${p.slug.padEnd(14)} tick #${String(p.lastTickId).padEnd(4)} ${ago(p.lastTickAt, brain.readAt).padEnd(8)} $${p.spend7dUsd.toFixed(3)}/7d  ${wait}`);
    for (const c of p.pending) out.push(`  ${c.id}  ${c.title}`);
  }
  return out.join('\n') + '\n';
}
