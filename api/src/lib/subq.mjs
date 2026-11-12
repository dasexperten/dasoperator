// SubQ Snap (Owner 2026-11-12): a cheap yes/no decision model, used as a second pair of eyes
// on blogger payouts. It never creates, pays or sends anything; it only answers questions.
// No key, an error or a timeout → null, and the rule-based checks decide alone.
const BASE = 'https://api.subq.ai/v1/systemone';
const MODEL = 'subq-snap-1.2';
const PHONE = /(?:\+?7|8)[\s()-]*9(?:[\s()-]*\d){9}/g;

export async function subqDecide(env, state, questions, images, fetchImpl = fetch) {
  const key = env?.SUBQ_API_KEY;
  if (!key) return null;
  try {
    const body = { model: MODEL, state: String(state).slice(0, 900_000), questions };
    if (images?.length) body.images = images.slice(0, 4);
    const r = await fetchImpl(BASE, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return null;
    const out = await r.json();
    return out?.answers ?? null;
  } catch {
    return null;
  }
}

/** Whole chat as dated lines; phone numbers masked before leaving the ERP. */
export function chatState(messages, handle) {
  return messages.map(m => {
    const who = m.direction === 'in' ? 'Блогер' : 'Мы';
    const text = String(m.text ?? '').replace(PHONE, '[номер телефона]').replace(/\s+/g, ' ').slice(0, 250);
    return `${String(m.created_at).slice(0, 10)} ${who}: ${text || '[медиа]'}`;
  }).join('\n');
}

/** Owner 2026-11-12 «paid is paid»: probability that this blogger was already paid for TERMO
 * in an earlier round of the same chat. Tested 12.11 on 50 live chats: one score above 0.8, and
 * that blogger had indeed been paid for TERMO before; 8 of 8 simulated TERMO repeats 0.65–0.98. */
export async function alreadyPaidForTermo(env, messages, handle, fetchImpl) {
  const state = 'Переписка бартера Das Experten. Самое последнее сообщение — новые реквизиты блогера.\n' + chatState(messages, handle);
  const a = await subqDecide(env, state, {
    repeat: {
      type: 'noul',
      instructions: 'Мы уже платили этой блогеру за пасту TERMO 39 раньше, в одном из прошлых кругов переписки?',
      criteria: {
        true: 'Да: выше есть наш перевод денег, а в том же круге речь шла о TERMO (корзина, заказ или ролик с TERMO)',
        false: 'Нет: за TERMO ей ещё не платили, прошлые переводы были за другие товары или их не было',
      },
    },
  }, null, fetchImpl);
  const p = a?.repeat?.noul;
  return Number.isFinite(p) ? p : null;
}

/** Second check of a cart screenshot after the main reader: is our TERMO there, and is its
 * large bold price the one the reader transcribed? */
export async function verifyCartImage(env, image, priceRub, fetchImpl) {
  if (!image?.data || !image?.mediaType || !(Number(priceRub) > 0)) return null;
  const a = await subqDecide(env, 'Скриншот прислала блогер в чате бартера Das Experten.', {
    ours: {
      type: 'noul',
      instructions: 'На скриншоте маркетплейса есть зубная паста TERMO 39 бренда Das Experten?',
      criteria: { true: 'да, паста TERMO на экране', false: 'нет' },
    },
    price: {
      type: 'noul',
      instructions: `Крупная жирная текущая цена в строке пасты TERMO 39 равна ${priceRub} ₽ (не зачёркнутая, не итог корзины, не другой товар)?`,
      criteria: { true: `да, ${priceRub} ₽`, false: 'нет, другая цена или пасты нет' },
    },
  }, [{ mediaType: image.mediaType, base64: image.data }], fetchImpl);
  if (!a) return null;
  const ours = a.ours?.noul, price = a.price?.noul;
  return Number.isFinite(ours) && Number.isFinite(price) ? { ours, price } : null;
}

export const SUBQ_REPEAT_BLOCK = 0.8;
export const SUBQ_CART_REJECT = 0.2;
