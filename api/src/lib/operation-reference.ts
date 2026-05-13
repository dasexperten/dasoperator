// =============================================================================
// Operation reference generator
// Format: ENTITY-YYMMDDXX
//   ENTITY — uppercase company id (DEE, DEI, DASEAN, DEC)
//   YYMMDD — UTC date from operation_date (unix seconds)
//   XX     — daily counter within (entity, day), 01..99 (zero-padded, 2 digits)
//
// Counter is computed by scanning existing references matching the
// ENTITY-YYMMDD prefix for the same day and taking max+1.
// Cancelled, deleted, and legacy-format references are still counted
// (via prefix LIKE) only if they happen to share the new format;
// historical "DEE-123" style refs never match the prefix and are ignored.
//
// In practice the daily count rarely exceeds 9; XX=02 leaves room up to 99.
// If a day ever overflows (>99) we silently widen to 3+ digits.
// =============================================================================

const ENTITY_FROM_COMPANY: Record<string, string> = {
  dee: 'DEE',
  dei: 'DEI',
  dasean: 'DASEAN',
  dec: 'DEC',
};

export function entityForCompany(companyId: string): string | null {
  return ENTITY_FROM_COMPANY[companyId.toLowerCase()] ?? null;
}

function yymmddFromUnix(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export interface OperationReferenceResult {
  reference: string;       // e.g. "DEE-26051301"
  entity: string;          // e.g. "DEE"
  yymmdd: string;          // e.g. "260513"
  counter: number;         // e.g. 1
}

/**
 * Issue the next operation reference for the given (company, operation_date).
 * Reads existing references in the same (entity, day) bucket and returns
 * max(counter) + 1.
 *
 * Race condition note: D1 has no UNIQUE constraint on operations.reference,
 * so concurrent inserts in the same millisecond on the same day could in
 * theory issue the same reference. In a single-region single-writer Worker
 * this is effectively impossible; if it ever does happen we accept the
 * collision (operations.reference is informational, not a primary key).
 */
export async function issueOperationReference(
  db: D1Database,
  companyId: string,
  operationDateUnix: number
): Promise<OperationReferenceResult | null> {
  const entity = entityForCompany(companyId);
  if (!entity) return null;

  const yymmdd = yymmddFromUnix(operationDateUnix);
  const prefix = `${entity}-${yymmdd}`;          // e.g. "DEE-260513"
  const likePattern = `${prefix}%`;              // e.g. "DEE-260513%"

  // Pull all existing refs in this (entity, day) bucket, including cancelled
  // and soft-deleted, so the counter never collides with a historical row.
  const rows = await db.prepare(`
    SELECT reference
    FROM operations
    WHERE reference LIKE ?
  `).bind(likePattern).all<{ reference: string }>();

  let maxCounter = 0;
  for (const row of rows.results) {
    const ref = row.reference;
    // Strip prefix; remaining must be all digits (the counter).
    if (!ref || !ref.startsWith(prefix)) continue;
    const tail = ref.slice(prefix.length);
    if (!/^\d+$/.test(tail)) continue;
    const n = parseInt(tail, 10);
    if (n > maxCounter) maxCounter = n;
  }

  const counter = maxCounter + 1;
  const counterStr = String(counter).padStart(2, '0');

  return {
    reference: `${prefix}${counterStr}`,
    entity,
    yymmdd,
    counter,
  };
}
