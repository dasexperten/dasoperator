// Owner 2026-11-15 (elena.vay): a native flow, like her best friend advising — not her name in every line.
// Iron rule: per day her name is used once; a second time only in a payment message (transfer,
// requisites, amount). Never more than twice a day. The day is the Moscow calendar day.
const NOT_NAME = new Set(['отлично', 'спасибо', 'здорово', 'супер', 'хорошо', 'понятно', 'да', 'нет', 'конечно', 'прекрасно', 'класс', 'ура', 'итак', 'кстати', 'смотрите', 'подскажите', 'простите', 'привет', 'здравствуйте', 'добрый', 'ок', 'окей', 'отличный', 'круто', 'договорились', 'принято', 'верно', 'точно', 'вау', 'ой', 'ага']);
const LEAD = /^\s*([А-ЯЁA-Z][а-яёa-z]{1,14})\s*[,!]\s+/;
const PAYMENT = /перев[её]д|перевел|оплат|реквизит|сбп|банк|номер телефона|сумм|₽|руб/i;
const day = t => new Date(Number(t) + 3 * 3600000).toISOString().slice(0, 10);

function leadName(text) {
  const m = String(text ?? '').match(LEAD);
  return m && !NOT_NAME.has(m[1].toLowerCase()) ? m[1] : null;
}
const esc = n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasName = (text, n) => new RegExp('(^|[^а-яёa-z])' + esc(n) + '(?![а-яёa-z])', 'i').test(String(text ?? ''));

/** history: [{direction, text, at(ms)}]. Returns the reply with her name removed when today's quota is spent. */
export function dropName(reply, history, { now = Date.now(), payment = false, firstName = null } = {}) {
  let text = String(reply ?? '');
  const ours = (history ?? []).filter(m => m.direction === 'out' && String(m.text ?? '').trim());
  if (!text.trim()) return text;
  const names = new Set([firstName, ...ours.map(m => leadName(m.text)), leadName(text)].filter(Boolean).map(n => String(n).trim()));
  if (!names.size) return text;
  const used = !ours.length ? 0 : ours.filter(m => Number.isFinite(m.at) && day(m.at) === day(now) && [...names].some(n => hasName(m.text, n))).length;
  const pay = payment || PAYMENT.test(text);
  if (used === 0 || (used === 1 && pay)) return text;
  for (const n of names) {
    const e = esc(n);
    text = text
      .replace(new RegExp('^\\s*' + e + '\\s*[,!]\\s*', 'i'), '')
      .replace(new RegExp(',\\s*' + e + '(?=\\s*[,.!?])', 'gi'), '')
      .replace(new RegExp('([.!?]\\s+)' + e + '\\s*,\\s*', 'gi'), '$1');
  }
  text = text.replace(/^\s*[,!]\s*/, '').replace(/([.!?]\s+)([а-яёa-z])/g, (m, p, c) => p + c.toUpperCase()).trim();
  return text ? text[0].toUpperCase() + text.slice(1) : String(reply);
}
