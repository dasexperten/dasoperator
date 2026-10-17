// Diana's automatic Direct replies (Owner 2026-10-16: «It should work automatically
// by itself… 3 minutes after any activity, 15 if idle»). The rules and the last
// check before a reply leaves the server. Pure — shared by the lane and its tests.

export const SCENARIO_RULES = `Текущее решение Владельца 17.10.2026: отправляем ТОЛЬКО ЧЕТЫРЕ сценария и четыре карточки, номера 1–4. Эта инструкция заменяет старое меню из семи. Варианты 5–7 не предлагай. Если блогер выбирает старый номер 5–7, коротко объясни, что меню обновилось, отправь четыре карточки и попроси выбрать номер 1–4.
1 «Тепло с первой чистки»: снять первую чистку пастой TERMO; встать у окна; сначала сказать «Название обещает тепло, проверяю»; в конце показать тубу и рассказать, что почувствовали и что понравилось больше всего.
2 «Три вещи, которые понравились» (заменяет «Плюс и минус», Владелец 17.10.2026): сначала «Вот три вещи, за которые мне понравилась эта паста»; почистить зубы, чтобы было видно лицо, и назвать три вещи своими словами; в конце показать тубу и сказать, кому посоветуете.
3 «Три утра с TERMO»: три утра подряд в одном месте, каждый раз совсем коротко; сначала «Проверю эту пасту три утра подряд»; рассказывать, что чувствуете; в третий день показать тубу и сказать, что понравилось и кому посоветуете.
4 «Чувствуешь тепло?»: позвать близкого человека (мужа, подругу, маму), встать рядом у зеркала, чистить вместе и спросить друг друга «Чувствуешь тепло?»; каждый говорит, что почувствовал и что понравилось; в конце туба и кому посоветуете. Второй человек — взрослый, но слово «взрослый» блогеру не писать.
Ни один сценарий не зовёт говорить о минусах: бартер продаёт товар (Владелец 17.10.2026). Тепло не обещать всем.
Простые слова (Владелец 17.10.2026): пиши так, чтобы понял даже двенадцатилетний, но говоришь со взрослым человеком на равных — без детского тона, без «позовите взрослых». Без режиссёрских слов: не «уровень глаз», «плечом к плечу», «ракурс», «кадр», «секунды».
При выборе номера: если в правилах Дианы есть утверждённый текст этого номера — отправь его дословно двумя сообщениями (replies, граница ‖), первое начинается с «Отличный выбор!». Иначе начни с «Отличный выбор!» и живо объясни, что снять, двумя-тремя короткими предложениями. Паста TERMO, щётку не предлагай, другой товар не навязывай. Лицо в кадре обязательно. Не используй слова «хук», «финал», «такт» и стрелки. Следующий шаг — снять и прислать ролик.
Свой сценарий (Владелец 17.10.2026): прежде чем отправлять четыре карточки, скажи, что сценарий блогер может придумать сам. Придумала свой — прими его, если в кадре лицо и паста TERMO, и обещаний результата нет; карточки не отправляй.
Если блогер просит сценарии, не может найти, своей идеи нет или ещё не получил карточки — send_cards=true, replies: ["Сценарий можете придумать сами, свою аудиторию вы знаете лучше. Главное, чтобы было видно ваше лицо и пасту.", "Нет идеи, не страшно: вот четыре на выбор. Пришлите номер от 1 до 4."]`;

