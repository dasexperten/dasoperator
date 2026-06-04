// =============================================================================
// Operation reference generator
// Format: PREFIX-YYMMDDXX
//
// Prefix rule:
//   - PURCHASE  → manufacturer.abbreviation (e.g. HHUI, MEIZ, YZJX, WDAA)
//   - SALE      → partner.abbreviation     (e.g. DSXG, DASR, DASCOM);
//                 fallback to companies.id uppercase if partner has none
//   - TRANSFER  → companies.id uppercase   (our_company is sender)
//   - SERVICE   → companies.id uppercase
//   - PRODUCTION→ companies.id uppercase
//
// YYMMDD — UTC date from operation_date (unix seconds)
// XX     — daily counter within (prefix, day), 01..99 (zero-padded, 2 digits)
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
  reference: string;       // e.g. "HHUI-26041601" or "DEE-26051301"
  entity: string;          // the prefix used
  yymmdd: string;          // e.g. "260513"
  counter: number;         // e.g. 1
}

export interface ReferenceInput {
  operationType: string;          // purchase | sale | transfer | service | production
  operationDateUnix: number;
  ourCompanyId: string;
  manufacturerId?: string | null; // for purchases — overrides prefix with manufacturer.abbreviation
  partnerId?: string | null;      // for sales — overrides prefix with partner.abbreviation
}

/**
 * Resolve the prefix string for this operation.
 * Purchases use the manufacturer's abbreviation; everything else uses our company.
 */
async function resolvePrefix(
  db: D1Database,
  input: ReferenceInput,
): Promise<string | null> {
  if (input.operationType === 'purchase' && input.manufacturerId) {
    const row = await db.prepare(
      'SELECT abbreviation FROM manufacturers WHERE id = ?'
    ).bind(input.manufacturerId).first<{ abbreviation: string | null }>();
    if (row?.abbreviation) return row.abbreviation.toUpperCase();
    // Fallback: if manufacturer has no abbreviation, derive from id
    return input.manufacturerId.toUpperCase().slice(0, 6);
  }
  if (input.operationType === 'sale' && input.partnerId) {
    const row = await db.prepare(
      'SELECT abbreviation FROM partners WHERE id = ?'
    ).bind(input.partnerId).first<{ abbreviation: string | null }>();
    if (row?.abbreviation) return row.abbreviation.toUpperCase();
    // Fallback: partner has no abbreviation — use our_company entity
  }
  // Transfer / service / production (and fallbacks) — use our_company entity
  return entityForCompany(input.ourCompanyId);
}

/**
 * Issue the next operation reference for the given inputs.
 * Reads existing references in the same (prefix, day) bucket and returns
 * max(counter) + 1.
 */
export async function issueOperationReference(
  db: D1Database,
  ...args: [ReferenceInput] | [string, number]
): Promise<OperationReferenceResult | null> {
  // Two call signatures supported for backward compat:
  //   issueOperationReference(db, { operationType, ourCompanyId, manufacturerId, operationDateUnix })
  //   issueOperationReference(db, companyId, operationDateUnix)  ← legacy, treats as our_company prefix
  let input: ReferenceInput;
  if (typeof args[0] === 'string') {
    input = {
      operationType: 'unknown',
      ourCompanyId: args[0] as string,
      operationDateUnix: args[1] as number,
    };
  } else {
    input = args[0] as ReferenceInput;
  }

  const entity = await resolvePrefix(db, input);
  if (!entity) return null;

  const yymmdd = yymmddFromUnix(input.operationDateUnix);
  const prefix = `${entity}-${yymmdd}`;
  const likePattern = `${prefix}%`;

  const rows = await db.prepare(`
    SELECT reference
    FROM operations
    WHERE reference LIKE ?
  `).bind(likePattern).all<{ reference: string }>();

  let maxCounter = 0;
  for (const row of rows.results) {
    const ref = row.reference;
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
