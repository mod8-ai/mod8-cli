/**
 * Adapter stub factory.  Used by Phase 3/4 adapter files until their
 * real bodies land — keeps the registry import set complete so tsc
 * resolves loadAllAdapters() dynamic imports.
 *
 * Stub adapters: register normally, but poll() yields nothing and
 * sink methods are absent.  Adapter-specific bodies replace this
 * factory call when the real implementation ships.
 */

import { register } from './registry.js';
import type { Adapter, AdapterCredsBase } from './types.js';
import type { Signal } from '../types.js';

export function registerStub(id: string, label: string, kind: 'source' | 'sink' | 'both' = 'source'): void {
  const adapter: Adapter<AdapterCredsBase> = {
    id,
    kind,
    label,
    async *poll(): AsyncIterable<Signal> {
      // No-op until real adapter ships.
      return;
    },
  };
  try { register(adapter); } catch { /* already registered */ }
}
