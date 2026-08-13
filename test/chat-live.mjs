// Live end-to-end test of the Ink chat against real Anthropic.
// Drives the App via ink-testing-library: types text, hits Enter,
// waits for streaming to complete, and prints the captured frames.

import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../dist/commands/chat.js';
import { createSession } from '../dist/storage/sessions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 60000, interval = 200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(interval);
  }
  return false;
}

// App requires a session — rendering without one produced empty frames and
// made this test look "broken" for months.
const session = await createSession();
const { lastFrame, stdin, unmount } = render(React.createElement(App, { session }));

await sleep(150);

// A turn is complete when the thinking indicator disappears.  Don't key off
// footer text ("tok ·") — that string moved to a context meter and silently
// broke every wait in this file.
const idle = () => !/thinking…/.test(lastFrame() ?? '');
const settled = async (label) => {
  // Wait for the turn to START before waiting for it to finish — otherwise
  // idle() is trivially true the instant after Enter and every check passes
  // without testing anything.  A very fast turn may never show the indicator,
  // so fall through after a short grace and rely on the frame having grown.
  // Count rendered reply lines, not frame length: an Ink frame is a fixed
  // height viewport, so its character count does NOT grow as the transcript
  // does.  Reply lines start with "│ "; the input box renders "│ ›".
  const replies = () => ((lastFrame() ?? '').match(/^│ (?!›)/gm) ?? []).length;
  const before = replies();
  await waitFor(() => !idle(), { timeoutMs: 5000 });
  const done = await waitFor(() => idle(), { timeoutMs: 45000 });
  const answered = replies() > before;
  const ok = done && answered;
  console.log(ok ? `  ✓ ${label}` : `  → FAILED (${label}: done=${done} answered=${answered})`);
  return ok;
};


console.log('=== Initial frame ===');
console.log(lastFrame());
console.log('');

// --- Turn 1: host turn ---
console.log('=== Turn 1: typing "say hi in exactly 3 words" ===');
stdin.write('say hi in exactly 3 words');
await sleep(100);
stdin.write('\r');

const got1 = await settled('turn 1 (host)');
console.log(got1 ? '  → stream completed' : '  → TIMED OUT');
console.log('');
console.log('--- Frame after turn 1 ---');
console.log(lastFrame());
console.log('');

// --- Switch to work mode ---
console.log('=== Typing "go" to switch to work mode ===');
stdin.write('go');
await sleep(100);
stdin.write('\r');
await sleep(300);
console.log('--- Frame after switch ---');
console.log(lastFrame());
console.log('');

// --- Turn 2: work-mode turn ---
console.log('=== Turn 2: typing "write a one-line bash to count files in cwd" ===');
stdin.write('write a one-line bash to count files in cwd');
await sleep(100);
stdin.write('\r');

console.log('  …waiting for work-mode stream to complete');
const got2 = await settled('turn 2 (work)');
console.log(got2 ? '  → stream completed' : '  → TIMED OUT');
console.log('');
console.log('--- Frame after turn 2 ---');
console.log(lastFrame());
console.log('');

// --- Switch back via @mod8 ---
console.log('=== Typing "@mod8 thanks, that\'s all" to switch back + send ===');
stdin.write("@mod8 thanks, that's all");
await sleep(100);
stdin.write('\r');

console.log('  …waiting for host stream to complete');
const got3 = await settled('turn 3 (back to host)');
console.log(got3 ? '  → stream completed' : '  → TIMED OUT');
console.log('');
console.log('--- Frame after turn 3 ---');
console.log(lastFrame());
console.log('');

// --- /exit ---
console.log('=== Typing "/exit" ===');
stdin.write('/exit');
await sleep(100);
stdin.write('\r');
await sleep(500);

console.log('--- Final frame ---');
console.log(lastFrame());

unmount();
process.exit(0);
