// Konsol payouts: limits, own-RUB stop, idempotency, callback status mapping.
// Synthetic data only — the phone below is a made-up number of the right shape.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyKonsolPayment, executePayout } from './ugc-payout-execute.mjs';
import { checkOwnRub, konsolPhone, mapKonsolStatus, maskPhoneWide, ownRubMinor, rubToMinor } from './ugc-payouts.mjs';

const PHONE = '+79000000011';
const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = '2026-10-14';
const balance = (ownRub) => ({ collection: [{ id: 'acc', balance: (1905000 + ownRub).toFixed(2), bank: 'tinkoff' }] });

function world({ rows = [], ownRub = 31615.38, payment = { ok: true, status: 201, body: { id: 'pay-1', status: 'created' } }, contractors = [] } = {}) {
  const db = new Map(rows.map((r) => [r.id, { status: 'awaiting_approval', payout_date: DAY, creator_id: 'cr1', handle: 'creator_one', fps_bank_member_id: '100000000004', ...r }]));
  const requisites = new Map(rows.map((r) => [r.id, { fps_mobile_phone: PHONE, first_name: 'Имя', last_name: 'Фамилия' }]));
  const calls = { payments: [], contractors: [], owner: [] };
  const store = {
    getPayout: async (id) => (db.has(id) ? { ...db.get(id) } : null),
    getRequisites: async (id) => requisites.get(id) ?? null,
    sameDayMinor: async (creator, day, exclude) => [...db.values()].filter((r) => r.creator_id === creator && r.payout_date === day && r.status !== 'failed' && r.id !== exclude).reduce((s, r) => s + r.amount_minor, 0),
    handedToday: async (creator, day, exclude) => [...db.values()].filter((r) => r.creator_id === creator && r.payout_date === day && r.id !== exclude && (r.status === 'sent' || r.status === 'paid' || r.konsol_payment_id || r.execute_claim)).length,
    dayTotalMinor: async (day, exclude) => [...db.values()].filter((r) => r.payout_date === day && r.status !== 'failed' && r.id !== exclude).reduce((s, r) => s + r.amount_minor, 0),
    claim: async (id, token) => { const r = db.get(id); if (r.execute_claim || r.konsol_payment_id) return false; r.execute_claim = token; return true; },
    release: async (id, error) => { const r = db.get(id); r.execute_claim = null; r.konsol_error = error; },
    holdUnclear: async (id, error) => { db.get(id).konsol_error = error; },
    setContractor: async (id, c) => { db.get(id).konsol_contractor_id = c; },
    markSent: async (id, s) => Object.assign(db.get(id), { konsol_payment_id: s.paymentId, konsol_contractor_id: s.contractorId, status: 'sent', sent_at: s.sentAt, payout_date: s.day, phone_masked: s.phoneMasked }),
    markPaid: async (id, s) => Object.assign(db.get(id), { status: 'paid', paid_at: s.paidAt, konsol_status: s.konsolStatus }),
    markFailed: async (id, s) => Object.assign(db.get(id), { status: 'failed', failed_at: s.failedAt, konsol_error: s.error }),
    setKonsolStatus: async (id, st) => { db.get(id).konsol_status = st; },
    claimNotice: async (id, at) => { const r = db.get(id); if (r.paid_notice_at) return false; r.paid_notice_at = at; return true; },
    releaseNotice: async (id) => { db.get(id).paid_notice_at = null; },
  };
  const konsol = {
    bankMember: async (id) => (id === '100000000004' ? { found: true, name: 'Т-Банк' } : { found: false }),
    companyAccounts: async () => ({ ok: true, status: 200, body: balance(ownRub) }),
    findContractorByPhone: async (phone) => { const hit = contractors.find((c) => c.phone === phone); return hit ? { id: hit.id } : {}; },
    createContractor: async (body) => { calls.contractors.push(body); return { ok: true, status: 201, body: { id: 'ctr-new' } }; },
    createPayment: async (body) => { calls.payments.push(body); return payment; },
  };
  const notifyOwner = async (text) => { calls.owner.push(text); return true; };
  const deps = { store, konsol, notifyOwner, now: NOW, claimToken: 'tok' };
  return { db, deps, calls };
}

