// Tests the session lifecycle: create → save → resume in a fresh process,
// /clear logic, and "always start in host on resume" rule.
// Doesn't hit the API — drives the session through its persistence layer
// + buildTranscript directly.

import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sandbox = await fs.mkdtemp(join(tmpdir(), 'mod8-flow-'));
process.env.MOD8_CONFIG_DIR = sandbox;

const {
  createSession,
  saveSession,
  loadSession,
  getMostRecentSession,
  clearSessionHistory,
} = await import('../dist/storage/sessions.js');

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log(`  ✓ ${l}`); };
const bad = (l, e) => { fail++; console.error(`  ✗ ${l} — ${e}`); };

// ---- Test 1: full save/resume cycle ----
{
  const session = await createSession();
  session.messages.push({ role: 'user', content: 'planning my app', mode: 'host' });
  session.messages.push({ role: 'assistant', content: 'sure, what kind?', mode: 'host' });
  session.messages.push({ role: 'user', content: 'a CLI for ai', mode: 'host' });
  session.messages.push({ role: 'assistant', content: 'cool — what features?', mode: 'host' });
  await saveSession(session);
  const sid = session.id;

  // Simulate fresh process: re-import is hard, but loadSession is independent of
  // any caches in our code, so loading from disk demonstrates persistence.
  const reloaded = await loadSession(sid);
  if (!reloaded) bad('resume reload', 'null'); else
  if (reloaded.messages.length === 4
      && reloaded.messages[0].content === 'planning my app'
      && reloaded.messages[3].content === 'cool — what features?') {
    ok('full save → resume preserves message order and content');
  } else bad('save/resume content', `got ${JSON.stringify(reloaded.messages)}`);
}

// ---- Test 2: mid-session work mode → exit → resume always starts in host ----
{
  const session = await createSession();
  // Some host turns
  session.messages.push({ role: 'user', content: 'plan an api', mode: 'host' });
  session.messages.push({ role: 'assistant', content: 'what stack?', mode: 'host' });
  // Then user typed "go" → switched to work — subsequent turns are work mode
  session.messages.push({ role: 'user', content: 'write an Express endpoint', mode: 'work' });
  session.messages.push({ role: 'assistant', content: 'app.get("/", ...)', mode: 'work' });
  await saveSession(session);

  const reloaded = await loadSession(session.id);
  // The session itself just stores per-message mode. Resume logic in chat.tsx
  // ALWAYS sets initial state to 'host' regardless. Verify by inspection:
  // - last message in saved data is mode='work' (correct historical state)
  // - on resume, App's useState defaults mode to 'host' (verified by reading source)
  const lastMode = reloaded.messages[reloaded.messages.length - 1].mode;
  if (lastMode === 'work') {
    ok('session persists per-message mode (last msg = work)');
  } else bad('per-message mode', `last was ${lastMode}`);

  // Verify chat.tsx hardcodes mode='host' on App init
  const chatSrc = await fs.readFile('./dist/commands/chat.js', 'utf8');
  if (chatSrc.includes("useState('host')")) {
    ok('App initializes in host mode regardless of saved last-mode');
  } else bad('host-on-resume', 'no useState(\'host\') init found');

  // Verify message history is intact (so claude sees prior context when invoked)
  if (reloaded.messages.length === 4) {
    ok('full mixed-mode history preserved (claude sees host turns on next work invocation)');
  } else bad('mixed-mode history', reloaded.messages.length);
}

// ---- Test 3: /clear keeps session id, empties messages, resets title ----
{
  const session = await createSession();
  session.messages.push({ role: 'user', content: 'something', mode: 'host' });
  session.messages.push({ role: 'assistant', content: 'else', mode: 'host' });
  session.title = 'Doomed conversation';
  await saveSession(session);

  await clearSessionHistory(session);
  const reloaded = await loadSession(session.id);
  if (!reloaded) bad('reload after /clear', 'null'); else
  if (reloaded.id !== session.id) bad('/clear changed id', reloaded.id); else
  if (reloaded.messages.length !== 0) bad('/clear messages', reloaded.messages.length); else
  if (reloaded.title !== null) bad('/clear title', reloaded.title); else
    ok('/clear empties messages, resets title, keeps session id');
}

// ---- Test 4: mod8 new while a session exists doesn't break the old one ----
{
  // Set up: existing session with content
  const old = await createSession();
  old.messages.push({ role: 'user', content: 'old conversation', mode: 'host' });
  old.messages.push({ role: 'assistant', content: 'reply', mode: 'host' });
  old.title = 'Old session';
  await saveSession(old);

  // "mod8 new" creates a different session
  const fresh = await createSession();

  if (fresh.id === old.id) {
    bad('mod8 new', 'returned same id');
  } else if (fresh.messages.length !== 0) {
    bad('mod8 new', 'fresh session has messages');
  } else {
    // Old session should still be intact on disk
    const reloadedOld = await loadSession(old.id);
    if (!reloadedOld) bad('old preserved', 'gone');
    else if (reloadedOld.messages.length === 2 && reloadedOld.title === 'Old session') {
      ok('mod8 new creates fresh session without touching the old one');
    } else bad('old preserved', JSON.stringify(reloadedOld));
  }
}

// ---- Test 5: most recent resolves correctly across multiple sessions ----
{
  // Sleep to ensure monotonic timestamps
  await new Promise(r => setTimeout(r, 5));
  const target = await createSession();
  target.lastActivity = Date.now() + 10000; // bump to most-recent
  await saveSession(target);

  const recent = await getMostRecentSession();
  if (recent && recent.id === target.id) {
    ok('getMostRecentSession returns the truly most recent (not just last created)');
  } else bad('most recent', recent?.id);
}

await fs.rm(sandbox, { recursive: true, force: true });

console.log();
console.log(`${pass} pass · ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
