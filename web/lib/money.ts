// =============================================================================
// Money helpers — Das Operator ERP currency unit conventions
// =============================================================================
//
// HARD RULE (do not violate):
//   ALL money columns in D1 store MINOR units, never decimal major units.
//
//   - USD / CNY / RUB / EUR / AED / AMD: cents (×100 of displayed value)
//   - VND / JPY / KRW:                    raw whole units (no subdivision)
//
//   Tables affected (non-exhaustive):
//     bank_transactions.amount
//     operations.total_amount
//     line_items.unit_price, line_total
//     payments.amount
//     agent_settlements outbound_/inbound_/variance_amount
//     stock_movements.cost_per_unit, product_prices.price
//
//   When in doubt, run a sanity check: if displayed value would be >1M USD,
//   >5M CNY, or >100M RUB, you have almost certainly forgotten to divide.
//
// Functions:
//   formatMinor(raw, ccy)   — raw DB value → "30,000.00 USD" (PREFERRED in UI)
//   fromMinor(raw, ccy)     — raw DB value → 30000           (use for math)
//   toMinor(major, ccy)     — 30000 → 3000000 (use BEFORE writing to D1)
//   formatMoney(major, ccy) — legacy formatter that assumes input is already
//                              a decimal value; use only when you already
//                              converted with fromMinor() or the source is
//                              not from D1 (e.g. user-entered, FX rate).
// =============================================================================

const ZERO_FRACTION_CURRENCIES = new Set(['VND', 'JPY', 'KRW']);

export function minorFactor(currency: string): number {
  return ZERO_FRACTION_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
}

export function fromMinor(minor: number, currency: string): number {
  return minor / minorFactor(currency);
}

export function toMinor(major: number, currency: string): number {
  return Math.round(major * minorFactor(currency));
}

export function formatMinor(
  minor: number | null | undefined,
  currency: string | null | undefined
): string {
  if (minor === null || minor === undefined) return '—';
  const cur = (currency || '').toUpperCase();
  const factor = minorFactor(cur);
  const value = minor / factor;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: factor === 1 ? 0 : 2,
    maximumFractionDigits: factor === 1 ? 0 : 2,
  }) + (cur ? ' ' + cur : '');
}

// LEGACY — assumes input is already decimal major-unit (kept for back-compat)
export function formatMoney(amount: number, currency: string): string {
  const isZeroDecimal = ZERO_FRACTION_CURRENCIES.has(currency.toUpperCase());
  const fractionDigits = isZeroDecimal ? 0 : 2;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}
