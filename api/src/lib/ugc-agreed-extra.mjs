// Owner 2026-11-13 (lona.lnk): a blogger asks for an extra amount — «2000 рублей», «доплатите 500» —
// and the Owner answers in the chat «Мы согласны». That agreement is an order: the ERP puts a payout
// button for exactly that amount, on the details of her earlier paid payout. The Owner still clicks.
const AGREE = /(?:^|[\s,.!])(?:мы\s+)?согласн(?:ы|а|ен)(?=$|[\s,.!])/i;
// Her message must ask for extra money, not quote a cart price.
const EXTRA_ASK = /стоимост|гонорар|доплат|сверху|дополнительн|за\s+(?:ролик|видео|съ[её]мк|монтаж|работу|рекламу|сценари)|оплатите|хочу|прошу|мой\s+прайс|моя\s+цена|комфортн/i;
const MONEY = /(\d{1,3}(?:[\s ]?\d{3})*|\d+)\s*(?:₽|р\.|р\b|руб\S*|тыс\S*)/gi;
const PAID_NOTICE = /перевел\S*\s+(?:вам\s+)?(\d[\d\s]*)\s*(?:₽|руб)/i;
const WINDOW_MS = 7 * 86400000;
const at = m => Date.parse(m.created_at);

function amountsIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(MONEY)) {
    let n = Number(m[1].replace(/[\s ]/g, ''));
    if (/тыс/i.test(m[0])) n *= 1000;
    if (Number.isFinite(n) && n >= 100 && n <= 2999) out.push(n);
  }
  return out;
}

/** The newest Owner agreement to a blogger's extra amount that has not been paid yet, or null. */
export function agreedExtra(rows) {
  const all = (rows ?? []).filter(m => Number.isFinite(at(m))).sort((a, b) => at(a) - at(b));
  for (let i = all.length - 1; i >= 0; i--) {
    const ok = all[i];
    const text = String(ok.text ?? '');
    if (ok.direction !== 'out' || text.length > 160 || /\?/.test(text)) continue;
    const own = amountsIn(text).at(-1) ?? null;
    // Only the Owner's word «согласны» is an agreement; Diana's «договорились» about dates is not.
    if (!AGREE.test(text)) continue;
    // The amount: named in our agreement itself, or the last extra amount she asked for just before it.
    let amount = own, ask = null;
    if (!amount) {
      for (let j = i - 1; j >= 0 && at(all[j]) >= at(ok) - WINDOW_MS; j--) {
        if (all[j].direction === 'out' && AGREE.test(String(all[j].text ?? ''))) break;
        if (all[j].direction !== 'in') continue;
        const found = EXTRA_ASK.test(String(all[j].text ?? '')) ? amountsIn(all[j].text).at(-1) : null;
        if (found) { amount = found; ask = all[j]; break; }
      }
    }
    if (!amount) continue;
    const paid = all.slice(i + 1).some(m => m.direction === 'out' && Number(String(m.text ?? '').match(PAID_NOTICE)?.[1]?.replace(/\s/g, '')) === amount);
    if (paid) return null;
    return { amount_minor: amount * 100, agreed_at: at(ok), agreement_message_id: ok.id, ask_message_id: ask?.id ?? null };
  }
  return null;
}
