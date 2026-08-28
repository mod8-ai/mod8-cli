/**
 * `mod8 standup` — the company briefing, with no prompt from the user.
 *
 * Reads what Claude Code already knows (memory files + typed prompts) and
 * the local git history of every project the user touched, groups it per
 * company, and prints: what moved, what's stuck, what needs the human.
 *
 *   --days N      window (default 7)
 *   --project X   only companies whose label contains X
 *   --raw         print the deterministic digest and skip the LLM
 *                 (what `mod8 verify` asserts on)
 *
 * Nothing leaves the machine except the digest sent to the user's own
 * configured provider — and only when --raw is not set.
 */

import chalk from 'chalk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readHistory, readMemories, projectLabelOf, companyOfPath, companyOfPrompt, knownRepoRoots, type MemoryFile, type HistoryEntry } from '../claudecode/reader.js';
import { streamProviderChat } from '../providers/genericChat.js';
import { readAuth } from '../storage/auth.js';
import { configuredProviderIds, resolveConfigured } from '../storage/providers.js';
import { classifyError } from '../util/errors.js';

const execFileP = promisify(execFile);
const HOST_PROVIDER_ID = 'anthropic';

export interface StandupOptions { days?: number; project?: string; raw?: boolean; provider?: string }

interface CompanyDigest {
  label: string;
  memories: MemoryFile[];
  prompts: HistoryEntry[];
  repos: { root: string; commits: number; last?: string }[];
}

