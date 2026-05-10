import { spawn, type ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import chalk from 'chalk';

// Resolve mod8 root from this compiled file's location (dist/verify/runner.js → mod8)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MOD8_ROOT = resolve(__dirname, '..', '..');
const MOD8_BIN_TARGET = join(MOD8_ROOT, 'bin', 'mod8.js');

interface ExpectClause {
  stdout_contains?: string | string[];
  stdout_matches?: string | string[];
  stdout_omits?: string | string[];
  stderr_contains?: string | string[];
  exit_code?: number;
  file_exists?: string;
  file_mode?: string; // path:mode, e.g. "$MOD8_CONFIG_DIR/keys.json:600"
}

interface RunStep {
  run?: string;
  shell?: string;
  stdin?: string;
  expect?: ExpectClause;
}

interface ReplStep {
  send?: string;
  delay_ms?: number;
}

interface SetupStep {
  run?: string;
  shell?: string;
  stdin?: string;
}

interface Test {
  name: string;
  requires_api_key?: boolean;
  run?: string;
  shell?: string;
  stdin?: string;
  expect?: ExpectClause;
  setup?: SetupStep[];
  steps?: RunStep[];
  repl?: {
    run: string;
    inputs?: ReplStep[];
    timeout_ms?: number;
  };
}

interface Spec {
  name: string;
  description?: string;
  requires_api_key?: boolean;
  tests: Test[];
}

interface TestResult {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  durationMs: number;
  reason?: string;
}

interface SpecResult {
  file: string;
  name: string;
  results: TestResult[];
}

export interface VerifySummary {
  pass: number;
  fail: number;
  skipped: number;
  durationMs: number;
  specs: SpecResult[];
}

interface Sandbox {
  dir: string;
  binDir: string;
  env: NodeJS.ProcessEnv;
}

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, '');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function setupSandbox(): Promise<Sandbox> {
  const id = randomBytes(4).toString('hex');
  const dir = join(tmpdir(), `mod8-verify-${id}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const binDir = join(dir, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.symlink(MOD8_BIN_TARGET, join(binDir, 'mod8'));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MOD8_CONFIG_DIR: dir,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };

  // API key: explicit verify key only. Strip the user's real key so
  // tests can never accidentally hit prod credentials.
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GEMINI_API_KEY;
  if (process.env.MOD8_VERIFY_KEY) {
    env.ANTHROPIC_API_KEY = process.env.MOD8_VERIFY_KEY;
  }
  // Ensure consent gate doesn't block --all tests.
  env.MOD8_AUTO_CONFIRM = '1';

  return { dir, binDir, env };
}

async function teardownSandbox(sandbox: Sandbox): Promise<void> {
  await fs.rm(sandbox.dir, { recursive: true, force: true });
}

interface CmdResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runShell(
  command: string,
  stdin: string | undefined,
  env: NodeJS.ProcessEnv,
  timeoutMs = 15000
): Promise<CmdResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn('bash', ['-c', command], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ stdout, stderr, exitCode: code ?? 0 });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function runRepl(
  command: string,
  inputs: ReplStep[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<CmdResult> {
  // Spawn directly via bash; stdin is a regular pipe.  Ink-driven REPLs that
  // require raw-mode TTY will crash on entry — that's expected, the runner just
  // captures whatever stdout/stderr was emitted before the crash + SIGKILL on
  // timeout, so spec assertions can still match against the early output.
  const child: ChildProcess = spawn('bash', ['-c', command], {
    env,
    detached: true, // own process group so we can SIGKILL grandchildren too
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  let resolveClose!: (code: number) => void;
  const closePromise = new Promise<number>((res) => {
    resolveClose = res;
  });

  const killEverything = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    try { child.stdout?.destroy(); } catch { /* ignore */ }
    try { child.stderr?.destroy(); } catch { /* ignore */ }
  };

  const timer = setTimeout(() => {
    killEverything();
    // Fallback: even if 'close' never fires (orphaned grandchild holding
    // pipes open elsewhere), resolve with -1 so the runner can move on.
    setTimeout(() => resolveClose(-1), 500);
  }, timeoutMs);

  child.stdout!.on('data', (d) => { stdout += d.toString(); });
  child.stderr!.on('data', (d) => { stderr += d.toString(); });
  child.on('error', () => {});
  child.stdin!.on('error', () => {});
  child.on('exit', () => { exited = true; });
  child.on('close', (code) => resolveClose(code ?? 0));

  await sleep(300);
  for (const step of inputs) {
    if (exited) break;
    if (step.send !== undefined) {
      try { child.stdin!.write(step.send); } catch { /* ignore — child gone */ }
    }
    if (step.delay_ms !== undefined) {
      await sleep(step.delay_ms);
    }
  }
  try { child.stdin!.end(); } catch { /* ignore */ }

  const exitCode = await closePromise;
  clearTimeout(timer);
  // Best-effort cleanup if we returned via the fallback timer.
  if (exitCode === -1) killEverything();
  return { stdout, stderr, exitCode };
}

interface MatchOk {
  ok: true;
}
interface MatchFail {
  ok: false;
  reason: string;
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

async function matchExpect(
  expect: ExpectClause | undefined,
  result: CmdResult,
  env: NodeJS.ProcessEnv
): Promise<MatchOk | MatchFail> {
  if (!expect) return { ok: true };
  const cleanStdout = stripAnsi(result.stdout);
  const cleanStderr = stripAnsi(result.stderr);

  for (const needle of asArray(expect.stdout_contains)) {
    if (!cleanStdout.includes(needle)) {
      return {
        ok: false,
        reason: `stdout missing ${JSON.stringify(needle)}\n--- actual stdout ---\n${cleanStdout || '(empty)'}\n--- actual stderr ---\n${cleanStderr || '(empty)'}`,
      };
    }
  }

  for (const pattern of asArray(expect.stdout_matches)) {
    const re = compileRegex(pattern);
    if (!re.test(cleanStdout)) {
      return {
        ok: false,
        reason: `stdout doesn't match /${pattern}/\n--- actual stdout ---\n${cleanStdout || '(empty)'}`,
      };
    }
  }

  for (const needle of asArray(expect.stdout_omits)) {
    if (cleanStdout.includes(needle)) {
      return {
        ok: false,
        reason: `stdout should NOT contain ${JSON.stringify(needle)}\n--- actual stdout ---\n${cleanStdout}`,
      };
    }
  }

  for (const needle of asArray(expect.stderr_contains)) {
    if (!cleanStderr.includes(needle)) {
      return {
        ok: false,
        reason: `stderr missing ${JSON.stringify(needle)}\n--- actual stderr ---\n${cleanStderr || '(empty)'}`,
      };
    }
  }

  if (expect.exit_code !== undefined && result.exitCode !== expect.exit_code) {
    return {
      ok: false,
      reason: `expected exit code ${expect.exit_code}, got ${result.exitCode}\n--- stdout ---\n${cleanStdout}\n--- stderr ---\n${cleanStderr}`,
    };
  }

  if (expect.file_exists !== undefined) {
    const path = expandEnv(expect.file_exists, env);
    try {
      await fs.access(path);
    } catch {
      return { ok: false, reason: `file does not exist: ${path}` };
    }
  }

  if (expect.file_mode !== undefined) {
    const [pathRaw, expectedMode] = expect.file_mode.split(':');
    const path = expandEnv(pathRaw!, env);
    try {
      const stat = await fs.stat(path);
      const mode = (stat.mode & 0o777).toString(8);
      if (mode !== expectedMode) {
        return { ok: false, reason: `file ${path} mode is ${mode}, expected ${expectedMode}` };
      }
    } catch (err) {
      return { ok: false, reason: `cannot stat ${path}: ${(err as Error).message}` };
    }
  }

  return { ok: true };
}

