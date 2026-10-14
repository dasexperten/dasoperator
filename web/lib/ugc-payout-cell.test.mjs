import assert from 'node:assert/strict';
import test from 'node:test';
import { payoutCell } from './ugc-payout-cell.mjs';

const NBSP = ' ';

test('sent and paid are green with the amount; the title tells them apart', () => {
  assert.deepEqual(payoutCell({ status: 'paid', amount_minor: 69100 }), { tone: 'green', text: `691${NBSP}₽`, title: 'Paid' });
  assert.deepEqual(payoutCell({ status: 'sent', amount_minor: 83600 }), { tone: 'green', text: `836${NBSP}₽`, title: 'Отправлено' });
});

test('not yet passed to Konsol is red with the amount, status only in the title', () => {
  for (const [status, title] of [['awaiting_approval', 'Ждёт одобрения'], ['approved', 'Одобрено'], ['failed', 'Ошибка']]) {
    assert.deepEqual(payoutCell({ status, amount_minor: 83600 }), { tone: 'red', text: `836${NBSP}₽`, title });
  }
});

test('no payout is a red rectangle with a dash', () => {
  assert.deepEqual(payoutCell(null), { tone: 'red', text: '—', title: 'Unpaid' });
  assert.deepEqual(payoutCell(undefined), { tone: 'red', text: '—', title: 'Unpaid' });
});

test('amounts of 1000 and more stay one figure (Owner 2026-10-14)', () => {
  assert.equal(payoutCell({ status: 'paid', amount_minor: 152700 }).text, `1527${NBSP}₽`);
});
