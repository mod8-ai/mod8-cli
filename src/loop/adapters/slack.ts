/**
 * Slack adapter — notifications-out (sink).  Posts an in-channel
 * message when the loop stages an interesting approval ("mod8 just
 * proposed a fix for issue #42").
 *
 * Phase 3 scope: sink only — does not poll Slack for messages
 * (Phase 4 could add inbound mentions if desired).  Apply() posts to
 * the configured webhook URL; rollback is "delete message" via API.
 *
 * Auth: incoming-webhook URL (paste).  Stored at
 * products/<slug>/connectors/slack.json.  No OAuth required for the
 * simple incoming-webhook flow.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext } from '../types.js';

interface SlackCreds extends AdapterCredsBase {
  authType: 'pat';
  webhookUrl: string;
  /** Optional channel name (purely display; webhook routes itself). */
  channel?: string;
}

export const slackAdapter: Adapter<SlackCreds> = {
  id: 'slack',
  kind: 'sink',
  label: 'Slack (incoming webhook notifications)',

  async validate(_ctx, creds) {
    return creds.webhookUrl?.startsWith('https://hooks.slack.com/')
      ? { ok: true }
      : { ok: false, detail: 'webhookUrl is not a Slack incoming-webhook URL' };
  },

  async apply(ctx, creds, action): Promise<ActionResult> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.webhookUrl) throw new Error('Slack creds missing — connect first');
    let text: string;
    if (action.type === 'social-post') {
      text = action.text;
    } else if (action.type === 'user-reply') {
      text = `[mod8 user-reply draft for ${action.channel}/${action.threadId}]\n${action.text}`;
    } else {
      text = `mod8 loop action: ${action.type}`;
    }
    const r = await fetch(c.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(`Slack webhook returned ${r.status}`);
    const body = await r.text();
    return {
      schemaVersion: 1,
      adapter: 'slack',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: { webhookResponse: body },
      rollbackRecipe: {
        description: 'Slack incoming-webhook posts are not deletable via the webhook API (would need bot token + chat.delete). Manual deletion required.',
        payload: { manual: true, channel: c.channel },
      },
    };
  },
};

export async function readCreds(ctx: ProductContext): Promise<SlackCreds | null> {
  const path = connectorPath(ctx, 'slack');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as SlackCreds; } catch { return null; }
}

register(slackAdapter as Adapter<AdapterCredsBase>);
