/**
 * Claude Code reader — mod8 learns about your projects WITHOUT being told.
 *
 * Claude Code leaves two durable, high-signal artifacts on disk:
 *   ~/.claude/history.jsonl                    every prompt the user typed
 *                                              ({display, timestamp, project, sessionId})
 *   ~/.claude/projects/<enc>/memory/*.md       auto-written memory files with
 *                                              frontmatter (name/description/type)
 *
 * This module reads them read-only, scrubs API keys AT INDEX TIME (tool
 * output is where credentials leak, not typed input), and hands back plain
 * records.  Nothing here touches the network.  Override the root with
 * MOD8_CLAUDE_DIR (tests use a fixture dir).
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeKeys } from '../util/secrets.js';

export function claudeDir(): string {
  return process.env.MOD8_CLAUDE_DIR ?? join(homedir(), '.claude');
}

export interface HistoryEntry {
  text: string;
  ts: number;
  project: string;
  sessionId: string;
}

export interface MemoryFile {
  path: string;
  name: string;
  description: string;
  type: string;
  body: string;
  mtime: number;
}

/** Claude Code encodes a project path by replacing every `/` with `-`. */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, '-');
}

export async function readHistory(opts: { since?: number; project?: string } = {}): Promise<HistoryEntry[]> {
  const file = join(claudeDir(), 'history.jsonl');
  if (!existsSync(file)) return [];
  const raw = await fs.readFile(file, 'utf8');
  const out: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: { display?: unknown; timestamp?: unknown; project?: unknown; sessionId?: unknown };
    try { rec = JSON.parse(line); } catch { continue; }
    const ts = typeof rec.timestamp === 'number' ? rec.timestamp : NaN;
    const text = typeof rec.display === 'string' ? rec.display : '';
    const project = typeof rec.project === 'string' ? rec.project : '';
    if (!Number.isFinite(ts) || !text) continue;
    if (opts.since !== undefined && ts < opts.since) continue;
    if (opts.project && !(project === opts.project || project.startsWith(opts.project + '/'))) continue;
    out.push({
      text: sanitizeKeys(text),
      ts,
      project,
      sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
    });
  }
  return out;
}

function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    let val = kv[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    meta[key] = val;
  }
  // Nested `metadata:` block puts `type:` on an indented line.
  const typeLine = /^\s+type:\s*(\S+)/m.exec(m[1]!);
  if (!meta.type && typeLine) meta.type = typeLine[1]!;
  return { meta, body: src.slice(m[0].length) };
}

/** Every memory file Claude Code has written, across all projects. */
export async function readMemories(opts: { since?: number } = {}): Promise<MemoryFile[]> {
  const projectsRoot = join(claudeDir(), 'projects');
  if (!existsSync(projectsRoot)) return [];
  const out: MemoryFile[] = [];
  const dirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const memDir = join(projectsRoot, d.name, 'memory');
    if (!existsSync(memDir)) continue;
    const files = await fs.readdir(memDir);
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const path = join(memDir, f);
      const st = await fs.stat(path);
      if (opts.since !== undefined && st.mtimeMs < opts.since) continue;
      const src = await fs.readFile(path, 'utf8');
      const { meta, body } = parseFrontmatter(src);
      out.push({
        path,
        name: meta.name ?? basename(f, '.md'),
        description: meta.description ?? '',
        type: meta.type ?? 'unknown',
        body: sanitizeKeys(body.trim()),
        mtime: st.mtimeMs,
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Canonical company aliases.  Memory names and repo folders use several
 *  spellings for the same company; collapse them so the briefing has one
 *  section per company. */
export const COMPANY_ALIASES: Record<string, string> = {
  anyprofit: 'dailyprofit', dailyprofit: 'dailyprofit',
  hotel: 'hotel-agents', hotelagents: 'hotel-agents', ha: 'hotel-agents', aira: 'hotel-agents',
  safer: 'safer', safeglobal: 'safer', voice: 'safer',
  mod8: 'mod8',
  sleepwell: 'sleepwell', sleepingwell: 'sleepwell',
  sentinel: 'sentinel',
  stocktalk: 'stocktalk',
  arbol: 'arbol', oxigeno: 'arbol',
  litoral: 'litoral', costa: 'litoral',
  stayinnovation: 'stayinnovation',
};

const KIND_PREFIX = /^(project|feedback|reference|user|design|settings)[-_]/;

/** Coarse company label for a memory file, from its name.  Files that
 *  don't name a known company (working-style feedback, user profile…)
 *  land in `general`. */
export function projectLabelOf(m: MemoryFile): string {
  const n = m.name.toLowerCase().replace(KIND_PREFIX, '');
  const tokens = n.split(/[-_\s]+/).filter(Boolean);
  for (const t of tokens.slice(0, 3)) {
    const hit = COMPANY_ALIASES[t.replace(/[^a-z0-9]/g, '')];
    if (hit) return hit;
  }
  // Also scan description for a company word (e.g. name "settings-redesign-v2").
  const desc = (m.description + ' ' + m.path).toLowerCase();
  for (const [k, v] of Object.entries(COMPANY_ALIASES)) if (desc.includes(k)) return v;
  return 'general';
}

/** Company label for a repo path (`~/hotel-agents-platform` → hotel-agents). */
export function companyOfPath(p: string): string | null {
  const segs = p.toLowerCase().split('/').filter(Boolean);
  for (const seg of segs.slice().reverse()) {
    for (const t of seg.split(/[-_]/)) { const hit = COMPANY_ALIASES[t]; if (hit) return hit; }
  }
  return null;
}

/** Company a typed prompt is about: its project dir if that names a
 *  company, else the first company word in the text (sessions run from
 *  $HOME talk about many companies). */
export function companyOfPrompt(h: HistoryEntry): string | null {
  const fromPath = companyOfPath(h.project);
  if (fromPath) return fromPath;
  const t = h.text.toLowerCase();
  for (const [k, v] of Object.entries(COMPANY_ALIASES)) if (k.length >= 4 && t.includes(k)) return v;
  return null;
}

/** Repo roots Claude Code has been run in, decoded from
 *  ~/.claude/projects/<enc> dir names.  Only dirs that still exist and
 *  contain .git; subagent/workflow dirs never do. */
export async function knownRepoRoots(): Promise<string[]> {
  const projectsRoot = join(claudeDir(), 'projects');
  if (!existsSync(projectsRoot)) return [];
  const out: string[] = [];
  for (const d of await fs.readdir(projectsRoot)) {
    if (!d.startsWith('-')) continue;
    const abs = d.replace(/-/g, '/');
    if (existsSync(join(abs, '.git'))) out.push(abs);
  }
  return out;
}

/** Does this memory look like it belongs to the given repo?  Matches on
 *  repo basename appearing in the file name or the memory body. */
export function memoryMentionsRepo(m: MemoryFile, repoRoot: string): boolean {
  const base = basename(repoRoot).toLowerCase().replace(/[-_]/g, '');
  if (!base) return false;
  const hay = (m.name + ' ' + m.description + ' ' + m.body).toLowerCase().replace(/[-_]/g, '');
  return hay.includes(base) || hay.includes(repoRoot.toLowerCase());
}
