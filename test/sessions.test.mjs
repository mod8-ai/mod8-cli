// Storage-layer tests for sessions. No API key needed.
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const sandbox = await fs.mkdtemp(join(tmpdir(), 'mod8-sessions-test-'));
process.env.MOD8_CONFIG_DIR = sandbox;

const {
  createSession,
  loadSession,
  saveSession,
  listSessions,
  getMostRecentSession,
  clearSessionHistory,
  generateSessionId,
  fallbackTitle,
  SESSION_ID_RE,
  SESSIONS_DIR_PATH,
} = await import('../dist/storage/sessions.js');

let pass = 0, fail = 0;
const ok = (label) => { pass++; console.log(`  ✓ ${label}`); };
const bad = (label, err) => { fail++; console.error(`  ✗ ${label} — ${err}`); };

// 1. ID format
{
  const id = generateSessionId();
  if (SESSION_ID_RE.test(id)) ok('generated id matches YYYY-MM-DD-XXXX format');
  else bad('id format', `got ${id}`);
}

// 2. Create session, load it back
{
  const created = await createSession();
  if (!SESSION_ID_RE.test(created.id)) bad('createSession id', created.id);
  if (created.messages.length !== 0) bad('createSession messages', 'expected empty');
  const loaded = await loadSession(created.id);
  if (!loaded) bad('loadSession', 'returned null');
  else if (loaded.id !== created.id) bad('loadSession id', `got ${loaded.id}`);
  else ok('createSession + loadSession roundtrip');
}

// 3. File permissions 0600
{
  const session = await createSession();
  const path = join(sandbox, 'sessions', `${session.id}.json`);
  const stat = await fs.stat(path);
  const mode = (stat.mode & 0o777).toString(8);
  if (mode === '600') ok('session file mode 0600');
  else bad('file mode', `got ${mode}`);
  // also dir
  const dirStat = await fs.stat(join(sandbox, 'sessions'));
  const dirMode = (dirStat.mode & 0o777).toString(8);
  if (dirMode === '700') ok('sessions dir mode 0700');
  else bad('dir mode', `got ${dirMode}`);
}

// 4. saveSession persists messages and title
{
  const session = await createSession();
  session.messages.push({ role: 'user', content: 'hello', mode: 'host' });
  session.messages.push({ role: 'assistant', content: 'hi', mode: 'host' });
  session.title = 'Test conversation';
  await saveSession(session);
  const reloaded = await loadSession(session.id);
  if (!reloaded) bad('reload after save', 'null');
  else if (reloaded.messages.length !== 2) bad('messages persist', reloaded.messages.length);
  else if (reloaded.title !== 'Test conversation') bad('title persist', reloaded.title);
  else ok('saveSession persists messages + title');
}

// 5. listSessions sorts by lastActivity desc
{
  // Wipe and create fresh
  await fs.rm(join(sandbox, 'sessions'), { recursive: true, force: true });
  const a = await createSession();
  await new Promise(r => setTimeout(r, 5));
  const b = await createSession();
  await new Promise(r => setTimeout(r, 5));
  const c = await createSession();
  // Bump a's lastActivity to be most recent
  a.lastActivity = Date.now() + 1000;
  await saveSession(a);
  const list = await listSessions(20);
  if (list.length !== 3) bad('listSessions count', list.length);
  else if (list[0].id !== a.id) bad('listSessions order', `expected ${a.id} first, got ${list[0].id}`);
  else ok('listSessions sorts by lastActivity desc');
}

// 6. listSessions limit
{
  await fs.rm(join(sandbox, 'sessions'), { recursive: true, force: true });
  for (let i = 0; i < 25; i++) {
    await createSession();
    await new Promise(r => setTimeout(r, 2));
  }
  const list = await listSessions(20);
  if (list.length === 20) ok('listSessions limit=20 returns 20');
  else bad('listSessions limit', `got ${list.length}`);
}

// 7. getMostRecentSession
{
  await fs.rm(join(sandbox, 'sessions'), { recursive: true, force: true });
  const a = await createSession();
  await new Promise(r => setTimeout(r, 5));
  const b = await createSession();
  const recent = await getMostRecentSession();
  if (!recent) bad('getMostRecentSession', 'null');
  else if (recent.id !== b.id) bad('most recent id', `got ${recent.id}`);
  else ok('getMostRecentSession returns last-saved');
}

// 8. clearSessionHistory wipes messages, keeps id
{
  const session = await createSession();
  session.messages.push({ role: 'user', content: 'a', mode: 'host' });
  session.messages.push({ role: 'assistant', content: 'b', mode: 'host' });
  session.title = 'pre-clear title';
  await saveSession(session);
  await clearSessionHistory(session);
  const reloaded = await loadSession(session.id);
  if (!reloaded) bad('reload after clear', 'null');
  else if (reloaded.id !== session.id) bad('clear preserved id', reloaded.id);
  else if (reloaded.messages.length !== 0) bad('clear emptied messages', reloaded.messages.length);
  else if (reloaded.title !== null) bad('clear reset title', reloaded.title);
  else ok('clearSessionHistory empties history but keeps id');
}

// 9. loadSession of non-existent id returns null
{
  const result = await loadSession('2026-01-01-zzzz');
  if (result === null) ok('loadSession non-existent returns null');
  else bad('loadSession non-existent', 'expected null');
}

// 10. loadSession with invalid id format returns null
{
  const result = await loadSession('../../etc/passwd');
  if (result === null) ok('loadSession rejects malformed id (path traversal guard)');
  else bad('loadSession malformed', 'expected null');
}

// 11. fallbackTitle from first user message
{
  const session = {
    version: 1,
    id: '2026-05-06-abcd',
    title: null,
    createdAt: 0,
    lastActivity: 0,
    messages: [
      { role: 'user', content: 'how do I refactor my auth middleware', mode: 'host' },
    ],
  };
  const t = fallbackTitle(session);
  if (t === 'how do I refactor my') ok('fallbackTitle takes first 5 words');
  else bad('fallbackTitle', `got ${JSON.stringify(t)}`);
}

// 12. fallbackTitle on empty session
{
  const session = { version: 1, id: 'x', title: null, createdAt: 0, lastActivity: 0, messages: [] };
  const t = fallbackTitle(session);
  if (t === '(empty session)') ok('fallbackTitle on empty session');
  else bad('fallbackTitle empty', `got ${JSON.stringify(t)}`);
}

// Cleanup
await fs.rm(sandbox, { recursive: true, force: true });

console.log();
console.log(`${pass} pass · ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
