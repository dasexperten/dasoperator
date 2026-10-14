import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDailyLimit, compareByRecent, latestActivityMs, maskPhone, parsePayoutAmount, payoutDate, statusStampColumn, UGC_PAYOUT_MAX_MINOR } from './ugc-payouts.mjs';

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
