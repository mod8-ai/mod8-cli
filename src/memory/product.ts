/**
 * product.md reader + scaffolder.
 *
 * product.md is the only file the founder writes by hand.  Two pages
 * max.  It defines what the product IS — goal, audience, non-goals,
 * voice, the one metric — and grounds every later phase.  The loop
 * REFUSES TO RUN without it (loop/tick.ts throws ProductMdMissing).
 * This is intentional: AI shouldn't propose changes to a product it
 * doesn't have a charter for.
 *
 * Phase 4's `mod8 connect <slug>` wizard scaffolds a template
 * product.md interactively.  Phase 1 ships the template generator so
 * the user (founder of mod8) can run `mod8 loop tick` and get a clear
 * "write this file" error with the template path.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { productFiles } from './paths.js';
import type { ProductContext } from '../loop/types.js';

export class ProductMdMissing extends Error {
  constructor(public readonly path: string, public readonly templatePath: string) {
    super(
      `product.md missing at ${path}\n` +
      `  The mod8 self-improvement loop refuses to run on a product without a charter.\n` +
      `  Write your charter (2 pages max). A template was scaffolded at:\n` +
      `    ${templatePath}\n` +
      `  Edit it, move it to ${path}, then re-run.`
    );
    this.name = 'ProductMdMissing';
  }
}

/** Read product.md.  Returns the raw markdown — phases consume it as
 *  context, not as structured fields.  This is intentional: the
 *  founder writes prose, the model reads prose, no schema in between. */
export async function read(ctx: ProductContext): Promise<string> {
  const path = productFiles.productMd(ctx);
  if (!existsSync(path)) {
    const tmpl = await scaffoldTemplate(ctx);
    throw new ProductMdMissing(path, tmpl);
  }
  return fs.readFile(path, 'utf8');
}

/** Check existence without throwing.  Used by `mod8 loop status` to
 *  surface "no charter yet" without exiting. */
export async function exists(ctx: ProductContext): Promise<boolean> {
  return existsSync(productFiles.productMd(ctx));
}

/** Write a starter product.md template to <productDir>/product.md.tmpl
 *  so the user can edit + rename.  Returns the template path. */
async function scaffoldTemplate(ctx: ProductContext): Promise<string> {
  const tmplPath = productFiles.productMd(ctx) + '.tmpl';
  await fs.mkdir(dirname(tmplPath), { recursive: true, mode: 0o700 });
  const body = TEMPLATE.replace(/{{slug}}/g, ctx.slug).replace(/{{repoRoot}}/g, ctx.repoRoot);
  await fs.writeFile(tmplPath, body, { mode: 0o600 });
  return tmplPath;
}

const TEMPLATE = `# {{slug}}

> Edit this file, then rename to \`product.md\` (drop the \`.tmpl\` suffix).
> Two pages max. mod8 will refuse to run the loop without it.

## What is this product?

One paragraph. What does it do? Who is it for? What unique thing does
it provide that no other product does?

(Example for mod8 itself: "mod8 is a provider-agnostic AI coding
harness. It picks the best model — Claude, GPT, Gemini, DeepSeek — for
each task automatically. It's for engineers who want their CLI agent to
save money by routing to cheaper models when they're good enough.")

## Who is the user?

- Primary persona (be specific — "indie dev shipping side projects" not "developers")
- What they were using before
- Why they switch to this product

## Non-goals

What this product will NEVER do. Even if a model proposes it.

- (Example: "Will never become a hosted IDE")
- (Example: "Will never own your data — always BYOK or transparent proxy")

## Voice + brand rules

- Tone (formal, casual, blunt, friendly)
- Banned phrases (corporate-speak, hype words)
- How we talk about competitors (with respect, never bash)

## The one metric

If we can only watch one number to know whether this product is
succeeding, what is it?

(Example: "Weekly active CLI sessions per user who completed onboarding")

## Repo

- Source: {{repoRoot}}
- Production: (URL)
- Docs: (URL)

## Out-of-scope topics for mod8 to propose changes about

(Optional — anything you want mod8 to never propose work on, even
when signals point that way.)
`;
