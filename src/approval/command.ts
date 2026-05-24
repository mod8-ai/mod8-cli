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
