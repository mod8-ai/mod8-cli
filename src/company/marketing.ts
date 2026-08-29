/**
 * company/marketing.ts — the MARKETING role, one per connected project.
 *
 * Marketing owns the whole funnel for a product (positioning → content →
 * channels → measurement) inside the boundaries the charter draws
 * (Non-goals, Voice + brand rules, The one metric).  It never publishes on
 * its own: every post becomes an ApprovalItem of kind 'marketing' that the
 * founder approves with [a] — the act phase then dispatches it to the meta
 * adapter (facebook / instagram).
 *
 * On disk, under products/<slug>/marketing/:
 *   plan.md          — the current week plan (rewritten by every plan run)
 *   questions.jsonl  — questions the charter did not answer, append-only:
 *                      {ts, question, answered:false} when asked, then
 *                      {ts, question, answered:true, answer} when the founder
 *                      answers (`mod8 marketing answer`).  Latest entry per
 *                      question wins.  Answers are FACTS fed back to the model
 *                      ("Founder answers"); prohibitions go through `mod8 rule`
 *                      (charter Non-goals) instead.
 *
 * Learning from the keypress: the last 10 marketing approvals (index +
 * archive) go into the prompt — rejected texts as "do not repeat", approved
 * ones as "this worked".
 */

import { promises as fs } from 'node:fs';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { buildProductContext, connectorPath, productFiles, productPath } from '../memory/paths.js';
import * as approvalStore from '../approval/store.js';
import * as loopState from '../loop/state.js';
import * as events from '../loop/events.js';
import * as proposalStore from '../loop/proposal.js';
import { loadPolicy } from '../loop/policy.js';
import { load as loadPrompt } from '../loop/promptLoader.js';
import { runStructuredPhase } from '../loop/runPhase.js';
import { setPolicyModels } from '../loop/modelPicker.js';
import { newApprovalId, type ApprovalItem } from '../approval/types.js';
import type { Proposal } from '../loop/proposal.js';
import type { ProductContext } from '../loop/types.js';
import { listProductSlugs } from './brain.js';

// ── schema the role returns ─────────────────────────────────────────────

const ChannelSchema = z.enum(['facebook', 'instagram']);

export const MarketingPlanSchema = z.object({
  positioning: z.string().max(300),
  weekPlan: z.array(z.object({ day: z.string(), channel: z.string(), goal: z.string() })).max(7),
  posts: z.array(z.object({
    channel: ChannelSchema,
    text: z.string().max(600),
    whyNow: z.string(),
    mediaHint: z.string().optional(),
  })).max(3),
  questionsForFounder: z.array(z.string()).max(3),
});
export type MarketingPlan = z.infer<typeof MarketingPlanSchema>;

export interface MarketingState {
  planPath: string;
  plan: string | null;
  planAt: number | null;
  channels: { facebook: boolean };
  postsWaiting: number;
  postsPublished7d: number;
  /** Questions whose latest entry is answered:false, oldest first (the
   *  1-based position is what `mod8 marketing answer <n>` refers to). */
  openQuestions: string[];
  /** Answered questions, oldest first — facts the next plan must use. */
  answered: { question: string; answer: string }[];
}

export interface MarketingPlanResult {
  ok: boolean;
  message: string;
  planPath: string;
  /** Every card now waiting for this plan's posts (new + already pending). */
  cards: string[];
  /** Cards skipped because an identical post was already pending. */
  reused: number;
  questions: string[];
  /** True when no channel is connected: cards wait until Meta is connected. */
  blocked: boolean;
}

interface QuestionEntry { ts: number; question: string; answered: boolean; answer?: string }

// ── paths ───────────────────────────────────────────────────────────────

function ctxFor(slug: string, tickId = 0): ProductContext {
  return buildProductContext(slug, process.cwd(), tickId);
}
const planPathOf = (ctx: ProductContext) => productPath(ctx, 'marketing', 'plan.md');
const questionsPathOf = (ctx: ProductContext) => productPath(ctx, 'marketing', 'questions.jsonl');