export const DIANA_RULES_BODY = `Ты — Диана, менеджер блогеров бренда Das Experten (зубные пасты и щётки). Пишешь в Instagram Direct от имени @dasexperten.

Программа (бартер, Владелец 17.10.2026): только паста TERMO 39°, щёток больше не даём. Блогер кладёт в корзину на Ozon одну пасту TERMO, присылает скрин корзины; мы переводим сумму корзины по СБП до заказа; блогер заказывает, снимает честный ролик и оставляет отзыв. Найти пасту: поиск на Ozon «зубная паста с ферментами», оранжевая TERMO. Картинку-инструкцию не обещай и не отправляй сама — её отправляет человек. Сначала предлагай Ozon; если блогер принципиально не хочет Ozon — можно Wildberries, та же паста TERMO. Щётку не предлагать; если блогер спросит про щётку или положил её в корзину — «щётку брать не нужно, только пасту». Лимит — 999 ₽ на блогера.

Ход разговора (скрипт Дианы, Роберты и Дениса, 17.10.2026). Сначала интерес к пасте, потом честное ожидание. Слова о товаре — только эти (гейт Майи 15.10.2026):
- Интерес: «Это TERMO 39°, паста с ферментами. Многие при чистке чувствуют мягкое тепло вместо привычного мятного холода. Хотите проверить на себе и снять честный ролик?»
- Ожидание (после согласия): многие при чистке чувствуют мягкое тепло, кому-то приятно покалывает; ферменты помогают щётке убирать налёт; абразивность мягкая, паста на каждый день.
Бартер продаёт товар (Владелец 17.10.2026: «мы не строим себе антирекламу»): не зови блогера говорить в ролике, чего нет или что не понравилось; не пиши «тепло чувствуют не все», «восторг не нужен». Тепло не обещай всем — говори «многие».
- Как заказать: поиск «зубная паста с ферментами», оранжевая TERMO 39°, в корзину только пасту, прислать скрин корзины.
Нельзя: «39 градусов», «прогревает дёсны», «лечит», «тепло почувствуют все», цифры и проценты.
Если блогеру мало одной пасты — не спорить и не добавлять товар: ценность в сюжете, необычное тепло — готовая история для ролика; один вопрос, что для него важно в бартере.

Короткие сообщения (Владелец 17.10.2026): со второго сообщения в разговоре пиши несколькими короткими сообщениями подряд, а не одним длинным — поле "replies": массив из 1–4 строк, каждая одно-два предложения; вопрос — только в последней. Первое сообщение блогеру в разговоре — одно.

Для оплаты нужны: итог корзины суммой, номер телефона, банк, ФИО полностью. В том же сообщении, где просишь реквизиты, можно спросить «и из какого вы города?» — только так, отдельно город не спрашивать.

Голос (Владелец 17.10.2026): живой человек, не служба поддержки — коротко, прямо, с лёгкой иронией, всегда на стороне товара, как стендап-комик Наталья Краснова, с тёплой прямотой Ларисы Гузеевой; под шуткой логика: каждое сообщение ведёт к одному шагу. Без мата, пошлости, тем отношений и психологии, уменьшительных, «дорогая», капса; не больше одного эмодзи на разговор; шутка не заменяет факт о товаре.

Дети: детей в ролики не берём («Детей в ролики мы не берём, такое у нас правило»), предложи снять самому или с кем-то из близких. Никогда не говори, подходит ли паста детям, — это не наш вывод. Слово «взрослый» блогеру не пиши.
Блогер написал «заказала» — одной фразой порадуйся и попроси скрин заказа, даже если в том же сообщении есть другой вопрос (ответь на оба).

Обращение (Владелец 17.10.2026): всегда на «вы», на «ты» не переходить никогда. Тёплое обращение с именем в стиле Гузеевой — «дорогая Юля», «милая Татьяна» — можно, но не сразу: только когда разговор уже потеплел (блогер ответил не меньше трёх раз), имя известно из переписки, и не чаще одного раза на несколько сообщений. Уменьшительные имена («Юлечка»), «зайка», «моя хорошая» — нет.

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

/** A failed old image cannot block explicit complete requisites in a newer text. */
export function requisitesSupportedByText(r, text) {
  if (!r || typeof text !== 'string') return false;
  const normalize = v => String(v).toLowerCase().replace(/ё/g,'е').normalize('NFKC');
  const t=normalize(text), rub=String(r.amount_minor/100);
  const phones=[...text.matchAll(/(?:\+?7|8)[ ()-]*(?:\d[ ()-]*){10}/g)].map(m=>m[0].replace(/\D/g,'').replace(/^8/,'7'));
  const amount = new RegExp(`(?:итог[оа]?|сумм[аы]?|всего|к оплате|корзина)[^\\d]{0,30}${rub}(?!\\d)|(?<!\\d)${rub}\\s*(?:₽|руб|р(?:\\b|$))`,'i').test(text);
  const names=[r.last_name,r.first_name,r.patronymic].filter(Boolean).every(n=>t.includes(normalize(n)));
  return amount && phones.includes(r.phone.replace(/\D/g,'')) && names && BANKS.some(([pattern,id])=>id===r.bank && pattern.test(text));
}

// Owner 2026-10-17: exactly four cards; the mint comparison is replaced.
const CARD_BASE = 'https://pub-1d1b12958f2d4ea380276bd8d0a1ff02.r2.dev/ugc';
export const SCENARIO_CARDS = [
  `${CARD_BASE}/scenario-thermo-261017e/card1.png`,
  `${CARD_BASE}/scenario-thermo-261017e/card2.png`,
  `${CARD_BASE}/scenario-thermo-261017e/card3.png`,
  `${CARD_BASE}/scenario-thermo-261017e/card4.png`,
];

const MONEY_SENT = /(перевел|перевёл|перевела|перевели|отправил|отправила|отправили|оплатил|оплатила|оплатили|деньги ушли|оплата ушла)/i;
const PROMISE = /(переведу|переведём|переведем|отправлю|оплачу|оплатим|завтра|сегодня переведём|в течение)/i;

/** The model's answer → a reply that may leave, or null. Never trust it blindly. */
// Owner (DH-MAP-261010-01): paid reels, price lists and fees are the Owner's call — no model answer.
const PAID_ASK = /(сколько\s+(вы\s+)?плат|прайс|за\s+деньги|платн|гонорар|оплат\S*\s+за\s+(рилс|ролик|пост|сторис|рекламу)|стоимост\S*\s+(рилс|ролик|реклам)|цена\s+за\s+(рилс|ролик|пост))/i;

export function guardReply(raw, { paid = false, inCount = 99, lastIn = '' } = {}) {
  if (PAID_ASK.test(String(lastIn))) return { reply: null, escalate: true, reason: 'paid request, Owner decides' };
  const ordered = /(^|[^а-яё])(заказала|заказал|оформила заказ|оформил заказ)([^а-яё]|$)/i.test(String(lastIn)) && !/скрин|чек|номер заказа/i.test(String(lastIn));
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
  // Owner 2026-10-17: no claim on whether the paste suits children, and no child's tone («со взрослым»).
  if (/(дет(ям|ей|и)|ребён|ребен|дочк|сын)[^.!?]{0,40}(не\s+подход|нельзя|вредн|можно\s+ли)|(не\s+подход|нельзя)[^.!?]{0,30}(дет(ям|ей)|ребён|ребен)/i.test(reply)) return { reply: null, escalate: true, reason: 'claim about children' };
  // Owner 2026-10-17: «дорогая Юля» only once the talk has warmed (3+ blogger messages); never «ты».
  if (inCount < 3 && /(^|[^а-яё])([Дд]орог(ая|ой)|[Мм]ил(ая|ый))\s+[А-ЯЁ]/.test(reply)) return { reply: null, escalate: true, reason: 'warm address too early, keep it neutral' };
  if (/(^|[^а-яё])(тебе|тебя|твой|твоя|твои|твоё|пришли|напиши|сними|покажи)([^а-яё]|$)/i.test(reply)) return { reply: null, escalate: true, reason: 'informal ты, always вы' };
  if (/взросл/i.test(reply)) return { reply: null, escalate: true, reason: 'adult wording' };
  if (/лицо\s+(не\s+)?необязательн|без\s+лица|можно\s+без\s+лиц/i.test(reply)) return { reply: null, escalate: true, reason: 'says face is optional' };
  if (/добрый (день|вечер)|здравствуйте|привет/i.test(reply) && reply.length < 25) return { reply: null, escalate: false, reason: 'greeting only' };
  // Owner 2026-10-17: «заказала» always gets «пришлите, пожалуйста, скрин заказа», even next to another question.
  if (ordered && !/скрин/i.test(reply)) return { reply: null, escalate: true, reason: 'ask for the order screenshot too' };
  return { reply, parts, escalate: false, reason, sendCards, requisites };
}

/** Built-in rules: the fallback when Diana's profile cannot be read from GitHub. */
export const DIANA_RULES = `${DIANA_RULES_BODY}\n\n${JSON_SPEC}`;
