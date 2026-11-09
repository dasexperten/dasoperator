import assert from 'node:assert/strict';
import test from 'node:test';
import { PAYOUT_STATUS_LABEL, isStaleSent, payoutCell } from './ugc-payout-cell.mjs';

const NBSP = ' ';
const NOW = Date.parse('2026-10-15T12:00:00Z');

test('green only when paid with an executed Konsol payment', () => {
  const cell = payoutCell({ status: 'paid', amount_minor: 69100, konsol_payment_id: 'p1' }, NOW);
  assert.equal(cell.tone, 'green');
  assert.equal(cell.text, `691${NBSP}₽`);
  assert.equal(cell.reason, 'оплата сделана');
});

test('paid or sent without a Konsol id is never green', () => {
  for (const status of ['paid', 'sent']) {
    const cell = payoutCell({ status, amount_minor: 48400, sent_at: '2026-10-15T08:00:00Z' }, NOW);
    assert.notEqual(cell.tone, 'green');
    assert.equal(cell.reason, 'не исполнено в Консоли');
  }
});

test('requisites received, not paid yet — brown with the amount (Owner 2026-10-15)', () => {
  for (const status of ['awaiting_approval', 'approved']) {
    const cell = payoutCell({ status, amount_minor: 83600, has_requisites: 1 }, NOW);
    assert.equal(cell.tone, 'brown');
    assert.equal(cell.text, `836${NBSP}₽`);
    assert.equal(cell.reason, 'к оплате');
  }
  const handed = payoutCell({ status: 'sent', amount_minor: 83600, has_requisites: 1, konsol_payment_id: 'p2' }, NOW);
  assert.deepEqual([handed.tone, handed.reason], ['lightgreen', 'передано в Консоль']);
});

test('no requisites — grey, waits for requisites', () => {
  const cell = payoutCell({ status: 'awaiting_approval', amount_minor: 50000 }, NOW);
  assert.equal(cell.tone, 'grey');
  assert.equal(cell.reason, 'ждёт реквизитов');
});

test('over the limit says so', () => {
  assert.equal(payoutCell({ status: 'approved', amount_minor: 90000, has_requisites: 1, over_limit: true }, NOW).reason, 'сверх лимита');
});

test('failed is red: refusal with a Konsol id, not executed without one', () => {
  assert.deepEqual([payoutCell({ status: 'failed', amount_minor: 100, konsol_payment_id: 'x' }, NOW).tone, payoutCell({ status: 'failed', amount_minor: 100, konsol_payment_id: 'x' }, NOW).reason], ['red', 'отказ']);
  assert.equal(payoutCell({ status: 'failed', amount_minor: 48400 }, NOW).reason, 'не исполнено в Консоли');
});

test('sent without a Konsol id older than 2 days turns red', () => {
  const old = { status: 'sent', amount_minor: 69100, sent_at: '2026-10-12T10:00:00Z' };
  assert.equal(isStaleSent(old, NOW), true);
  assert.equal(payoutCell(old, NOW).tone, 'red');
  assert.equal(isStaleSent({ ...old, konsol_payment_id: 'p' }, NOW), false);
  assert.equal(isStaleSent({ status: 'sent', payout_date: '2026-10-12' }, NOW), true);
  assert.equal(isStaleSent({ status: 'sent', payout_date: '2026-10-14' }, NOW), false);
});

test('no payout is a grey dash; awaiting_approval never reads as waiting for the Owner', () => {
  assert.equal(payoutCell(null, NOW).tone, 'grey');
  assert.equal(payoutCell(null, NOW).text, '—');
  assert.equal(PAYOUT_STATUS_LABEL.awaiting_approval, 'К оплате');
});

test('amounts of 1000 and more stay one figure (Owner 2026-10-14)', () => {
  assert.equal(payoutCell({ status: 'paid', amount_minor: 152700, konsol_payment_id: 'p' }, NOW).text, `1527${NBSP}₽`);
});

import { canPay, payConfirmText } from './ugc-payout-cell.mjs';

test('pay button only on brown, within limits, not yet in Konsol', () => {
  const ready = { status: 'approved', amount_minor: 83600, has_requisites: 1 };
  assert.equal(canPay(ready), true);
  assert.equal(canPay({ ...ready, status: 'awaiting_approval' }), true);
  assert.equal(canPay({ ...ready, has_requisites: 0 }), false);
  assert.equal(canPay({ ...ready, over_limit: true }), false);
  assert.equal(canPay({ ...ready, konsol_payment_id: 'p' }), false);
  for (const status of ['sent', 'paid', 'failed']) assert.equal(canPay({ ...ready, status }), false);
  assert.equal(canPay(null), false);
});

test('confirm names nick, amount, bank and only the last two phone digits', () => {
  const text = payConfirmText({ amount_minor: 83600, bank_ref: 'Т-Банк', phone_masked: '+7930*****25' }, 'mis_alina_010');
  assert.match(text, /@mis_alina_010/);
  assert.match(text, /836 ₽/);
  assert.match(text, /Т-Банк/);
  assert.match(text, /…25$/);
  assert.doesNotMatch(text, /7930/);
});

test('no double pay (UI): light green and green are never clickable; recorded future dates do not schedule payment', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const ready = { status: 'approved', amount_minor: 50000, has_requisites: 1, payout_date: '2026-10-15' };
  assert.equal(canPay(ready, now), true);
  assert.equal(canPay({ ...ready, status: 'sent', konsol_payment_id: 'k' }, now), false);
  assert.equal(canPay({ ...ready, status: 'paid', konsol_payment_id: 'k' }, now), false);
  assert.equal(canPay({ ...ready, execute_claim: 'x' }, now), false);
  assert.equal(canPay({ ...ready, payout_date: '2026-10-16' }, now), true);
});

