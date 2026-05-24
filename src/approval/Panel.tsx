/**
 * Approval Panel — Ink UI rendered by both /approvals (in chat REPL)
 * and `mod8 approvals` (full-screen one-shot).
 *
 * Affordances per item:
 *   [a]pprove  [r]eject  [e]dit  [w]hy  [s]kip   (+ ↑/↓ navigate, q/esc quit)
 *
 * When the user picks edit, we yield control to EditPanel (Phase 2:
 * structured fields only; $EDITOR for diff is Phase 3+).
 *
 * Approve dispatches to act phase (Phase 3) via the onAct callback;
 * Phase 2 surfaces approvals as decided and persists them, but the
 * actual apply runs in Phase 3 once act adapters land.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import * as store from './store.js';
import type { ApprovalItem } from './types.js';
import type { ProductContext } from '../loop/types.js';
import { buildProductContext } from '../memory/paths.js';

export interface PanelProps {
  productSlug: string;
  repoRoot: string;
  /** Called after an approve; Phase 3 wires the act dispatch here. */
  onApprove?: (item: ApprovalItem, ctx: ProductContext) => Promise<void>;
  /** Filter to specific kinds. */
  filter?: ApprovalItem['kind'][];
  /** Auto-quit after first action (for one-shot subcommand). */
  oneShot?: boolean;
}

type View = 'list' | 'expanded' | 'why' | 'edit' | 'done';

