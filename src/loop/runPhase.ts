/**
 * Shared phase runner.  Every phase calls `runPhase()` (or its
 * deterministic cousin `runDeterministicPhase()` for phases that
 * don't need an LLM).
 *
 * Responsibilities:
 *   - Pre-flight kill switch check (1 line at the top).
 *   - Pre-flight budget check (policy.check spend + budget.canSpend).
 *   - Emit phase.start + phase.complete events.
 *   - Catch + surface errors as phase.error events (never throw past
 *     this boundary — the tick must always end cleanly).
 *   - Append an audit entry for the phase boundary.
 *
 * Phase 1 only exercises the deterministic path (sense.ts uses
 * adapters + memory generators, no LLM call).  Phase 2 fills in the
 * LLM path, which extends RunAgentOptions with a tokenBudget for
 * mid-stream cost-cap enforcement.  The signature here is designed
 * so Phase 2 can add the LLM path without changing the deterministic
 * path's call sites.
 */

import * as kill from './kill.js';
import * as events from './events.js';
import * as audit from './audit.js';
import type { PhaseId, PolicyConfig, ProductContext } from './types.js';

export interface DeterministicPhaseOptions<TOutput> {
  ctx: ProductContext;
  phase: PhaseId;
  policy: PolicyConfig;
  /** The actual phase body.  Returns the structured output that the
   *  next phase consumes (and that gets written to the phase event's
   *  payload). */
  body: () => Promise<TOutput>;
  /** Optional cost estimate.  Deterministic phases usually pass 0;
   *  budget guard short-circuits when 0. */
  estimatedUsd?: number;
  /** Optional summary the audit log will reference.  When omitted,
   *  the phase name is used. */
  summary?: string;
}

export interface PhaseResult<TOutput> {
  ok: boolean;
  output: TOutput | null;
  reason?: string;
  durationMs: number;
}

/** Run a non-LLM phase end-to-end with full safety nets.  Returns
 *  a structured result rather than throwing so tick.ts can decide
 *  whether to continue with the next phase or bail. */
export async function runDeterministicPhase<TOutput>(
  opts: DeterministicPhaseOptions<TOutput>
): Promise<PhaseResult<TOutput>> {
  const start = Date.now();
  const { ctx, phase, policy, body } = opts;

  // 1. Kill switch.
  const ks = kill.check(policy);
  if (ks.active) {
    await events.append(ctx, { phase, kind: 'kill-switch', payload: { reason: ks.reason } });
    await audit.append(ctx, 'kill-switch', { phase, reason: ks.reason });
    return { ok: false, output: null, reason: ks.reason, durationMs: Date.now() - start };
  }

  // 2. Phase start event + audit boundary.
  await events.append(ctx, { phase, kind: 'start' });

  // 3. Run the body.  Catch + surface — never throw past runPhase.
  let output: TOutput | null = null;
  let errorReason: string | undefined;
  try {
    output = await body();
  } catch (err) {
    errorReason = err instanceof Error ? err.message : String(err);
  }
  const durationMs = Date.now() - start;

  if (errorReason !== undefined) {
    await events.append(ctx, {
      phase,
      kind: 'error',
      payload: { reason: errorReason },
      durationMs,
    });
    await audit.append(ctx, 'phase.error', { phase, reason: errorReason, durationMs });
    return { ok: false, output: null, reason: errorReason, durationMs };
  }

  // 4. Phase complete event.  Payload includes a compact summary;
  //    full structured output is the runDeterministicPhase return.
  await events.append(ctx, {
    phase,
    kind: 'complete',
    payload: summarizeOutput(output),
    durationMs,
  });
  await audit.append(ctx, 'phase.complete', { phase, durationMs, summary: opts.summary ?? phase });

  return { ok: true, output, reason: undefined, durationMs };
}

