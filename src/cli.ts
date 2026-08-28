import { Command } from 'commander';
import chalk from 'chalk';
import { installCrashHandlers } from './storage/crashLog.js';
import { keysSet, keysList, keysRemove } from './commands/keys.js';

installCrashHandlers();
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { readAuth } from './storage/auth.js';
import { runPrompt, resolveProvider } from './commands/prompt.js';
import { runAll, ensureAllConsent } from './commands/all.js';
import { configGet, configSet } from './commands/config.js';
import { runChat } from './commands/chat.js';
import { demoCommand } from './commands/demo.js';
import {
  getBalance,
  openTopupCheckout,
  formatUsdMicros,
  TOPUP_AMOUNTS_USD,
  NotLoggedIn,
  BillingNotConfigured,
} from './commands/billing.js';
import {
  loopTick,
  loopStatus,
  loopLogs,
  loopAuditVerify,
  loopStart,
  loopStop,
  loopHalt,
  loopResume,
} from './commands/loop.js';
import { approvalsCommand } from './approval/command.js';
import {
  connectAddProduct,
  connectList,
  connectRemove,
  connectAddAdapter,
  pauseLoop,
} from './commands/connect.js';
import { listCommand } from './commands/list.js';
import { verifyCommand } from './commands/verify.js';
import { getMostRecentSession } from './storage/sessions.js';
import { addProviderCommand } from './commands/addProvider.js';
import { publish as publishCommand } from './commands/publish.js';
import { listProvidersCommand } from './commands/providers.js';
import { devHostAsk } from './commands/devHostAsk.js';
import { devResolve } from './commands/devResolve.js';
import { devProjectInfo } from './commands/devProjectInfo.js';
import { devRoutingPrefs } from './commands/devRoutingPrefs.js';
import { devWorkAsk } from './commands/devWorkAsk.js';
import { devSimulate } from './commands/devSimulate.js';
import { devHostSystem } from './commands/devHostSystem.js';
import { driveCommand } from './commands/drive.js';
import { readStdin } from './input/stdin.js';
import { composePrompt } from './input/compose.js';
import { createRequire } from 'node:module';

// Single source of truth for the version: package.json at the package root
// (../package.json relative to both src/cli.ts in dev and dist/cli.js when
// built).  Reading it at runtime keeps `mod8 --version` from ever drifting
// from the published package version again.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('mod8')
  .description(
    'Talk to any LLM from your terminal — Claude, GPT, Gemini, DeepSeek, Mistral, Groq, anything OpenAI-compatible. BYOK.'
  )
  .version(PKG_VERSION);

program
  .argument('[prompt]', 'prompt to send (uses default provider unless a flag is set)')
  .option('-c, --claude', 'use Claude (Anthropic)')
  .option('-o, --openai', 'use OpenAI (GPT)')
  .option('-g, --gemini', 'use Gemini (Google)')
  .option('-d, --deepseek', 'use DeepSeek')
  .option('--all', 'run on every configured provider in parallel and show side-by-side')
  .option('--model <id>', 'starting model for the agent REPL (claude-sonnet-4-6, gpt-4o, gemini-2.5-flash, deepseek-chat)')
  .option('--yes', 'auto-approve every destructive tool call (REPL only)')
  .action(
    async (
      prompt: string | undefined,
      opts: {
        claude?: boolean;
        openai?: boolean;
        gemini?: boolean;
        deepseek?: boolean;
        all?: boolean;
        model?: string;
        yes?: boolean;
      }
    ) => {
      if (!prompt) {
        // Bare `mod8` (no flags, no prompt) → the Ink REPL with full
        // visual identity (per-provider colors, mode-switch banners,
        // bare-name routing, compare grid).  Agent tools integration
        // lands as a follow-up — INTO this REPL, not as a replacement.
        if (!opts.claude && !opts.openai && !opts.gemini && !opts.deepseek && !opts.all) {
          await printStartupBanner();
          await runChat({ fresh: true });
          return;
        }
        program.help();
        return;
      }

      // Order matters: consent must be gathered BEFORE stdin is consumed.
      const stdinPiped = !process.stdin.isTTY;
      if (opts.all) {
        await ensureAllConsent({ stdinPiped });
      }

      const stdinContent = await readStdin();
      const { finalPrompt, warnings } = await composePrompt(prompt, stdinContent);
      for (const w of warnings) {
        console.error(chalk.yellow(`warning: ${w}`));
      }

      if (opts.all) {
        await runAll(finalPrompt);
        return;
      }
      const provider = await resolveProvider(opts);
      await runPrompt({ provider, prompt: finalPrompt });
    }
  );

