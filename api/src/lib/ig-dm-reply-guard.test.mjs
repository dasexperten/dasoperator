import test from 'node:test';
import assert from 'node:assert/strict';
import { guardReply } from './ig-dm-reply-guard.mjs';

test('a plain reply passes', () => {
  assert.equal(guardReply('{"reply":"Получила, проверяю!","escalate":false,"reason":"req"}').reply, 'Получила, проверяю!');
});
test('money sent is said only when ERP shows paid', () => {
  const ok = 'Перевела 560 ₽ по СБП. Проверьте, пожалуйста, должно быть уже дошло.';
  assert.equal(guardReply(JSON.stringify({ reply: ok, escalate: false })).reply, null);
  assert.equal(guardReply(JSON.stringify({ reply: ok, escalate: false }), { paid: true }).reply, ok);
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
  // Owner 2026-10-17: a surname initial is enough for SBP; a missing first name is not.
  assert.ok(cleanRequisites({ amount_rub: 500, phone: '+79001112233', bank: 'Т-Банк', last_name: 'С', first_name: 'Екатерина' }));
  assert.equal(cleanRequisites({ amount_rub: 500, phone: '+79001112233', bank: 'Т-Банк', last_name: 'Смирнова', first_name: 'Е' }), null);
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

test('a paid-reel question goes to the Owner, never answered by the model', () => {
  const j = JSON.stringify({ reply: 'Платного формата сейчас нет.', escalate: false, send_cards: false, requisites: null, reason: 'x' });
  assert.equal(guardReply(j, { lastIn: 'А сколько вы платите за рилс?' }).reason, 'paid request, Owner decides');
  assert.ok(guardReply(j, { lastIn: 'Сняла, вот ссылка' }).reply);
});

test('«заказала» always asks for the order screenshot', () => {
  const j = (reply) => JSON.stringify({ reply, escalate: false, send_cards: false, requisites: null, reason: 'x' });
  assert.equal(guardReply(j('Отличный выбор! Снимите три вещи.'), { lastIn: 'Заказала! Хочу вторую карточку' }).reason, 'ask for the order screenshot too');
  assert.ok(guardReply(j('Отлично! Пришлите, пожалуйста, скрин заказа.'), { lastIn: 'Заказала!' }).reply);
});

test('a basket assembled before the paste-only rule keeps its brush (Owner 2026-10-17)', () => {
  const j = JSON.stringify({ reply: 'Паста и щётка ETALON в корзине — всё верно.', escalate: false, send_cards: false, requisites: null, reason: 'x' });
  assert.equal(guardReply(j).reason, 'offers a brush, paste only');
  assert.ok(guardReply(j, { allowBrush: true }).reply);
});

test('paid notice is a statement, never «дошло?» (Owner 2026-10-17)', () => {
  const j = (reply) => JSON.stringify({ reply, escalate: false, send_cards: false, requisites: null, reason: 'x' });
  assert.match(guardReply(j('Перевели 900 ₽ — дошло?'), { paid: true }).reason, /^paid notice as a question/);
  assert.ok(guardReply(j('Перевела 900 ₽ по СБП. Проверьте, пожалуйста, должно быть уже дошло.'), { paid: true }).reply);
});

test('no dashes and long paragraphs become short messages (Owner 2026-10-17)', async () => {
  const { noDashes, shortParts } = await import('./ig-dm-reply-guard.mjs');
  assert.equal(noDashes('Паста TERMO — с ферментами'), 'Паста TERMO, с ферментами');
  assert.equal(noDashes('Кто-то чувствует сразу'), 'Кто-то чувствует сразу');
  assert.equal(noDashes('номер 1–4'), 'номер 1 до 4');
  const long = 'Снимите, пожалуйста, как вы первый раз чистите зубы пастой TERMO. Встаньте у окна, чтобы было светло. Сначала скажите в камеру: «Название обещает тепло, проверяю». Покажите пасту на щётке, потом почистите зубы, чтобы было видно лицо.';
  const parts = shortParts([long]);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 180));
  const out = guardReply(JSON.stringify({ reply: 'Отлично — пришлите, пожалуйста, скрин.', escalate: false, send_cards: false, requisites: null, reason: 'x' }));
  assert.equal(out.reply, 'Отлично, пришлите, пожалуйста, скрин.');
});

test('permission and polite requests are not commands (yasmin_i.b, Owner 2026-10-18)', () => {
  const j = (reply) => JSON.stringify({ reply, escalate: false, reason: 'ok' });
  assert.notEqual(guardReply(j('Всё отлично, можно выкладывать завтра!')).reason, 'command tone, ask with «пожалуйста»');
  assert.notEqual(guardReply(j('Выкладывайте, пожалуйста, и пришлите ссылку.')).reason, 'command tone, ask with «пожалуйста»');
  assert.notEqual(guardReply(j('Здорово! Пришлите, пожалуйста, фото заказа.'), { lastIn: 'Заказала' }).reason, 'ask for the order screenshot too');
});
test('no command tone (Owner 2026-10-17)', () => {
  const j = (reply) => JSON.stringify({ reply, escalate: false, send_cards: false, requisites: null, reason: 'x' });
  assert.equal(guardReply(j('Оформляйте заказ и пришлите скрин.')).reason, 'command tone, ask with «пожалуйста»');
  assert.ok(guardReply(j('Оформите, пожалуйста, заказ и пришлите скрин.')).reply);
});

