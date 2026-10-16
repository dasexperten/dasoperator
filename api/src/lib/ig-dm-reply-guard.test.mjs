import test from 'node:test';
import assert from 'node:assert/strict';
import { guardReply } from './ig-dm-reply-guard.mjs';

test('a plain reply passes', () => {
  assert.equal(guardReply('{"reply":"Получила, проверяю!","escalate":false,"reason":"req"}').reply, 'Получила, проверяю!');
});
test('money sent is said only when ERP shows paid', () => {
  assert.equal(guardReply('{"reply":"Перевели 560 ₽ — дошло?","escalate":false}').reply, null);
  assert.equal(guardReply('{"reply":"Перевели 560 ₽ — дошло?","escalate":false}', { paid: true }).reply, 'Перевели 560 ₽ — дошло?');
});
test('a promise of payment never leaves', () => {
  const out = guardReply('{"reply":"Переведу завтра!","escalate":false}');
  assert.equal(out.reply, null);
  assert.equal(out.escalate, true);
});
test('escalation and broken output send nothing', () => {
  assert.equal(guardReply('{"reply":"x","escalate":true}').reply, null);
  assert.equal(guardReply('not json').escalate, true);
});

test('requisites become a payout only when complete and within 999 ₽', async () => {
  const { cleanRequisites } = await import('./ig-dm-reply-guard.mjs');
  assert.deepEqual(cleanRequisites({ amount_rub: 758, phone: '8 909 702 47 44', bank: 'Сбербанк', last_name: 'Мирзода', first_name: 'Хамида', patronymic: 'Ахмадхон' }),
    { amount_minor: 75800, phone: '+79097024744', bank: '100000000111', last_name: 'Мирзода', first_name: 'Хамида', patronymic: 'Ахмадхон', product: null });
  assert.equal(cleanRequisites({ amount_rub: 1082, phone: '+79001112233', bank: 'Сбер', last_name: 'Ан', first_name: 'Бо' }), null);
  assert.equal(cleanRequisites({ amount_rub: 500, phone: '+7940 123 45 67', bank: 'Т-Банк', last_name: 'Хачатрян', first_name: 'Лиана' }), null);
  assert.equal(cleanRequisites({ amount_rub: 500, phone: '+79001112233', bank: 'Т-Банк', last_name: 'С', first_name: 'Екатерина' }), null);
});
