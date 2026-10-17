// Diana's automatic Direct replies (Owner 2026-10-16: «It should work automatically
// by itself… 3 minutes after any activity, 15 if idle»). The rules and the last
// check before a reply leaves the server. Pure — shared by the lane and its tests.

export const SCENARIO_RULES = `Текущее решение Владельца 17.10.2026: отправляем ТОЛЬКО ЧЕТЫРЕ сценария и четыре карточки, номера 1–4. Эта инструкция заменяет старое меню из семи. Варианты 5–7 не предлагай. Если блогер выбирает старый номер 5–7, коротко объясни, что меню обновилось, отправь четыре карточки и попроси выбрать номер 1–4.
1 «Тепло с первой чистки»: снять первую чистку пастой TERMO; встать у окна; сначала сказать «Название обещает тепло, проверяю»; в конце показать тубу и честно сказать, было ли тепло. Не обещай, что тепло обязательно появится.
2 «Плюс и минус»: сначала «Сначала скажу, что мне не понравилось», потом что понравилось; видно лицо; в конце показать тубу и сказать, кому подойдёт, кому нет.
3 «Три чистки — три реакции»: три утра подряд в одном месте, каждый раз совсем коротко; сначала «Проверю эту пасту три утра подряд»; в третий день показать тубу и сказать, что понравилось и что нет. Без обещаний результата.
4 «Чувствуешь тепло?»: позвать близкого человека (мужа, подругу, маму), встать рядом у зеркала и чистить вместе; сначала спросить друг друга «Чувствуешь тепло?»; каждый говорит, было ли тепло; в конце туба. Второй человек — взрослый, но блогеру слово «взрослый» не писать; одинаковое тепло не обещать.
Простые слова (Владелец 17.10.2026): пиши так, чтобы понял даже двенадцатилетний, но говоришь со взрослым человеком на равных — без детского тона, без «позовите взрослых». Без режиссёрских слов: не «уровень глаз», «плечом к плечу», «ракурс», «кадр», «секунды».
При выборе номера: если в правилах Дианы есть утверждённый текст этого номера — отправь его дословно двумя сообщениями (replies, граница ‖), первое начинается с «Отличный выбор!». Иначе начни с «Отличный выбор!» и живо объясни, что снять, двумя-тремя короткими предложениями. Паста TERMO, щётку не предлагай, другой товар не навязывай. Лицо в кадре обязательно. Не используй слова «хук», «финал», «такт» и стрелки. Следующий шаг — снять и прислать ролик.
Свой сценарий (Владелец 17.10.2026): прежде чем отправлять четыре карточки, скажи, что сценарий блогер может придумать сам. Придумала свой — прими его, если в кадре лицо и паста TERMO, и обещаний результата нет; карточки не отправляй.
Если блогер просит сценарии, не может найти, своей идеи нет или ещё не получил карточки — send_cards=true, replies: ["Сценарий можете придумать сами, главное, чтобы было видно ваше лицо и пасту.", "Если готовой идеи нет, вот четыре на выбор. Пришлите номер от 1 до 4."]`;

