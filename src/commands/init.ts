/**
 * `mod8 init` — scaffold a `.mod8/` project-awareness folder in cwd.
 *
 * Creates:
 *   - `.mod8/context.md`       (active in MVP — read by every agent run)
 *   - `.mod8/decisions.md`     (placeholder — future memory layer)
 *   - `.mod8/architecture.md`  (placeholder — future memory layer)
 *
 * The two placeholders reserve the namespace and signal direction without
 * doing anything at runtime.  When we add per-topic memory readers later,
 * these files are already in place across user projects.
 *
 * Existing files are NOT clobbered unless `--force` is set, in which case
 * each one is backed up to `<file>.bak` and rewritten with the template.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';

const CONTEXT_TEMPLATE = `# Project context

This file is automatically included in every model's system prompt when
you run \`mod8\` (or \`mod8 agent\`) in this directory.  Keep it tight —
everything you write here lands in the prompt on every turn.

Safe to commit — this is documentation, not a secret.  Do NOT paste API
keys or credentials here.

## Project summary

One paragraph: what this project is, who it's for, what it does.

## Stack

- Language:
- Framework:
- Build / test:
- Deploy target:

## Important folders

- \`src/\` —
- \`tests/\` —
- \`scripts/\` —

## Coding conventions

-

## Rules

- (e.g. "never commit secrets", "all PRs go through main")

## Decisions

- (architectural choices the agent should respect)

## Do-not-touch

- (files / paths the agent must NOT edit without explicit approval)
`;

const DECISIONS_TEMPLATE = `# Decisions

_Reserved for the future mod8 memory layer.  Not yet loaded by the agent._

Use this file to record architectural decisions you want every model to
remember across sessions (the "why" behind tradeoffs, rejected options,
etc.).  In a future mod8 release this will be injected alongside
\`context.md\`.
`;

const ARCHITECTURE_TEMPLATE = `# Architecture

_Reserved for the future mod8 memory layer.  Not yet loaded by the agent._

Use this file to record high-level system design (modules, data flow,
external integrations).  In a future mod8 release this will be injected
alongside \`context.md\`.
`;

const FILES: Array<{ name: string; content: string }> = [
  { name: 'context.md', content: CONTEXT_TEMPLATE },
  { name: 'decisions.md', content: DECISIONS_TEMPLATE },
  { name: 'architecture.md', content: ARCHITECTURE_TEMPLATE },
];

export interface InitOptions {
  force?: boolean;
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  const dir = '.mod8';
  await fs.mkdir(dir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];
  const overwritten: string[] = [];

  for (const f of FILES) {
    const path = join(dir, f.name);
    const exists = await fileExists(path);
    if (exists && !opts.force) {
      skipped.push(path);
      continue;
    }
    if (exists && opts.force) {
      await fs.rename(path, `${path}.bak`);
      overwritten.push(path);
    } else {
      created.push(path);
    }
    await fs.writeFile(path, f.content, { mode: 0o644 });
  }

  for (const p of created) process.stdout.write(chalk.green('✓') + ` created ${p}\n`);
  for (const p of overwritten) {
    process.stdout.write(chalk.yellow('↻') + ` rewrote ${p} (backup at ${p}.bak)\n`);
  }
  for (const p of skipped) {
    process.stdout.write(
      chalk.dim('·') + ` ${p} already exists (use --force to rewrite)\n`
    );
  }

  if (created.length === 0 && overwritten.length === 0) {
    process.stdout.write(
      chalk.dim('\nNothing changed.  Edit .mod8/context.md to describe your project.\n')
    );
    return;
  }

  process.stdout.write(
    '\n' +
      chalk.bold('Next:') +
      ' edit .mod8/context.md to describe your project (summary, stack,\n' +
      'folders, conventions, rules).  Every model will see it.\n'
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
