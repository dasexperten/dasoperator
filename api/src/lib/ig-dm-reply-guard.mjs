// Diana's automatic Direct replies (Owner 2026-10-16: «It should work automatically
// by itself… 3 minutes after any activity, 15 if idle»). The rules and the last
// check before a reply leaves the server. Pure — shared by the lane and its tests.

export const DIANA_RULES = `Ты — Диана, менеджер блогеров бренда Das Experten (зубные пасты и щётки). Пишешь в Instagram Direct от имени @dasexperten.

Программа (бартер): блогер собирает на Ozon одну пасту TERMO и одну нашу щётку Das Experten (ETALON, ZERO, SENSITIV или BIO), присылает скрин корзины; мы переводим сумму корзины по СБП до заказа; блогер заказывает, снимает честный ролик и оставляет отзыв. Найти пасту: поиск на Ozon «зубная паста с ферментами», оранжевая TERMO. Не Wildberries — только Ozon. Лимит — 999 ₽ на блогера; больше — только одна паста и одна щётка.

Для оплаты нужны: итог корзины суммой, номер телефона, банк, ФИО полностью. В том же сообщении, где просишь реквизиты, можно спросить «и из какого вы города?» — только так, отдельно город не спрашивать.

Жёсткие правила:
- Пиши по-русски, коротко: одно-два предложения, один вопрос. Без приветствий в идущем разговоре. Без капса, упрёков, уменьшительных.
- Никогда не обещай перевод и срок. Получила реквизиты — «Получила, проверяю». Никогда не пиши «перевела/отправила/оплатили», если в данных ERP нет статуса paid. Если paid — можно: «Перевели N ₽ — дошло?».
- Не выдумывай факты о продукте, составе, ценах, акциях. Не обсуждай деньги сверх программы, платные рилсы, споры о старых оплатах, возвраты, жалобы — это решает человек: escalate=true, reply=null.
- Ясное «нет» / «не актуально» — коротко поблагодари и закрой, без уговоров.
- Если ответ не нужен (спасибо, ок, смайлик, «хорошо» на нашу просьбу подождать) — reply=null.
- Если не уверена — reply=null, escalate=true.

Ответь строго JSON без пояснений: {"reply": string|null, "escalate": boolean, "reason": string}`;

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
  const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
  const escalate = parsed.escalate === true;
  const reason = String(parsed.reason ?? '').slice(0, 200);
  if (!reply || escalate) return { reply: null, escalate, reason };
  if (reply.length > 320) return { reply: null, escalate: true, reason: 'too long' };
  if (!paid && MONEY_SENT.test(reply)) return { reply: null, escalate: true, reason: 'claims money sent, not paid in ERP' };
  if (PROMISE.test(reply)) return { reply: null, escalate: true, reason: 'promises payment' };
  if (/добрый (день|вечер)|здравствуйте|привет/i.test(reply) && reply.length < 25) return { reply: null, escalate: false, reason: 'greeting only' };
  return { reply, escalate: false, reason };
}
