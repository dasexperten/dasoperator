// Konsol payouts: limits, own-RUB stop, idempotency, callback status mapping.
// Synthetic data only — the phone below is a made-up number of the right shape.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyKonsolPayment, bloggerFailedText, bloggerPaidText, executePayout, failedSide } from './ugc-payout-execute.mjs';
import { checkOwnRub, konsolPhone, mapKonsolStatus, maskPhoneWide, ownRubMinor, rubToMinor, isCommittedPayout, committedPayoutDay } from './ugc-payouts.mjs';

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
    sameDayMinor: async (creator, day, exclude) => [...db.values()].filter((r) => r.creator_id === creator && committedPayoutDay(r) === day && isCommittedPayout(r) && r.id !== exclude).reduce((s, r) => s + r.amount_minor, 0),
    handedToday: async (creator, day, exclude) => [...db.values()].filter((r) => r.creator_id === creator && committedPayoutDay(r) === day && r.id !== exclude && isCommittedPayout(r)).length,
    dayTotalMinor: async (day, exclude) => [...db.values()].filter((r) => committedPayoutDay(r) === day && isCommittedPayout(r) && r.id !== exclude).reduce((s, r) => s + r.amount_minor, 0),
    claim: async (id, token, at) => {
      const r = db.get(id);
      if (r.execute_claim || r.konsol_payment_id) return false;
      const other = [...db.values()].filter((p) => p.id !== id && isCommittedPayout(p) && committedPayoutDay(p) === DAY);
      const same = other.filter((p) => p.creator_id === r.creator_id);
      void same; // Owner 2026-10-19: no caps in the claim
      r.execute_claim = token; r.execute_claimed_at = at; return true;
    },
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
  const after = Date.parse('2026-10-19T00:00:00Z');
  assert.equal(checkOwnRub(balance(31), 100, after).ok, true, '1 ₽ + 30 ₽ fee fits in 31 ₽');
  assert.equal(checkOwnRub(balance(30.99), 100, after).code, 'own_rub_low');
  // One-day exception (Owner 2026-10-18): the overdraft may carry the payout until 24:00 Yerevan.
  const during = Date.parse('2026-10-18T12:00:00Z');
  assert.equal(checkOwnRub(balance(0), 100, during).ok, true);
  assert.equal(checkOwnRub({ collection: [{ balance: '0.10' }] }, 100, during).code, 'own_rub_low');
  assert.equal(checkOwnRub(balance(0), 100, Date.parse('2026-10-18T20:00:00Z')).code, 'own_rub_low');
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
  deps.now = Date.parse('2026-10-19T08:00:00Z'); // after the one-day overdraft exception
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
  deps.now = Date.parse('2026-10-19T08:00:00Z'); // after the one-day overdraft exception
  const out = await executePayout('p1', deps);
  assert.equal(out.code, 'own_rub_odd');
  assert.equal(calls.payments.length, 0);
  assert.equal(calls.owner.length, 1);
});

test('no limits at execute (Owner 2026-10-19): a second payout of a blogger the same day goes', async () => {
  const perCreator = world({ rows: [{ id: 'a', amount_minor: 60000, status: 'sent', konsol_payment_id: 'x' }, { id: 'b', amount_minor: 40000, status: 'approved' }] });
  const out1 = await executePayout('b', perCreator.deps);
  assert.equal(out1.ok, true);
  assert.equal(perCreator.calls.payments.length, 1);
  const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: `s${n}`, creator_id: `c${n}`, amount_minor: 99900, status: 'sent', konsol_payment_id: `k${n}` }));
  const total = world({ rows: [...rows, { id: 'last', creator_id: 'c99', amount_minor: 1100 }] });
  const out2 = await executePayout('last', total.deps);
  assert.equal(out2.ok, true);
  assert.equal(total.calls.payments.length, 1);
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

test('callback status mapping: executed → paid with no Telegram message, failed → failed', async () => {
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
  assert.equal(w.calls.owner.length, 0, 'no message per payment (Owner 2026-10-16)');
  assert.equal(out.noticed, false, 'no blogger sender in this world → nothing claimed');

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

test('a second payout row of the same blogger today goes on the Owner\'s click (Owner 2026-10-19)', async () => {
  const rows = [{ id: 'a', amount_minor: 300, status: 'sent', konsol_payment_id: 'k' }, { id: 'b', amount_minor: 300 }];
  const first = world({ rows });
  const out = await executePayout('b', first.deps);
  assert.equal(out.http, 201);
  const second = world({ rows: [rows[0], { id: 'b', amount_minor: 300, status: 'approved' }] });
  assert.equal((await executePayout('b', second.deps)).http, 201);
});

test('a future recorded date does not delay a ready payout', async () => {
  const { deps, calls, db } = world({ rows: [{ id: 'p1', amount_minor: 100, payout_date: '2026-10-15' }] });
  assert.equal((await executePayout('p1', deps)).http, 201);
  assert.equal(calls.payments.length, 1);
  assert.equal(db.get('p1').payout_date, DAY);
});


test('waiting payouts beyond a daily budget do not block a ready payout', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, creator_id: `c${i}`, amount_minor: 99900 }));
  const { deps, calls } = world({ rows });
  assert.equal((await executePayout('q0', deps)).http, 201);
  assert.equal(calls.payments.length, 1);
});


