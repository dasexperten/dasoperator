// =============================================================================
// Money formatting — values are decimal major units (e.g. 690.50 RUB, 1234.56 USD).
// VND/JPY/KRW have no subdivision, so they render with 0 fraction digits.
// =============================================================================

export function formatMoney(amount: number, currency: string): string {
  const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(currency);
  const fractionDigits = isZeroDecimal ? 0 : 2;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}
