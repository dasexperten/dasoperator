/** Seller API promotion reads: v2 Money and cursor pagination. Never writes prices. */
export function moneyRub(value: unknown): number | undefined {
  if (value == null) return undefined;
  let amount = value;
  if (typeof value === 'object') {
    const money = value as { amount?: unknown; currency?: unknown };
    if (money.currency !== 'RUB' && money.currency !== '') throw new Error('Ozon promotion Money currency must be RUB');
    amount = money.amount;
  }
  if ((typeof amount !== 'number' && typeof amount !== 'string') || amount === '' ||
      !/^\d+(\.\d+)?$/.test(String(amount))) throw new Error('Invalid Ozon promotion Money amount');
  const number = Number(amount);
  if (!Number.isFinite(number) || number < 0) throw new Error('Invalid Ozon promotion price');
  return number;
}

export function normalizeActionProduct(product: Record<string, unknown>) {
  const normalized = { ...product };
  for (const key of ['price', 'action_price', 'max_action_price', 'marketplace_seller_price',
    'min_seller_price', 'alert_max_action_price', 'price_min_elastic', 'price_max_elastic']) {
    normalized[`${key}_money`] = product[key];
    normalized[key] = moneyRub(product[key]);
  }
  normalized.currency_is_explicit_rub = typeof product.action_price === 'object' && (product.action_price as any)?.currency === 'RUB';
  normalized.add_mode_raw = product.add_mode;
  // SELLER is the v2 manual membership value. AUTO with stock=0 remains enrolled.
  if (normalized.add_mode === 'SELLER') normalized.add_mode = 'MANUAL';
  return normalized;
}

export async function readActionProducts(
  request: (path: string, body: unknown) => Promise<any>,
  actionId: number, candidates = false,
) {
  const path = candidates ? '/v2/actions/candidates' : '/v2/actions/products';
  const products: Record<string, unknown>[] = [];
  const ids = new Set<number>();
  const seen = new Set<string>();
  let lastId = '';
  for (let page = 0; page < 100; page++) {
    const response = await request(path, { action_id: actionId, limit: 100, last_id: lastId });
    const data = response.result ?? response;
    if (!Array.isArray(data.products)) throw new Error(`Ozon ${path}: missing products`);
    for (const raw of data.products) {
      if (!Number.isSafeInteger(raw.id) || ids.has(raw.id)) throw new Error('Ozon promotion product id invalid/duplicated');
      ids.add(raw.id);
      products.push(normalizeActionProduct(raw));
    }
    const complete = () => {
      if (typeof data.total === 'number' && products.length < data.total) throw new Error('Ozon promotion membership truncated');
      return products;
    };
    // Live v2 returns an empty terminal page echoing the previous cursor.
    if (data.products.length === 0) return complete();
    const next = data.last_id;
    if (next == null || next === '') return complete();
    if (typeof next !== 'string' || seen.has(next)) throw new Error('Ozon promotion cursor repeated/invalid');
    seen.add(next);
    lastId = next;
  }
  throw new Error('Ozon promotion pagination exceeded safety limit');
}

// Legacy stock/refill/rejoin controls echo prices. After this cutover an echo
// changes the card ceiling; deactivate is voucher-only. Do not guess a price
// to remove elastic/stock actions or silently convert a stock edit into a discount.
export class PromotionMigrationError extends Error {}

export class PromotionInputError extends Error {}

/** An explicit input, never a candidate-price fallback or echoed stock price. */
export function explicitPriceLimit(input: { price_limit?: unknown; confirm_card_price_limit?: unknown }) {
  if (input.confirm_card_price_limit !== true) {
    throw new PromotionInputError('Confirm the card price effect: from 13 October this limit also changes the card price ceiling and may change promotion membership.');
  }
  const text = String(input.price_limit ?? '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new PromotionInputError('Enter an explicit positive RUB price limit with at most two decimal places.');
  const amount = Number(text);
  if (amount <= 0 || !Number.isSafeInteger(Math.round(amount * 100))) throw new PromotionInputError('Invalid price limit.');
  return { amount: amount.toFixed(2), currency: 'RUB' };
}

export function assertPromotionFloor(amount: string, minimum: number | null | undefined) {
  // Owner 18.07: Dasha LEARNING DK-LAW-260718-04 / DK-HARD-260718-01;
  // price.min_price from v5, not v2 min_seller_price or the candidate maximum.
  if (minimum == null || !Number.isFinite(minimum) || minimum <= 0) {
    throw new PromotionInputError('Seller min_price is unknown; no price limit was sent. Load the actual minimum first.');
  }
  const priceCents = Math.round(Number(amount) * 100);
  const minCents = Math.round(minimum * 100);
  if (priceCents * 100 < minCents * 80) {
    throw new PromotionInputError('Price limit is below 80% of seller min_price (Owner rule DK-LAW-260718-04). A deeper price needs Justina and Owner; no limit was sent.');
  }
  return priceCents < minCents;
}

export function promotionUpdateOutcome(response: any, productId: number) {
  const data = response.result ?? response;
  if (!Array.isArray(data.active_product_ids) || !Array.isArray(data.deactivated_product_ids) || !Array.isArray(data.rejected)) {
    throw new Error('Ozon update confirmation is incomplete. The outcome is unknown; refresh before any retry.');
  }
  const active = data.active_product_ids.includes(productId);
  const deactivated = data.deactivated_product_ids.includes(productId);
  const rejected = data.rejected.filter((item: any) => Number(item.product_id ?? item.id) === productId);
  if (active === deactivated && !rejected.length) throw new Error('Ozon did not confirm this product outcome. Refresh before any retry.');
  if ((active || deactivated) && rejected.length) throw new Error('Ozon returned contradictory product outcomes. Refresh before any retry.');
  return {
    membership: rejected.length ? 'rejected' : active ? 'active' : 'deactivated',
    active_product_ids: data.active_product_ids,
    deactivated_product_ids: data.deactivated_product_ids,
    rejected: data.rejected,
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
  };
}

export function assertLegacyPromotionWriteSafe(path: string, now = Date.now()) {
  if (['/v1/actions/products/activate', '/v1/actions/products/deactivate'].includes(path) &&
      now >= Date.parse('2026-10-13T00:00:00+03:00')) {
    throw new PromotionMigrationError('Ozon changed promotion price semantics on 13 October: this legacy control is disabled. Use Set explicit limit with the agreed numeric price; no price or membership was changed by ERP.');
  }
}