/**
 * Collect all *.yaml files under a directory, recursively.  Returns paths
 * relative to the root so display lines stay short ("behavior/foo.yaml"
 * rather than the full sandbox path).
 */
async function collectSpecFiles(root: string, relBase = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...(await collectSpecFiles(join(root, e.name), rel)));
    } else if (e.isFile() && e.name.endsWith('.yaml')) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Compile a regex from a spec string. Supports a leading `(?<flags>)` prefix
 * (e.g. `(?i)…` for case-insensitive) — JS's RegExp doesn't accept inline
 * flags by default, so we strip them and pass to the constructor.
 */
function compileRegex(pattern: string): RegExp {
  const m = pattern.match(/^\(\?([imsuy]+)\)([\s\S]*)$/);
  if (m) return new RegExp(m[2]!, m[1]!);
  return new RegExp(pattern);
}

function expandEnv(s: string, env: NodeJS.ProcessEnv): string {
  return s.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => env[name] ?? '');
}

async function runTest(test: Test, spec: Spec): Promise<TestResult> {
  const start = Date.now();
  const requiresKey = test.requires_api_key ?? spec.requires_api_key ?? false;
  if (requiresKey && !process.env.MOD8_VERIFY_KEY) {
    return {
      name: test.name,
      status: 'skipped',
      durationMs: 0,
      reason: 'no MOD8_VERIFY_KEY',
    };
  }

  let sandbox: Sandbox | null = null;
  try {
    sandbox = await setupSandbox();

    if (test.setup) {
      for (let i = 0; i < test.setup.length; i++) {
        const step = test.setup[i]!;
        const cmd = step.run ?? step.shell;
        if (!cmd) {
          return {
            name: test.name,
            status: 'fail',
            durationMs: Date.now() - start,
            reason: `setup step ${i + 1}: missing 'run' or 'shell'`,
          };
        }
        const result = await runShell(cmd, step.stdin, sandbox.env);
        if (result.exitCode !== 0) {
          return {
            name: test.name,
            status: 'fail',
            durationMs: Date.now() - start,
            reason: `setup step ${i + 1} (${cmd}) exited ${result.exitCode}\n--- stdout ---\n${stripAnsi(result.stdout)}\n--- stderr ---\n${stripAnsi(result.stderr)}`,
          };
        }
      }
    }

    if (test.repl) {
      const result = await runRepl(
        test.repl.run,
        test.repl.inputs ?? [],
        sandbox.env,
        test.repl.timeout_ms ?? 30000
      );
      const match = await matchExpect(test.expect, result, sandbox.env);
      return {
        name: test.name,
        status: match.ok ? 'pass' : 'fail',
        durationMs: Date.now() - start,
        reason: match.ok ? undefined : match.reason,
      };
    }

    if (test.steps) {
      for (let i = 0; i < test.steps.length; i++) {
        const step = test.steps[i]!;
        const cmd = step.run ?? step.shell;
        if (!cmd) {
          return {
            name: test.name,
            status: 'fail',
            durationMs: Date.now() - start,
            reason: `step ${i + 1}: missing 'run' or 'shell'`,
          };
        }
        const result = await runShell(cmd, step.stdin, sandbox.env);
        const match = await matchExpect(step.expect, result, sandbox.env);
        if (!match.ok) {
          return {
            name: test.name,
            status: 'fail',
            durationMs: Date.now() - start,
            reason: `step ${i + 1} (${cmd}): ${match.reason}`,
          };
        }
      }
      return { name: test.name, status: 'pass', durationMs: Date.now() - start };
    }

    if (test.run || test.shell) {
      const cmd = test.run ?? test.shell!;
      const result = await runShell(cmd, test.stdin, sandbox.env);
      const match = await matchExpect(test.expect, result, sandbox.env);
      return {
        name: test.name,
        status: match.ok ? 'pass' : 'fail',
        durationMs: Date.now() - start,
        reason: match.ok ? undefined : match.reason,
      };
    }

    return {
      name: test.name,
      status: 'fail',
      durationMs: Date.now() - start,
      reason: 'test has no run/shell/steps/repl',
    };
  } catch (err) {
    return {
      name: test.name,
      status: 'fail',
      durationMs: Date.now() - start,
      reason: `runner error: ${(err as Error).message}`,
    };
  } finally {
    if (sandbox) await teardownSandbox(sandbox);
  }
}