export function Panel({ productSlug, repoRoot, onApprove, filter, oneShot }: PanelProps): React.ReactElement {
  const { exit } = useApp();
  const ctx = buildProductContext(productSlug, repoRoot, 0);
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<View>('list');
  const [status, setStatus] = useState<string>('');
  const [autonomyLabel, setAutonomyLabel] = useState<string>('L?');

  useEffect(() => {
    void (async () => {
      let pending = await store.listPending(ctx);
      if (filter && filter.length > 0) {
        pending = pending.filter((p) => filter.includes(p.kind));
      }
      setItems(pending);
      // Best-effort autonomy display from policy.
      try {
        const { loadPolicy, effectiveAutonomy } = await import('../loop/policy.js');
        const policy = await loadPolicy(ctx);
        setAutonomyLabel(`L${effectiveAutonomy(policy)}`);
      } catch { /* tolerate */ }
    })();
  }, []);

  useInput((input, key) => {
    if (view === 'done') return;
    if (key.escape || input === 'q') {
      exit();
      return;
    }
    if (view === 'list') {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === 'j') setCursor((c) => Math.min(items.length - 1, c + 1));
      else if (key.return) setView('expanded');
      else if (input === 'a') void approve();
      else if (input === 'r') void reject();
      else if (input === 'w') setView('why');
      else if (input === 's') setCursor((c) => Math.min(items.length - 1, c + 1));
      else if (input === 'e') setView('edit');
    } else if (view === 'expanded' || view === 'why' || view === 'edit') {
      if (key.return || input === 'q' || key.escape) setView('list');
      else if (view === 'expanded') {
        if (input === 'a') void approve();
        else if (input === 'r') void reject();
        else if (input === 'w') setView('why');
        else if (input === 'e') setView('edit');
      }
    }
  });

  async function approve(): Promise<void> {
    const item = items[cursor];
    if (!item) return;
    setStatus(`approving ${item.id}...`);
    try {
      const decided = await store.decide(ctx, item.id, { state: 'approved', decidedBy: process.env.USER ?? 'user' });
      if (onApprove) {
        try { await onApprove(decided, ctx); } catch (err) {
          setStatus(`approved but act failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
      // Remove from local view.
      setItems((prev) => prev.filter((_, i) => i !== cursor));
      setCursor((c) => Math.max(0, Math.min(items.length - 2, c)));
      setStatus(`✓ approved ${item.id}`);
      if (oneShot) { setView('done'); setTimeout(() => exit(), 50); }
    } catch (err) {
      setStatus(`approve failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function reject(): Promise<void> {
    const item = items[cursor];
    if (!item) return;
    setStatus(`rejecting ${item.id}...`);
    try {
      await store.decide(ctx, item.id, { state: 'rejected', decidedBy: process.env.USER ?? 'user' });
      // Dispose the worktree if present.
      if (item.worktreePath) {
        try {
          const wt = await import('../loop/worktree.js');
          const handle = await wt.attach(ctx, item.proposalId);
          if (handle) await handle.dispose('rejected');
        } catch { /* tolerate */ }
      }
      setItems((prev) => prev.filter((_, i) => i !== cursor));
      setCursor((c) => Math.max(0, Math.min(items.length - 2, c)));
      setStatus(`✗ rejected ${item.id}`);
      if (oneShot) { setView('done'); setTimeout(() => exit(), 50); }
    } catch (err) {
      setStatus(`reject failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const current = items[cursor];

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>mod8 approvals</Text>
        <Text> — </Text>
        <Text color="cyan">{items.length} pending</Text>
        <Text dimColor>{`  (autonomy: ${autonomyLabel})`}</Text>
      </Box>
      {items.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>no pending approvals — run `mod8 loop tick` to see if any get staged</Text>
        </Box>
      )}
      {view === 'list' && items.map((item, idx) => (
        <ApprovalRow key={item.id} item={item} active={idx === cursor} index={idx + 1} />
      ))}
      {view === 'expanded' && current && (
        <ExpandedView item={current} />
      )}
      {view === 'why' && current && (
        <WhyView item={current} />
      )}
      {view === 'edit' && current && (
        <EditFieldsView item={current} ctx={ctx} onDone={() => setView('list')} />
      )}
      <Box marginTop={1} flexDirection="column">
        {status && <Text color="yellow">{status}</Text>}
        <Text dimColor>
          {view === 'list'
            ? '↑↓ navigate · enter expand · [a]pprove · [r]eject · [w]hy · [e]dit · [s]kip · q/esc quit'
            : 'enter/esc back · [a]pprove · [r]eject · [w]hy · [e]dit'}
        </Text>
      </Box>
    </Box>
  );
}

function ApprovalRow({ item, active, index }: { item: ApprovalItem; active: boolean; index: number }): React.ReactElement {
  const kindBadge = item.kind.toUpperCase().padEnd(8);
  const riskColor = item.risk === 'high' ? 'red' : item.risk === 'medium' ? 'yellow' : 'green';
  const filesLabel = item.proposedAction.type === 'file-edit' || item.proposedAction.type === 'git-pr'
    ? `${item.proposedAction.files.length} file${item.proposedAction.files.length === 1 ? '' : 's'}`
    : item.proposedAction.type;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={active ? 'cyan' : undefined}>{active ? '▶ ' : '  '}</Text>
        <Text dimColor>{`#${index}  `}</Text>
        <Text color="magenta">{kindBadge}</Text>
        <Text> </Text>
        <Text bold>{item.title}</Text>
      </Box>
      <Box marginLeft={4}>
        <Text dimColor>risk: </Text>
        <Text color={riskColor}>{item.risk}</Text>
        <Text dimColor>{' · impact: '}{item.impact}{' · '}{filesLabel}</Text>
        {item.evidence.testsPassed !== undefined && (
          <Text color={item.evidence.testsPassed ? 'green' : 'red'}>
            {item.evidence.testsPassed ? ' · tests passing' : ' · tests failing'}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function ExpandedView({ item }: { item: ApprovalItem }): React.ReactElement {
  const a = item.proposedAction;
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Text bold>{item.title}</Text>
      <Text dimColor>{`${item.id}  ·  proposal ${item.proposalId}`}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{item.reason}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>proposed action: {a.type}</Text>
        {(a.type === 'file-edit' || a.type === 'git-pr') && (
          <>
            <Text dimColor>files: {a.files.join(', ')}</Text>
            <Text dimColor>{`diff: +${a.diffStats.added} / −${a.diffStats.removed} across ${a.diffStats.files} file(s)`}</Text>
            <Text dimColor>{a.diff.split('\n').slice(0, 30).join('\n')}</Text>
            {a.diff.split('\n').length > 30 && <Text dimColor>… (truncated; full patch in worktree)</Text>}
          </>
        )}
        {a.type === 'social-post' && (
          <Text>channel={a.channel}{a.inReplyTo ? ` (in reply to ${a.inReplyTo})` : ''}: {a.text}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text bold>rollback: </Text>
        <Text>{item.rollback.description}</Text>
      </Box>
    </Box>
  );
}

function WhyView({ item }: { item: ApprovalItem }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Text bold>why — {item.title}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>{item.reason}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>signals consulted ({item.signals.length})</Text>
        {item.signals.slice(0, 10).map((s, i) => (
          <Text key={i} dimColor>{`  · ${s.source}/${s.digest}`}</Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>evidence</Text>
        {item.evidence.testsPassed !== undefined && (
          <Text dimColor>{`  tests: ${item.evidence.testsPassed ? 'passed' : 'failed'} (cycles: ${item.evidence.buildCycles ?? 1})`}</Text>
        )}
        {item.evidence.secretScanPassed !== undefined && (
          <Text dimColor>{`  secret scan: ${item.evidence.secretScanPassed ? 'clean' : 'detected'}`}</Text>
        )}
        {item.evidence.diffStats && (
          <Text dimColor>{`  diff: +${item.evidence.diffStats.added} / −${item.evidence.diffStats.removed} across ${item.evidence.diffStats.files} file(s)`}</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>rollback</Text>
        <Text dimColor>{`  ${item.rollback.description}`}</Text>
        <Text dimColor>{`  recipe: ${item.rollback.recipe}`}</Text>
      </Box>
    </Box>
  );
}

function EditFieldsView({ item, ctx, onDone }: { item: ApprovalItem; ctx: ProductContext; onDone: () => void }): React.ReactElement {
  // Phase 2: simple structured-field display + acknowledge.  Full
  // diff-edit via $EDITOR ships in Phase 3.  We persist any tweaks
  // and trigger revalidation in the worktree (test re-run).
  const [editCount, setEditCount] = useState<number>(item.editCount ?? 0);

  useInput(async (input, key) => {
    if (key.return || input === 'q' || key.escape) {
      const updated: ApprovalItem = {
        ...item,
        editCount: editCount + 1,
        state: 'pending-revalidation',
      };
      try {
        await store.updatePending(ctx, updated);
      } catch { /* tolerate */ }
      // Trigger revalidation: re-run tests in worktree (synchronous-ish).
      try {
        const wt = await import('../loop/worktree.js');
        const handle = await wt.attach(ctx, item.proposalId);
        if (handle) {
          const { loadPolicy } = await import('../loop/policy.js');
          const policy = await loadPolicy(ctx);
          const run = await handle.run('sh', ['-c', policy.tests.cmd], { timeoutMs: 5 * 60 * 1000 });
          await store.updatePending(ctx, {
            ...updated,
            state: run.exitCode === 0 ? 'pending' : 'revalidation-failed',
            evidence: { ...updated.evidence, testsPassed: run.exitCode === 0, testOutput: (run.stdout + run.stderr).slice(-2000) },
          });
        }
      } catch { /* tolerate */ }
      setEditCount(editCount + 1);
      onDone();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Text bold>edit — {item.title}</Text>
      <Text dimColor>{`edit count: ${editCount}`}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>Press enter/esc to acknowledge and trigger revalidation (re-runs tests in worktree).</Text>
        <Text dimColor>Phase 2: structured-field display only. Full diff-edit via $EDITOR ships in Phase 3.</Text>
      </Box>
    </Box>
  );
}
