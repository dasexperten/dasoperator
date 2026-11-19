import test from 'node:test';
import assert from 'node:assert/strict';
import { asksRefundNumber, REFUND_ANSWER } from './diana-refund.mjs';
test('a question where to return money is recognised (Owner 19.11, dasha_vous)', () => {
  for (const t of ['на какой номер вернуть деньги?', 'Куда вам вернуть деньги?', 'Скиньте реквизиты для возврата', 'Подскажите номер, куда сделать возврат'])
    assert.equal(asksRefundNumber(t), true, t);
  for (const t of ['Когда переведёте деньги?', 'Номер телефона 89001234567, Сбер, Анна', 'Вернусь вечером', 'Спасибо!'])
    assert.equal(asksRefundNumber(t), false, t);
  assert.equal(REFUND_ANSWER, 'Вот номер для возврата: Т-Банк, +7 930 955-40-25');
});
