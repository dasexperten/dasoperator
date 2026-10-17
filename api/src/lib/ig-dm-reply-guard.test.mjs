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

test('menu jargon and «no face» never leave (Owner 2026-10-16)', () => {
  assert.equal(guardReply('{"reply":"Хук: «Название обещает тепло» → чистка","escalate":false}').reply, null);
  assert.equal(guardReply('{"reply":"Показывать лицо необязательно — руки тоже работают","escalate":false}').reply, null);
  assert.equal(guardReply('{"reply":"Отличный выбор! Снимаете первую чистку пастой TERMO.","escalate":false}').reply, 'Отличный выбор! Снимаете первую чистку пастой TERMO.');
});

test('only the four current scenarios may be offered', async () => {
 const { SCENARIO_CARDS, DIANA_RULES_BODY } = await import('./ig-dm-reply-guard.mjs');
 assert.equal(SCENARIO_CARDS.length,4);
 assert.match(DIANA_RULES_BODY,/Три утра с TERMO/);
 for (const reply of ['Вот семь сценариев — выбирайте!', 'Выберите 1–7', 'Вот карточка 6']) assert.equal(guardReply(JSON.stringify({reply,escalate:false})).reason,'scenario outside active menu');
 assert.equal(guardReply(JSON.stringify({reply:'Вот четыре сценария — пришлите номер от 1 до 4.',escalate:false,send_cards:true})).sendCards,true);
});

test('paste only: a brush offer never leaves (Owner 2026-10-17)', () => {
  const j = (reply) => JSON.stringify({ reply, escalate: false, send_cards: false, requisites: null, reason: 'x' });
  assert.equal(guardReply(j('Положите в корзину пасту и щётку ETALON.')).reason, 'offers a brush, paste only');
  assert.equal(guardReply(j('Добавьте пасту и нашу щётку, пришлите скрин.')).reason, 'offers a brush, paste only');
  assert.ok(guardReply(j('В корзину нужна только паста, щётку брать не нужно. Пришлёте скрин?')).reply);
  assert.ok(guardReply(j('Покажите крупно немного пасты на щётке.')).reply);
});

test('several short messages pass as parts (Owner 2026-10-17)', () => {
  const out = guardReply(JSON.stringify({ reply: null, replies: ['Тепло у всех разное.', 'У части людей бывает лёгкое покалывание.', 'Пришлёте скрин корзины?'], escalate: false, send_cards: false, requisites: null, reason: 'x' }));
  assert.deepEqual(out.parts, ['Тепло у всех разное.', 'У части людей бывает лёгкое покалывание.', 'Пришлёте скрин корзины?']);
  assert.equal(out.reply, out.parts.join('\n'));
  const one = guardReply(JSON.stringify({ reply: 'Пришлёте скрин?', escalate: false, send_cards: false, requisites: null, reason: 'x' }));
  assert.deepEqual(one.parts, ['Пришлёте скрин?']);
});

test('no claim about children and no adult wording (Owner 2026-10-17)', () => {
  const j = (reply) => JSON.stringify({ reply, escalate: false, send_cards: false, requisites: null, reason: 'x' });
  assert.equal(guardReply(j('Детям паста не подходит, только для взрослых.')).reason, 'claim about children');
  assert.equal(guardReply(j('Снимите вдвоём со взрослым.')).reason, 'adult wording');
  assert.ok(guardReply(j('Детей в ролики мы не берём, такое у нас правило.')).reply);
});

test('warm address only after the talk warmed, always вы (Owner 2026-10-17)', () => {
  const j = (reply) => JSON.stringify({ reply, escalate: false, send_cards: false, requisites: null, reason: 'x' });
  assert.equal(guardReply(j('Дорогая Юля, пришлите скрин?'), { inCount: 1 }).reason, 'warm address too early, keep it neutral');
  assert.ok(guardReply(j('Дорогая Юля, пришлите, пожалуйста, скрин?'), { inCount: 4 }).reply);
  assert.equal(guardReply(j('Пришли скрин, как будет готово'), { inCount: 4 }).reason, 'informal ты, always вы');
  assert.ok(guardReply(j('Пришлите, пожалуйста, скрин.'), { inCount: 1 }).reply);
});
