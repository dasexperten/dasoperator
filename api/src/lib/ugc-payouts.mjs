// UGC barter payouts — pure rules, shared by the route and its tests.
// Owner 2026-10-14: at most 999 ₽ per creator per payout per day; every payout
// is approved by the Owner; the ERP holds status, never payment details.
// Owner 2026-10-14 («Автоодобрение, потолок 5000 в день»): payouts are
// auto-approved within both limits — 999 ₽ per creator per day and 5 000 ₽
// for all creators together per day.
// Owner 2026-10-16 («remove 5000 ruble lock put it to 10000»), later the same day:
// «убираешь лимит на 10 тысяч, вообще убираешь» — no day total is enforced anywhere.

export const UGC_PAYOUT_MAX_MINOR = 99900;
export const UGC_PAYOUT_DAILY_TOTAL_MAX_MINOR = 1000000;
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

/** Kopecks as roubles: 4 101 ₽ or 4 100,50 ₽, never split from the sign. */
export function formatRub(minor) {
  const value = Math.max(0, Math.round(Number(minor || 0)));
  const whole = String(Math.floor(value / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  const kopecks = value % 100;
  return `${whole}${kopecks ? `,${String(kopecks).padStart(2, '0')}` : ''}\u00a0₽`;
}

/**
 * Sum of every other live payout that day (all creators, failed excluded)
 * plus this one must stay within 10 000 ₽. The refusal names the room left.
 */
export function checkDailyTotalLimit(existingDayTotalMinor, amountMinor) {
  const existing = Number(existingDayTotalMinor || 0);
  if (existing + Number(amountMinor || 0) > UGC_PAYOUT_DAILY_TOTAL_MAX_MINOR) {
    const remaining = Math.max(0, UGC_PAYOUT_DAILY_TOTAL_MAX_MINOR - existing);
    return {
      ok: false,
      code: 'daily_total_limit',
      remaining_minor: remaining,
      message: `Daily total for all creators is capped at ${formatRub(UGC_PAYOUT_DAILY_TOTAL_MAX_MINOR)}; ${formatRub(remaining)} left that day`,
    };
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
  return yerevanDay(fallbackMs ?? Date.now());
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

// ---------------------------------------------------------------------------
// Konsol Payment Service (Owner 2026-10-14: «запускай выплаты через API»).
// HARD money law (Owner 2026-10-14, DH-LAW-261014-05 · JT-LAW-261014-01):
// `balance` from GET /api/v1/company_accounts INCLUDES the overdraft. Own RUB =
// balance − 1 905 000 ₽. A payout leaves only when own RUB ≥ amount + 30 ₽ fee.
// The overdraft is never touched; a negative or odd own figure stops everything.
// ---------------------------------------------------------------------------

export const KONSOL_OVERDRAFT_MINOR = 190500000;
export const KONSOL_FEE_MINOR = 3000;
export const KONSOL_SERVICE_TITLE = 'Подарок для покупателя продукции ТМ Дас Экспертен';

/** "1936615.38" → 193661538 kopecks, or null when it is not a clean number. */
export function rubToMinor(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
}

/**
 * Own RUB from the company_accounts answer. Exactly one account is expected;
 * anything else is odd and stops payouts. Never returns the overdraft figure.
 */
export function ownRubMinor(accountsBody) {
  const list = accountsBody && Array.isArray(accountsBody.collection) ? accountsBody.collection : null;
  if (!list || list.length !== 1) return { ok: false, code: 'own_rub_odd', reason: `expected one Konsol account, got ${list ? list.length : 'none'}` };
  const balance = rubToMinor(list[0].balance);
  if (balance == null) return { ok: false, code: 'own_rub_odd', reason: 'balance is not a number' };
  const own = balance - KONSOL_OVERDRAFT_MINOR;
  if (own < 0) return { ok: false, code: 'own_rub_odd', own_minor: own, reason: 'own RUB came out negative — overdraft limit may have changed' };
  return { ok: true, own_minor: own };
}

/** Pay only if own RUB covers the amount plus the 30 ₽ fee. */
export function checkOwnRub(accountsBody, amountMinor) {
  const own = ownRubMinor(accountsBody);
  if (!own.ok) return own;
  const need = Number(amountMinor || 0) + KONSOL_FEE_MINOR;
  if (own.own_minor < need) return { ok: false, code: 'own_rub_low', own_minor: own.own_minor, need_minor: need, reason: 'own RUB below amount plus fee' };
  return { ok: true, own_minor: own.own_minor, need_minor: need };
}

/** Konsol payment status → ERP payout status. Only these two are final. */
export function mapKonsolStatus(status) {
  if (status === 'executed') return 'paid';
  if (status === 'failed') return 'failed';
  return 'sent';
}

/** Any Russian mobile form → +7XXXXXXXXXX (the form Konsol stores), or null. */
export function konsolPhone(value) {
  if (value == null) return null;
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) digits = `7${digits}`;
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length !== 11 || !digits.startsWith('79')) return null;
  return `+${digits}`;
}

/** Masked for the ERP and reports: +7930*****25 (first four digits, last two). */
export function maskPhoneWide(value) {
  const phone = konsolPhone(value);
  if (!phone) return null;
  return `${phone.slice(0, 5)}*****${phone.slice(-2)}`;
}

/** SBP bank member id as Konsol expects it: the 12-digit NSPK id. */
export function isFpsBankMemberId(value) {
  return /^\d{12}$/.test(String(value ?? '').trim());
}

// ---------------------------------------------------------------------------
// Honest «Оплата» (Owner 2026-10-15): paid means executed in Konsol, nothing less.
// ---------------------------------------------------------------------------

const YEREVAN_OFFSET_MS = 4 * 3600_000;

/** YYYY-MM-DD of a moment in Yerevan time. */
export function yerevanDay(msValue) {
  return new Date(Number(msValue) + YEREVAN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Actual sends/claims consume the daily limit; waiting rows never reserve a day. */
export function isCommittedPayout(row) {
  return row.status !== 'failed' && Boolean(row.status === 'sent' || row.status === 'paid' || row.konsol_payment_id || row.execute_claim);
}

/** Day money was handed to Konsol (or claimed); legacy rows fall back to their recorded date. */
export function committedPayoutDay(row) {
  const at = toMs(row.sent_at) ?? toMs(row.execute_claimed_at) ?? toMs(row.paid_at);
  return at == null ? row.payout_date : yerevanDay(at);
}

/** One ready queue. Each row is checked against actual usage now, not other waiting rows. */
export function annotateOverLimit(rows, now = Date.now()) {
  const today = yerevanDay(now);
  const perCreator = new Map();
  for (const r of rows) {
    if (!isCommittedPayout(r) || committedPayoutDay(r) !== today) continue;
    const amount = Number(r.amount_minor || 0);
    perCreator.set(r.creator_id, (perCreator.get(r.creator_id) ?? 0) + amount);
  }
  for (const r of rows) {
    const open = r.status === 'awaiting_approval' || r.status === 'approved';
    const amount = Number(r.amount_minor || 0);
    // Only 999 ₽ per blogger per day; the day total for all is gone (Owner 2026-10-16).
    r.over_limit = open && !checkDailyLimit(perCreator.get(r.creator_id) ?? 0, amount).ok;
  }
  return rows;
}

/** «Оплачено сегодня / вчера»: only payouts executed in Konsol, by Yerevan day of paid_at. */
export function paidCounters(rows, now = Date.now()) {
  const today = yerevanDay(now);
  const yesterday = yerevanDay(now - 24 * 3600_000);
  const out = { today: { count: 0, minor: 0, day: today }, yesterday: { count: 0, minor: 0, day: yesterday } };
  for (const r of rows) {
    if (r.status !== 'paid' || !r.konsol_payment_id || !r.paid_at) continue;
    const at = Date.parse(String(r.paid_at));
    if (Number.isNaN(at)) continue;
    const day = yerevanDay(at);
    const slot = day === today ? out.today : day === yesterday ? out.yesterday : null;
    if (slot) { slot.count += 1; slot.minor += Number(r.amount_minor || 0); }
  }
  return out;
}
