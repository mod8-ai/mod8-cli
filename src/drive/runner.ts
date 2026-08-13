import React from 'react';
import { App } from '../commands/chat.js';
import { createSession } from '../storage/sessions.js';
import type {
  DriveScript,
  DriveStep,
  DriveResult,
  DriveStepResult,
} from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  interval = 120
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(interval);
  }
  return predicate();
}

/**
 * Transcript lines render with a coloured vertical bar: "│ text".  The input
 * box renders "│ ›".  Tool activity renders as "  ✓ Listed  ·  20 entries".
 * We strip ANSI before matching so colour never affects assertions.
 */
const ANSI = /\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI, '');

const replyLines = (frame: string): string[] =>
  stripAnsi(frame)
    .split('\n')
    .filter((l) => /^│ /.test(l) && !/^│ ›/.test(l))
    .map((l) => l.replace(/^│ /, '').trimEnd());

const toolLines = (frame: string): string[] =>
  stripAnsi(frame)
    .split('\n')
    .filter((l) => /^\s+✓ \S/.test(l))
    .map((l) => l.trim().replace(/^✓ /, ''));

const isThinking = (frame: string) => /thinking…/.test(stripAnsi(frame));

/**
 * A turn is finished only when the REPL has been BOTH not-thinking and
 * visually unchanged for a sustained window.  A momentary "not thinking" is
 * not enough: during an agent turn the indicator drops out between tool
 * calls, so a naive check reports the turn complete while the model is still
 * working, and the real answer then lands inside the NEXT step's window.
 */
async function waitQuiescent(
  frame: () => string,
  timeoutMs: number,
  quietMs = 1_600
): Promise<boolean> {
  const start = Date.now();
  let lastChange = Date.now();
  let previous = frame();

  while (Date.now() - start < timeoutMs) {
    await sleep(120);
    const current = frame();
    if (current !== previous) {
      previous = current;
      lastChange = Date.now();
      continue;
    }
    if (!isThinking(current) && Date.now() - lastChange >= quietMs) return true;
  }
  return false;
}

/**
 * The status line names the active speaker: "<icon> <name> · esc to
 * interrupt".  Match that line specifically — the welcome banner also
 * contains the string "mod8" and never scrolls away, so testing the whole
 * frame reports host mode forever.
 */
const modeOf = (frame: string): 'host' | 'work' => {
  const status = stripAnsi(frame)
    .split('\n')
    .reverse()
    .find((l) => l.includes('esc to interrupt'));
  if (!status) return 'host';
  return /^\s*✻ mod8 ·/.test(status) ? 'host' : 'work';
};

function checkStep(
  step: DriveStep,
  reply: string,
  tools: string[],
  mode: 'host' | 'work',
  timedOut: boolean
): string[] {
  const failures: string[] = [];
  if (timedOut) failures.push('turn did not settle before timeout');

  const e = step.expect;
  if (!e) return failures;

  if (e.silent && reply.trim().length > 0) {
    failures.push(`expected no reply, got: ${JSON.stringify(reply.slice(0, 80))}`);
  }
  for (const needle of e.reply_contains ?? []) {
    if (!reply.toLowerCase().includes(needle.toLowerCase())) {
      failures.push(`reply missing ${JSON.stringify(needle)}`);
    }
  }
  for (const needle of e.reply_omits ?? []) {
    if (reply.toLowerCase().includes(needle.toLowerCase())) {
      failures.push(`reply should not contain ${JSON.stringify(needle)}`);
    }
  }
  if (e.reply_matches && !new RegExp(e.reply_matches, 'i').test(reply)) {
    failures.push(`reply does not match /${e.reply_matches}/i`);
  }
  for (const tool of e.tool_used ?? []) {
    if (!tools.some((t) => t.toLowerCase().includes(tool.toLowerCase()))) {
      failures.push(
        `expected tool ${JSON.stringify(tool)}; saw [${tools.join(', ') || 'none'}]`
      );
    }
  }
  if (e.mode && mode !== e.mode) {
    failures.push(`expected ${e.mode} mode, was in ${mode} mode`);
  }
  return failures;
}

export async function runDrive(script: DriveScript): Promise<DriveResult> {
  // ink-testing-library is ESM-only and pulls in ink's reconciler; import it
  // lazily so `mod8 --help` and every other command stay fast.
  const { render } = await import('ink-testing-library');

  const started = Date.now();
  const turnTimeout = script.timeout_ms ?? 45_000;
  const session = await createSession();
  const { lastFrame, stdin, unmount } = render(
    React.createElement(App, { session })
  );

  const frame = () => lastFrame() ?? '';
  await sleep(200);

  const steps: DriveStepResult[] = [];

  for (const step of script.steps) {
    const before = replyLines(frame());
    const toolsBefore = toolLines(frame()).length;
    const stepStart = Date.now();

    stdin.write(step.send);
    await sleep(80);
    stdin.write('\r');

    let timedOut = false;
    if (!step.no_turn) {
      // Wait for the turn to START before waiting for it to finish.  Without
      // this, "not thinking" is trivially true the instant after Enter and
      // every step passes without testing anything.  Fast turns may never
      // show the indicator, hence the short grace rather than a hard require.
      await waitFor(() => isThinking(frame()), 6_000);
      timedOut = !(await waitQuiescent(frame, turnTimeout));
    } else {
      await sleep(600);
    }

    const after = replyLines(frame());
    // New reply text = lines appended since the step began.  Comparing counts
    // rather than frame length matters: an Ink frame is a fixed-height
    // viewport, so its character count does not grow as the transcript does.
    const reply = after.slice(before.length).join('\n').trim();
    const tools = toolLines(frame()).slice(toolsBefore);
    const mode = modeOf(frame());
    const failures = checkStep(step, reply, tools, mode, timedOut);

    steps.push({
      label: step.label ?? step.send,
      sent: step.send,
      reply,
      tools,
      mode,
      durationMs: Date.now() - stepStart,
      ok: failures.length === 0,
      failures,
      timedOut,
    });
  }

  const finalFrame = stripAnsi(frame());
  unmount();

  return {
    script: script.name,
    ok: steps.every((s) => s.ok),
    steps,
    finalFrame,
    durationMs: Date.now() - started,
  };
}
