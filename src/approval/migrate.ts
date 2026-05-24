/**
 * ApprovalItem migration chain.  Pure functions applied on read.
 *
 * Add a new migration each time the schema bumps:
 *   v1 → v2: shift `kind` enum, rename fields, etc.
 *
 * Archive entries are never deleted; migrations make ancient items
 * readable in current code.  When write-back of an archived item is
 * needed (rarely — typically for an edit-and-resubmit flow), the
 * migrated item is rewritten at the current schemaVersion.
 *
 * Phase 1 ships with the genesis v1; no migrations yet.
 */

/** Apply all migrations needed to bring `raw` up to the current
 *  schemaVersion.  Returns the migrated object (still untyped — the
 *  caller validates with ApprovalItemSchema). */
export function migrate(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  let cur = raw as Record<string, unknown>;
  const v = typeof cur.schemaVersion === 'number' ? cur.schemaVersion : 1;
  // Future: chain migrations here when v2+ ships.
  //   if (v === 1) cur = v1_to_v2(cur);
  //   if (v === 2) cur = v2_to_v3(cur);
  void v;
  return cur;
}
