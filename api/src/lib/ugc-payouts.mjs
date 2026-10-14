// UGC barter payouts — pure rules, shared by the route and its tests.
// Owner 2026-10-14: at most 999 ₽ per creator per payout per day; every payout
// is approved by the Owner; the ERP holds status, never payment details.

export const UGC_PAYOUT_MAX_MINOR = 99900;
export const UGC_PAYOUT_STATUSES = ['awaiting_approval', 'approved', 'sent', 'paid', 'failed'];

const STATUS_STAMP = { approved: 'approved_at', sent: 'sent_at', paid: 'paid_at', failed: 'failed_at' };

/**
 * Reads an amount from a request body. `amount_rub` (roubles, up to two
 * decimals) or `amount_minor` (kopecks). Returns { ok, amount_minor } or
 * { ok: false, code, message }.
 */
export function parsePayoutAmount(body) {
  let minor = null;
  if (body && body.amount_minor !== undefined && body.amount_minor !== null && body.amount_minor !== '') {
    const value = Number(body.amount_minor);
    if (!Number.isFinite(value) || !Number.isInteger(value)) return { ok: false, code: 'invalid_amount', message: 'amount_minor must be a whole number of kopecks' };
    minor = value;
  } else if (body && body.amount_rub !== undefined && body.amount_rub !== null && body.amount_rub !== '') {
    const value = Number(String(body.amount_rub).replace(',', '.').replace(/[\s ₽]/g, ''));
    if (!Number.isFinite(value)) return { ok: false, code: 'invalid_amount', message: 'amount_rub must be a number' };
    minor = Math.round(value * 100);
  } else {
    return { ok: false, code: 'amount_required', message: 'amount_rub or amount_minor required' };
  }
  if (minor <= 0) return { ok: false, code: 'invalid_amount', message: 'Amount must be above zero' };
  if (minor > UGC_PAYOUT_MAX_MINOR) return { ok: false, code: 'amount_over_limit', message: 'Payout above 999 ₽ is not allowed (Owner limit per creator per day)' };
  return { ok: true, amount_minor: minor };
}

/** Sum of the creator's other live payouts that day plus this one must stay within 999 ₽. */
export function checkDailyLimit(existingSameDayMinor, amountMinor) {
  const total = Number(existingSameDayMinor || 0) + Number(amountMinor || 0);
  if (total > UGC_PAYOUT_MAX_MINOR) {
    return { ok: false, code: 'daily_limit', message: `Creator already has ${Math.round(Number(existingSameDayMinor || 0)) / 100} ₽ that day; total would pass 999 ₽` };
  }
  return { ok: true };
}

export function isPayoutStatus(value) {
  return UGC_PAYOUT_STATUSES.includes(value);
}

/** Column that records the moment a status was reached, or null. */
export function statusStampColumn(status) {
  return STATUS_STAMP[status] ?? null;
}

/**
 * Never stores a raw number. Whatever is given is reduced to +79XX*****09:
 * the first two digits, a fixed mask, the last two digits.
 */
export function maskPhone(value) {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `+${digits.slice(0, 2)}XX*****${digits.slice(-2)}`;
}

/** YYYY-MM-DD or null. */
export function payoutDate(value, fallbackMs) {
  if (value != null && /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) return String(value).trim();
  return new Date(fallbackMs ?? Date.now()).toISOString().slice(0, 10);
}

function toMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^\d{10,13}$/.test(text)) return Number(text.length === 10 ? Number(text) * 1000 : text);
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Latest activity of a creator, in ms: collaboration last contact and update,
 * payout update, content imported or published. Null when nothing is known.
 */
export function latestActivityMs({ collaboration, payouts, content } = {}) {
  const stamps = [];
  if (collaboration) stamps.push(toMs(collaboration.last_contact_at), toMs(collaboration.updated_at));
  for (const payout of payouts ?? []) stamps.push(toMs(payout.updated_at), toMs(payout.paid_at), toMs(payout.sent_at));
  for (const item of content ?? []) stamps.push(toMs(item.imported_at), toMs(item.published_at));
  const known = stamps.filter((value) => value != null);
  return known.length ? Math.max(...known) : null;
}

/** Most recent first; unknown activity last; ties by followers, then name. */
export function compareByRecent(a, b) {
  const av = a.last_activity_at ?? -1;
  const bv = b.last_activity_at ?? -1;
  if (bv !== av) return bv - av;
  const af = a.followers ?? -1;
  const bf = b.followers ?? -1;
  if (bf !== af) return bf - af;
  return String(a.name ?? '').localeCompare(String(b.name ?? ''));
}