const keys = program.command('keys').description('Manage API keys (stored locally, never sent anywhere)');
keys
  .command('set <provider>')
  .description('Save an API key for a built-in provider (anthropic | openai | google | deepseek | groq | mistral | xai | openrouter | together)')
  .action(async (provider: string) => {
    await keysSet(provider);
  });
keys
  .command('list')
  .description('List configured providers (keys masked)')
  .action(async () => {
    await keysList();
  });
keys
  .command('remove <provider>')
  .description('Remove a stored API key')
  .action(async (provider: string) => {
    await keysRemove(provider);
  });

program
  .command('chat')
  .description('Open the multi-provider chat REPL (host + workers, /compare, "use X" — no agent tools)')
  .action(async () => {
    await printStartupBanner();
    await runChat({ fresh: true });
  });

program
  .command('new')
  .description('Start a fresh chat session')
  .action(async () => {
    await runChat({ fresh: true });
  });

program
  .command('list')
  .description('Show recent chat sessions')
  .action(async () => {
    await listCommand();
  });

program
  .command('resume [id]')
  .description('Resume the most recent session, or a specific session by id')
  .action(async (id: string | undefined) => {
    if (id) {
      await runChat({ sessionId: id });
      return;
    }
    const recent = await getMostRecentSession();
    if (!recent) {
      console.error(
        chalk.red('mod8: ') +
          'no sessions to resume yet. Try `mod8` to start fresh, or `mod8 list` to see saved sessions.'
      );
      process.exit(1);
    }
    await runChat({ sessionId: recent.id });
  });

program
  .command('add-provider')
  .description('Register a provider (built-in or custom OpenAI-compatible) by pasting its key')
  .action(async () => {
    await addProviderCommand();
  });

program
  .command('providers')
  .description('List configured providers (id, name, model, base URL)')
  .action(async () => {
    await listProvidersCommand();
  });

program
  .command('standup')
  .description('The company briefing — what moved, what is stuck, what needs you (reads Claude Code memory + history, no prompt needed)')
  .option('-d, --days <n>', 'window in days', '7')
  .option('-p, --project <name>', 'only companies matching this label')
  .option('--raw', 'print the deterministic digest without calling a model')
  .option('--provider <id>', 'provider to brief with (anthropic | deepseek | groq | …); default: local Anthropic key, else any local key, else proxy')
  .action(async (o: { days: string; project?: string; raw?: boolean; provider?: string }) => {
    const { standupCommand } = await import('./commands/standup.js');
    await standupCommand({ days: Number(o.days) || 7, project: o.project, raw: o.raw, provider: o.provider });
  });

program
  .command('verify')
  .description("Run mod8's self-verification spec suite (specs/*.yaml)")
  .action(async () => {
    await verifyCommand();
  });

program
  .command('init')
  .description('Scaffold a .mod8/ project-awareness folder in the current directory')
  .option('--force', 'Overwrite existing files (backs them up to <file>.bak)')
  .action(async (opts: { force?: boolean }) => {
    const { runInit } = await import('./commands/init.js');
    await runInit({ ...(opts.force ? { force: true } : {}) });
  });

program
  .command('context')
  .description('Show what project context the agent would load from this directory (debug)')
  .action(async () => {
    const { runContext } = await import('./commands/context.js');
    await runContext();
  });

program
  .command('demo')
  .description('30-second pitch: same prompt across every configured model, side-by-side')
  .action(async () => {
    await demoCommand();
  });

program
  .command('drive <script>')
  .description('Run a scripted session against the real chat REPL and assert on what it renders')
  .option('--json', 'emit machine-readable results instead of a report', false)
  .option('--quiet', 'show pass/fail only, no replies', false)
  .action(async (script: string, opts: { json: boolean; quiet: boolean }) => {
    await driveCommand(script, { json: opts.json, quiet: opts.quiet });
  });

const loop = program
  .command('loop')
  .description('Self-improvement loop — sense → ideate → build → approve → measure → learn');
loop
  .command('tick')
  .description('Run one pass of the loop now (the cron-driven entry; Phase 1)')
  .option('--slug <slug>', 'product slug (default: mod8)')
  .option('--unsafe-no-lock', 'skip the advisory lock — debug only', false)
  .option('-f, --force', 'ignore cadence gates and run every phase now', false)
  .action(async (opts: { slug?: string; unsafeNoLock?: boolean }) => {
    await loopTick(opts);
  });
