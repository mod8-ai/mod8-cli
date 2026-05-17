/**
 * Dev endpoint: print the agent system prompt as it would be assembled
 * right now from the current cwd's `.mod8/context.md` (if any).
 *
 * Pure — no network call, no LLM, no tool execution.  Used by behavioral
 * specs to verify the prompt-injection pipeline end-to-end (walk-up,
 * truncation, footer presence/absence, provider-shaper pass-through)
 * without spending API tokens.
 */

import { buildAgentSystemPrompt } from '../agent/systemPrompt.js';
import { readProjectContext } from '../agent/projectContext.js';
import { shapeProjectContextForProvider } from '../agent/contextShaping.js';

export async function devAgentSystem(opts: {
  providerId?: string;
  model?: string;
} = {}): Promise<void> {
  const providerId = opts.providerId ?? 'anthropic';
  const model = opts.model ?? 'claude-sonnet-4-6';
  const cwd = process.cwd();

  const result = await readProjectContext(cwd);
  const shaped =
    result.kind === 'found'
      ? shapeProjectContextForProvider(result.ctx, providerId, model)
      : undefined;
  const source = result.kind === 'found' ? result.ctx.foundAt : undefined;

  const prompt = buildAgentSystemPrompt({
    cwd,
    model,
    providerLabel: providerId,
    ...(shaped !== undefined ? { projectContext: shaped } : {}),
    ...(source ? { projectContextSource: source } : {}),
  });

  process.stdout.write(prompt + '\n');
}
