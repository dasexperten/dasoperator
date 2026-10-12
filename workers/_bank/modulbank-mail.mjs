// Modulbank payment notifications (no-reply@modulbank.ru → dasexperten@gmail.com)
// turned into bank_transactions rows. Owner 2026-10-12: the Modulbank API feed is off
// since 2 October and silent since 18 August; the bank still mails every payment.
// Pure parsing lives here so it can be tested without Gmail or D1.

export const MODULBANK_ACCOUNT_ID = "cba_dee_modul_rub";
const OUR_ACCOUNT = "40702810370010335401";
const OUR_ACCOUNT_TAIL = "5401";

const MONTHS = {
  "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
  "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
};

function flat(s) {
  return String(s || "")
    .replace(/\[\]\(/g, " (")             // markdown-style empty links keep their URL
    .replace(/[|*  ]/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

function ruDate(d, m, y) {
  const mm = MONTHS[String(m).toLowerCase()];
  if (!mm) return null;
  return `${y}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "94 623,14" → 9462314 (kopecks). */
export function kopecks(s) {
  const clean = String(s).replace(/[\s  ]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

const AMOUNT = "(\\d{1,3}(?:[\\s\\u00a0\\u202f]\\d{3})*,\\d{2})";

/**
 * Parse one notification body. Returns { transactions, problems }.
 * A block is the text up to each "transaction/<uuid>" link; the uuid is Modulbank's own
 * transaction id and the same id the API feed stored, so rows never double.
 */
export function parseModulbankMail(body, { subject = "", fallbackDate = null } = {}) {
  const text = flat(body);
  const head = flat(subject) + " " + text.slice(0, 400);
  const incoming = /пришёл платёж|пришел платеж|Поступление средств/i.test(head);
  const out = { transactions: [], problems: [] };
  // Only the RUB settlement account ***5401 maps to cba_dee_modul_rub.
  const raw = String(body || "");
  const ours = raw.includes(OUR_ACCOUNT) || raw.includes("***" + OUR_ACCOUNT_TAIL) || raw.includes("*" + OUR_ACCOUNT_TAIL);

  const re = /transaction\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    const block = text.slice(last, m.index);
    last = m.index + m[0].length;
    const id = m[1].toLowerCase();

    if (!ours) {
      out.problems.push(`${id}: not account ${OUR_ACCOUNT_TAIL}`);
      continue;
    }

    let amount = null;
    const sum = new RegExp("Сумма:\\s*" + AMOUNT + "\\s*р", "i").exec(block);
    const signed = new RegExp("[+–-]\\s*" + AMOUNT + "\\s*р\\.", "i").exec(block);
    if (sum) amount = kopecks(sum[1]);
    else if (signed) amount = kopecks(signed[1]);

    const doc = /(?:Платёжное поручение|Платёж|Платеж):\s*№\s*(\d+)\s+от\s+(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i.exec(block);
    const done = /Исполнено:\s*(\d{1,2})\s+([а-яё]+)\s+(\d{4})/i.exec(block);
    const date = (done && ruDate(done[1], done[2], done[3])) || (doc && ruDate(doc[2], doc[3], doc[4])) || fallbackDate;

    const commission = /Списана комиссия|Назначение комиссии/i.test(block);
    let name = null;
    const from = /От:\s*(.+?)\s+ИНН:/i.exec(block);
    const to = /Кому:\s*(.+?)\s+(?:Со сч[её]та|ИНН|Назначение)/i.exec(block);
    const payee = /Получатель:?\s*(.+?)\s+ИНН:/i.exec(block);
    if (incoming && from) name = from[1];
    else if (payee) name = payee[1];
    else if (to) name = to[1];
    else if (commission) name = "Модульбанк";
    const inn = /ИНН:\s*(\d{10}|\d{12})\b/i.exec(block);
    const purpose = /Назначение (?:платежа|комиссии):\s*«?(.+?)»?\s*(?:Остаток на сч|Сумма:|Исполнено:|Комиссия:|Посмотреть|Подробная|$)/i.exec(block);

    if (!amount || !date) {
      out.problems.push(`${id}: amount or date not found`);
      continue;
    }
    out.transactions.push({
      external_id: id,
      external_doc_number: doc ? doc[1] : null,
      direction: incoming ? "incoming" : "outgoing",
      amount,
      currency: "RUB",
      executed_at: date,
      contragent_name: name ? name.replace(/\s+/g, " ").trim() : null,
      contragent_inn: commission ? null : inn ? inn[1] : null,
      payment_purpose: purpose ? purpose[1].trim() : null,
    });
  }
  if (!out.transactions.length && !out.problems.length) out.problems.push("no transaction link in letter");
  return out;
}