test('own RUB is balance minus the 1 905 000 ₽ overdraft, never the overdraft figure', () => {
  assert.deepEqual(ownRubMinor({ collection: [{ balance: '1936615.38' }] }), { ok: true, own_minor: 3161538 });
  assert.equal(ownRubMinor({ collection: [{ balance: '1904999.99' }] }).code, 'own_rub_odd');
  assert.equal(ownRubMinor({ collection: [] }).code, 'own_rub_odd');
  assert.equal(ownRubMinor({ collection: [{ balance: 'x' }, { balance: '1' }] }).code, 'own_rub_odd');
  assert.equal(rubToMinor('836.0'), 83600);
  assert.equal(checkOwnRub(balance(31), 100).ok, true, '1 ₽ + 30 ₽ fee fits in 31 ₽');
  assert.equal(checkOwnRub(balance(30.99), 100).code, 'own_rub_low');
});

test('phones: Konsol form and the ERP mask', () => {
  assert.equal(konsolPhone('8 900 000-00-11'), PHONE);
  assert.equal(konsolPhone('9000000011'), PHONE);
  assert.equal(konsolPhone('+374 94 000000'), null);
  assert.equal(maskPhoneWide(PHONE), '+7900*****11');
});

test('a payout within limits and money is sent once to Konsol as fps', async () => {
  const { db, deps, calls } = world({ rows: [{ id: 'p1', amount_minor: 100 }] });
  const out = await executePayout('p1', deps);
  assert.equal(out.http, 201);
  assert.equal(db.get('p1').status, 'sent');
  assert.equal(db.get('p1').konsol_payment_id, 'pay-1');
  assert.equal(calls.contractors.length, 1);
  assert.deepEqual(calls.contractors[0], { kind: 'individual', first_name: 'Имя', last_name: 'Фамилия', phone: PHONE });
  assert.equal(calls.payments.length, 1);
  const p = calls.payments[0];
  assert.equal(p.bank_details_kind, 'fps');
  assert.equal(p.amount, 1);
  assert.equal(p.bank_details.fps_bank_member_id, '100000000004');
  assert.equal(p.bank_details.fps_mobile_phone, PHONE);
  assert.equal(p.contractor_id, 'ctr-new');
});

test('idempotent: a second execute returns the existing payment and never pays again', async () => {
  const { deps, calls } = world({ rows: [{ id: 'p1', amount_minor: 100 }] });
  await executePayout('p1', deps);
  const again = await executePayout('p1', deps);
  assert.equal(again.http, 200);
  assert.equal(again.already, true);
  assert.equal(again.payout.konsol_payment_id, 'pay-1');
  assert.equal(calls.payments.length, 1);
});

test('an existing contractor with the same phone is reused', async () => {
  const { deps, calls } = world({ rows: [{ id: 'p1', amount_minor: 100 }], contractors: [{ id: 'ctr-old', phone: PHONE }] });
  await executePayout('p1', deps);
  assert.equal(calls.contractors.length, 0);
  assert.equal(calls.payments[0].contractor_id, 'ctr-old');
});

test('own RUB below amount + 30 ₽ stops the payout and tells the Owner', async () => {
  const { db, deps, calls } = world({ rows: [{ id: 'p1', amount_minor: 50000 }], ownRub: 529.99 });
  const out = await executePayout('p1', deps);
  assert.equal(out.http, 409);
  assert.equal(out.code, 'own_rub_low');
  assert.equal(calls.payments.length, 0);
  assert.equal(db.get('p1').status, 'awaiting_approval');
  assert.equal(calls.owner.length, 1);
  assert.match(calls.owner[0], /Свой рублёвый счёт Консоли кончился/);
  assert.doesNotMatch(calls.owner[0], /1\s?9\d\d\s?\d{3}/, 'overdraft figure never named');
});

test('negative own RUB (overdraft limit changed) stops the payout', async () => {
  const { deps, calls } = world({ rows: [{ id: 'p1', amount_minor: 100 }], ownRub: -10 });
  const out = await executePayout('p1', deps);
  assert.equal(out.code, 'own_rub_odd');
  assert.equal(calls.payments.length, 0);
  assert.equal(calls.owner.length, 1);
});

