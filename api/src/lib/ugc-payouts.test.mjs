import assert from 'node:assert/strict';
import test from 'node:test';
import { missingInfo, checkDailyLimit, checkDailyTotalLimit, compareByRecent, formatRub, latestActivityMs, maskPhone, parsePayoutAmount, payoutDate, statusStampColumn, UGC_PAYOUT_DAILY_TOTAL_MAX_MINOR, UGC_PAYOUT_MAX_MINOR } from './ugc-payouts.mjs';

test('accepts payouts up to and including 999 ₽', () => {
  assert.deepEqual(parsePayoutAmount({ amount_rub: 691 }), { ok: true, amount_minor: 69100 });
  assert.deepEqual(parsePayoutAmount({ amount_rub: '836,50' }), { ok: true, amount_minor: 83650 });
  assert.deepEqual(parsePayoutAmount({ amount_rub: 999 }), { ok: true, amount_minor: UGC_PAYOUT_MAX_MINOR });
  assert.deepEqual(parsePayoutAmount({ amount_minor: 99900 }), { ok: true, amount_minor: 99900 });
});

test('rejects payouts above 999 ₽, zero, negative and missing amounts', () => {
  assert.equal(parsePayoutAmount({ amount_rub: 999.01 }).code, 'amount_over_limit');
  assert.equal(parsePayoutAmount({ amount_rub: 1000 }).code, 'amount_over_limit');
  assert.equal(parsePayoutAmount({ amount_minor: 99901 }).code, 'amount_over_limit');
  assert.equal(parsePayoutAmount({ amount_rub: 0 }).code, 'invalid_amount');
  assert.equal(parsePayoutAmount({ amount_rub: -5 }).code, 'invalid_amount');
  assert.equal(parsePayoutAmount({ amount_minor: 100.5 }).code, 'invalid_amount');
  assert.equal(parsePayoutAmount({ amount_rub: 'abc' }).code, 'invalid_amount');
  assert.equal(parsePayoutAmount({}).code, 'amount_required');
});

test('the daily sum per creator stays within 999 ₽', () => {
  assert.equal(checkDailyLimit(0, 99900).ok, true);
  assert.equal(checkDailyLimit(50000, 49900).ok, true);
  assert.equal(checkDailyLimit(50000, 50000).ok, false);
});

test('all creators together stay within 10 000 ₽ per day', () => {
  assert.equal(UGC_PAYOUT_DAILY_TOTAL_MAX_MINOR, 1000000);
  assert.equal(checkDailyTotalLimit(0, 99900).ok, true);
  assert.equal(checkDailyTotalLimit(900100, 99900).ok, true); // exactly 10 000 ₽
  assert.equal(checkDailyTotalLimit(900101, 99900).ok, false); // one kopeck over
  const over = checkDailyTotalLimit(910000, 99900);
  assert.equal(over.ok, false);
  assert.equal(over.code, 'daily_total_limit');
  assert.equal(over.remaining_minor, 90000);
  assert.match(over.message, /900\u00a0₽ left/);
  assert.match(over.message, /10\u00a0000\u00a0₽/);
  const full = checkDailyTotalLimit(1000000, 100);
  assert.equal(full.ok, false);
  assert.equal(full.remaining_minor, 0);
  assert.match(full.message, /0\u00a0₽ left/);
});

test('roubles are written with a non-breaking sign and digit groups', () => {
  assert.equal(formatRub(500000), '5\u00a0000\u00a0₽');
  assert.equal(formatRub(410050), '4\u00a0100,50\u00a0₽');
  assert.equal(formatRub(-5), '0\u00a0₽');
});

test('a phone is always masked, never stored raw', () => {
  assert.equal(maskPhone('+7 (916) 123-45-09'), '+79XX*****09');
  assert.equal(maskPhone('79161234509'), '+79XX*****09');
  assert.equal(maskPhone('+79XX*****09'), '+79XX*****09');
  assert.equal(maskPhone('12'), null);
  assert.equal(maskPhone(null), null);
});

test('status stamps and payout date', () => {
  assert.equal(statusStampColumn('paid'), 'paid_at');
  assert.equal(statusStampColumn('awaiting_approval'), null);
  assert.equal(payoutDate('2026-10-14'), '2026-10-14');
  assert.equal(payoutDate('14.10.2026', Date.UTC(2026, 9, 14, 10)), '2026-10-14');
});

test('latest activity takes the newest of collaboration, payout and content', () => {
  const ms = latestActivityMs({
    collaboration: { last_contact_at: '2026-10-01', updated_at: Date.UTC(2026, 8, 1) },
    payouts: [{ updated_at: Date.UTC(2026, 9, 14, 10, 1) }],
    content: [{ imported_at: Date.UTC(2026, 6, 1), published_at: '2026-10-10' }],
  });
  assert.equal(ms, Date.UTC(2026, 9, 14, 10, 1));
  assert.equal(latestActivityMs({}), null);
});