/** Structured-output LLM phase — uses generateObject for a
 *  schema-validated single-shot completion.  Used by ideate (proposals)
 *  and measure (Measurement).  No tools.  No streaming.
 *
 *  Caller passes the Zod schema; runStructuredPhase returns the parsed
 *  object or null on failure (with the failure surfaced as an error
 *  event + audit entry). */
import { generateObject, streamText, stepCountIs } from 'ai';
import type { ZodType } from 'zod';
import { pickModelFor } from './modelPicker.js';
import * as budget from './budget.js';

export interface LlmPhaseBaseOptions {
  ctx: ProductContext;
  phase: PhaseId;
  policy: PolicyConfig;
  /** Per-phase model override (defaults to modelPicker's choice). */
  modelOverride?: string;
  /** Loaded prompt content. */
  system: string;
  /** Per-call max input tokens; used to size the cost estimate. */
  maxOutputTokens?: number;
}

export interface RunStructuredOptions<TOutput> extends LlmPhaseBaseOptions {
  /** Zod schema for the LLM output. */
  schema: ZodType<TOutput>;
  /** User message for this phase — typically a structured digest of
   *  inputs (memory excerpts, signals, priors). */
  userMessage: string;
}

export async function runStructuredPhase<TOutput>(
  opts: RunStructuredOptions<TOutput>
): Promise<PhaseResult<TOutput>> {
  const start = Date.now();
  const { ctx, phase, policy } = opts;

  if (kill.check(policy).active) {
    await events.append(ctx, { phase, kind: 'kill-switch', payload: { reason: kill.check(policy).reason } });
    await audit.append(ctx, 'kill-switch', { phase });
    return { ok: false, output: null, reason: kill.check(policy).reason, durationMs: Date.now() - start };
  }

  await events.append(ctx, { phase, kind: 'start', payload: { mode: 'structured' } });

  const pick = await pickModelFor(phase, opts.modelOverride);
  if (!pick) {
    const reason = `no model available for phase ${phase}`;
    await events.append(ctx, { phase, kind: 'error', payload: { reason }, durationMs: Date.now() - start });
    await audit.append(ctx, 'phase.error', { phase, reason });
    return { ok: false, output: null, reason, durationMs: Date.now() - start };
  }

  // Mock mode short-circuits ahead of budget check (mocks are free).
  if (pick.mock) {
    await events.append(ctx, { phase, kind: 'complete', payload: { mock: true }, durationMs: Date.now() - start });
    await audit.append(ctx, 'phase.complete', { phase, mock: true });
    return { ok: true, output: null, durationMs: Date.now() - start };
  }

  // Pre-flight budget check.
  const planned = estimateCostUsd(pick.modelId, opts.maxOutputTokens ?? 4000);
  const canSpend = await budget.canSpend(ctx, policy, planned, phase);
  if (!canSpend.allowed) {
    await events.append(ctx, { phase, kind: 'budget-exhausted', payload: { reason: canSpend.reason } });
    await audit.append(ctx, 'budget.blocked', { phase, reason: canSpend.reason });
    return { ok: false, output: null, reason: canSpend.reason ?? 'budget exhausted', durationMs: Date.now() - start };
  }

  let output: TOutput | null = null;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let reason: string | undefined;

  try {
    const r = await generateObject({
      model: pick.connection.model,
      system: opts.system,
      prompt: opts.userMessage,
      schema: opts.schema,
      maxOutputTokens: opts.maxOutputTokens ?? 4000,
    });
    output = r.object as TOutput;
    inputTokens = r.usage.inputTokens ?? 0;
    outputTokens = r.usage.outputTokens ?? 0;
    costUsd = estimateActualCost(pick.modelId, inputTokens, outputTokens);
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - start;
  await budget.record(ctx, phase, costUsd, inputTokens, outputTokens, pick.modelId);

  if (reason !== undefined) {
    await events.append(ctx, { phase, kind: 'error', payload: { reason, costUsd }, durationMs, costUsd });
    await audit.append(ctx, 'phase.error', { phase, reason, durationMs });
    return { ok: false, output: null, reason, durationMs };
  }
  await events.append(ctx, { phase, kind: 'complete', payload: { model: pick.modelId, inputTokens, outputTokens, costUsd }, durationMs, costUsd });
  await audit.append(ctx, 'phase.complete', { phase, durationMs, model: pick.modelId, costUsd });
  return { ok: true, output, durationMs };
}

/** Tool-using LLM phase — uses streamText with a per-phase tool
 *  allowlist.  Used by build (real edits in worktree).  Returns a
 *  caller-supplied result shape (build returns BuildOutput with
 *  approvalId; caller extracts from tool-call sequence). */
export interface RunLlmToolsOptions<TOutput> extends LlmPhaseBaseOptions {
  /** AI-SDK tool set, already constructed by the caller (e.g. via
   *  buildInkTools()) and filtered to the allowlist. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  /** User message (initial turn). */
  userMessage: string;
  /** Max agent steps. */
  maxSteps?: number;
  /** Hard wall-clock cap for the whole tool loop (default 12 min). */
  hardTimeoutMs?: number;
  /** Caller maps the completed stream into the phase output. */
  finalize(streamSummary: { text: string; toolCalls: number; toolErrors: number }): TOutput | null;
}

export async function runLlmToolsPhase<TOutput>(opts: RunLlmToolsOptions<TOutput>): Promise<PhaseResult<TOutput>> {
  const start = Date.now();
  const { ctx, phase, policy } = opts;

  if (kill.check(policy).active) {
    await events.append(ctx, { phase, kind: 'kill-switch', payload: { reason: kill.check(policy).reason } });
    return { ok: false, output: null, reason: kill.check(policy).reason, durationMs: Date.now() - start };
  }
  await events.append(ctx, { phase, kind: 'start', payload: { mode: 'tools' } });

  const pick = await pickModelFor(phase, opts.modelOverride);
  if (!pick) {
    return failPhase(ctx, phase, start, `no model available for phase ${phase}`);
  }
  if (pick.mock) {
    await events.append(ctx, { phase, kind: 'complete', payload: { mock: true }, durationMs: Date.now() - start });
    return { ok: true, output: opts.finalize({ text: '', toolCalls: 0, toolErrors: 0 }), durationMs: Date.now() - start };
  }
  const planned = estimateCostUsd(pick.modelId, opts.maxOutputTokens ?? 8000);
  const canSpend = await budget.canSpend(ctx, policy, planned, phase);
  if (!canSpend.allowed) {
    await events.append(ctx, { phase, kind: 'budget-exhausted', payload: { reason: canSpend.reason } });
    return { ok: false, output: null, reason: canSpend.reason ?? 'budget exhausted', durationMs: Date.now() - start };
  }

  let text = '';
  let toolCalls = 0;
  let toolErrors = 0;
  const toolTrail: string[] = [];
  let reason: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  // The model call had no timeout: tick #9 hung 17 minutes on a stream that
  // never returned a byte.  Idle = no stream event for IDLE_MS; hard = total.
  const IDLE_MS = 120_000;
  const HARD_MS = opts.hardTimeoutMs ?? 12 * 60_000;
  const abort = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => { reason = `phase idle timeout (${IDLE_MS / 1000}s without a stream event)`; abort.abort(); }, IDLE_MS); };
  const hardTimer = setTimeout(() => { reason = `phase hard timeout (${HARD_MS / 60_000}m)`; abort.abort(); }, HARD_MS);
  try {
    armIdle();
    const result = streamText({
      model: pick.connection.model,
      system: opts.system,
      prompt: opts.userMessage,
      tools: opts.tools,
      stopWhen: stepCountIs(opts.maxSteps ?? 12),
      abortSignal: abort.signal,
    });
    for await (const part of result.fullStream) {
      armIdle();
      if (part.type === 'text-delta') text += (part as { text: string }).text;
      else if (part.type === 'tool-call') {
        toolCalls++;
        const name = (part as { toolName?: string }).toolName ?? '?';
        const input = (part as { input?: unknown }).input as Record<string, unknown> | undefined;
        const arg = input && typeof input === 'object' ? String(input.path ?? input.command ?? input.pattern ?? '') : '';
        if (toolTrail.length < 60) toolTrail.push(arg ? `${name}(${arg.slice(0, 80)})` : name);
      }
      else if (part.type === 'tool-result') {
        const output = (part as { output?: unknown }).output;
        if (typeof output === 'string' && output.startsWith('Error:')) toolErrors++;
      } else if (part.type === 'error') {
        reason = String((part as { error?: unknown }).error ?? 'streamText error');
        break;
      }
    }
    if (!abort.signal.aborted) {
      const usage = await result.usage;
      inputTokens = usage.inputTokens ?? 0;
      outputTokens = usage.outputTokens ?? 0;
    }
  } catch (err) {
    if (reason === undefined) reason = err instanceof Error ? err.message : String(err);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  }

  const costUsd = estimateActualCost(pick.modelId, inputTokens, outputTokens);
  const durationMs = Date.now() - start;
  await budget.record(ctx, phase, costUsd, inputTokens, outputTokens, pick.modelId);

  if (reason !== undefined) {
    await events.append(ctx, { phase, kind: 'error', payload: { reason, costUsd, toolCalls, toolErrors, toolTrail }, durationMs, costUsd });
    await audit.append(ctx, 'phase.error', { phase, reason, durationMs });
    return { ok: false, output: null, reason, durationMs };
  }
  await events.append(ctx, { phase, kind: 'complete', payload: { model: pick.modelId, inputTokens, outputTokens, costUsd, toolCalls, toolErrors, toolTrail }, durationMs, costUsd });
  await audit.append(ctx, 'phase.complete', { phase, durationMs, model: pick.modelId, costUsd });
  return { ok: true, output: opts.finalize({ text, toolCalls, toolErrors }), durationMs };
}

