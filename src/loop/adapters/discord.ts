/**
 * Discord adapter — notifications-out via webhook.
 *
 * Same shape as the Slack adapter: posts a message to the configured
 * webhook URL when an approval gets applied; manual deletion required
 * for rollback unless caller stored the message id.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { register } from './registry.js';
import { connectorPath } from '../../memory/paths.js';
import type { Adapter, AdapterCredsBase, ActionResult, ApprovedAction } from './types.js';
import type { ProductContext } from '../types.js';

interface DiscordCreds extends AdapterCredsBase {
  authType: 'pat';
  webhookUrl: string;
  channel?: string;
}

export const discordAdapter: Adapter<DiscordCreds> = {
  id: 'discord',
  kind: 'sink',
  label: 'Discord (webhook notifications)',

  async validate(_ctx, creds) {
    return creds.webhookUrl?.includes('discord.com/api/webhooks/')
      ? { ok: true }
      : { ok: false, detail: 'webhookUrl is not a Discord webhook URL' };
  },

  async apply(ctx, creds, action): Promise<ActionResult> {
    const c = creds ?? (await readCreds(ctx));
    if (!c?.webhookUrl) throw new Error('Discord creds missing — connect first');
    const content = action.type === 'social-post'
      ? action.text
      : action.type === 'user-reply'
        ? `[mod8 user-reply draft for ${action.channel}/${action.threadId}]\n${action.text}`
        : `mod8 loop action: ${action.type}`;
    // Append ?wait=true to get back a message object (with id) for rollback.
    const url = c.webhookUrl.includes('?') ? `${c.webhookUrl}&wait=true` : `${c.webhookUrl}?wait=true`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) throw new Error(`Discord webhook returned ${r.status}`);
    const j = (await r.json()) as { id?: string; channel_id?: string };
    return {
      schemaVersion: 1,
      adapter: 'discord',
      approvalId: (action as ApprovedAction).approvalId,
      appliedAt: Date.now(),
      payload: { messageId: j.id, channelId: j.channel_id },
      rollbackRecipe: {
        description: j.id ? `delete Discord message ${j.id} via webhook DELETE /messages/${j.id}` : 'manual deletion required',
        payload: { messageId: j.id, webhookUrl: c.webhookUrl },
      },
    };
  },

  async rollback(_ctx, creds, result): Promise<{ ok: boolean; detail?: string }> {
    const c = creds ?? null;
    const messageId = result.rollbackRecipe.payload?.messageId as string | undefined;
    const webhookUrl = (result.rollbackRecipe.payload?.webhookUrl as string | undefined) ?? c?.webhookUrl;
    if (!messageId || !webhookUrl) return { ok: false, detail: 'no messageId/webhookUrl available — manual delete required' };
    const r = await fetch(`${webhookUrl}/messages/${messageId}`, { method: 'DELETE' });
    return r.ok ? { ok: true } : { ok: false, detail: `Discord DELETE returned ${r.status}` };
  },
};

export async function readCreds(ctx: ProductContext): Promise<DiscordCreds | null> {
  const path = connectorPath(ctx, 'discord');
  if (!existsSync(path)) return null;
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as DiscordCreds; } catch { return null; }
}

register(discordAdapter as Adapter<AdapterCredsBase>);
