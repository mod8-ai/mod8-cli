import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getKey } from './keys.js';

const CONFIG_DIR = process.env.MOD8_CONFIG_DIR ?? join(homedir(), '.config', 'mod8');
const SESSIONS_DIR = join(CONFIG_DIR, 'sessions');

export type Mode = 'host' | 'work';

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  costUsd: number;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  mode: Mode;
  stats?: SessionStats;
  aborted?: boolean;
}

export interface Session {
  version: 1;
  id: string;
  title: string | null;
  createdAt: number;
  lastActivity: number;
  messages: SessionMessage[];
}

export interface SessionSummary {
  id: string;
  title: string | null;
  lastActivity: number;
  turnCount: number;
}

export const SESSION_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]{4}$/;

export function generateSessionId(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const date = `${yyyy}-${mm}-${dd}`;
  const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${date}-${suffix}`;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

function pathFor(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

export async function createSession(): Promise<Session> {
  const now = Date.now();
  const session: Session = {
    version: 1,
    id: generateSessionId(),
    title: null,
    createdAt: now,
    lastActivity: now,
    messages: [],
  };
  await saveSession(session);
  return session;
}

export async function saveSession(session: Session): Promise<void> {
  await ensureDir();
  const target = pathFor(session.id);
  const tmp = `${target}.tmp`;
  const data = JSON.stringify(session, null, 2) + '\n';
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, target);
  await fs.chmod(target, 0o600);
}

export async function loadSession(id: string): Promise<Session | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  try {
    const data = await fs.readFile(pathFor(id), 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Session;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listSessions(limit = 20): Promise<SessionSummary[]> {
  await ensureDir();
  let files: string[];
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    if (file.endsWith('.tmp')) continue;
    const id = file.slice(0, -5);
    if (!SESSION_ID_RE.test(id)) continue;
    try {
      const session = await loadSession(id);
      if (!session) continue;
      const turnCount = session.messages.filter((m) => m.role === 'assistant').length;
      summaries.push({
        id: session.id,
        title: session.title,
        lastActivity: session.lastActivity,
        turnCount,
      });
    } catch {
      // skip corrupted
    }
  }
  summaries.sort((a, b) => b.lastActivity - a.lastActivity);
  return summaries.slice(0, limit);
}

export async function getMostRecentSession(): Promise<Session | null> {
  const summaries = await listSessions(1);
  if (summaries.length === 0) return null;
  return loadSession(summaries[0]!.id);
}

export async function clearSessionHistory(session: Session): Promise<void> {
  session.messages = [];
  session.title = null;
  session.lastActivity = Date.now();
  await saveSession(session);
}

/**
 * Generate a 4-5 word title summarizing the conversation, using Haiku for cost.
 * Returns '' on any failure (no key, network error, etc.) — caller falls back.
 */
export async function generateTitle(
  messages: { role: 'user' | 'assistant'; content: string }[]
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? (await getKey('anthropic'));
  if (!apiKey) return '';
  try {
    const client = new Anthropic({ apiKey });
    const truncated = messages.slice(0, 6);
    const res = await client.messages.create({
      model: process.env.MOD8_TITLE_MODEL ?? 'claude-haiku-4-5',
      max_tokens: 32,
      system:
        'Generate a 4-5 word title summarizing this conversation. Output ONLY the title — no quotes, no period, no preamble. Be specific to what was discussed.',
      messages: truncated.map((m) => ({ role: m.role, content: m.content })),
    });
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
      .trim()
      .replace(/^["']|["']$/g, '')
      .replace(/[.!?]+$/, '');
    return text;
  } catch {
    return '';
  }
}

/**
 * Fallback title from first user message when no AI-generated title exists.
 */
export function fallbackTitle(session: Session): string {
  const firstUser = session.messages.find((m) => m.role === 'user');
  if (!firstUser) return '(empty session)';
  const words = firstUser.content.trim().split(/\s+/).slice(0, 5).join(' ');
  return words.length > 60 ? words.slice(0, 57) + '…' : words;
}

export const SESSIONS_DIR_PATH = SESSIONS_DIR;