test('one person, one program; phone never repeated (Owner 2026-10-17)', () => {
  const j = (reply) => JSON.stringify({ reply, escalate: false, send_cards: false, requisites: null, reason: 'x' });
  assert.equal(guardReply(j('Второй аккаунт, это отдельная программа. Пришлите ник второго аккаунта.')).reason, 'one person, one program; ask what she means');
  assert.equal(guardReply(j('900 ₽ ушли на номер +79028764000, Сбер.'), { paid: true }).reason, 'do not repeat phone and recipient to the blogger');
  assert.ok(guardReply(j('Уточните, пожалуйста: вы про оплату по этой корзине?')).reply);
});

test('a first name and the surname initial are enough for SBP (Owner 2026-10-17)', async () => {
  const { cleanRequisites } = await import('./ig-dm-reply-guard.mjs');
  const r = cleanRequisites({ amount_rub: 395, phone: '89674029721', bank: 'Т-Банк', first_name: 'Кристина', last_name: 'С.' });
  assert.ok(r); assert.equal(r.last_name, 'С');
});

test('a surname initial counts only as a standalone letter, never inside Сумма or Сбер', async () => {
  const { requisitesSupportedByText } = await import('./ig-dm-reply-guard.mjs');
  const r = { amount_minor: 39500, phone: '+79674029721', bank: '100000000004', last_name: 'С', first_name: 'Кристина', patronymic: null };
  assert.equal(requisitesSupportedByText(r, 'Сумма 395 руб, телефон 89674029721, Т-Банк, имя Кристина'), false);
  assert.equal(requisitesSupportedByText(r, 'Сумма 395 руб\n89674029721\nТ-Банк\nКристина С.'), true);
});

test('«снимайте» is a command; «можно снимать» passes (Owner 2026-10-17, krainova_nadya)', () => {
  const j = (r) => JSON.stringify({ reply: r, replies: [r], send_cards: false, escalate: false, requisites: null });
  assert.equal(guardReply(j('Как получите, снимайте сценарий №1.'), { paid: false, inCount: 5, lastIn: '', allowBrush: true }).reply, null);
  assert.ok(guardReply(j('Как получите, можно снимать сценарий №1.'), { paid: false, inCount: 5, lastIn: '', allowBrush: true }).reply);
});

test('returns and money back go to the Owner first (Owner 2026-10-17, blog_lezginka_22)', () => {
  const j = (r) => JSON.stringify({ reply: r, replies: [r], send_cards: false, escalate: false, requisites: null });
  const o = { paid: true, inCount: 5, allowBrush: false };
  assert.equal(guardReply(j('Хорошо, поняла вас.'), { ...o, lastIn: 'Если так то я возврат сделаю и отправлю обратно деньги' }).reason, 'return or money back, Owner decides');
  assert.equal(guardReply(j('Оформите, пожалуйста, возврат через Ozon.'), { ...o, lastIn: 'ок' }).reply, null);
  assert.ok(guardReply(j('Вот и чудесно! Пришлите, пожалуйста, скрин заказа.'), { ...o, lastIn: 'ок' }).reply);
});

test('own scenario without the face is fine; unboxing is never offered (Owner 2026-10-17)', () => {
  const j = (r) => JSON.stringify({ reply: r, replies: [r], send_cards: false, escalate: false, requisites: null });
  const o = { paid: true, inCount: 5, lastIn: 'Без лица смогу', allowBrush: false };
  assert.ok(guardReply(j('Хорошо, снимите, пожалуйста, по своему сценарию. Главное, чтобы паста была в деле.'), o).reply);
  assert.equal(guardReply(j('Можно просто распаковку, это тоже подойдёт.'), o).reason, 'offers unboxing or closed packaging');
});

test('a refusal never sounds like a refusal (noza_finds 2026-10-18)', () => {
  for (const reply of ['Артикул не даём, ищите через поиск.', 'Артикул не даем', 'Ссылку не можем дать.', 'Так не положено.']) {
    assert.equal(guardReply(JSON.stringify({ reply, escalate: false, reason: 'ok' }), { paid: false, inCount: 2, lastIn: 'можно артикул' }).reason, 'refusal tone');
  }
  assert.notEqual(guardReply(JSON.stringify({ reply: 'Лучше через поиск, так ваша покупка поможет нашей карточке)', escalate: false, reason: 'ok' }), { paid: false, inCount: 2, lastIn: 'можно артикул' }).reason, 'refusal tone');
});
