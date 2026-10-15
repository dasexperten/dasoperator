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
