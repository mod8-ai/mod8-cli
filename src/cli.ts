import { Command } from 'commander';
import chalk from 'chalk';
import { keysSet, keysList, keysRemove } from './commands/keys.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { readAuth } from './storage/auth.js';
import { runPrompt, resolveProvider } from './commands/prompt.js';
import { runAll, ensureAllConsent } from './commands/all.js';
import { configGet, configSet } from './commands/config.js';
import { runChat } from './commands/chat.js';
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
import { readStdin } from './input/stdin.js';
import { composePrompt } from './input/compose.js';

const program = new Command();

program
  .name('mod8')
  .description(
    'Talk to any LLM from your terminal — Claude, GPT, Gemini, DeepSeek, Mistral, Groq, anything OpenAI-compatible. BYOK.'
  )
  .version('0.5.29');

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
  } else {
    process.stderr.write(chalk.dim(`Local mode — using providers.json (mod8 login to use the hosted proxy)\n`));
  }
}

program.parseAsync().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red('mod8: ') + msg);
  process.exit(1);
});