loop
  .command('status')
  .description('Current loop state — autonomy, last tick, per-phase status, recent events')
  .option('--slug <slug>', 'product slug (default: mod8)')
  .action(async (opts: { slug?: string }) => {
    await loopStatus(opts);
  });
loop
  .command('logs')
  .description('Tail the loop event log (events.jsonl)')
  .option('--slug <slug>', 'product slug (default: mod8)')
  .option('--tail <n>', 'how many events to show (default 50, max 1000)')
  .action(async (opts: { slug?: string; tail?: string }) => {
    await loopLogs(opts);
  });
loop
  .command('start')
  .description('Start the loop daemon — same engine as `loop tick` but long-lived')
  .option('--slug <slug>', 'product slug (default: mod8)')
  .option('--foreground', 'run in foreground (don\'t detach)', false)
  .option('--interval-minutes <n>', 'tick interval (default: policy.cadence.sense_every_minutes)', (v) => parseInt(v, 10))
  .action(async (opts: { slug?: string; foreground?: boolean; intervalMinutes?: number }) => {
    await loopStart(opts);
  });
loop
  .command('stop')
  .description('Stop the running daemon (SIGTERM)')
  .action(async () => { await loopStop(); });
loop
  .command('halt')
  .description('Activate the kill switch — every subsequent tick is a no-op')
  .action(async () => { await loopHalt(); });
loop
  .command('resume')
  .description('Clear the kill switch')
  .action(async () => { await loopResume(); });
loop
  .command('pause')
  .description('Pause the loop until <date> — effective autonomy drops to L1 until then')
  .option('--slug <slug>', 'product slug (default: mod8)')
  .requiredOption('--until <date>', 'ISO date (e.g. 2026-08-15)')
  .action(async (opts: { slug?: string; until: string }) => {
    await pauseLoop(opts.slug ?? 'mod8', opts.until);
  });

const connect = program
  .command('connect')
  .description('Connect a product (or external service adapter) to the mod8 self-improvement loop');
connect
  .command('add <slug>', { isDefault: true })
  .description('Onboard a new product — scaffolds product.md + starter policy.yaml')
  .action(async (slug: string) => { await connectAddProduct(slug); });
connect
  .command('list')
  .description('List connected products')
  .action(async () => { await connectList(); });
connect
  .command('remove <slug>')
  .description('Remove a product (deletes its ~/.config/mod8/products/<slug>/ directory)')
  .action(async (slug: string) => { await connectRemove(slug); });
connect
  .command('add-adapter <slug> <adapter>')
  .description('Store adapter credentials interactively (github, vercel, plausible, posthog, ga4, stripe, slack, discord, …)')
  .action(async (slug: string, adapter: string) => { await connectAddAdapter(slug, adapter); });
loop
  .command('audit')
  .description('Audit-log helpers (verify hash chain)')
  .argument('<action>', 'one of: verify')
  .option('--slug <slug>', 'product slug (default: mod8)')
  .action(async (action: string, opts: { slug?: string }) => {
    if (action !== 'verify') {
      process.stderr.write(`mod8 loop audit: unknown action "${action}" (only "verify" is supported in Phase 1)\n`);
      process.exit(1);
    }
    await loopAuditVerify(opts);
  });

program
  .command('approvals')
  .description('Review pending loop approvals (full-screen Ink panel — same as /approvals in chat)')
  .option('--slug <slug>', 'product slug (default: mod8)')
  .option('--kind <kind>', 'filter by kind (code|doc|website-copy|marketing|user-reply|experiment|paid-campaign|roadmap)')
  .action(async (opts: { slug?: string; kind?: string }) => {
    await approvalsCommand(opts);
  });

const approvalsCli = program.command('approvals-cli').description('Non-interactive approvals (for scripts and tests)');
approvalsCli
  .command('list')
  .option('-s, --slug <slug>', 'product slug', 'mod8')
  .action(async (o: { slug: string }) => {
    const { approvalsList } = await import('./approval/command.js');
    await approvalsList(o);
  });