function printResult(result: TestResult): void {
  const dur = `${(result.durationMs / 1000).toFixed(2)}s`;
  if (result.status === 'pass') {
    console.log(`  ${chalk.green('✓')} ${result.name}  ${chalk.dim(dur)}`);
  } else if (result.status === 'skipped') {
    console.log(
      `  ${chalk.yellow('⊘')} ${chalk.dim(result.name)}  ${chalk.dim(`(skipped — ${result.reason})`)}`
    );
  } else {
    console.log(`  ${chalk.red('✗')} ${result.name}  ${chalk.dim(dur)}`);
    const indented = (result.reason ?? '').split('\n').map((l) => '      ' + l).join('\n');
    console.log(chalk.red(indented));
  }
}

export async function runVerify(opts: { specsDir?: string } = {}): Promise<VerifySummary> {
  const specsDir = opts.specsDir ?? join(MOD8_ROOT, 'specs');
  const start = Date.now();

  let files: string[];
  try {
    files = (await collectSpecFiles(specsDir)).sort();
  } catch {
    console.error(chalk.red(`mod8 verify: no specs/ directory found at ${specsDir}`));
    return { pass: 0, fail: 0, skipped: 0, durationMs: 0, specs: [] };
  }

  if (files.length === 0) {
    console.error(chalk.dim(`mod8 verify: no .yaml specs found in ${specsDir}`));
    return { pass: 0, fail: 0, skipped: 0, durationMs: 0, specs: [] };
  }

  const hasKey = !!process.env.MOD8_VERIFY_KEY;
  console.log();
  console.log(
    chalk.bold('mod8 verify') +
      chalk.dim(` · ${files.length} spec file${files.length === 1 ? '' : 's'}`) +
      (hasKey ? chalk.dim(' · MOD8_VERIFY_KEY set') : chalk.dim(' · no MOD8_VERIFY_KEY (api tests will skip)'))
  );

  const specResults: SpecResult[] = [];
  let totalPass = 0,
    totalFail = 0,
    totalSkipped = 0;

  for (const relPath of files) {
    const path = join(specsDir, relPath);
    const data = await fs.readFile(path, 'utf8');
    let spec: Spec;
    try {
      spec = yaml.load(data) as Spec;
    } catch (err) {
      console.log();
      console.log(chalk.bold(relPath) + chalk.red(' (parse error)'));
      console.log('  ' + chalk.red((err as Error).message));
      totalFail++;
      continue;
    }

    console.log();
    console.log(chalk.bold(relPath) + chalk.dim(` — ${spec.name}`));
    const results: TestResult[] = [];
    for (const test of spec.tests ?? []) {
      const result = await runTest(test, spec);
      results.push(result);
      printResult(result);
      if (result.status === 'pass') totalPass++;
      else if (result.status === 'fail') totalFail++;
      else totalSkipped++;
    }
    specResults.push({ file: relPath, name: spec.name, results });
  }

  const durationMs = Date.now() - start;
  console.log();
  console.log(chalk.dim('─'.repeat(60)));
  const total = totalPass + totalFail + totalSkipped;
  console.log(
    `${chalk.green(totalPass + ' pass')} · ` +
      `${totalFail > 0 ? chalk.red(totalFail + ' fail') : chalk.dim(totalFail + ' fail')} · ` +
      `${chalk.dim(totalSkipped + ' skipped')} · ` +
      `${chalk.dim(total + ' total · ' + (durationMs / 1000).toFixed(2) + 's')}`
  );
  console.log();

  return {
    pass: totalPass,
    fail: totalFail,
    skipped: totalSkipped,
    durationMs,
    specs: specResults,
  };
}
