/**
 * `mod8 dev:resolve <input>` — runs the chat REPL's intent-routing logic on a
 * single input string and prints the structured result.  Used by behavioral
 * specs to test synonym handling, switch-back triggers, and routing edge
 * cases without booting Ink.
 *
 * Match priority (mirrors what chat.tsx does in handleSubmit):
 *   1. parseHostBack         — "/mod8", "back to mod8", "mod8", etc.
 *   2. parseCompareWithPrompt / isCompareCommand
 *   3. parseProviderRoute    — "use deepseek", "talk with codex", etc.
 *
 * Output format (one line, machine-parseable):
 *   host-back rest=<json>
 *   compare payload=<json>
 *   compare-bare
 *   route id=<raw> resolved=<id|null> rest=<json>
 *   none
 */

import {
  parseProviderRoute,
  parseHostBack,
  parseBareProviderHint,
  parseCompareWithPrompt,
  isCompareCommand,
} from './intentRouting.js';
import {
  resolveProviderHint,
  strictResolveProviderHint,
} from '../storage/providers.js';

export async function devResolve(input: string): Promise<void> {
  const back = parseHostBack(input);
  if (back) {
    process.stdout.write(`host-back rest=${JSON.stringify(back.rest)}\n`);
    return;
  }
  const payload = parseCompareWithPrompt(input);
  if (payload) {
    process.stdout.write(`compare payload=${JSON.stringify(payload)}\n`);
    return;
  }
  if (isCompareCommand(input)) {
    process.stdout.write(`compare-bare\n`);
    return;
  }
  const route = parseProviderRoute(input);
  if (route) {
    const resolved = await resolveProviderHint(route.id);
    process.stdout.write(
      `route id=${route.id} resolved=${resolved ?? 'null'} rest=${JSON.stringify(route.rest)}\n`
    );
    return;
  }
  // Bare-name / first-word / greeting matching — same logic as chat.tsx.
  const bare = parseBareProviderHint(input);
  if (bare) {
    const resolved =
      bare.resolution === 'strict'
        ? await strictResolveProviderHint(bare.name)
        : await resolveProviderHint(bare.name);
    if (resolved) {
      process.stdout.write(
        `route id=${bare.name} resolved=${resolved} rest=${JSON.stringify(bare.rest)}\n`
      );
      return;
    }
  }
  process.stdout.write(`none\n`);
}
