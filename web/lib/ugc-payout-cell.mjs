// «Оплата» cell on /ugc. Colours (Owner 2026-10-15, overrides 2026-10-14):
//   GREEN — «Оплата сделана»: paid AND an executed Konsol payment is linked
//           (konsol_payment_id present). Nothing else is ever green.
//   BROWN — the creator sent requisites (phone, bank, name) and the payout row
//           exists, not yet paid: «если блогер отправил нам свои координаты…
//           пометить коричневым цветом, не зеленым».
//   GREY  — no requisites yet («ждёт реквизитов»), or no payout at all.
//   RED   — failed / refused, and «Отправлено» without a Konsol id older than
//           2 days (the money did not go through Konsol and nobody noticed).
// A short reason sits under the amount, so an unpaid row never reads as paid.

export const PAYOUT_STATUS_LABEL = {
  none: 'Нет выплаты',
  // Not «ждёт одобрения»: payouts within the limits are auto-approved, the row
  // is waiting to be paid, not waiting for the Owner (Owner 2026-10-15).
  awaiting_approval: 'К оплате',
  approved: 'К оплате',
  sent: 'Отправлено',
  paid: 'Оплачено',
  failed: 'Не прошла',
};

export const STALE_SENT_MS = 2 * 24 * 3600_000;

/** Roubles as one figure (Owner 2026-10-14: «1527 ₽»), non-breaking space before the sign (§4h-2). */
export function formatRub(minor) {
  if (minor == null || !Number.isFinite(Number(minor))) return '';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, useGrouping: false }).format(Number(minor) / 100)} ₽`;
}

function ms(value) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(String(value).length === 10 ? `${value}T00:00:00Z` : String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/** True when the payout is really paid: executed in Konsol, with its id. */
export function isKonsolPaid(payout) {
  return Boolean(payout && payout.status === 'paid' && payout.konsol_payment_id);
}

/** «Отправлено» with no Konsol payment, older than 2 days. */
export function isStaleSent(payout, now = Date.now()) {
  if (!payout || payout.status !== 'sent' || payout.konsol_payment_id) return false;
  const at = ms(payout.sent_at) ?? ms(payout.payout_date);
  return at != null && now - at > STALE_SENT_MS;
}

export function payoutCell(payout, now = Date.now()) {
  if (!payout) return { tone: 'grey', text: '—', reason: '', title: PAYOUT_STATUS_LABEL.none };
  const amount = formatRub(payout.amount_minor) || '—';
  const label = PAYOUT_STATUS_LABEL[payout.status] ?? PAYOUT_STATUS_LABEL.none;
  const out = (tone, reason) => ({ tone, text: amount, reason, title: [tone === 'green' ? 'Оплата сделана' : 'Не оплачено', tone === 'green' ? '' : reason].filter(Boolean).join(' · ') });

  if (isKonsolPaid(payout)) return out('green', 'оплата сделана');
  if (payout.status === 'failed') return out('red', payout.konsol_payment_id ? 'отказ' : 'не исполнено в Консоли');
  if (isStaleSent(payout, now)) return out('red', 'не исполнено в Консоли');
  if ((payout.status === 'sent' || payout.status === 'paid') && !payout.konsol_payment_id) {
    return out(payout.has_requisites ? 'brown' : 'grey', 'не исполнено в Консоли');
  }
  if (payout.over_limit) return out(payout.has_requisites ? 'brown' : 'grey', 'сверх лимита');
  if (!payout.has_requisites) return out('grey', 'ждёт реквизитов');
  if (payout.status === 'sent') return out('brown', 'в Консоли, ждёт исполнения');
  return { ...out('brown', label.toLowerCase()) };
}

// «Оплатить» (Owner 2026-10-15): the Owner pays by hand from /ugc. The button
// shows only to Admin, only on a brown badge: requisites in, within the limits,
// not yet handed to Konsol. Nothing here pays — the click goes to
// POST /api/ugc/payouts/:id/execute after the Owner confirms.
export function canPay(payout) {
  if (!payout || payout.konsol_payment_id) return false;
  if (payout.status !== 'awaiting_approval' && payout.status !== 'approved') return false;
  return Boolean(payout.has_requisites) && !payout.over_limit;
}

/** Confirm text: nick, amount, bank, last two phone digits — never the full phone. */
export function payConfirmText(payout, handle) {
  const digits = String(payout?.phone_masked ?? '').replace(/\D/g, '');
  const last2 = digits.length >= 2 ? digits.slice(-2) : '??';
  const nick = handle ? `@${String(handle).replace(/^@/, '')}` : 'блогер';
  const bank = payout?.bank_ref || (payout?.fps_bank_member_id ? `банк ${payout.fps_bank_member_id}` : 'банк не указан');
  return `Оплатить через Консоль?\n\n${nick}\n${formatRub(payout?.amount_minor)}\n${bank}\nтелефон …${last2}`;
}