test('limits: 999 ₽ per creator per day and 5 000 ₽ for all, checked at execute', async () => {
  const perCreator = world({ rows: [{ id: 'a', amount_minor: 60000, status: 'sent', konsol_payment_id: 'x' }, { id: 'b', amount_minor: 40000, status: 'approved' }] });
  const out1 = await executePayout('b', perCreator.deps);
  assert.equal(out1.code, 'daily_limit');
  assert.equal(perCreator.calls.payments.length, 0);
  const rows = [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, creator_id: `c${n}`, amount_minor: 99900, status: 'sent', konsol_payment_id: `k${n}` }));
  const total = world({ rows: [...rows, { id: 'last', creator_id: 'c9', amount_minor: 600 }] });
  const out2 = await executePayout('last', total.deps);
  assert.equal(out2.code, 'daily_total_limit');
  assert.equal(total.calls.payments.length, 0);
});

test('a Konsol refusal releases the lock; an unclear answer keeps it', async () => {
  const refused = world({ rows: [{ id: 'p1', amount_minor: 100 }], payment: { ok: false, status: 422, body: null, error: 'bad' } });
  assert.equal((await executePayout('p1', refused.deps)).code, 'konsol_refused');
  assert.equal(refused.db.get('p1').execute_claim, null);
  const unclear = world({ rows: [{ id: 'p1', amount_minor: 100 }], payment: { ok: false, status: 0, body: null, error: 'timeout' } });
  assert.equal((await executePayout('p1', unclear.deps)).code, 'konsol_unclear');
  const retry = await executePayout('p1', unclear.deps);
  assert.equal(retry.code, 'execute_unclear');
  assert.equal(unclear.calls.payments.length, 1, 'no blind second send');
});

test('missing requisites or unknown bank never reach Konsol', async () => {
  const w = world({ rows: [{ id: 'p1', amount_minor: 100, fps_bank_member_id: '100000000999' }] });
  assert.equal((await executePayout('p1', w.deps)).code, 'bank_unknown');
  const w2 = world({ rows: [{ id: 'p1', amount_minor: 100, fps_bank_member_id: null }] });
  assert.equal((await executePayout('p1', w2.deps)).code, 'bank_required');
  assert.equal(w.calls.payments.length + w2.calls.payments.length, 0);
});

test('callback status mapping: executed → paid with one notice, failed → failed', async () => {
  assert.equal(mapKonsolStatus('executed'), 'paid');
  assert.equal(mapKonsolStatus('failed'), 'failed');
  assert.equal(mapKonsolStatus('created'), 'sent');
  assert.equal(mapKonsolStatus('manualpay'), 'sent');
  const w = world({ rows: [{ id: 'p1', amount_minor: 100, status: 'sent', konsol_payment_id: 'pay-1' }] });
  const row = await w.deps.store.getPayout('p1');
  const out = await applyKonsolPayment(row, { id: 'pay-1', status: 'executed', paid_at: '2026-10-14T12:01:00Z' }, w.deps);
  assert.equal(out.status, 'paid');
  assert.equal(w.db.get('p1').status, 'paid');
  assert.equal(w.db.get('p1').paid_at, '2026-10-14T12:01:00Z');
  assert.equal(w.calls.owner.length, 1);
  assert.match(w.calls.owner[0], /Деньги пришли/);
  await applyKonsolPayment(await w.deps.store.getPayout('p1'), { id: 'pay-1', status: 'executed' }, w.deps);
  assert.equal(w.calls.owner.length, 1, 'notice goes once');

  const f = world({ rows: [{ id: 'p2', amount_minor: 100, status: 'sent', konsol_payment_id: 'pay-2' }] });
  await applyKonsolPayment(await f.deps.store.getPayout('p2'), { id: 'pay-2', status: 'failed', error_message: 'Банк получателя отклонил выплату.' }, f.deps);
  assert.equal(f.db.get('p2').status, 'failed');
  assert.equal(f.db.get('p2').konsol_error, 'Банк получателя отклонил выплату.');
  assert.equal(f.calls.owner.length, 0);
});

