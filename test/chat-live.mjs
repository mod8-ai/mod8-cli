// Live end-to-end test of the Ink chat against real Anthropic.
// Drives the App via ink-testing-library: types text, hits Enter,
// waits for streaming to complete, and prints the captured frames.

import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../dist/commands/chat.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 60000, interval = 200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(interval);
  }
  return false;
}

const { lastFrame, stdin, unmount } = render(React.createElement(App));

await sleep(150);

console.log('=== Initial frame ===');
console.log(lastFrame());
console.log('');

// --- Turn 1: host turn ---
console.log('=== Turn 1: typing "say hi in exactly 3 words" ===');
stdin.write('say hi in exactly 3 words');
await sleep(100);
stdin.write('\r');

console.log('  …waiting for stream to complete (looking for stats footer "tok ·")');
const got1 = await waitFor(() => /tok ·/.test(lastFrame() ?? ''), { timeoutMs: 30000 });
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
const startCount = (lastFrame() ?? '').match(/tok ·/g)?.length ?? 0;
const got2 = await waitFor(
  () => ((lastFrame() ?? '').match(/tok ·/g)?.length ?? 0) > startCount,
  { timeoutMs: 60000 }
);
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
const startCount2 = (lastFrame() ?? '').match(/tok ·/g)?.length ?? 0;
const got3 = await waitFor(
  () => ((lastFrame() ?? '').match(/tok ·/g)?.length ?? 0) > startCount2,
  { timeoutMs: 30000 }
);
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
