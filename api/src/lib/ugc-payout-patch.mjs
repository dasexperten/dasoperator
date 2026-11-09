// Atomic PATCH helper. Authentication and request normalization stay in the route.
// This helper accepts only explicitly requested, canonical fields, never a payout
// snapshot. Every SQL identifier below comes from this fixed whitelist.
const fields = ['amount_minor', 'payout_date', 'marketplace', 'phone_masked', 'bank_ref', 'note'];
const protectedFields = new Set(['amount_minor', 'payout_date', 'phone_masked', 'bank_ref']);
const maxText = { marketplace: 40, phone_masked: 40, bank_ref: 200, note: 1000 };
const editable = `status IN ('awaiting_approval','approved','failed')
  AND COALESCE(execute_claim,'')='' AND COALESCE(konsol_payment_id,'')=''
  AND COALESCE(konsol_status,'')<>'paid_outside'
  AND NOT EXISTS (SELECT 1 FROM crm_sync_state WHERE key='payout_hold:' || ugc_payouts.id)`;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const failure = (http, code) => ({ ok: false, http, code });

function validField(key, value) {
  if (key === 'amount_minor') return Number.isSafeInteger(value) && value > 0;
  if (key === 'payout_date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
  }
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > maxText[key]) return false;
  // This is the canonical output of the route's existing maskPhone function.
  return key !== 'phone_masked' || /^\+\d{2}XX\*{5}\d{2}$/.test(value);
}

/**
 * input = { id, patch: { ...explicit canonical fields }, now }.
 * A protected field in the request, even if unchanged, requires an editable row.
 * Mixed safe/protected edits are one UPDATE, so cannot be partially applied.
 * A safe-only request changes just note/marketplace and updated_at on any row.
 * No provider calls, receipt bookkeeping, creator uniqueness, or status changes.
 */
export async function patchPayout(db, input) {
  if (!record(input) || Reflect.ownKeys(input).some(key => !['id', 'patch', 'now'].includes(key)))
    return failure(422, 'invalid_payout_patch');
  const { id, patch, now } = input;
  if (typeof id !== 'string' || !id.trim() || !Number.isSafeInteger(now) || now < 0 || now > 8640000000000000
    || !record(patch) || Reflect.ownKeys(patch).some(key => !fields.includes(key)))
    return failure(422, 'invalid_payout_patch');
  const keys = fields.filter(key => own(patch, key));
  if (!keys.length || keys.some(key => !validField(key, patch[key])))
    return failure(422, 'invalid_payout_patch');
  const protectedEdit = keys.some(key => protectedFields.has(key));
  // Old tabs used generic PATCH to turn 1 kopeck into a payable row. Only the
  // dedicated amount-review transaction may fill that sentinel, with its hold.
  const sentinelGuard = keys.includes('amount_minor') ? ' AND amount_minor<>1' : '';
  const values = keys.map(key => patch[key]);
  const assignments = keys.map((key, index) => `${key}=?${index + 2}`);
  assignments.push(`updated_at=?${keys.length + 2}`);
  const stmt = (sql, ...args) => db.prepare(sql).bind(...args);
  let results;
  try {
    results = await db.batch([
      stmt(`UPDATE ugc_payouts SET ${assignments.join(',')} WHERE id=?1${protectedEdit ? ` AND ${editable}` : ''}${sentinelGuard}`,
        id, ...values, now),
      stmt(`SELECT id,amount_minor,payout_date,marketplace,phone_masked,bank_ref,note,updated_at
        FROM ugc_payouts WHERE id=?1`, id),
    ]);
  } catch {
    return failure(503, 'payout_write_unavailable');
  }
  // D1 executes the batch transactionally. Never infer success from a stale
  // route snapshot, a resolved promise, or a missing/malformed result envelope.
  if (!Array.isArray(results) || results.length !== 2 || results[0]?.success !== true || results[1]?.success !== true
    || ![0, 1].includes(results[0].meta?.changes) || !Array.isArray(results[1].results))
    return failure(503, 'payout_write_not_verified');
  const changes = results[0].meta.changes;
  const rows = results[1].results;
  if (changes === 0) {
    if (rows.length === 0) return failure(404, 'not_found');
    if (rows.length !== 1 || rows[0]?.id !== id) return failure(503, 'payout_write_not_verified');
    return failure(protectedEdit ? 409 : 503, protectedEdit ? 'payout_not_editable' : 'payout_write_not_verified');
  }
  const row = rows[0];
  if (rows.length !== 1 || row?.id !== id || row.updated_at !== now
    || keys.some((key, index) => row[key] !== values[index])
    || fields.some(key => !own(row, key)))
    return failure(503, 'payout_write_not_verified');
  return { ok: true, changes, payout: row };
}