async function gitSummary(root: string, sinceIso: string): Promise<{ commits: number; last?: string }> {
  if (!existsSync(root + '/.git')) return { commits: 0 };
  try {
    const { stdout } = await execFileP('git', ['log', `--since=${sinceIso}`, '--no-merges', '--pretty=format:%s'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    const lines = stdout.split('\n').filter(Boolean);
    return { commits: lines.length, last: lines[0] };
  } catch { return { commits: 0 }; }
}


export interface Digest { companies: CompanyDigest[]; general?: CompanyDigest; unattributed: number; days: number; sinceMs: number }

export async function buildDigest(opts: StandupOptions): Promise<Digest> {
  const days = opts.days ?? 7;
  const sinceMs = Date.now() - days * 86_400_000;
  const [memories, prompts] = await Promise.all([readMemories(), readHistory({ since: sinceMs })]);

  const byLabel = new Map<string, CompanyDigest>();
  const get = (label: string) => {
    let c = byLabel.get(label);
    if (!c) { c = { label, memories: [], prompts: [], repos: [] }; byLabel.set(label, c); }
    return c;
  };
  for (const m of memories) get(projectLabelOf(m)).memories.push(m);

  const repoRoots = new Set<string>();
  let unattributed = 0;
  for (const p of prompts) {
    const label = companyOfPrompt(p);
    if (!label) { unattributed++; continue; }
    if (p.project && companyOfPath(p.project)) repoRoots.add(p.project);
    get(label).prompts.push(p);
  }
  for (const r of await knownRepoRoots()) repoRoots.add(r);
  const sinceIso = new Date(sinceMs).toISOString();
  for (const root of repoRoots) {
    const label = companyOfPath(root);
    if (!label) continue;
    const g = await gitSummary(root, sinceIso);
    get(label).repos.push({ root, ...g });
  }
  // `general` = working-style feedback + user profile: useful context for the
  // model, not a company.  Keep it last and out of the company count.
  const general = byLabel.get('general');
  byLabel.delete('general');

  let companies = Array.from(byLabel.values());
  if (opts.project) {
    const q = opts.project.toLowerCase();
    companies = companies.filter((c) => c.label.includes(q));
  }
  // Most active first: recent memory edits + prompts + commits.
  const activity = (c: CompanyDigest) =>
    c.memories.filter((m) => m.mtime >= sinceMs).length * 3 + c.prompts.length + c.repos.reduce((n, r) => n + r.commits, 0);
  companies.sort((a, b) => activity(b) - activity(a));
  return { companies, general, unattributed, days, sinceMs };
}

export function renderRaw(d: Digest): string {
  const lines: string[] = [];
  lines.push(`# standup — last ${d.days} days`);
  const memN = d.companies.reduce((n, c) => n + c.memories.length, 0) + (d.general?.memories.length ?? 0);
  const promptN = d.companies.reduce((n, c) => n + c.prompts.length, 0);
  lines.push(`companies: ${d.companies.length} · memories: ${memN} · prompts: ${promptN} (+${d.unattributed} not about any company)`);
  for (const c of d.companies) {
    const recentMem = c.memories.filter((m) => m.mtime >= d.sinceMs);
    const commits = c.repos.reduce((n, r) => n + r.commits, 0);
    lines.push('');
    lines.push(`## ${c.label}  (${c.memories.length} memories, ${recentMem.length} updated · ${c.prompts.length} prompts · ${commits} commits)`);
    for (const m of recentMem.slice(0, 8)) lines.push(`- [memory] ${m.description || m.name}`);
    for (const r of c.repos) if (r.commits) lines.push(`- [git] ${r.root}: ${r.commits} commits, last: ${r.last}`);
    for (const p of c.prompts.filter((p) => p.text.length >= 12).slice(-5)) lines.push(`- [asked] ${p.text.slice(0, 140).replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n') + '\n';
}

function buildContext(d: Digest): string {
  // Full memory bodies for the LLM, capped per company so six companies fit.
  const parts: string[] = [renderRaw(d), '\n# memory (full text, most recent first)\n'];
  let budget = 220_000; // chars
  const all = d.general ? [...d.companies, { ...d.general, label: 'general (working style, user profile — not a company)' }] : d.companies;
  for (const c of all) {
    parts.push(`\n## ${c.label}\n`);
    for (const m of c.memories) {
      const chunk = `### ${m.name} (${m.type})\n${m.description}\n${m.body}\n`;
      if (chunk.length > budget) break;
      budget -= chunk.length;
      parts.push(chunk);
    }
  }
  return parts.join('\n');
}

const SYSTEM = `You are mod8, running the founder's companies. Write the morning standup from the evidence below. The reader is a non-developer founder with several companies; they will only read this, so be concrete and short.

For EACH company (most active first), exactly this shape:
**<Company>** — one line: what it is and its current stage.
- Moved: what changed in the window (from memory updates, commits, prompts). If nothing, say "nothing moved".
- Stuck: the blockers, named precisely (a login, a key, an unbuilt feature, a decision).
- Needs YOU: only things a human must do (logins, 2FA, money, decisions, outreach). Empty if none.
- mod8 can do alone: up to 3 concrete next tasks that need no human.

End with **Today's 3** — the three highest-leverage items across all companies, money first.
Never invent facts; if the evidence is thin for a company, say so in one line. No preamble.`;

export async function standupCommand(opts: StandupOptions): Promise<void> {
  const d = await buildDigest(opts);
  if (d.companies.length === 0) {
    process.stdout.write(chalk.dim(`mod8 standup: nothing found under ${process.env.MOD8_CLAUDE_DIR ?? '~/.claude'} — no memories or prompts yet.\n`));
    return;
  }
  if (opts.raw) { process.stdout.write(renderRaw(d)); return; }

  // Same rule as the REPL front door: host voice is Anthropic, but any key works.
  // Precedence: --provider / MOD8_STANDUP_PROVIDER → local Anthropic key →
  // any local key → proxy.  YOUR OWN KEY WINS over the proxy (same rule as
  // buildProviderModel); the old order used the proxy whenever you were
  // logged in, so a dead proxy account took standup down even with a
  // working DeepSeek key on disk.
  const auth = await readAuth();
  const explicit = opts.provider ?? process.env.MOD8_STANDUP_PROVIDER?.trim();
  let providerId = HOST_PROVIDER_ID;
  if (explicit) {
    providerId = explicit;
  } else if (!(await resolveConfigured(HOST_PROVIDER_ID))) {
    const ids = await configuredProviderIds();
    if (ids.length > 0) providerId = ids[0]!;
    else if (!auth) {
      console.error(chalk.red('mod8: ') + 'no provider keys configured — add one with `mod8 keys set <provider>`, or run `mod8 standup --raw`.');
      process.exit(1);
    }
  }

  process.stderr.write(chalk.dim(`standup: ${d.companies.length} companies · ${d.companies.reduce((n, c) => n + c.memories.length, 0)} memories · last ${d.days} days · via ${providerId}\n\n`));
  let lastChar = '';
  try {
    for await (const ev of streamProviderChat({ providerId, system: SYSTEM, maxTokens: 12_000, messages: [{ role: 'user', content: buildContext(d) }] })) {
      if (ev.type === 'text') { process.stdout.write(ev.delta); lastChar = ev.delta.slice(-1); }
    }
  } catch (err) {
    if (lastChar && lastChar !== '\n') process.stdout.write('\n');
    console.error(chalk.red('mod8: ') + classifyError(err, providerId));
    process.exit(1);
  }
  if (lastChar !== '\n') process.stdout.write('\n');
}