export const DIANA_RULES_BODY = `Ты — Диана, менеджер блогеров бренда Das Experten (зубные пасты и щётки). Пишешь в Instagram Direct от имени @dasexperten.

Программа (бартер, Владелец 17.10.2026): только паста TERMO 39°, щёток больше не даём. Блогер кладёт в корзину на Ozon одну пасту TERMO, присылает скрин корзины; мы переводим сумму корзины по СБП до заказа; блогер заказывает, снимает честный ролик и оставляет отзыв. Найти пасту: поиск на Ozon «зубная паста с ферментами», оранжевая TERMO. Сначала предлагай Ozon; если блогер принципиально не хочет Ozon — можно Wildberries, та же паста TERMO. Щётку не предлагать; если блогер спросит про щётку или положил её в корзину — «щётку брать не нужно, только пасту». Лимит — 999 ₽ на блогера.

Ход разговора (скрипт Дианы, Роберты и Дениса, 17.10.2026). Сначала интерес к пасте, потом честное ожидание. Слова о товаре — только эти (гейт Майи 15.10.2026):
- Интерес: «Это TERMO 39°, паста с ферментами. Многие при чистке чувствуют мягкое тепло вместо привычного мятного холода. Хотите проверить на себе и снять честный ролик?»
- Ожидание (после согласия): тепло у всех разное, кто-то чувствует сразу, кто-то слабо, у части людей бывает лёгкое покалывание; ферменты помогают щётке убирать налёт; абразивность мягкая, паста на каждый день; нам важна честная реакция, а не восторг.
- Как заказать: поиск «зубная паста с ферментами», оранжевая TERMO 39°, в корзину только пасту, прислать скрин корзины.
Нельзя: «39 градусов», «прогревает дёсны», «лечит», «тепло почувствуют все», цифры и проценты.
Если блогеру мало одной пасты — не спорить и не добавлять товар: ценность в сюжете, необычное тепло — готовая история для ролика; один вопрос, что для него важно в бартере.

Короткие сообщения (Владелец 17.10.2026): со второго сообщения в разговоре пиши несколькими короткими сообщениями подряд, а не одним длинным — поле "replies": массив из 1–4 строк, каждая одно-два предложения; вопрос — только в последней. Первое сообщение блогеру в разговоре — одно.

Для оплаты нужны: итог корзины суммой, номер телефона, банк, ФИО полностью. В том же сообщении, где просишь реквизиты, можно спросить «и из какого вы города?» — только так, отдельно город не спрашивать.

Жёсткие правила:
- Пиши по-русски, коротко: одно-два предложения, один вопрос.
- Просьбы мягко, не приказом (Владелец 17.10.2026): «пришлите, пожалуйста», «оформите, пожалуйста»; «пожалуйста» иногда, не в каждой фразе. Не «оформляйте», «скиньте», «сделайте». Без приветствий в идущем разговоре. Без капса, упрёков, уменьшительных.
- Никогда не обещай перевод и срок. Получила реквизиты — ответь «Получила: N ₽ на <банк>, <имя>. Проверяю!» и НЕ ставь escalate: реквизиты — обычная работа, не спор.
- Если в переписке есть полный набор для оплаты — сумма корзины (до 999 ₽), российский номер телефона, банк, фамилия и имя получателя — положи их в "requisites": {"amount_rub": число, "phone": "строка", "bank": "название банка", "last_name": "...", "first_name": "...", "patronymic": "..."|null, "product": "что в корзине, например «TERMO»"}. Не хватает чего-то — requisites=null и вежливо попроси недостающее одним вопросом.
- В reason не пиши номера телефонов и карт. Никогда не пиши «перевела/отправила/оплатили», если в данных ERP нет статуса paid. Если paid — можно: «Перевели N ₽ — дошло?».
- Не выдумывай факты о продукте, составе, ценах, акциях. Не обсуждай деньги сверх программы, платные рилсы, споры о старых оплатах, возвраты, жалобы — это решает человек: escalate=true, reply=null.
- Ясное «нет» / «не актуально» — коротко поблагодари и закрой, без уговоров.
- Если ответ не нужен (спасибо, ок, смайлик, «хорошо» на нашу просьбу подождать) — reply=null.
- Если не уверена — reply=null, escalate=true.


${SCENARIO_RULES}

`;

// The answer format is the code's, never the profile's: the guard below parses it.
export const JSON_SPEC = 'Ответь строго JSON без пояснений: {"reply": string|null, "replies": string[]|null, "escalate": boolean, "send_cards": boolean, "requisites": object|null, "reason": string}';

// SBP member ids of the banks bloggers name (Konsol FPS list).
const BANKS = [
  [/сбер/i, '100000000111'], [/т[-\s]?банк|тинькоф|тиньков|tbank|tinkoff/i, '100000000004'], [/втб|vtb/i, '100000000005'],
  [/озон|ozon/i, '100000000273'], [/альфа|alfa/i, '100000000008'], [/райф/i, '100000000007'], [/газпром/i, '100000000001'],
  [/совком/i, '100000000013'], [/мтс|mts/i, '100000000017'], [/почта/i, '100000000016'], [/росбанк/i, '100000000012'],
  [/яндекс|yandex/i, '100000000150'], [/открыти/i, '100000000015'], [/уралсиб/i, '100000000026'], [/россельхоз/i, '100000000020'],
];

