/**
 * `mod8 drive` — scripted end-to-end sessions against the REAL Ink REPL.
 *
 * The point of this module is that it drives the same `App` a human drives.
 * It does not reimplement the REPL, mock the transcript, or shortcut the
 * agent runtime.  If a drive script passes, a person typing the same words
 * would have seen the same thing.
 */

/** One assertion set applied after a step's turn settles. */
export interface DriveExpect {
  /** Substrings that must appear in the reply produced by THIS step. */
  reply_contains?: string[];
  /** Substrings that must NOT appear in the reply produced by this step. */
  reply_omits?: string[];
  /** Regex (JS syntax, no slashes) the reply must match. */
  reply_matches?: string;
  /** Tool activity lines that must appear, e.g. "Listed", "Read", "Wrote". */
  tool_used?: string[];
  /** Assert the REPL is in this mode after the step. */
  mode?: 'host' | 'work';
  /** Assert the step produced no reply at all (e.g. a pure mode switch). */
  silent?: boolean;
}

export interface DriveStep {
  /** Text typed into the input box, then Enter. */
  send: string;
  /** Optional human label for output. Defaults to the sent text. */
  label?: string;
  /** Skip settle-waiting — for inputs that don't start a turn (e.g. "/exit"). */
  no_turn?: boolean;
  expect?: DriveExpect;
}

export interface DriveScript {
  name: string;
  description?: string;
  /** Per-turn settle timeout in ms. Default 45000. */
  timeout_ms?: number;
  steps: DriveStep[];
}

export interface DriveStepResult {
  label: string;
  sent: string;
  /** Reply text this step produced (may be empty for mode switches). */
  reply: string;
  /** Tool activity lines observed during this step. */
  tools: string[];
  mode: 'host' | 'work';
  durationMs: number;
  ok: boolean;
  /** Human-readable assertion failures. Empty when ok. */
  failures: string[];
  /** True when the turn never settled inside timeout_ms. */
  timedOut: boolean;
}

export interface DriveResult {
  script: string;
  ok: boolean;
  steps: DriveStepResult[];
  /** Everything the REPL rendered at the end — the final frame. */
  finalFrame: string;
  durationMs: number;
}
