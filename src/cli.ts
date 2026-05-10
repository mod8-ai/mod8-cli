import { Command } from 'commander';
import chalk from 'chalk';
import { keysSet, keysList, keysRemove } from './commands/keys.js';
import { runPrompt, resolveProvider } from './commands/prompt.js';
import { runAll, ensureAllConsent } from './commands/all.js';
import { configGet, configSet } from './commands/config.js';
import { runChat } from './commands/chat.js';
import { listCommand } from './commands/list.js';
import { verifyCommand } from './commands/verify.js';
import { getMostRecentSession } from './storage/sessions.js';
import { addProviderCommand } from './commands/addProvider.js';
import { listProvidersCommand } from './commands/providers.js';
import { devHostAsk } from './commands/devHostAsk.js';
import { devResolve } from './commands/devResolve.js';
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
  .version('0.1.0');

program
  .argument('[prompt]', 'prompt to send (uses default provider unless a flag is set)')
  .option('-c, --claude', 'use Claude (Anthropic)')
  .option('-o, --openai', 'use OpenAI (GPT)')
  .option('-g, --gemini', 'use Gemini (Google)')
  .option('--all', 'run on every configured provider in parallel and show side-by-side')
  .action(
    async (
      prompt: string | undefined,
      opts: { claude?: boolean; openai?: boolean; gemini?: boolean; all?: boolean }
    ) => {
      if (!prompt) {
        // Bare `mod8` (no flags, no prompt) → enter chat REPL with a FRESH
        // session.  Mirrors how chat products work elsewhere: opening = new
        // conversation; history is one click (or one `mod8 resume`) away.
        // With any flag set but no prompt, fall through to help.
        if (!opts.claude && !opts.openai && !opts.gemini && !opts.all) {
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

program.parseAsync().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red('mod8: ') + msg);
  process.exit(1);
});
