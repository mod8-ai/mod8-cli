/**
 * Claude Code adapter.  The loop's richest local source: what the user
 * actually asked for in Claude Code sessions on this repo, and the memory
 * files Claude Code wrote about it.  No remote calls, no auth.
 *
 * Signal kinds:
 *   - claude-code.prompt   one per typed prompt in this repo since `since`
 *   - claude-code.memory   one per memory file (about this repo) modified since `since`
 */

import type { Adapter, AdapterCredsBase } from './types.js';
import { register } from './registry.js';
import type { ProductContext, Signal } from '../types.js';
import { readHistory, readMemories, memoryMentionsRepo } from '../../claudecode/reader.js';
import { createHash } from 'node:crypto';

interface ClaudeCodeCreds extends AdapterCredsBase { authType: 'none'; }

const digest = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

export const claudeCodeAdapter: Adapter<ClaudeCodeCreds> = {
  id: 'claude-code',
  kind: 'source',
  label: 'Claude Code sessions + memory',

  async validate() { return { ok: true }; },

  async *poll(ctx: ProductContext, _creds: ClaudeCodeCreds | null, since: Date): AsyncIterable<Signal> {
    const sinceMs = since.getTime();
    for (const h of await readHistory({ since: sinceMs, project: ctx.repoRoot })) {
      // "go", "yes", "ok" carry no signal on their own.
      if (h.text.trim().length < 12) continue;
      yield {
        schemaVersion: 1,
        source: 'claude-code',
        digest: digest(h.sessionId + ':' + h.ts),
        ts: h.ts,
        kind: 'claude-code.prompt',
        title: h.text.length > 120 ? h.text.slice(0, 117) + '…' : h.text,
        body: h.text.length > 120 ? h.text : undefined,
        raw: { sessionId: h.sessionId },
      };
    }
    for (const m of await readMemories({ since: sinceMs })) {
      if (!memoryMentionsRepo(m, ctx.repoRoot)) continue;
      yield {
        schemaVersion: 1,
        source: 'claude-code',
        digest: digest(m.path + ':' + Math.floor(m.mtime)),
        ts: m.mtime,
        kind: 'claude-code.memory',
        title: m.description || m.name,
        body: m.body,
        raw: { path: m.path, type: m.type, name: m.name },
      };
    }
  },
};

register(claudeCodeAdapter as Adapter<AdapterCredsBase>);
