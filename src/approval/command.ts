/**
 * `mod8 approvals` subcommand — renders the same Panel.tsx as the
 * /approvals slash command, in one-shot full-screen mode.
 */

import React from 'react';
import { render } from 'ink';
import { Panel } from './Panel.js';
import type { ApprovalItem } from './types.js';
import type { ProductContext } from '../loop/types.js';
import { loadPolicy } from '../loop/policy.js';
import { run as runAct } from '../loop/phases/act.js';
import * as store from './store.js';
import { buildProductContext } from '../memory/paths.js';

export async function approvalsCommand(opts: { slug?: string; kind?: string }): Promise<void> {
  const slug = opts.slug ?? 'mod8';
  const kindFilter = opts.kind
    ? [opts.kind as ApprovalItem['kind']]
    : undefined;

  const onApprove = async (item: ApprovalItem, ctx: ProductContext): Promise<void> => {
    try {
      const policy = await loadPolicy(ctx);
      const result = await runAct(ctx, policy, { approvalId: item.id });
      if (!result.ok) {
        throw new Error(result.reason ?? 'act phase failed');
      }
    } catch (err) {
      throw new Error(`act dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const instance = render(
    React.createElement(Panel, {
      productSlug: slug,
      repoRoot: process.cwd(),
      onApprove,
      ...(kindFilter ? { filter: kindFilter } : {}),
    })
  );
  await instance.waitUntilExit();
}

/** `mod8 approvals list` — pending items, one line each, no TTY needed. */
export async function approvalsList(opts: { slug?: string }): Promise<void> {
  const ctx = buildProductContext(opts.slug ?? 'mod8', process.cwd(), 0);
  const items = await store.listPending(ctx);
  if (items.length === 0) { process.stdout.write('no pending approvals\n'); return; }
  for (const it of items) {
    process.stdout.write(`${it.id}  ${it.kind}  ${it.proposedAction.type}  ${it.title}\n`);
  }
}

/** `mod8 approvals decide <id> approve|reject` — the [a]/[r] keypress
 *  without the panel.  Approve dispatches act exactly like the panel. */
export async function approvalsDecide(id: string, verdict: string, opts: { slug?: string }): Promise<void> {
  const ctx = buildProductContext(opts.slug ?? 'mod8', process.cwd(), 0);
  if (verdict !== 'approve' && verdict !== 'reject') {
    process.stderr.write("mod8 approvals decide: verdict must be 'approve' or 'reject'\n");
    process.exit(2);
  }
  const state = verdict === 'approve' ? 'approved' : 'rejected';
  const decided = await store.decide(ctx, id, { state, decidedBy: process.env.USER ?? 'user' });
  process.stdout.write(`${state}: ${decided.id} — ${decided.title}\n`);
  if (state !== 'approved') return;
  const policy = await loadPolicy(ctx);
  const result = await runAct(ctx, policy, { approvalId: decided.id });
  if (!result.ok || !result.output?.result) {
    // The act phase records the adapter's failure on the card itself
    // ("Meta creds missing", merge conflict, …) — surface that, not "no result".
    let stored: string | undefined;
    try {
      const after = await store.load(ctx, decided.id);
      const err = (after?.appliedResult as { error?: unknown } | undefined)?.error;
      if (typeof err === 'string' && err) stored = err;
    } catch { /* keep the generic reason */ }
    process.stderr.write(`act failed: ${stored ?? result.reason ?? 'no result'}\n`);
    process.exit(1);
  }
  process.stdout.write(`acted: ${JSON.stringify(result.output.result.payload)}\n`);
}
