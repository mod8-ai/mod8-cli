/**
 * email-imap adapter — thin shim that documents the recommended path:
 * point your email service's webhook (e.g. Cloudflare Email Workers,
 * Postmark inbound, AWS SES → SNS → file) at
 * `~/.config/mod8/products/<slug>/inbox/` and let the inbox-folder
 * source pick them up.
 *
 * Why no real IMAP client: a production IMAP integration needs OAuth
 * for Gmail/Outlook, app-passwords for others, MIME parsing, attachment
 * handling, dedup-by-message-id state, and an ever-growing folder map.
 * It's a multi-week project; the inbox-folder pipeline is the right
 * surface for v1 and lets every email service work without per-provider
 * adapter code.
 *
 * apply() drafts outbound replies via an SMTP relay if creds include
 * an SMTP URL; otherwise it leaves the draft as a file in
 * `<productDir>/drafts/<approvalId>.eml` for the human to send manually.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath, productPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext } from '../types.js';

interface EmailCreds extends AdapterCredsBase {
  authType: 'pat';
  /** Optional SMTP URL like smtps://user:pass@host:port — when present,
   *  apply() POSTs via a tiny relay endpoint configured by the user
   *  (their proxy / Postmark / etc).  When absent, drafts only. */
  smtpRelayUrl?: string;
  smtpRelayToken?: string;
  /** Display "from" address. */
  from?: string;
}

export const emailAdapter: Adapter<EmailCreds> = {
  id: 'email-imap',
  kind: 'sink',
  label: 'Email (inbound via inbox-folder, outbound via optional SMTP relay)',

  async apply(ctx, creds, action): Promise<ActionResult> {
    const c = creds ?? (await readCreds(ctx));
    if (action.type !== 'user-reply') throw new Error(`email.apply: unsupported type ${action.type}`);

    // Draft file always written — useful as an audit artifact even when relay is configured.
    const draftDir = productPath(ctx, 'drafts');
    await fs.mkdir(draftDir, { recursive: true, mode: 0o700 });
    const draftPath = productPath(ctx, 'drafts', `${(action as ApprovedAction).approvalId}.eml`);
    const draft = [
      `To: ${action.threadId}`,
      `From: ${c?.from ?? 'mod8-loop@example.com'}`,
      `Subject: re: mod8 loop draft`,
      '',
      action.text,
    ].join('\n');
    await fs.writeFile(draftPath, draft, { mode: 0o600 });

    if (c?.smtpRelayUrl && c?.smtpRelayToken) {
      const r = await fetch(c.smtpRelayUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.smtpRelayToken}`, 'Content-Type': 'message/rfc822' },
        body: draft,
      });
      if (!r.ok) {
        // Relay failed — leave the draft on disk and report.
        return {
          schemaVersion: 1,
          adapter: 'email-imap',
          approvalId: (action as ApprovedAction).approvalId,
          appliedAt: Date.now(),
          payload: { draftOnly: true, draftPath, relayError: `HTTP ${r.status}` },
          rollbackRecipe: {
            description: `relay failed — draft saved at ${draftPath}; nothing to undo`,
            payload: { manual: false, draftPath },
          },
        };
      }
    }

    return {
      schemaVersion: 1,
      adapter: 'email-imap',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: { sent: !!c?.smtpRelayUrl, draftPath },
      rollbackRecipe: {
        description: c?.smtpRelayUrl
          ? 'email already sent — cannot recall; mod8 can draft a follow-up correction'
          : `draft saved at ${draftPath} — manually send or delete`,
        payload: { manual: true, draftPath },
      },
    };
  },
};

export async function readCreds(ctx: ProductContext): Promise<EmailCreds | null> {
  const path = connectorPath(ctx, 'email-imap');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as EmailCreds; } catch { return null; }
}

register(emailAdapter as Adapter<AdapterCredsBase>);