/** Latest entry per question text, in first-asked order. */
async function readQuestions(ctx: ProductContext): Promise<QuestionEntry[]> {
  const p = questionsPathOf(ctx);
  if (!existsSync(p)) return [];
  const latest = new Map<string, QuestionEntry>();
  for (const line of (await fs.readFile(p, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as QuestionEntry;
      if (typeof e.question !== 'string') continue;
      latest.set(e.question, e);
    } catch { /* skip */ }
  }
  return [...latest.values()];
}

/** Open questions for a slug (latest entry answered:false), oldest first.
 *  Shared with the receipt so both agree on numbering. */
export async function openMarketingQuestions(slug: string): Promise<string[]> {
  return (await readQuestions(ctxFor(slug))).filter((q) => !q.answered).map((q) => q.question);
}

/** Record the founder's answer to open question #n (1-based, as printed by
 *  `mod8 marketing status`).  The answer is a fact: it goes to the next plan
 *  as "Founder answers" and the question stops showing as open. */
export async function answerMarketingQuestion(slug: string, n: number, answer: string): Promise<{ ok: boolean; message: string }> {
  const text = answer.trim();
  if (!text) return { ok: false, message: 'empty answer' };
  const ctx = ctxFor(slug);
  if (!existsSync(productFiles.productMd(ctx))) {
    return { ok: false, message: `${slug}: no charter (product.md) — run \`mod8 connect add ${slug}\` first` };
  }
  const open = await openMarketingQuestions(slug);
  if (open.length === 0) return { ok: false, message: `${slug}: no open marketing questions` };
  if (!Number.isInteger(n) || n < 1 || n > open.length) {
    return { ok: false, message: `${slug}: pick a question 1–${open.length} (see \`mod8 marketing status --slug ${slug}\`)` };
  }
  const question = open[n - 1]!;
  const qp = questionsPathOf(ctx);
  await fs.mkdir(dirname(qp), { recursive: true, mode: 0o700 });
  const entry: QuestionEntry = { ts: Date.now(), question, answered: true, answer: text };
  await fs.appendFile(qp, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return { ok: true, message: `${slug}: answered "${question}" → "${text}" (the next plan uses it)` };
}

// ── state ───────────────────────────────────────────────────────────────

export async function readMarketingState(slug: string): Promise<MarketingState> {
  const ctx = ctxFor(slug);
  const planPath = planPathOf(ctx);
  let plan: string | null = null;
  let planAt: number | null = null;
  if (existsSync(planPath)) {
    try {
      plan = await fs.readFile(planPath, 'utf8');
      planAt = (await fs.stat(planPath)).mtimeMs;
    } catch { /* unreadable → treated as none */ }
  }
  const channels = { facebook: existsSync(connectorPath(ctx, 'meta')) };

  let postsWaiting = 0;
  try {
    postsWaiting = (await approvalStore.listPending(ctx)).filter((it) => it.kind === 'marketing').length;
  } catch { /* none */ }

  let postsPublished7d = 0;
  try {
    const since = Date.now() - 7 * 86_400_000;
    const index = await approvalStore.readIndex(ctx);
    for (const e of index) {
      if (e.kind !== 'marketing' || e.state !== 'applied') continue;
      const full = await approvalStore.load(ctx, e.id);
      if ((full?.appliedAt ?? e.createdAt) >= since) postsPublished7d++;
    }
  } catch { /* none */ }

  const qs = await readQuestions(ctx);
  const openQuestions = qs.filter((q) => !q.answered).map((q) => q.question);
  const answered = qs.filter((q) => q.answered && q.answer).map((q) => ({ question: q.question, answer: q.answer! }));
  return { planPath, plan, planAt, channels, postsWaiting, postsPublished7d, openQuestions, answered };
}

// ── charter helpers ─────────────────────────────────────────────────────

function charterSection(charter: string, heading: string): string {
  const re = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`, 'm');
  const m = re.exec(charter);
  if (!m) return '';
  const start = m.index + m[0].length;
  const next = charter.slice(start).search(/^## /m);
  return charter.slice(start, next === -1 ? charter.length : start + next).trim();
}

/** Deterministic voice check.  The only rule we can verify without a
 *  model: a charter that says "no exclamation" forbids '!' in the text. */
function voiceFilterPassed(charter: string, text: string): boolean {
  const voice = charterSection(charter, 'Voice + brand rules').toLowerCase();
  if (/no exclamation/.test(voice) && text.includes('!')) return false;
  return true;
}

// ── plan run ────────────────────────────────────────────────────────────

function mockPlan(slug: string): MarketingPlan {
  return {
    positioning: `Mock positioning for ${slug}`,
    weekPlan: [
      { day: 'Mon', channel: 'facebook', goal: `Mock goal 1 for ${slug}` },
      { day: 'Thu', channel: 'instagram', goal: `Mock goal 2 for ${slug}` },
    ],
    posts: [
      { channel: 'facebook', text: `Mock post 1 for ${slug}`, whyNow: 'mock: first post of the week' },
      { channel: 'instagram', text: `Mock post 2 for ${slug}`, whyNow: 'mock: second post of the week' },
    ],
    questionsForFounder: ['Mock question?'],
  };
}

function renderPlanMd(slug: string, plan: MarketingPlan, connected: string[]): string {
  const lines: string[] = [];
  lines.push(`# Marketing plan — ${slug}`);
  lines.push('');
  lines.push(`date: ${new Date().toISOString()}`);
  lines.push(`channels: ${connected.length ? connected.join(', ') : 'none connected'}`);
  lines.push('');
  lines.push('## Positioning');
  lines.push('');
  lines.push(plan.positioning);
  lines.push('');
  lines.push('## Week plan');
  lines.push('');
  lines.push('| day | channel | goal |');
  lines.push('|---|---|---|');
  for (const w of plan.weekPlan) lines.push(`| ${w.day} | ${w.channel} | ${w.goal.replace(/\|/g, '/')} |`);
  lines.push('');
  lines.push('## Posts (as approval cards)');
  lines.push('');
  for (const p of plan.posts) {
    lines.push(`- [${p.channel}] ${p.text.replace(/\s+/g, ' ')}`);
    lines.push(`  why now: ${p.whyNow}${p.mediaHint ? ` · media: ${p.mediaHint}` : ''}`);
  }
  lines.push('');
  lines.push('## Questions for the founder');
  lines.push('');
  if (plan.questionsForFounder.length === 0) lines.push('(none — the charter answers everything this plan needed)');
  for (const q of plan.questionsForFounder) lines.push(`- ${q}`);
  lines.push('');
  return lines.join('\n');
}

async function recentMarketingHistory(ctx: ProductContext): Promise<{ approved: string[]; rejected: string[] }> {
  const approved: string[] = [];
  const rejected: string[] = [];
  try {
    const index = (await approvalStore.readIndex(ctx)).filter((e) => e.kind === 'marketing').slice(0, 10);
    for (const e of index) {
      const item = await approvalStore.load(ctx, e.id);
      const text = item?.proposedAction.type === 'social-post' ? item.proposedAction.text : e.title;
      if (e.state === 'rejected') rejected.push(text);
      else if (e.state === 'approved' || e.state === 'applied') approved.push(text);
    }
  } catch { /* no history */ }
  return { approved, rejected };
}

export async function runMarketingPlan(slug: string, opts: { modelOverride?: string } = {}): Promise<MarketingPlanResult> {
  const ctx0 = ctxFor(slug);
  const charterPath = productFiles.productMd(ctx0);
  const planPath = planPathOf(ctx0);
  if (!existsSync(charterPath)) {
    return { ok: false, message: `${slug}: no charter (product.md) — run \`mod8 connect add ${slug}\` and write the charter first`, planPath, cards: [], reused: 0, questions: [], blocked: false };
  }
  const charter = await fs.readFile(charterPath, 'utf8');

  let lastTickId = 0;
  try { lastTickId = (await loopState.load(ctx0)).lastTickId; } catch { /* genesis */ }
  const ctx = ctxFor(slug, lastTickId);

  let policy;
  try { policy = await loadPolicy(ctx); } catch (err) {
    return { ok: false, message: `${slug}: policy.yaml missing or invalid — ${err instanceof Error ? err.message : String(err)}`, planPath, cards: [], reused: 0, questions: [], blocked: false };
  }

  const state = await readMarketingState(slug);
  const connected = state.channels.facebook ? ['facebook', 'instagram'] : [];
  const history = await recentMarketingHistory(ctx);

  const userMessage = [
    `# Charter (products/${slug}/product.md)`,
    charter.trim(),
    '',
    '# Connected channels',
    connected.length ? connected.map((c) => `- ${c}`).join('\n') : '- none connected yet (plan for facebook + instagram anyway; the cards wait until the founder connects Meta)',
    '',
    '# Previous plan',
    state.plan ? state.plan.trim() : '(none — this is the first plan)',
    '',
    '# Founder keypresses on earlier posts',
    history.rejected.length ? '## REJECTED — do not repeat these angles or wording:\n' + history.rejected.map((t) => `- ${t.replace(/\s+/g, ' ')}`).join('\n') : '## REJECTED: none yet',
    history.approved.length ? '## APPROVED — this voice worked:\n' + history.approved.map((t) => `- ${t.replace(/\s+/g, ' ')}`).join('\n') : '## APPROVED: none yet',
    '',
    '# Founder answers (facts — use them, never contradict them)',
    state.answered.length ? state.answered.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join('\n') : '(none yet)',
    '',
    '# Open questions already asked (do not ask again)',
    state.openQuestions.length ? state.openQuestions.map((q) => `- ${q}`).join('\n') : '(none)',
  ].join('\n');

  const system = await loadPrompt('marketing', { slug });
  // Same as tick.ts: policy.yaml `models:` decides the provider (env MOD8_LOOP_MODEL* still wins).
  setPolicyModels(policy.models);
  const phase = await runStructuredPhase<MarketingPlan>({
    ctx, phase: 'marketing', policy, system, userMessage,
    schema: MarketingPlanSchema, maxOutputTokens: 3000,
    ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
  });
  if (!phase.ok) {
    return { ok: false, message: `${slug}: marketing plan failed — ${phase.reason ?? 'unknown'}`, planPath, cards: [], reused: 0, questions: [], blocked: false };
  }
  // MOD8_MOCK: runStructuredPhase returns ok + null → deterministic fixture.
  const plan: MarketingPlan = phase.output ?? mockPlan(slug);

  // 1. plan.md
  await fs.mkdir(dirname(planPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(planPath, renderPlanMd(slug, plan, connected), { mode: 0o600 });

  // 2. one Proposal + one ApprovalItem per post
  const oneMetric = charterSection(charter, 'The one metric').replace(/\s+/g, ' ').trim();
  const successCriteria = oneMetric ? `moves the one metric: ${oneMetric.slice(0, 200)}` : 'post published and engagement recorded by the next measure phase';
  const blocked = connected.length === 0;
  const cards: string[] = [];
  let reused = 0;
  // Re-planning before the founder pressed [a] must not pile up duplicates:
  // an identical (channel, text) already pending is reused, not recreated.
  const pendingPosts = new Map<string, string>();
  try {
    for (const it of await approvalStore.listPending(ctx)) {
      if (it.kind === 'marketing' && it.proposedAction.type === 'social-post') {
        pendingPosts.set(`${it.proposedAction.channel}\n${it.proposedAction.text}`, it.id);
      }
    }
  } catch { /* none pending */ }
  for (const post of plan.posts) {
    const dup = pendingPosts.get(`${post.channel}\n${post.text}`);
    if (dup) { cards.push(dup); reused++; continue; }
    const proposal: Proposal = {
      schemaVersion: 1,
      id: proposalStore.newProposalId(),
      productSlug: slug,
      createdAt: Date.now(),
      createdByPhase: 'ideate',
      originTickId: lastTickId,
      kind: 'marketing-post',
      title: `[${post.channel}] ${post.text.replace(/\s+/g, ' ').slice(0, 100)}`,
      summary: post.text,
      targetFiles: [],
      evidenceDigests: [],
      rationale: post.whyNow,
      estimatedEffort: 'small',
      estimatedRisk: 'low',
      estimatedImpact: 'medium',
      rollbackHint: 'delete the post',
      successCriteria,
    };
    await proposalStore.save(ctx, proposal);

    const id = newApprovalId();
    const item: ApprovalItem = {
      schemaVersion: 1,
      id,
      productSlug: slug,
      createdAt: Date.now(),
      proposalId: proposal.id,
      originTickId: lastTickId,
      kind: 'marketing',
      title: proposal.title,
      reason: blocked ? `${post.whyNow} — BLOCKED: Meta not connected; run \`mod8 connect add-adapter ${slug} meta\` before approving` : post.whyNow,
      signals: [],
      proposedAction: { type: 'social-post', channel: post.channel, text: post.text },
      risk: 'low',
      impact: 'medium',
      rollback: { description: 'delete the published post', recipe: `manual: delete the post on the ${post.channel === 'instagram' ? 'Instagram account' : 'Facebook Page'} (post id is in card ${id} appliedResult); mod8 has no automatic undo for social posts` },
      evidence: { voiceFilterPassed: voiceFilterPassed(charter, post.text), secretScanPassed: true },
      state: 'pending',
    };
    try {
      await approvalStore.create(ctx, item);
    } catch (err) {
      if (err instanceof approvalStore.ApprovalCapReached) {
        const evicted = await approvalStore.evictLowestRisk(ctx);
        if (!evicted) {
          await proposalStore.updateState(ctx, proposal.id, 'dropped');
          continue;
        }
        await approvalStore.create(ctx, item);
      } else {
        throw err;
      }
    }
    await proposalStore.updateState(ctx, proposal.id, 'staged');
    cards.push(id);
  }

  // 3. questions
  if (plan.questionsForFounder.length) {
    const qp = questionsPathOf(ctx);
    await fs.mkdir(dirname(qp), { recursive: true, mode: 0o700 });
    const existing = new Set((await readQuestions(ctx)).map((q) => q.question));
    const fresh = plan.questionsForFounder.filter((q) => !existing.has(q));
    if (fresh.length) {
      const lines = fresh.map((question) => JSON.stringify({ ts: Date.now(), question, answered: false } satisfies QuestionEntry));
      await fs.appendFile(qp, lines.join('\n') + '\n', { mode: 0o600 });
    }
  }

  await events.append(ctx, { phase: 'marketing', kind: 'complete', payload: { cards, reused, planPath, blocked } });

  const questions = plan.questionsForFounder;
  const message = `${slug}: plan written (${plan.posts.length} post${plan.posts.length === 1 ? '' : 's'} → ${cards.length} card${cards.length === 1 ? '' : 's'} waiting${reused ? ` (${reused} already waiting, not duplicated)` : ''}${questions.length ? `, ${questions.length} question${questions.length === 1 ? '' : 's'} for you` : ''})`;
  return { ok: true, message, planPath, cards, reused, questions, blocked };
}

// ── rendering ───────────────────────────────────────────────────────────

function ago(ts: number | null, now = Date.now()): string {
  if (!ts) return 'none';
  const m = Math.round((now - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const CONNECT_META_HINT = 'connect Meta: mod8 connect add-adapter <slug> meta   (paste the Page access token + Page id; Instagram needs the IG business account id too)';

/** The exact line a founder runs to answer open question #n. */
export function answerHint(slug: string, n: number | string = '<n>'): string {
  return `mod8 marketing answer --slug ${slug} ${n} <your answer>   (or /marketing answer ${slug} ${n} <your answer> in the REPL)`;
}

export async function renderMarketingStatus(slug: string): Promise<string> {
  const s = await readMarketingState(slug);
  const out: string[] = [];
  out.push(`marketing — ${slug}`);
  out.push(`  plan:          ${s.plan ? `${ago(s.planAt)} (${s.planPath})` : 'none'}`);
  out.push(`  facebook:      ${s.channels.facebook ? 'connected' : 'not connected'}`);
  out.push(`  instagram:     ${s.channels.facebook ? 'connected (via Meta)' : 'not connected'}`);
  out.push(`  posts waiting: ${s.postsWaiting}`);
  out.push(`  published 7d:  ${s.postsPublished7d}`);
  if (s.openQuestions.length) {
    out.push(`  open questions (${s.openQuestions.length}):`);
    s.openQuestions.forEach((q, i) => out.push(`    ${i + 1}. ${q}`));
    out.push(`    answer with: ${answerHint(slug)}`);
    out.push(`    (a prohibition — "never mention pricing" — is a rule, not an answer: mod8 rule ${slug} <text>)`);
  } else {
    out.push('  open questions: none');
  }
  out.push('');
  out.push('next:');
  if (!s.plan) out.push(`  mod8 marketing plan --slug ${slug}`);
  else if (s.postsWaiting > 0) out.push(`  mod8 approvals --slug ${slug}   (or /approve <id> in the REPL)`);
  else out.push(`  mod8 marketing plan --slug ${slug}`);
  if (!s.channels.facebook) out.push(`  ${CONNECT_META_HINT.replace('<slug>', slug)}`);
  return out.join('\n') + '\n';
}

/** 1–3 lines for the company-brain block. */
export async function marketingBrainLines(slug: string): Promise<string[]> {
  const s = await readMarketingState(slug);
  const lines: string[] = [];
  lines.push(`marketing: plan ${ago(s.planAt)} · facebook ${s.channels.facebook ? 'connected' : 'not connected'} · ${s.postsWaiting} post${s.postsWaiting === 1 ? '' : 's'} waiting · published 7d: ${s.postsPublished7d}`);
  if (s.openQuestions.length) lines.push(`  open questions: ${s.openQuestions.slice(0, 3).join(' | ')}`);
  lines.push(`  next: ${s.plan ? `/approvals ${slug}` : `mod8 marketing plan --slug ${slug}`}${s.channels.facebook ? '' : ' · Meta not connected'}`);
  return lines;
}

/** The connected product whose charter "Source:" line (or policy repos)
 *  points at `cwd`.  Used by `mod8 marketing` to default --slug. */
function real(p: string): string {
  try { return realpathSync(resolve(p)); } catch { return resolve(p); }
}

export async function slugForCwd(cwd: string = process.cwd()): Promise<string | null> {
  const want = real(cwd);
  for (const slug of await listProductSlugs()) {
    const ctx = ctxFor(slug);
    const p = productFiles.productMd(ctx);
    if (!existsSync(p)) continue;
    try {
      const md = await fs.readFile(p, 'utf8');
      const m = md.match(/^-\s*Source:\s*(\S+)/m);
      if (m && real(m[1]!) === want) return slug;
    } catch { /* skip */ }
  }
  return null;
}
