import assert from 'node:assert/strict';
import test from 'node:test';
import { payoutCell } from './ugc-payout-cell.mjs';

const NBSP = ' ';

test('paid is a green rectangle with the amount', () => {
  assert.deepEqual(payoutCell({ status: 'paid', amount_minor: 69100 }), { tone: 'green', text: `691${NBSP}₽`, title: 'Paid' });
});

test('every other status is red with the amount, status only in the title', () => {
  for (const [status, title] of [['awaiting_approval', 'Ждёт одобрения'], ['approved', 'Одобрено'], ['sent', 'Отправлено'], ['failed', 'Ошибка']]) {
    assert.deepEqual(payoutCell({ status, amount_minor: 83600 }), { tone: 'red', text: `836${NBSP}₽`, title });
  }
});

test('no payout is a red rectangle with a dash', () => {
  assert.deepEqual(payoutCell(null), { tone: 'red', text: '—', title: 'Unpaid' });
  assert.deepEqual(payoutCell(undefined), { tone: 'red', text: '—', title: 'Unpaid' });
});
