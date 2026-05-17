/**
 * Provider-specific shaping of the project context before it lands in the
 * system prompt.
 *
 * MVP: pass-through.  Every provider gets the same string.  This file
 * exists so we have ONE place to add per-provider shaping later (e.g.
 * Gemini gets more repo structure, DeepSeek gets a compressed digest,
 * Claude gets richer architecture reasoning) without touching the prompt
 * builder or the call sites.
 *
 * Keep this module pure — no I/O, no Ink, no logging.  Both the REPL and
 * the one-shot agent call into it on every turn.
 */

import type { RawProjectContext } from './projectContext.js';

/** Shape the project-context payload for a specific provider+model.
 *
 *  Today: returns `raw.content` unchanged for every provider.
 *  Tomorrow: provider-specific transforms plug in here. */
export function shapeProjectContextForProvider(
  raw: RawProjectContext,
  _providerId: string,
  _model: string
): string {
  return raw.content;
}
