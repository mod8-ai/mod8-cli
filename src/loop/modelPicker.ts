/**
 * Per-phase model selection.
 *
 * Each phase has a default model preference based on its character:
 *   - sense:      cheap, fast (haiku) — though Phase 1 is deterministic
 *   - ideate:     strong reasoner (opus / sonnet) — high-quality proposals
 *   - prioritize: deterministic (no LLM); falls back to haiku if forced
 *   - build:      coder model (sonnet) — needs tool use + quality code
 *   - act:        deterministic (no LLM)
 *   - measure:    sonnet — needs to compare snapshots intelligently
 *   - learn:      deterministic (no LLM) — Beta-Binomial update is pure math
 *
 * Policy can override per-phase via policy.phaseModels (optional).
 * MOD8_MOCK=1 short-circuits to a mock model when set, for tests.
 */

import { resolveModel, buildProviderModel, type ProviderConnection } from '../agent/providerModel.js';
import type { PhaseId } from './types.js';

const DEFAULT_BY_PHASE: Record<PhaseId, string> = {
  sense: 'claude-haiku-4-5',
  ideate: 'claude-sonnet-4-6',
  prioritize: 'claude-haiku-4-5',
  build: 'claude-sonnet-4-6',
  act: 'claude-haiku-4-5',
  measure: 'claude-sonnet-4-6',
  learn: 'claude-haiku-4-5',
};

export interface PhaseModelPick {
  modelId: string;
  label: string;
  connection: ProviderConnection;
  mock: boolean;
}

/** Resolve model + connection for a phase.  Returns null when no
 *  provider is configured (caller treats as "skip LLM, run as
 *  deterministic phase"). */
export async function pickModelFor(phase: PhaseId, override?: string): Promise<PhaseModelPick | null> {
  // Test mode — return a sentinel that the LLM runners detect and
  // use a stub completion instead of hitting any real provider.
  if (process.env.MOD8_MOCK === '1') {
    return {
      modelId: 'mock',
      label: 'mock',
      mock: true,
      connection: { model: null as unknown as ProviderConnection['model'], source: 'local' },
    };
  }
  // MOD8_LOOP_MODEL=<model> routes every phase to one model (e.g. deepseek-chat
  // when the Anthropic proxy is out of credits); MOD8_LOOP_MODEL_<PHASE> wins per phase.
  const envPhase = process.env[`MOD8_LOOP_MODEL_${phase.toUpperCase()}`]?.trim();
  const envAll = process.env.MOD8_LOOP_MODEL?.trim();
  const id = override ?? (envPhase || envAll || DEFAULT_BY_PHASE[phase]);
  try {
    const resolved = resolveModel(id);
    const conn = await buildProviderModel(resolved);
    return { modelId: resolved.modelId, label: resolved.label, connection: conn, mock: false };
  } catch {
    return null;
  }
}
