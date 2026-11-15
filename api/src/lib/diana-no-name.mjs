// Owner 2026-11-15 (elena.vay): «why her name all three times in the middle of the conversation —
// it should be a native flow, like her best friend advising». Her name is used once, in the very
// first message of the chat. After that Diana never addresses her by name.
const NOT_NAME = new Set(['отлично', 'спасибо', 'здорово', 'супер', 'хорошо', 'понятно', 'да', 'нет', 'конечно', 'прекрасно', 'класс', 'ура', 'итак', 'кстати', 'смотрите', 'подскажите', 'простите', 'привет', 'здравствуйте', 'добрый', 'ок', 'окей', 'отличный', 'круто', 'договорились', 'принято', 'верно', 'точно', 'вау', 'ой', 'ага']);
const LEAD = /^\s*([А-ЯЁA-Z][а-яёa-z]{1,14})\s*[,!]\s+/;

function leadName(text) {
  const m = String(text ?? '').match(LEAD);
  return m && !NOT_NAME.has(m[1].toLowerCase()) ? m[1] : null;
}

/** Strip the creator's name from a reply when we have already written to her in this chat. */
export function dropName(reply, history, firstName) {
  let text = String(reply ?? '');
  const ours = (history ?? []).filter(m => m.direction === 'out' && String(m.text ?? '').trim());
  if (!text.trim() || !ours.length) return text;
  const names = new Set([firstName, ...ours.map(m => leadName(m.text))].filter(Boolean).map(n => String(n).trim()));
  const lead = leadName(text);
  if (lead) names.add(lead);
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text
      .replace(new RegExp('^\\s*' + esc + '\\s*[,!]\\s*', 'i'), '')
      .replace(new RegExp(',\\s*' + esc + '(?=\\s*[,.!?])', 'gi'), '')
      .replace(new RegExp('([.!?]\\s+)' + esc + '\\s*,\\s*', 'gi'), '$1');
  }
  text = text.replace(/^\s*[,!]\s*/, '').replace(/([.!?]\s+)([а-яёa-z])/g, (m, p, c) => p + c.toUpperCase()).trim();
  return text ? text[0].toUpperCase() + text.slice(1) : String(reply);
}
