/**
 * The mod8 agent runtime.
 *
 * Wraps Vercel AI SDK's `streamText` + `fullStream` and emits a normalized
 * stream of `RuntimeEvent`s.  UI layers (chat.tsx Ink REPL, agent.ts CLI
 * one-shot) consume this generator and translate events into their own
 * rendering — no `streamText`, no `fullStream`, no React, no chalk in this
 * file.
 *
 * Why an async generator (and not a callback-based API):
 *   - `for await (...)` reads cleanly in the consumer.
 *   - Backpressure is automatic: the generator pauses while the consumer
 *     awaits its yield.
 *   - Abort propagation works through the existing `AbortSignal` plumbing
 *     without an extra cancellation layer.
 *
 * Scope discipline (intentionally limited):
 *   - Does NOT own session persistence, transcript items, or UI state.
 *   - Does NOT decide error policy (retry / fallback / user-facing
 *     formatting).  Errors are emitted as events; the consumer decides.
 *   - Does NOT inject system prompts or build tools — callers do that with
 *     `buildAgentSystemPrompt` and `buildInkTools` (or `buildAgentTools`).
 *
 * This file is internal — no public SDK API yet.
 */

import { streamText, stepCountIs } from 'ai';

type StreamTextOpts = Parameters<typeof streamText>[0];

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
}

export type RuntimeEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: unknown;
      ok: boolean;
    }
  | { type: 'finish'; usage: RuntimeUsage }
  | { type: 'error'; error: Error };

export interface RunAgentOptions {
  /** Provider model — from `buildProviderModel(resolved).model`. */
  model: StreamTextOpts['model'];
  /** Fully-assembled system prompt — from `buildAgentSystemPrompt(...)`. */
  system: string;
  /** Chat history.  Tool-call/result entries are NOT supported yet — pass
   *  only text turns.  `content` is usually a string but can be a Vercel
   *  AI SDK content-part array for multimodal turns (e.g. image attached
   *  to a user message). */
  messages: { role: 'user' | 'assistant'; content: unknown }[];
  /** Tool set — from `buildInkTools(...)` or `buildAgentTools(...)`. */
  tools: StreamTextOpts['tools'];
  /** Stop after this many agent steps (one step = up to one tool call + a
   *  response chunk).  Default: 20. */
  maxSteps?: number;
  /** Caller's abort signal — esc / Ctrl+C / programmatic cancel. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_STEPS = 20;

/**
 * Run one agent turn.  Yields `RuntimeEvent`s as they happen.
 *
 * The generator always ends with EITHER a `finish` event (success) OR an
 * `error` event (any failure, including aborts mid-stream).  Consumers can
 * therefore rely on receiving exactly one terminal event per call.
 */
export async function* runAgent(
  opts: RunAgentOptions
): AsyncIterable<RuntimeEvent> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  let result;
  try {
    // Cast to any: `content` is typed unknown here because callers may
    // pass string OR an AI-SDK content-part array (for multimodal turns
    // — image + text).  The SDK accepts both at runtime; only the static
    // type is narrower.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkMessages = opts.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })) as any;
    result = streamText({
      model: opts.model,
      system: opts.system,
      messages: sdkMessages,
      tools: opts.tools,
      stopWhen: stepCountIs(maxSteps),
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    });
  } catch (err) {
    yield { type: 'error', error: toError(err) };
    return;
  }

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          yield {
            type: 'text-delta',
            delta: (part as { text: string }).text,
          };
          break;

        case 'tool-call':
          yield {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: (part as { input?: unknown }).input,
          };
          break;

        case 'tool-result': {
          const output = (part as { output?: unknown }).output;
          // The inkTools / agentTools convention is to return strings that
          // start with "Error: " when something went wrong.  Honor that
          // here so consumers don't have to re-implement the check.
          const ok = !(typeof output === 'string' && output.startsWith('Error:'));
          yield {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            output,
            ok,
          };
          break;
        }

        case 'error':
          yield { type: 'error', error: toError(part.error) };
          return;

        // Other event kinds (start, finish-step, raw, etc.) are not
        // exposed — they're either trivially mapped to text/tool events
        // already, or carry no information our consumers use.
      }
    }
  } catch (err) {
    yield { type: 'error', error: toError(err) };
    return;
  }

  let usage: { inputTokens?: number; outputTokens?: number };
  try {
    usage = await result.usage;
  } catch {
    usage = {};
  }
  yield {
    type: 'finish',
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    },
  };
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : JSON.stringify(err));
}
