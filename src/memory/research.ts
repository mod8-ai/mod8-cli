/**
 * Research memory — one-shot research outputs the loop consulted.
 *
 * Each research run produces a dated markdown file at
 * products/<slug>/memory/research/<topic>-<date>.md.  Used by ideate
 * (Phase 2+) when proposing changes that need external context (e.g.
 * "what's new in TanStack Query v5?").
 *
 * Phase 3 ships persistence; LLM-driven research generation (a
 * dedicated phase or sub-pipeline) is a later refinement.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { productPath } from './paths.js';
import type { ProductContext } from '../loop/types.js';

const DIR = 'memory/research';

function slugify(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'research';
}

export async function write(ctx: ProductContext, topic: string, markdown: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const name = `${slugify(topic)}-${day}.md`;
  const path = productPath(ctx, DIR, name);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(path, markdown, { mode: 0o600 });
  return path;
}

export async function list(ctx: ProductContext): Promise<{ name: string; path: string; ts: number }[]> {
  const dir = productPath(ctx, DIR);
  if (!existsSync(dir)) return [];
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: { name: string; path: string; ts: number }[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const full = productPath(ctx, DIR, name);
    try {
      const st = await fs.stat(full);
      out.push({ name, path: full, ts: st.mtimeMs });
    } catch { /* skip */ }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

export async function read(ctx: ProductContext, name: string): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(name)) return null;
  const path = productPath(ctx, DIR, name);
  if (!existsSync(path)) return null;
  try { return fs.readFile(path, 'utf8'); } catch { return null; }
}
