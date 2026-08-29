/**
 * `mod8 receipt` — the Friday receipt: outcomes + hit rate, per project and
 * company-wide, from the Harness state under ~/.config/mod8/products/.
 *
 *   --days N        window (default 7)
 *   --slug X        one project only
 *   --raw           deterministic markdown, no LLM (what specs assert on)
 *   --provider ID   narrative provider override
 *
 * Always writes ~/.config/mod8/receipts/<YYYY-MM-DD>.md and prints
 * "saved <path>" last.
 */

import chalk from 'chalk';
import { buildReceiptDigest, renderReceipt, writeReceipt, narrateReceipt } from '../company/receipt.js';

export interface ReceiptCommandOptions { days?: number; slug?: string; raw?: boolean; provider?: string; now?: number }

export async function receiptCommand(opts: ReceiptCommandOptions): Promise<void> {
  const d = await buildReceiptDigest({ days: opts.days, slug: opts.slug, now: opts.now });
  const md = renderReceipt(d);
  const raw = opts.raw || process.env.MOD8_MOCK === '1';
  const out = raw ? md : await narrateReceipt(md, { provider: opts.provider });
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  const path = await writeReceipt(d, md);
  process.stdout.write(chalk.dim(`saved ${path}`) + '\n');
  if (d.unknownSlug) process.exitCode = 1;
}
