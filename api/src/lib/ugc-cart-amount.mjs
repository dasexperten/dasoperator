/** Reuse a read basket only while its exact image is still the newest attachment.
 * Owner 2026-11-06: requisites must not discard the amount already read by ERP. */
export function confirmedCartAmount(imageCheck, latestImageAt) {
  const check = imageCheck?.checks?.at(-1);
  if (!latestImageAt || imageCheck?.status !== 'yes' || check?.kind !== 'basket'
    || check.product !== 'yes' || check.amount !== 'yes' || check.seller === 'no'
    || (check.unresolved_required ?? []).some(field => field !== 'seller')) return null;
  const sourceAt = check.label?.match(/сообщения (\S+), вложение/)?.[1];
  if (!sourceAt || sourceAt !== latestImageAt) return null;
  if (!/^(RUB|₽|руб\.?|рублей)$/iu.test(check.observed?.currency?.trim() ?? '')) return null;
  const price = String(check.observed?.price ?? '').trim().replace(/\s/gu, '').replace(/(?:₽|RUB|руб\.?|рублей)$/iu, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(price)) return null;
  const minor = Math.round(Number(price) * 100);
  return minor >= 5000 && minor <= 99900 ? minor : null;
}
