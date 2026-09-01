/**
 * `mod8 dev:host-route` — print the fuel ladder for mod8's own voice.
 *
 * The REPL's failover is invisible by design, which makes it easy to break
 * without noticing.  This is the testable seam: it prints the ordered list of
 * accounts the host voice would speak through, and (with --failed) which one
 * it moves to after the ones named have gone dry.  No network, no model.
 */

import { hostRouteCandidates, nextHostRoute, isFuelFailure } from '../providers/hostRoute.js';
import { markFuelDry, markFuelGood, clearFuelMemory, lastGoodFuel, dryFuelIds } from '../storage/hostFuel.js';

export async function devHostRoute(opts: {
  failed?: string;
  reset?: boolean;
  markDry?: string;
  markGood?: string;
}): Promise<void> {
  if (opts.reset) await clearFuelMemory();
  if (opts.markDry) await markFuelDry(opts.markDry);
  if (opts.markGood) await markFuelGood(opts.markGood);

  const failed = (opts.failed ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Static contract — printed before any early return so it is assertable
  // even on a machine with no fuel at all.
  console.log(
    `fuel_failure_kinds=${['no-credit', 'auth', 'forbidden', 'server', 'context-too-long']
      .map((k) => `${k}:${isFuelFailure(k)}`)
      .join(' ')}`
  );

  const [remembered, dryNow] = await Promise.all([lastGoodFuel(), dryFuelIds()]);
  console.log(`last_good=${remembered ?? 'none'}`);
  console.log(`dry=${dryNow.join(',') || 'none'}`);

  const candidates = await hostRouteCandidates();
  if (candidates.length === 0) {
    console.log('routes=0');
    console.log('voice=unfuelled');
    return;
  }

  console.log(`routes=${candidates.length}`);
  for (const [i, r] of candidates.entries()) {
    console.log(
      `${i + 1}. providerId=${r.providerId} model=${r.model} preferred=${r.preferred}`
    );
  }

  const next = await nextHostRoute(failed);
  console.log(`failed=${failed.join(',') || 'none'}`);
  console.log(`next=${next ? `${next.providerId}/${next.model}` : 'none'}`);
  // The voice never changes, whichever tank pays.
  console.log('voice=mod8');
}