test('sorts by most recent activity, unknown last, ties by followers', () => {
  const rows = [
    { name: 'old', last_activity_at: 100, followers: 9e6 },
    { name: 'none', last_activity_at: null, followers: 1e7 },
    { name: 'new', last_activity_at: 300, followers: 10 },
    { name: 'tie-big', last_activity_at: 200, followers: 500 },
    { name: 'tie-small', last_activity_at: 200, followers: 50 },
  ];
  assert.deepEqual([...rows].sort(compareByRecent).map((row) => row.name), ['new', 'tie-big', 'tie-small', 'old', 'none']);
});

// Honest «Оплата» (Owner 2026-10-15).
import { annotateOverLimit, paidCounters, yerevanDay } from './ugc-payouts.mjs';

test('paid counters count only Konsol-executed payouts by Yerevan day', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const rows = [
    { status: 'paid', konsol_payment_id: 'a', paid_at: '2026-10-15T06:00:00Z', amount_minor: 69100 },
    { status: 'paid', konsol_payment_id: 'b', paid_at: '2026-10-14T19:30:00Z', amount_minor: 83600 }, // 23:30 Yerevan 14.10
    { status: 'paid', konsol_payment_id: 'c', paid_at: '2026-10-14T20:30:00Z', amount_minor: 10000 }, // 00:30 Yerevan 15.10
    { status: 'paid', paid_at: '2026-10-15T06:00:00Z', amount_minor: 48400 },  // no Konsol id — not counted
    { status: 'sent', konsol_payment_id: 'd', paid_at: null, amount_minor: 5000 },
  ];
  const out = paidCounters(rows, now);
  assert.deepEqual(out.today, { count: 2, minor: 79100, day: '2026-10-15' });
  assert.deepEqual(out.yesterday, { count: 1, minor: 83600, day: '2026-10-14' });
  assert.equal(yerevanDay(Date.parse('2026-10-14T20:00:00Z')), '2026-10-15');
});

test('one queue: waiting rows do not reserve daily budget or depend on their date', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const rows = annotateOverLimit(Array.from({ length: 8 }, (_, i) => ({
    creator_id: 'x', payout_date: i % 2 ? '2026-10-16' : '2026-10-15',
    status: 'approved', amount_minor: 99900,
  })), now);
  assert.deepEqual(rows.map((r) => r.over_limit), Array(8).fill(false));
});

test('ready queue uses actual sends and in-flight claims on the current Yerevan day', () => {
  const now = Date.parse('2026-10-15T21:00:00Z'); // 16.10 in Yerevan
  const rows = annotateOverLimit([
    { creator_id: 'x', payout_date: '2026-10-15', status: 'sent', sent_at: '2026-10-15T20:30:00Z', amount_minor: 60000 },
    { creator_id: 'x', payout_date: '2026-10-20', status: 'approved', amount_minor: 40000 },
    { creator_id: 'y', payout_date: '2026-10-16', status: 'failed', amount_minor: 99900 },
    { creator_id: 'z', payout_date: '2026-10-17', status: 'approved', amount_minor: 30000 },
    { creator_id: 'z', payout_date: '2026-10-15', status: 'awaiting_approval', execute_claim: 'held', execute_claimed_at: '2026-10-15T20:30:00Z', amount_minor: 70000 },
  ], now);
  assert.deepEqual(rows.map((r) => r.over_limit), [false, true, false, true, true]);
});

test('no day total blocks a ready payout, and its date is never moved', () => {
  const now = Date.parse('2026-10-16T10:00:00Z');
  const rows = annotateOverLimit([
    ...Array.from({ length: 10 }, (_, i) => ({ creator_id: `p${i}`, status: 'sent', sent_at: '2026-10-16T06:00:00Z', amount_minor: 99900 })),
    { creator_id: 'q', status: 'approved', payout_date: '2026-10-17', amount_minor: 1100 },
  ], now);
  assert.equal(rows.at(-1).over_limit, false);
  assert.equal(rows.at(-1).payout_date, '2026-10-17');
});

test('a payout is ready only with followers, ER and product (Owner 2026-10-16)', () => {
  assert.deepEqual(missingInfo({ creator_followers: 3062, creator_er: 0.026, product: 'TERMO + ZERO' }), []);
  assert.deepEqual(missingInfo({ creator_followers: null, creator_er: null, product: '' }), ['подписчики', 'ER', 'продукт']);
  assert.deepEqual(missingInfo({ creator_followers: 1663, creator_er: null, product: 'TERMO' }), ['ER']);
});
