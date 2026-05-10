/**
 * Public entry point for getting a provider client by id.
 *
 * Used by one-shot (`mod8 -c/-o/-g`), `--all`, and config-set default routing.
 * The chat REPL uses streamProviderChat from genericChat.ts directly.
 */

import type { ProviderClient } from './types.js';
import { buildProviderClient } from './generic.js';

export async function getProviderClient(id: string): Promise<ProviderClient> {
  return buildProviderClient(id);
}