test('a payment id that does not belong to the row changes nothing', async () => {
  const w = world({ rows: [{ id: 'p1', amount_minor: 100, status: 'sent', konsol_payment_id: 'pay-1' }] });
  const out = await applyKonsolPayment(await w.deps.store.getPayout('p1'), { id: 'other', status: 'executed' }, w.deps);
  assert.equal(out.changed, false);
  assert.equal(w.db.get('p1').status, 'sent');
});

test('a failed Telegram notice is retried next time', async () => {
  const w = world({ rows: [{ id: 'p1', amount_minor: 100, status: 'sent', konsol_payment_id: 'pay-1' }] });
  let fail = true;
  w.deps.notifyOwner = async () => !fail;
  await applyKonsolPayment(await w.deps.store.getPayout('p1'), { id: 'pay-1', status: 'executed' }, w.deps);
  assert.equal(w.db.get('p1').paid_notice_at, null);
  fail = false;
  const out = await applyKonsolPayment(await w.deps.store.getPayout('p1'), { id: 'pay-1', status: 'executed' }, w.deps);
  assert.equal(out.noticed, true);
});

import { matchRegistryPayment } from './ugc-payout-execute.mjs';

test('registry payout links only to exactly one executed Konsol payment of its amount and day', () => {
  const row = { id: 'r', amount_minor: 69100, payout_date: '2026-10-14' };
  const ok = { id: 'k1', status: 'executed', amount: '691.0', paid_at: '2026-10-14T11:00:00Z' };
  assert.equal(matchRegistryPayment(row, [ok, { id: 'k2', status: 'executed', amount: '836.0', paid_at: '2026-10-14T11:00:00Z' }]).payment.id, 'k1');
  assert.match(matchRegistryPayment(row, [ok, { ...ok, id: 'k3' }]).reason, /ambiguous/);
  assert.match(matchRegistryPayment(row, [{ ...ok, status: 'failed' }]).reason, /no executed/);
  assert.match(matchRegistryPayment(row, [{ ...ok, paid_at: '2026-10-20T11:00:00Z', created_at: null }]).reason, /no executed/);
  assert.match(matchRegistryPayment(row, [ok], new Set(['k1'])).reason, /no executed/);
});

// Double payment impossible (Owner 2026-10-15) — server and blogger-day levels.
test('no double pay (server): a claimed, sent or paid row never reaches Konsol again', async () => {
  for (const extra of [{ execute_claim: 'other' }, { status: 'sent' }, { status: 'paid' }]) {
    const { deps, calls } = world({ rows: [{ id: 'p1', amount_minor: 100, ...extra }] });
    const out = await executePayout('p1', deps);
    assert.equal(out.ok, false);
    assert.equal(calls.payments.length, 0);
    assert.equal(calls.contractors.length, 0);
  }
});

test('no double pay (server): two clicks at once — Konsol is called once', async () => {
  const { deps, calls } = world({ rows: [{ id: 'p1', amount_minor: 100 }] });
  await Promise.all([executePayout('p1', deps), executePayout('p1', deps)]);
  assert.equal(calls.payments.length, 1);
});

test('no double pay (blogger-day): a second payout of the same blogger today is refused unless approved', async () => {
  const rows = [{ id: 'a', amount_minor: 300, status: 'sent', konsol_payment_id: 'k' }, { id: 'b', amount_minor: 300 }];
  const first = world({ rows });
  const out = await executePayout('b', first.deps);
  assert.equal(out.code, 'already_paid_today');
  assert.equal(first.calls.payments.length, 0);
  const second = world({ rows: [rows[0], { id: 'b', amount_minor: 300, status: 'approved' }] });
  assert.equal((await executePayout('b', second.deps)).http, 201);
});

test('a payout dated tomorrow is not paid today', async () => {
  const { deps, calls } = world({ rows: [{ id: 'p1', amount_minor: 100, payout_date: '2026-10-15' }] });
  assert.equal((await executePayout('p1', deps)).code, 'not_due');
  assert.equal(calls.payments.length, 0);
});
