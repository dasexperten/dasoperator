// Wio Business notifications (communications@mail.wio.io → dasexperten@gmail.com) turned into
// bank_transactions rows for Das Experten International (DEI). Owner 2026-10-17: «перейдем к Wio,
// исправим адрес отправителя, подключим ящик». Wio has no API feed for us; the bank mails every
// incoming credit, every local transfer and every international transfer. Monthly statements
// live only in the app, so those letters are not parsed here.
// Pure parsing lives here so it can be tested without Gmail or D1.

// Our accounts are recognised by the masked number Wio prints (90XXXX9406, 91XXXX9772).
export const WIO_ACCOUNTS = {
  "9406": { id: "cba_dei_wio_aed", currency: "AED" },
  "9772": { id: "cba_dei_wio_usd", currency: "USD" },
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function flat(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\]\([^)]*\)/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/[|*#  ]/g, " ")
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

/** "2,619.75" → 261975 (minor units). */
export function minor(s) {
  const clean = String(s).replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

function enDate(d, mon, y) {
  const m = MONTHS[String(mon).slice(0, 3).toLowerCase()];
  return m ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
}

const MONEY = "([A-Z]{3})\\s+(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?)";
const MASK = "(\\d{2}X+(\\d{4}))";

/**
 * Parse one Wio letter. Returns { transactions, problems, kind }.
 * kind: "credit" | "local_transfer" | "international_transfer" | "other" (not a money letter).
 */
export function parseWioMail(body, { subject = "", fallbackDate = null } = {}) {
  const text = flat(body);
  const head = (flat(subject) + " " + text.slice(0, 300)).toLowerCase();
  const out = { transactions: [], problems: [], kind: "other" };

  const push = (tx, mask) => {
    const acc = WIO_ACCOUNTS[mask];
    if (!acc) { out.problems.push(`unknown Wio account ***${mask}`); return; }
    if (acc.currency !== tx.currency) { out.problems.push(`currency ${tx.currency} on ***${mask} (${acc.currency})`); return; }
    if (tx.amount === null || tx.amount <= 0) { out.problems.push("amount not read"); return; }
    if (!tx.executed_at) { out.problems.push("date not read"); return; }
    if (!tx.external_id) { out.problems.push("reference not read"); return; }
    out.transactions.push({ ...tx, account_id: acc.id });
  };

  if (/received money/.test(head)) {
    out.kind = "credit";
    const amt = text.match(new RegExp(`Amount\\s+${MONEY}`));
    const from = text.match(new RegExp(`From Reference ID Account\\s+(.+?)\\s+([A-Z0-9]{8,})\\s+${MASK}`));
    if (!amt || !from) { out.problems.push("credit letter: fields not found"); return out; }
    push({
      direction: "incoming",
      amount: minor(amt[2]),
      currency: amt[1],
      contragent_name: from[1].trim(),
      external_id: from[2],
      external_doc_number: from[2],
      payment_purpose: `Wio credit ${from[2]}`,
      executed_at: fallbackDate,
    }, from[4]);
    return out;
  }

  if (/local transfer is sent/.test(head)) {
    out.kind = "local_transfer";
    const total = text.match(new RegExp(`Total amount debited\\s+${MONEY}`))
      || text.match(new RegExp(`Transfer amount\\s+${MONEY}`));
    const to = text.match(new RegExp(`\\bTo\\s+(.+?)\\s+Account\\s+${MASK}`));
    const ref = text.match(/Reference ID\s+([A-Z0-9]{8,})/);
    if (!total || !to || !ref) { out.problems.push("local transfer letter: fields not found"); return out; }
    push({
      direction: "outgoing",
      amount: minor(total[2]),
      currency: total[1],
      contragent_name: to[1].trim(),
      external_id: ref[1],
      external_doc_number: ref[1],
      payment_purpose: `Wio local transfer ${ref[1]}`,
      executed_at: fallbackDate,
    }, to[3]);
    return out;
  }

  if (/transfer is on its way|international transfer/.test(head)) {
    out.kind = "international_transfer";
    const paid = text.match(new RegExp(`You paid\\s+${MONEY}`));
    const row = text.match(new RegExp(`Estimated delivery\\s+(.+?)\\s+${MASK}\\s+([A-Z0-9]{8,})\\s+(\\d{1,2})\\s+([A-Za-z]{3,9})\\s+(\\d{4})`));
    if (!paid || !row) { out.problems.push("international transfer letter: fields not found"); return out; }
    push({
      direction: "outgoing",
      amount: minor(paid[2]),
      currency: paid[1],
      contragent_name: row[1].trim(),
      external_id: row[4],
      external_doc_number: row[4],
      payment_purpose: `Wio international transfer ${row[4]}`,
      executed_at: enDate(row[5], row[6], row[7]) || fallbackDate,
    }, row[3]);
    return out;
  }

  return out;
}
