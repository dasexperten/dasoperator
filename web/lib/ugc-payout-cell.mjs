// «Оплата» cell on /ugc (Owner 2026-10-14): a solid rectangle with the amount.
// Green only when paid; red for every other state, and for no payout at all.
// The status name lives in the hover title only.

export const PAYOUT_STATUS_LABEL = {
  none: 'Unpaid',
  awaiting_approval: 'Ждёт одобрения',
  approved: 'Одобрено',
  sent: 'Отправлено',
  paid: 'Paid',
  failed: 'Ошибка',
};

/** Roubles with a non-breaking space before the sign (§4h-2). */
export function formatRub(minor) {
  if (minor == null || !Number.isFinite(Number(minor))) return '';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(minor) / 100)} ₽`;
}

export function payoutCell(payout) {
  if (!payout) return { tone: 'red', text: '—', title: PAYOUT_STATUS_LABEL.none };
  const status = payout.status in PAYOUT_STATUS_LABEL ? payout.status : 'none';
  return {
    tone: status === 'paid' ? 'green' : 'red',
    text: formatRub(payout.amount_minor) || '—',
    title: PAYOUT_STATUS_LABEL[status],
  };
}