async function failPhase(ctx: ProductContext, phase: PhaseId, start: number, reason: string): Promise<PhaseResult<never>> {
  await events.append(ctx, { phase, kind: 'error', payload: { reason }, durationMs: Date.now() - start });
  await audit.append(ctx, 'phase.error', { phase, reason });
  return { ok: false, output: null, reason, durationMs: Date.now() - start };
}

/** Rough per-1M-token cost lookup.  Tracks Claude / GPT / Gemini /
 *  DeepSeek prices; intentionally over-estimates so budget pre-flight
 *  is conservative.  Refine via providers/pricing.ts when ideate
 *  start needing more precision. */
const COSTS_PER_M: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-7': { input: 15, output: 75 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-5': { input: 3, output: 15 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
};

function estimateCostUsd(modelId: string, maxOutputTokens: number, assumedInputTokens = 4000): number {
  const c = COSTS_PER_M[modelId] ?? { input: 5, output: 25 };
  return (assumedInputTokens * c.input + maxOutputTokens * c.output) / 1_000_000;
}

function estimateActualCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const c = COSTS_PER_M[modelId] ?? { input: 5, output: 25 };
  return (inputTokens * c.input + outputTokens * c.output) / 1_000_000;
}

/** Compact payload for phase.complete events.  We avoid embedding the
 *  full output to keep events.jsonl bounded; consumers that want the
 *  full output should read it from the phase's persisted artifact
 *  (e.g. memory/codebase/architecture.md). */
function summarizeOutput(output: unknown): Record<string, unknown> {
  if (output === null || output === undefined) return {};
  if (typeof output !== 'object') return { value: String(output).slice(0, 200) };
  // For objects, snapshot a small subset of fields.  Each phase's
  // output shape already declares its own summary fields; we just
  // include the top-level numeric counts that are universally useful.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
    if (typeof v === 'number') out[k] = v;
    else if (Array.isArray(v)) out[`${k}_count`] = v.length;
    else if (typeof v === 'string' && v.length < 80) out[k] = v;
  }
  return out;
}