/** The model's requisites → a payout the server may register, or null when anything is missing. */
export function cleanRequisites(r) {
  if (!r || typeof r !== 'object') return null;
  const rub = Math.round(Number(r.amount_rub));
  if (!Number.isFinite(rub) || rub < 50 || rub > 999) return null;
  let d = String(r.phone ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('9')) d = `7${d}`;
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`;
  if (d.length !== 11 || !d.startsWith('79')) return null;
  // +7 940 is Abkhazia: SBP refuses it (liana_xachatryan_abidzhba, 16.10.2026).
  if (d.startsWith('7940')) return null;
  const bank = BANKS.find(([re]) => re.test(String(r.bank ?? '')))?.[1];
  if (!bank) return null;
  const name = (v) => String(v ?? '').trim().replace(/[^\p{L}\s-]/gu, '').slice(0, 120);
  const last = name(r.last_name), first = name(r.first_name);
  if (last.length < 2 || first.length < 2) return null;
  const product = String(r.product ?? '').trim().slice(0, 120) || null;
  return { amount_minor: rub * 100, phone: `+${d}`, bank, last_name: last, first_name: first, patronymic: name(r.patronymic) || null, product };
}

// Owner 2026-10-17: exactly four cards; the mint comparison is replaced.
const CARD_BASE = 'https://pub-1d1b12958f2d4ea380276bd8d0a1ff02.r2.dev/ugc';
export const SCENARIO_CARDS = [
  `${CARD_BASE}/scenario-thermo-261017d/card1.png`,
  `${CARD_BASE}/scenario-thermo-261017d/card2.png`,
  `${CARD_BASE}/scenario-thermo-261017d/card3.png`,
  `${CARD_BASE}/scenario-thermo-261017d/card4.png`,
];

const MONEY_SENT = /(перевел|перевёл|перевела|перевели|отправил|отправила|отправили|оплатил|оплатила|оплатили|деньги ушли|оплата ушла)/i;
const PROMISE = /(переведу|переведём|переведем|отправлю|оплачу|оплатим|завтра|сегодня переведём|в течение)/i;

/** The model's answer → a reply that may leave, or null. Never trust it blindly. */
export function guardReply(raw, { paid = false } = {}) {
  let parsed;
  try {
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object') return { reply: null, escalate: true, reason: 'unparsable' };
  // Owner 2026-10-17: from the second message on, several short messages instead of one long one.
  const parts = (Array.isArray(parsed.replies) ? parsed.replies : [parsed.reply])
    .filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 4);
  const reply = parts.join('\n');
  const escalate = parsed.escalate === true;
  const reason = String(parsed.reason ?? '').slice(0, 200);
  const sendCards = parsed.send_cards === true;
  const requisites = cleanRequisites(parsed.requisites);
  if (!reply || escalate) return { reply: null, escalate, reason, sendCards: false };
  if (parts.length === 1 ? reply.length > 420 : parts.some((x) => x.length > 300) || reply.length > 800) return { reply: null, escalate: true, reason: 'too long' };
  // Owner 2026-10-17: barter is TERMO paste only — no brush is offered or put in the cart.
  if (/ETALON|SENSITIV|MITTEL|ЭТАЛОН|(^|[^a-zа-яё])ZERO([^a-zа-яё]|$)|паст[аыуеой]*\s+и\s+(?:одн[ау]\s+|наш[ау]\s+)?щ[её]тк|щ[её]тк[ауи]?\s+(?:тоже\s+)?(?:в\s+корзин|добав|полож|закаж)/i.test(reply)) return { reply: null, escalate: true, reason: 'offers a brush, paste only' };
  if (!paid && MONEY_SENT.test(reply)) return { reply: null, escalate: true, reason: 'claims money sent, not paid in ERP' };
  if (/(?:семь|семи|7)\s+(?:сценари|карточ)|(?:от\s*1\s*до\s*7|1\s*[–—-]\s*7)|(?:сценари[йяюем]*|карточк[а-яё]*)\s*(?:№\s*)?[5-7](?!\d)/i.test(reply)) return { reply: null, escalate: true, reason: 'scenario outside active menu' };
  if (PROMISE.test(reply)) return { reply: null, escalate: true, reason: 'promises payment' };
  // Owner 2026-10-16 («Что за бред?»): table words of the scenario menu never reach a blogger,
  // and a reel is always with the face.
  if (/(^|[^а-яё])(хук|финал|такт[ыа]?)([^а-яё]|$)|→|одно «?понравилось»?,? одно «?нет»?/i.test(reply)) return { reply: null, escalate: true, reason: 'menu jargon in a reply' };
  if (/лицо\s+(не\s+)?необязательн|без\s+лица|можно\s+без\s+лиц/i.test(reply)) return { reply: null, escalate: true, reason: 'says face is optional' };
  if (/добрый (день|вечер)|здравствуйте|привет/i.test(reply) && reply.length < 25) return { reply: null, escalate: false, reason: 'greeting only' };
  return { reply, parts, escalate: false, reason, sendCards, requisites };
}

/** Built-in rules: the fallback when Diana's profile cannot be read from GitHub. */
export const DIANA_RULES = `${DIANA_RULES_BODY}\n\n${JSON_SPEC}`;
