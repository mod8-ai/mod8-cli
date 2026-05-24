/**
 * Hacker News adapter — read-only.  Polls Algolia HN API for stories
 * + comments matching the configured product name / domain, surfaces
 * them as signals so the loop can react ("you got front-paged",
 * "someone is complaining about X").
 *
 * No outbound — HN posting via API is not supported (HN has no
 * official write API; submission requires a logged-in browser flow).
 * Approvals of kind 'social-post' with channel='hn' are blocked at
 * policy.check time when no adapter implements apply().
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase } from './types.js';
import type { ProductContext, Signal } from '../types.js';

interface HnCreds extends AdapterCredsBase {
  authType: 'none';
  /** Comma-separated terms to monitor (e.g. "mod8,mod8.ai"). */
  watchTerms: string;
}

const ALGOLIA = 'https://hn.algolia.com/api/v1';

export const hnAdapter: Adapter<HnCreds> = {
  id: 'hn',
  kind: 'source',
  label: 'Hacker News (Algolia search — read-only)',

  async validate() { return { ok: true }; },

  async *poll(ctx, creds, since): AsyncIterable<Signal> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.watchTerms) return;
    const terms = c.watchTerms.split(',').map((t) => t.trim()).filter(Boolean);
    const sinceUnix = Math.floor(since.getTime() / 1000);
    for (const term of terms) {
      try {
        const r = await fetch(
          `${ALGOLIA}/search_by_date?query=${encodeURIComponent(term)}&numericFilters=created_at_i>${sinceUnix}&hitsPerPage=20`
        );
        if (!r.ok) continue;
        const j = (await r.json()) as { hits?: Array<{ objectID: string; title?: string; comment_text?: string; url?: string; created_at_i?: number; _tags?: string[]; author?: string }> };
        for (const h of j.hits ?? []) {
          const ts = (h.created_at_i ?? Math.floor(Date.now() / 1000)) * 1000;
          const kindTag = h._tags?.includes('story') ? 'story' : h._tags?.includes('comment') ? 'comment' : 'item';
          yield {
            schemaVersion: 1,
            source: 'hn',
            digest: `hn-${h.objectID}`,
            ts,
            kind: `hn.${kindTag}`,
            title: (h.title ?? (h.comment_text ?? '').slice(0, 120) ?? 'HN mention').toString(),
            body: h.comment_text,
            url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
            raw: { id: h.objectID, author: h.author, term },
          };
        }
      } catch { /* tolerate */ }
    }
  },
};

export async function readCreds(ctx: ProductContext): Promise<HnCreds | null> {
  const path = connectorPath(ctx, 'hn');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as HnCreds; } catch { return null; }
}

register(hnAdapter as Adapter<AdapterCredsBase>);
