// Programmatic smoke test of the Ink chat UI. No API key needed.
// Renders the App component to a virtual terminal and asserts on the output.

import { render } from 'ink-testing-library';
import React from 'react';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Sandbox sessions storage so we don't touch real config.
const sandbox = await fs.mkdtemp(join(tmpdir(), 'mod8-smoke-'));
process.env.MOD8_CONFIG_DIR = sandbox;

const { App } = await import('../dist/commands/chat.js');
const { createSession } = await import('../dist/storage/sessions.js');
const session = await createSession();

let failures = 0;
const assertContains = (haystack, needle, label) => {
  if (haystack.includes(needle)) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    expected to contain: ${JSON.stringify(needle)}`);
    console.error(`    actual frame:\n${haystack}`);
    failures++;
  }
};

console.log('mod8 chat — Ink UI smoke test\n');

const { lastFrame, stdin, rerender, unmount } = render(React.createElement(App, { session }));

// Give ink a microtask to settle initial render.
await new Promise((r) => setTimeout(r, 100));

const frame = lastFrame();

console.log('Initial frame:');
console.log(frame);
console.log('');

console.log('Assertions:');
assertContains(frame, 'mod8', 'welcome header');
assertContains(frame, 'switch to claude', 'welcome shows switch-in hint');
assertContains(frame, 'back to mod8', 'welcome shows switch-out hint');
assertContains(frame, '/exit', 'welcome shows quit hint');
assertContains(frame, '/clear', 'welcome shows /clear hint');
assertContains(frame, 'mod8', 'status line shows current speaker (mod8)');
assertContains(frame, 'esc to interrupt', 'status line shows interrupt hint');
assertContains(frame, '›', 'input box has prompt prefix');
assertContains(frame, '╭', 'input box has rounded border (top-left corner)');
assertContains(frame, '╰', 'input box has rounded border (bottom-left corner)');
// Branding — model identity must not leak.
if (/claude-(sonnet|opus|haiku)/.test(frame)) {
  console.error(`  ✗ branding: model name leaked to UI`);
  failures++;
} else {
  console.log(`  ✓ branding: no model name in UI`);
}

unmount();

await fs.rm(sandbox, { recursive: true, force: true });

console.log('');
if (failures === 0) {
  console.log(`ALL ASSERTIONS PASS`);
  process.exit(0);
} else {
  console.error(`${failures} assertion(s) failed`);
  process.exit(1);
}