test('simultaneous clicks on different bloggers all go — no day total', async () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, creator_id: `c${i}`, amount_minor: 99900, payout_date: '2026-10-20' }));
  const { deps, calls } = world({ rows });
  await Promise.all(rows.map((row) => executePayout(row.id, deps)));
  assert.equal(calls.payments.length, 11);
});

test('green payout: Diana writes the blogger once; a failed send is retried next time', async () => {
  const w = world({ rows: [{ id: 'p1', amount_minor: 33300, status: 'sent', konsol_payment_id: 'pay-1', handle: 'madifood_' }] });
  const sent = [];
  let okSend = false;
  w.deps.notifyBlogger = async (row, text) => { sent.push({ handle: row.handle, text }); return { ok: okSend }; };
  w.deps.store.claimNotice = async (id, at) => { const r = w.db.get(id); if (r.paid_notice_at) return false; r.paid_notice_at = at; return true; };
  w.deps.store.releaseNotice = async (id) => { w.db.get(id).paid_notice_at = null; };
  const first = await applyKonsolPayment(await w.deps.store.getPayout('p1'), { id: 'pay-1', status: 'executed' }, w.deps);
  assert.equal(first.noticed, false);
  assert.equal(w.db.get('p1').paid_notice_at, null, 'failed send releases the lock');
  assert.match(sent[0].text, /^Перевели 333 ₽ по СБП/);
  okSend = true;
  w.db.get('p1').status = 'sent';
  const second = await applyKonsolPayment(await w.deps.store.getPayout('p1'), { id: 'pay-1', status: 'executed' }, w.deps);
  assert.equal(second.noticed, true);
  const third = await applyKonsolPayment(await w.deps.store.getPayout('p1'), { id: 'pay-1', status: 'executed' }, w.deps);
  assert.equal(third.noticed, false, 'already paid → no second message');
  assert.equal(sent.length, 2);
});

test('an old debt is thanked, not asked for a new order', () => {
  assert.match(bloggerPaidText({ amount_minor: 33300, note: 'Старый долг, подтвердила 15.10' }), /за ваш ролик/);
  assert.match(bloggerPaidText({ amount_minor: 50900, note: null }), /Оформите, пожалуйста, заказ/);
  assert.doesNotMatch(bloggerPaidText({ amount_minor: 50900, note: null }), /[—–]|дошло\?|👍/);
});

test('new-payment brief asks for the order only — the scenario waits for the order screenshot (Owner 2026-10-18)', () => {
  const text = bloggerPaidText({ amount_minor: 90000, payout_date: '2026-10-17' });
  assert.match(text, /заказ/);
  assert.match(text, /НЕ писать/);
  assert.doesNotMatch(text, /выберите|номер от/);
});


// Owner 2026-10-19 (eseniya__oo3__): «Тинькофф отклонил» was invented — the payment never left us.
test('failed payout: real bank refusal asks for another bank, our failure never blames the bank', () => {
  assert.equal(failedSide('Банк получателя отклонил выплату. Попросите получателя обратиться туда или выберите другой его банк.'), 'bank');
  assert.equal(failedSide(null), 'ours');
  assert.equal(failedSide('Konsol: failed'), 'ours');
  const ours = bloggerFailedText({ amount_minor: 48400 }, null);
  assert.match(ours, /с нашей стороны/);
  assert.match(ours, /Не проси другой банк/);
  const bank = bloggerFailedText({ amount_minor: 33300 }, 'Банк получателя отклонил выплату.');
  assert.match(bank, /попроси другой банк/);
});

test('failed payout: Diana writes the blogger at once, once', async () => {
  const w = world({ rows: [{ id: 'p1', amount_minor: 48400, status: 'sent', konsol_payment_id: 'pay-1', handle: 'eseniya__oo3__' }] });
  const sent = [];
  w.deps.notifyBlogger = async (row, text, kind) => { sent.push({ text, kind }); return { ok: true }; };
  w.deps.store.claimNotice = async (id, at) => { const r = w.db.get(id); if (r.paid_notice_at) return false; r.paid_notice_at = at; return true; };
  w.deps.store.releaseNotice = async (id) => { w.db.get(id).paid_notice_at = null; };
  const out = await applyKonsolPayment(await w.deps.store.getPayout('p1'), { id: 'pay-1', status: 'failed', error_message: 'Konsol: failed' }, w.deps);
  assert.equal(out.noticed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'failed');
  assert.match(sent[0].text, /с нашей стороны/);
  const again = await applyKonsolPayment(await w.deps.store.getPayout('p1'), { id: 'pay-1', status: 'failed' }, w.deps);
  assert.equal(again.noticed, false);
  assert.equal(sent.length, 1);
});
