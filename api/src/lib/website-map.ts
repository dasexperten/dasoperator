/**
 * Pure mapping functions: Stripe objects → ERP row shapes.
 *
 * No Env, no D1, no fetch — everything here is deterministic and unit-tested
 * in website-map.test.ts. SKU matching against the ERP catalog happens in the
 * caller (website-pull.ts), which passes in the set of known product ids;
 * these functions only normalize and carry the raw SKU so an unmatched SKU is
 * recorded as data (product_id = null), never thrown.
 */

// ---- Stripe object shapes (only the fields we read) ------------------------

export interface StripePrice {
  id: string;
  unit_amount: number | null;
  currency: string;
  active?: boolean;
  product?: string | { id: string; name?: string; metadata?: Record<string, string> };
  metadata?: Record<string, string>;
}

export interface StripeProduct {
  id: string;
  name?: string;
  active?: boolean;
  metadata?: Record<string, string>;
}

export interface StripeLineItem {
  id?: string;
  description?: string;
  quantity?: number | null;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  price?: StripePrice | null;
}

export interface StripeCheckoutSession {
  id: string;
  created: number;
  status?: string | null;
  payment_status?: string | null;
  currency?: string | null;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  total_details?: {
    amount_discount?: number | null;
    amount_shipping?: number | null;
    amount_tax?: number | null;
  } | null;
  customer_details?: {
    email?: string | null;
    name?: string | null;
    address?: { country?: string | null } | null;
  } | null;
  shipping_details?: { address?: { country?: string | null } | null } | null;
  collected_information?: { shipping_details?: { address?: { country?: string | null } | null } | null } | null;
  payment_intent?: string | { id: string } | null;
  line_items?: { data?: StripeLineItem[] } | null;
}

// ---- Helpers ---------------------------------------------------------------

/** Normalize a SKU to the ERP catalog convention (products.id is lowercase). */
export function normalizeSku(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  return s.length ? s : null;
}

/** Extract a plain id from a field that Stripe returns as string or object. */
function idOf(v: string | { id: string } | null | undefined): string | null {
  if (v == null) return null;
  return typeof v === 'string' ? v : v.id ?? null;
}

function intOr0(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

/** Resolve the SKU for a line: prefer price metadata, fall back to product metadata. */
function skuFromPrice(price: StripePrice | null | undefined): string | null {
  if (!price) return null;
  const fromPrice = price.metadata?.sku;
  if (fromPrice) return normalizeSku(fromPrice);
  if (price.product && typeof price.product === 'object') {
    return normalizeSku(price.product.metadata?.sku);
  }
  return null;
}

function productIdOf(price: StripePrice | null | undefined): string | null {
  if (!price) return null;
  if (typeof price.product === 'string') return price.product;
  if (price.product && typeof price.product === 'object') return price.product.id ?? null;
  return null;
}

// ---- Row shapes ------------------------------------------------------------

export interface WebsiteOrderRow {
  id: string;
  source: string;
  number: string | null;
  created_date: number;
  status: string | null;
  payment_status: string | null;
  currency: string;
  amount_subtotal: number;
  amount_shipping: number;
  amount_tax: number;
  amount_discount: number;
  amount_total: number;
  buyer_email: string | null;
  buyer_name: string | null;
  ship_country: string | null;
  payment_intent: string | null;
}

export interface WebsiteOrderLineRow {
  id: string;
  order_id: string;
  stripe_price_id: string | null;
  stripe_product_id: string | null;
  sku_raw: string | null;
  qty: number;
  unit_amount: number;
  line_total: number;
  item_name: string | null;
}

export interface WebsiteProductRow {
  stripe_price_id: string;
  stripe_product_id: string;
  sku_raw: string | null;
  name: string | null;
  unit_amount: number | null;
  currency: string;
  active: number;
}

// ---- Mappers ---------------------------------------------------------------

/** Map a Stripe Checkout Session to the website_orders row shape. */
export function mapOrder(s: StripeCheckoutSession): WebsiteOrderRow {
  const shipCountry =
    s.shipping_details?.address?.country ??
    s.collected_information?.shipping_details?.address?.country ??
    s.customer_details?.address?.country ??
    null;
  return {
    id: s.id,
    source: 'stripe',
    number: idOf(s.payment_intent ?? null),
    created_date: intOr0(s.created),
    status: s.status ?? null,
    payment_status: s.payment_status ?? null,
    currency: (s.currency ?? 'usd').toUpperCase(),
    amount_subtotal: intOr0(s.amount_subtotal),
    amount_shipping: intOr0(s.total_details?.amount_shipping),
    amount_tax: intOr0(s.total_details?.amount_tax),
    amount_discount: intOr0(s.total_details?.amount_discount),
    amount_total: intOr0(s.amount_total),
    buyer_email: s.customer_details?.email ?? null,
    buyer_name: s.customer_details?.name ?? null,
    ship_country: shipCountry,
    payment_intent: idOf(s.payment_intent ?? null),
  };
}

/**
 * Map a session's expanded line items to website_order_lines rows.
 * `known` is the set of ERP product ids (lowercase); an unmatched SKU keeps
 * product_id = null. Line id is deterministic: `${orderId}_${index}`.
 */
export function mapOrderLines(
  s: StripeCheckoutSession,
  known: Set<string>
): Array<WebsiteOrderLineRow & { product_id: string | null }> {
  const items = s.line_items?.data ?? [];
  return items.map((li, idx) => {
    const skuRaw = skuFromPrice(li.price);
    const productId = skuRaw && known.has(skuRaw) ? skuRaw : null;
    const qty = li.quantity ?? 1;
    const lineTotal = intOr0(li.amount_total);
    const unit = intOr0(li.price?.unit_amount) || (qty ? Math.round(lineTotal / qty) : lineTotal);
    return {
      id: `${s.id}_${idx}`,
      order_id: s.id,
      stripe_price_id: li.price?.id ?? null,
      stripe_product_id: productIdOf(li.price),
      sku_raw: skuRaw,
      product_id: productId,
      qty,
      unit_amount: unit,
      line_total: lineTotal,
      item_name: li.description ?? null,
    };
  });
}

/**
 * Map a Stripe Price (with its Product looked up via `productById`) to the
 * website_products row shape. `known` matches the SKU to the ERP catalog.
 */
export function mapPrice(
  price: StripePrice,
  productById: Map<string, StripeProduct>,
  known: Set<string>
): WebsiteProductRow & { product_id: string | null } {
  const prodId = productIdOf(price) ?? '';
  const product = productById.get(prodId);
  const skuRaw =
    normalizeSku(price.metadata?.sku) ?? normalizeSku(product?.metadata?.sku);
  const productId = skuRaw && known.has(skuRaw) ? skuRaw : null;
  return {
    stripe_price_id: price.id,
    stripe_product_id: prodId,
    sku_raw: skuRaw,
    product_id: productId,
    name: product?.name ?? null,
    unit_amount: typeof price.unit_amount === 'number' ? price.unit_amount : null,
    currency: (price.currency ?? 'usd').toUpperCase(),
    active: price.active === false ? 0 : 1,
  };
}