approvalsCli
  .command('decide <id> <verdict>')
  .description("approve|reject — approve dispatches the act phase like the panel's [a]")
  .option('-s, --slug <slug>', 'product slug', 'mod8')
  .action(async (id: string, verdict: string, o: { slug: string }) => {
    const { approvalsDecide } = await import('./approval/command.js');
    await approvalsDecide(id, verdict, o);
  });

program
  .command('balance')
  .description('Show your mod8 proxy credit balance (requires `mod8 login`)')
  .action(async () => {
    try {
      const b = await getBalance();
      const who = b.email ? chalk.dim(` (${b.email})`) : '';
      process.stdout.write(
        chalk.bold(`mod8 balance: ${formatUsdMicros(b.availableMicros)}`) + who + '\n' +
        chalk.dim(`Top up:  mod8 topup ${TOPUP_AMOUNTS_USD.join('|')}\n`)
      );
    } catch (err) {
      handleBillingError(err);
    }
  });

program
  .command('topup [amount]')
  .description(`Buy mod8 credits via Stripe (amounts: ${TOPUP_AMOUNTS_USD.map((a) => `$${a}`).join(', ')})`)
  .action(async (amountArg: string | undefined) => {
    try {
      const amount = amountArg ? Number(amountArg.replace(/^\$/, '')) : 50;
      if (!Number.isFinite(amount) || amount < 5) {
        process.stderr.write(
          chalk.red(`mod8 topup: invalid amount "${amountArg}". `) +
          `Pick one of $${TOPUP_AMOUNTS_USD.join(', $')} (min $5).\n`
        );
        process.exit(1);
      }
      await openTopupCheckout(amount);
    } catch (err) {
      handleBillingError(err);
    }
  });

function handleBillingError(err: unknown): never {
  if (err instanceof NotLoggedIn) {
    process.stderr.write(
      chalk.yellow('mod8: not logged in. Run ') + chalk.bold('mod8 login') +
      chalk.yellow(' first.\n')
    );
    process.exit(1);
  }
  if (err instanceof BillingNotConfigured) {
    process.stderr.write(
      chalk.yellow(`mod8: billing isn't enabled on this proxy yet (${err.endpoint} returned 404/501).\n`) +
      chalk.dim(`The mod8-proxy deployment needs to be upgraded to a build that includes Stripe.\n`) +
      chalk.dim(`If you're the operator, see docs/PROXY_BILLING_CONTRACT.md in the mod8-cli repo.\n`)
    );
    process.exit(1);
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(chalk.red('mod8: ') + msg + '\n');
  process.exit(1);
}

// Static-site hosting: package the current project's build output and
// ship it to a free <slug>.apps.mod8.ai subdomain.  Dry-run by default
// — the actual upload requires --confirm and a logged-in account.
program
  .command('publish')
  .description('Publish the current project as a static site at <slug>.apps.mod8.ai (dry-run by default)')
  .option('--confirm', 'Actually upload (default is dry run — prints the plan only)')
  .option('--slug <name>', 'Override the auto-derived subdomain (3-32 chars, a-z 0-9 -)')
  .option('--dir <path>', 'Override the auto-detected output dir (e.g. ./build, ./out)')
  .option('--domain <domain>', 'Attach a custom domain (e.g. propflow.com) — site answers at BOTH the apps.mod8.ai URL and your domain')
  .action(async (opts: { confirm?: boolean; slug?: string; dir?: string; domain?: string }) => {
    await publishCommand({
      confirm: !!opts.confirm,
      ...(opts.slug ? { slug: opts.slug } : {}),
      ...(opts.dir ? { dir: opts.dir } : {}),
      ...(opts.domain ? { domain: opts.domain } : {}),
    });
  });

program
  .command('agent <task...>')
  .description('Run a coding agent in the current directory — reads/writes files, runs commands, loops until done.')
  .option('--model <id>', 'Model to use (claude-sonnet-4-6, gpt-4o, gemini-2.5-flash, deepseek-chat, or short aliases: claude, gpt, gemini, deepseek)')
  .option('--yes', 'Auto-approve all destructive tool calls (skip y/n prompts)')
  .option('--max-steps <n>', 'Maximum number of agent steps before stopping (default 20)', (v) => parseInt(v, 10))
  .action(async (taskParts: string[], opts: { model?: string; yes?: boolean; maxSteps?: number }) => {
    const { runAgent } = await import('./commands/agent.js');
    await runAgent(taskParts.join(' '), {
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.yes ? { yes: true } : {}),
      ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
    });
  });