test('missing creator data never blocks a ready payout (Owner follow-up 2026-10-16)', () => {
  const p = { status: 'awaiting_approval', amount_minor: 50000, has_requisites: 1, missing_info: ['подписчики', 'ER', 'продукт'] };
  const cell = payoutCell(p);
  assert.equal(cell.tone, 'brown');
  assert.equal(cell.reason, 'к оплате');
  assert.equal(canPay(p), true);
  assert.equal(canPay({ ...p, missing_info: [] }), true);
});

test('a payout the Owner paid outside the ERP is green and never a pay button (Owner 2026-11-03)', () => {
  const p = { status: 'paid', konsol_status: 'paid_outside', konsol_payment_id: null, has_requisites: 1, amount_minor: 41000 };
  assert.equal(payoutCell(p).tone, 'green');
  assert.equal(canPay(p), false);
  assert.equal(payoutCell({ ...p, konsol_status: null }).tone, 'brown');
});

test('unknown and one-kopeck amounts are neutral and not payable, regardless of requisites',()=>{
 for(const amount_minor of [1,0,49,4999])for(const has_requisites of [0,1]){
  const p={status:'awaiting_approval',amount_minor,has_requisites};assert.equal(payoutCell(p).tone,'grey');assert.equal(canPay(p),false);
 }
 for(const amount_minor of [39400,45300])assert.equal(payoutCell({status:'awaiting_approval',amount_minor,has_requisites:1}).tone,'brown');
});

test('historical sent/paid rows without provider proof cannot make an unknown amount brown',()=>{
 for(const status of ['sent','paid'])assert.equal(payoutCell({status,amount_minor:1,has_requisites:1,payout_date:new Date().toISOString().slice(0,10)}).tone,'grey');
});

import { canSetPayoutAmount, canMarkPaidOutside } from './ugc-payout-cell.mjs';

test('placeholder is neutral, never payable or markable, even when requisites are complete', () => {
  for (const has_requisites of [false, true]) {
    const p = { status: 'awaiting_approval', amount_minor: 1, has_requisites };
    assert.equal(payoutCell(p).tone, 'grey');
    assert.equal(payoutCell(p).text, 'сумма?');
    assert.equal(canPay(p), false);
    assert.equal(canMarkPaidOutside(p), false);
    assert.equal(canSetPayoutAmount(p), true);
  }
});

test('453 and 394 RUB held amounts stay neutral and unavailable for either paid action', () => {
  for (const amount_minor of [45300, 39400]) for (const has_requisites of [false, true]) {
    const p = { status: 'approved', amount_minor, has_requisites, payout_hold: true };
    assert.equal(payoutCell(p).tone, 'grey');
    assert.equal(payoutCell(p).text, `${amount_minor / 100} ₽`);
    assert.equal(payoutCell(p).reason, 'требует проверки');
    assert.equal(canPay(p), false); assert.equal(canMarkPaidOutside(p), false); assert.equal(canSetPayoutAmount(p), false);
  }
});

test('save amount only admits pending one-kopeck placeholders without claims, provider or conflicts', () => {
  const p = { status: 'approved', amount_minor: 1, has_requisites: false };
  assert.equal(canSetPayoutAmount(p), true);
  assert.equal(canSetPayoutAmount({ ...p, payout_hold: true }), true);
  assert.equal(payoutCell({ ...p, payout_hold: true }).text, 'сумма?');
  for (const patch of [{ status: 'paid' }, { status: 'sent' }, { status: 'failed' }, { amount_minor: 2 }, { amount_minor: 0 }, { amount_minor: 45300 }, { execute_claim: 'claim' }, { konsol_payment_id: 'payment' }, { konsol_status: 'pending' }, { konsol_contractor_id: 'contractor' }, { payout_review_required: true }]) {
    assert.equal(canSetPayoutAmount({ ...p, ...patch }), false);
  }
});

test('explicit review hold dominates all payment-action eligibility', () => {
  const ready = { status: 'approved', amount_minor: 45300, has_requisites: true };
  assert.equal(canMarkPaidOutside(ready), true);
  for (const patch of [{ payout_hold: true }, { payout_review_required: true }, { execute_claim: 'claim' }, { konsol_payment_id: 'payment' }]) {
    assert.equal(canPay({ ...ready, ...patch }), false);
    assert.equal(canMarkPaidOutside({ ...ready, ...patch }), false);
  }
});


test('paid-outside keeps existing known historical and over-limit brown eligibility', async () => {
  const { canMarkPaidOutside } = await import('./ugc-payout-cell.mjs');
  const known = { amount_minor: 45300, has_requisites: 1, status: 'approved' };
  for (const change of [{ status: 'sent', sent_at: new Date().toISOString() }, { status: 'paid' }, { over_limit: true }]) {
    const row = { ...known, ...change };
    assert.equal(canMarkPaidOutside(row), true);
    for (const lock of [{ payout_hold: true }, { payout_review_required: true }, { execute_claim: 'held' }, { konsol_payment_id: 'linked' }, { amount_minor: 1 }]) {
      assert.equal(canMarkPaidOutside({ ...row, ...lock }), false);
    }
  }
});


test('contractor presence flag blocks editing without exposing a provider identity', async () => {
 const { canSetPayoutAmount } = await import('./ugc-payout-cell.mjs');
 assert.equal(canSetPayoutAmount({ status: 'approved', amount_minor: 1, has_konsol_contractor: true }), false);
});
