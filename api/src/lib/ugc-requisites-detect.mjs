// Owner 2026-11-06: «ERP had to put immediately the brown button». The button must not wait for Diana's
// model reply: the ERP itself reads phone, bank and first name from the blogger's own text and registers
// the payout at once. The amount lives only in the cart picture, so it starts unconfirmed (UNCONFIRMED_MINOR)
// and the Owner types it once before paying; Diana's later reading replaces it.
import { cleanRequisites } from './ig-dm-reply-guard.mjs';

export const UNCONFIRMED_MINOR = 1; // 0.01 ₽ marks «сумма не подтверждена»; execute refuses anything under 50 ₽

const BANK_WORDS = /^(сбер|сбербанк|т-?банк|тинькофф?|тиньков|втб|озон|альфа|альфабанк|райф|райффайзен|газпром|газпромбанк|совком|совкомбанк|мтс|почта|росбанк|яндекс|открытие|уралсиб|россельхоз|банк|bank|по|на|номер|телефон|тел|карта|сбп|получатель|получателя|имя|фио)$/i;
// Owner 2026-11-06 (darina_melnikova): greetings and ordinary words are never a name.
const COMMON_WORDS = /^(здравствуйте|здравствуй|привет|добрый|доброе|доброго|день|дня|вечер|утро|слушаю|давайте|давай|можно|нужно|сразу|спасибо|благодарю|да|нет|хорошо|ок|окей|вот|это|мой|моя|мои|реквизиты|реквизит|перевод|переведите|отправьте|сумма|оплата|заказ|корзина|телефона|номеру|время|времени|сейчас|потом|тоже|если|или|как|так|что|для|все|всё|уже|еще|ещё|пожалуйста|вы|мне|меня|юмани|юmoney|ozon|wb|вайлдбериз|вайлдберриз|отп|киви)$/i;
const PATRONYMIC = /(вна|вич|чна|ична|инична|оглы|кызы)$/i;

/** Pure: complete requisites from the blogger's messages, or null when anything is missing. */
export function detectRequisites(texts) {
  const text = (texts || []).filter(Boolean).join('\n');
  if (!text.trim()) return null;
  const phoneMatch = text.match(/(?:\+?7|8)[\s()-]*9(?:[\s()-]*\d){9}/);
  if (!phoneMatch) return null;
  const bankLine = text.split('\n').find((l) => /сбер|т[-\s]?банк|тинькоф|тиньков|tbank|tinkoff|втб|vtb|озон|ozon|альфа|alfa|райф|газпром|совком|мтс|mts|почта|росбанк|яндекс|yandex|открыти|уралсиб|россельхоз/i.test(l));
  if (!bankLine) return null;
  // Name: Cyrillic words that are not bank or service words, outside the phone.
  const words = text.replace(phoneMatch[0], ' ').match(/[А-ЯЁа-яё][А-ЯЁа-яё-]*\.?/g) || [];
  const nameWords = words.map((w) => w.replace(/\.$/, '')).filter((w) => !BANK_WORDS.test(w) && !COMMON_WORDS.test(w));
  // Owner 2026-11-06 (e_zulia.20 «Асварова Зульфия Хелифовна»): with a patronymic, the first name is the word right
  // before it and the surname the word before that (or the word after: «Людмила Игоревна з»).
  const pi = nameWords.findIndex((w) => PATRONYMIC.test(w));
  let first, patronymic = null, last = null;
  if (pi >= 1) {
    first = nameWords[pi - 1]; patronymic = nameWords[pi];
    last = pi >= 2 ? nameWords[pi - 2] : (nameWords[pi + 1] ?? null);
  } else {
    first = nameWords.find((w) => /^[А-ЯЁ]/.test(w) && w.length >= 2 && !PATRONYMIC.test(w));
    last = nameWords.find((w) => w !== first && /^[А-ЯЁа-яё]/.test(w) && (w.length === 1 || /^[А-ЯЁ]/.test(w))) || null;
  }
  if (!first || !/^[А-ЯЁ]/.test(first) || first.length < 2) return null;
  const clean = cleanRequisites({ amount_rub: 100, phone: phoneMatch[0], bank: bankLine, first_name: first, last_name: last ? last.charAt(0).toUpperCase() + last.slice(1) : null, patronymic, product: 'TERMO 39°' });
  return clean ? { ...clean, amount_minor: UNCONFIRMED_MINOR } : null;
}