// Dev endpoint: print the resolved auth status + the proxy-routing decision
// for a few canonical provider ids.  Pure (no network).  Used by the login
// behavioral spec.
program
  .command('dev:auth-status')
  .description('print resolved auth.json + proxy routing decision (no network)')
  .action(async () => {
    const { devAuthStatus } = await import('./commands/devAuthStatus.js');
    await devAuthStatus();
  });

program
  .command('login')
  .description('Connect this CLI to your mod8 account — routes calls through the hosted proxy')
  .action(async () => {
    await loginCommand();
  });

program
  .command('logout')
  .description('Drop mod8 credentials — falls back to your local providers.json')
  .action(async () => {
    await logoutCommand();
  });

// Dev endpoint: one-shot through the host (mod8) system prompt — used by
// the chat-meta verify spec to confirm mod8 can answer questions about
// itself. Also useful from the shell for quick meta queries.
program
  .command('dev:host-ask <prompt>')
  .description('one-shot through the host (mod8) system prompt')
  .action(async (prompt: string) => {
    await devHostAsk(prompt);
  });

// Dev endpoint: print how the chat REPL would route a given input string
// (provider switch, compare, or none) — used to test synonym handling.
program
  .command('dev:resolve <input>')
  .description('show how the chat REPL would route an input (debug only)')
  .action(async (input: string) => {
    await devResolve(input);
  });

// Dev endpoint: show which provider/model the Harness would use for a
// phase after env (MOD8_LOOP_MODEL*) and policy.yaml `models:` overrides.
// Resolution only — never opens a connection, never needs a key.
program
  .command('dev:loop-model <phase>')
  .option('--slug <slug>', 'product slug whose policy.yaml models: to apply')
  .description('print the resolved Harness model for a loop phase (debug only)')
  .action(async (phase: string, opts: { slug?: string }) => {
    const { resolveModel } = await import('./agent/providerModel.js');
    const { resolvePhaseModelId, setPolicyModels } = await import('./loop/modelPicker.js');
    if (opts.slug) {
      const { loadPolicy } = await import('./loop/policy.js');
      const { buildProductContext } = await import('./memory/paths.js');
      const policy = await loadPolicy(buildProductContext(opts.slug, process.cwd(), 0));
      setPolicyModels(policy.models);
    }
    const id = resolvePhaseModelId(phase as never);
    const r = resolveModel(id);
    process.stdout.write(`${phase} → ${r.kind} ${r.modelId}\n`);
  });

// Dev endpoint: derive the project identity that mod8 would send with
// each run-tracking call.  Used by behavioral specs to lock in cwd
// → projectId, stack detection, and .mod8/project.yaml override handling.
program
  .command('dev:project-info [cwd]')
  .description('print the project identity mod8 derives for a directory (debug only)')
  .action(async (cwd?: string) => {
    await devProjectInfo(cwd);
  });

// Dev endpoint: drive the per-user routing-prefs module from a shell so
// behavioral specs can assert load / record / preferred without booting
// the full chat UI.
program
  .command('dev:routing-prefs <action> [arg1] [arg2]')
  .description('debug only — drive loadPrefs / recordPick / preferredProviderFor')
  .action(async (action: string, arg1?: string, arg2?: string) => {
    await devRoutingPrefs(action, arg1, arg2);
  });

// Dev endpoint: one-shot through WORK-mode system prompt for the given
// provider.  Used to test that work-mode models stay in character and
// don't impersonate the host.
program
  .command('dev:work-ask <providerId> <prompt>')
  .description('one-shot through the work-mode system prompt for a provider')
  .action(async (providerId: string, prompt: string) => {
    await devWorkAsk(providerId, prompt);
  });

// Dev endpoint: simulate a chat session by reading inputs from stdin and
// applying the same routing state machine the chat REPL uses (no LLM, no
// Ink).  Used by stress-test specs to verify long sequences of switches.
program
  .command('dev:simulate')
  .description('simulate a chat session from stdin (one input per line)')
  .action(async () => {
    await devSimulate();
  });

// Dev endpoint: print the host system prompt as it would be assembled right
// now from current providers.json state.  Used by behavioral specs to
// verify the host-self-knowledge refresh (Bug 1) — rebuilding the prompt
// always reflects the latest providers, not a stale startup snapshot.
program
  .command('dev:host-system')
  .description('print the host system prompt with current provider state')
  .action(async () => {
    await devHostSystem();
  });

// Dev endpoint: print the AGENT system prompt as it would be assembled
// right now from the current cwd's .mod8/context.md (if any).  Used by
// behavioral specs to verify the project-context injection pipeline.
program
  .command('dev:agent-system')
  .description('print the agent system prompt with the current project-context state')
  .option('--provider <id>', 'Provider id (default: anthropic)')
  .option('--model <id>', 'Model id (default: claude-sonnet-4-6)')
  .action(async (opts: { provider?: string; model?: string }) => {
    const { devAgentSystem } = await import('./commands/devAgentSystem.js');
    await devAgentSystem({
      ...(opts.provider ? { providerId: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
  });

// Dev endpoint: test the auto-fallback decision logic for a given count of
// consecutive work-mode errors.  Pure, no API calls.
program
  .command('dev:check-fallback <count>')
  .description('print the auto-fallback decision for N consecutive work errors')
  .action(async (count: string) => {
    const { fallbackDecision, AUTO_FALLBACK_THRESHOLD } = await import(
      './commands/intentRouting.js'
    );
    const n = Number.parseInt(count, 10);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`mod8: count must be a non-negative integer, got ${JSON.stringify(count)}`);
      process.exit(1);
    }
    const decision = fallbackDecision(n);
    console.log(
      `consecutive=${n} threshold=${AUTO_FALLBACK_THRESHOLD} decision=${decision}`
    );
  });

// Dev endpoint: drive the open-browser interceptor's pure parsers from a
// shell.  Behavioral specs use this to lock down which phrases trigger the
// client-side opener (and which fall through to the LLM as normal English).
//
// Usage:
//   mod8 dev:open-browser-parse "<input>"
//     - prints: intent=open url=<resolved-or-null>   (one of two forms)
//     - or: intent=none                              (no open-browser intent)
//   mod8 dev:open-browser-parse --find-url "<transcript-text>"
//     - exercises findRecentUrl on a synthetic single-message transcript
//     - prints: url=<resolved-or-null>
program
  .command('dev:open-browser-parse <input>')
  .description('show how the open-browser interceptor parses an input (debug only)')
  .option('--find-url', 'treat <input> as transcript text; print findRecentUrl()')
  .action(async (input: string, opts: { findUrl?: boolean }) => {
    const { parseOpenBrowser, findRecentUrl } = await import(
      './commands/intentRouting.js'
    );
    if (opts.findUrl) {
      const url = findRecentUrl([{ role: 'assistant', content: input }]);
      console.log(`url=${url ?? 'null'}`);
      return;
    }
    const r = parseOpenBrowser(input);
    if (!r) {
      console.log('intent=none');
      return;
    }
    console.log(`intent=open url=${r.explicitUrl ?? 'null'}`);
  });

// Dev endpoint: pin the four Tier-A slash command parsers (/goal, /cost,
// /help, /preview).  Behavioral specs call this so the parsers can't
// silently drift — every command needs to keep recognizing the inputs
// the help text advertises, plus reject obvious non-matches.
program
  .command('dev:parse-slash <input>')
  .description('show how the Tier-A slash parsers see an input (debug only)')
  .action(async (input: string) => {
    const {
      parseGoalCommand,
      GOAL_CLEAR_SENTINEL,
      isCostCommand,
      isHelpCommand,
      parsePreviewCommand,
      PREVIEW_AUTO_SENTINEL,
    } = await import('./commands/intentRouting.js');
    const g = parseGoalCommand(input);
    const goalLabel =
      g === null ? 'none' : g === GOAL_CLEAR_SENTINEL ? 'clear' : `set:${g}`;
    const p = parsePreviewCommand(input);
    const previewLabel =
      p === null ? 'none' : p === PREVIEW_AUTO_SENTINEL ? 'auto' : `script:${p}`;
    console.log(
      `goal=${goalLabel} cost=${isCostCommand(input)} help=${isHelpCommand(input)} preview=${previewLabel}`
    );
  });

// Dev endpoint: print which model would be sent to the provider, with the
// resolution source (opts > env > providers.json).  No allowlist, no
// substitution — whatever the user wrote (or set in MOD8_<ID>_MODEL) is
// what the SDK will receive.  Behavioral specs use this to verify
// passthrough without making real network calls.
program
  .command('dev:resolve-model <providerId>')
  .description('print the model + resolution source for a provider id')
  .action(async (providerId: string) => {
    const { resolveConfigured } = await import('./storage/providers.js');
    const { resolveModel } = await import('./providers/modelResolution.js');
    const entry = await resolveConfigured(providerId);
    const r = resolveModel(providerId, undefined, entry?.defaultModel);
    console.log(
      `providerId=${providerId} model=${JSON.stringify(r.model)} source=${r.source} envVar=${r.envVar}`
    );
  });

// Dev endpoint: print the EXACT debug line that would be emitted on a
// provider call — including the URL the SDK is about to hit, the resolved
// model, the masked key.  No network call, no SDK invocation, just the
// resolution logic.  Behavioral specs use this to verify model-name
// passthrough into the provider URL without depending on real network.
program
  .command('dev:debug-call <providerId>')
  .description('print the would-be debug-call line for a provider (no network)')
  .action(async (providerId: string) => {
    const { resolveConfigured } = await import('./storage/providers.js');
    const { resolveModel } = await import('./providers/modelResolution.js');
    const { approximateProviderUrl } = await import('./util/debug.js');
    const { maskApiKey } = await import('./util/secrets.js');
    const entry = await resolveConfigured(providerId);
    if (!entry) {
      console.error(`mod8: ${providerId} not configured`);
      process.exit(1);
    }
    const r = resolveModel(providerId, undefined, entry.defaultModel);
    const url = approximateProviderUrl(entry.apiType, r.model, entry.baseUrl);
    console.log(
      `providerId=${providerId} apiType=${entry.apiType} model=${JSON.stringify(r.model)} modelSource=${r.source} key=${maskApiKey(entry.apiKey)} url=${JSON.stringify(url)}`
    );
  });

// Dev endpoint: feed a synthetic error message + provider id through the
// per-kind explainer.  Pure (no API calls).  Behavioral specs use this to
// verify that the diagnoser extracts HTTP code, retry-after, raw message,
// and produces the right kind-specific short / long / suggestion text.
//
// Usage: mod8 dev:explain-error <providerId> "<error message>"
//   e.g. mod8 dev:explain-error google "[403 Forbidden] Your project has been denied access."
program
  .command('dev:explain-error <providerId> <message>')
  .description('print the structured diagnosis for a synthetic provider error')
  .action(async (providerId: string, message: string) => {
    const { explainError } = await import('./providers/errorHints.js');
    const e = explainError(new Error(message), providerId);
    console.log(`kind=${e.kind}`);
    console.log(`short=${e.short}`);
    console.log('long=');
    if (e.long) console.log(e.long);
    console.log(`suggestion=${e.suggestion}`);
  });

const config = program.command('config').description('Manage configuration');
config
  .command('get')
  .description('Show current configuration')
  .action(async () => {
    await configGet();
  });
config
  .command('set <key> <value>')
  .description('Set a config value (e.g. "default anthropic")')
  .action(async (key: string, value: string) => {
    await configSet(key, value);
  });

/**
 * Banner printed before the REPL boots — one line so it never gets in the
 * way.  Quiet on every other entry point (one-shot prompts, dev:* commands,
 * keys/config) so the output stays predictable for scripting.
 */
async function printStartupBanner(): Promise<void> {
  const auth = await readAuth();
  if (auth) {
    const who = auth.email ? chalk.bold(auth.email) : 'mod8 account';
    process.stderr.write(chalk.dim(`Logged in as ${who} — proxy mode (mod8 logout to switch off)\n`));
    return;
  }
  const { configuredProviderIds } = await import('./storage/providers.js');
  const local = await configuredProviderIds();
  if (local.length === 0) {
    // Fresh install — say so explicitly and point at the two ways to
    // add credentials.  This used to claim "Local mode — using
    // providers.json" even when no providers.json existed, leaving
    // first-run users staring at an empty REPL with no clue what to do.
    process.stderr.write(
      chalk.yellow(`No providers configured yet. To get started:\n`) +
      chalk.dim(`  · ${chalk.bold('mod8 keys set <id>')}    (recommended — bring your own key: claude, openai, gemini, deepseek, …)\n`) +
      chalk.dim(`  · ${chalk.bold('mod8 login')}            (optional — connects your mod8 dashboard & account)\n`)
    );
  } else {
    process.stderr.write(chalk.dim(`Ready — ${local.length} provider${local.length === 1 ? '' : 's'} configured with your own key${local.length === 1 ? '' : 's'} (mod8 login to connect your dashboard)\n`));
  }
}

program.parseAsync().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red('mod8: ') + msg);
  process.exit(1);
});
