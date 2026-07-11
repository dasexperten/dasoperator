// =============================================================================
// Website carts — dasexperten.com abandoned-checkout capture (Phase 12.1)
//
// The Stripe checkout Worker `dasexperten-checkout` reaches the /quote step once
// the shopper has entered a shipping address and a delivery agent (NSS shipping
// option) is being chosen. At that point it has created an NSS *draft order* and
// knows email + recipient + line items — everything except payment. It POSTs
// that as an "initiated" cart to POST /api/crm/website/cart.
//
//   initiated  — /quote captured, no payment yet
//   converted  — a paid order with the same order_number was ingested
//   abandoned  — swept after N hours with no conversion, or superseded by a
//                re-quote (address edit → new draft → old draft cancelled)
//   recovered  — reserved for future win-back flows
//
// Join key is order_number (the NSS draft number), identical to what
// crm_orders.order_number stores for website orders. D1 only — the raw order
// JSON already lives under crm_orders/R2, a cart is a lightweight funnel row.
// =============================================================================

import type { Env } from '../types';

const now = () => Math.floor(Date.now() / 1000);

// -----------------------------------------------------------------------------
// DDL — single source shared by db/migrations/0061_crm_carts.sql and
// POST /admin/migrate/crm-carts. Pure IF NOT EXISTS, safe to re-run.
// -----------------------------------------------------------------------------
export const CRM_CARTS_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS crm_carts (
    id                    TEXT PRIMARY KEY,
    order_number          TEXT NOT NULL UNIQUE,
    status                TEXT NOT NULL DEFAULT 'initiated'
                          CHECK (status IN ('initiated','converted','abandoned','recovered')),
    email                 TEXT,
    phone                 TEXT,
    customer_name         TEXT,
    ship_country          TEXT,
    ship_city             TEXT,
    lang                  TEXT,
    currency              TEXT NOT NULL DEFAULT 'USD',
    subtotal_cents        INTEGER NOT NULL DEFAULT 0,
    items                 TEXT,
    stripe_payment_intent TEXT,
    initiated_at          INTEGER NOT NULL,
    converted_at          INTEGER,
    abandoned_at          INTEGER,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_crm_carts_status ON crm_carts(status, initiated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_crm_carts_email  ON crm_carts(email)`,
];

export interface CartItem {
  sku: string;
  name?: string | null;
  qty: number;
}

export interface CartInput {
  order_number: string;
  email?: string | null;
  phone?: string | null;
  customer_name?: string | null;
  ship_country?: string | null;
  ship_city?: string | null;
  lang?: string | null;
  currency?: string | null;
  subtotal_cents?: number | null;
  items?: CartItem[] | null;
}

function cleanItems(items: CartItem[] | null | undefined): CartItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && it.sku)
    .map((it) => ({
      sku: String(it.sku),
      name: it.name ? String(it.name) : null,
      qty: Math.max(1, Math.round(Number(it.qty) || 1)),
    }));
}

// -----------------------------------------------------------------------------
// upsertCart — idempotent on order_number. A cart already 'converted' is never
// pulled back to 'initiated' (a stray late /quote must not un-convert a paid
// order); other fields still refresh so the CRM shows the latest contact info.
// -----------------------------------------------------------------------------
export async function upsertCart(
  env: Env,
  input: CartInput
): Promise<{ action: 'created' | 'updated' | 'skipped'; id: string | null }> {
  const orderNumber = String(input.order_number ?? '').trim();
  if (!orderNumber) return { action: 'skipped', id: null };

  const ts = now();
  const items = cleanItems(input.items);
  const currency = (input.currency ?? 'USD').toUpperCase();
  const subtotal = Math.max(0, Math.round(Number(input.subtotal_cents) || 0));

  const existing = await env.DB.prepare(
    'SELECT id, status FROM crm_carts WHERE order_number = ?'
  )
    .bind(orderNumber)
    .first<{ id: string; status: string }>();

  if (existing) {
    // Keep a converted/recovered cart's terminal status; only refresh details.
    const keepStatus = existing.status === 'converted' || existing.status === 'recovered';
    await env.DB.prepare(
      `UPDATE crm_carts SET
         status = ${keepStatus ? 'status' : "'initiated'"},
         email = COALESCE(?, email),
         phone = COALESCE(?, phone),
         customer_name = COALESCE(?, customer_name),
         ship_country = COALESCE(?, ship_country),
         ship_city = COALESCE(?, ship_city),
         lang = COALESCE(?, lang),
         currency = ?,
         subtotal_cents = ?,
         items = ?,
         updated_at = ?
       WHERE id = ?`
    )
      .bind(
        input.email ?? null,
        input.phone ?? null,
        input.customer_name ?? null,
        input.ship_country ?? null,
        input.ship_city ?? null,
        input.lang ?? null,
        currency,
        subtotal,
        JSON.stringify(items),
        ts,
        existing.id
      )
      .run();
    return { action: 'updated', id: existing.id };
  }

  const id = 'cart_' + crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO crm_carts
       (id, order_number, status, email, phone, customer_name, ship_country,
        ship_city, lang, currency, subtotal_cents, items, initiated_at,
        created_at, updated_at)
     VALUES (?, ?, 'initiated', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      orderNumber,
      input.email ?? null,
      input.phone ?? null,
      input.customer_name ?? null,
      input.ship_country ?? null,
      input.ship_city ?? null,
      input.lang ?? null,
      currency,
      subtotal,
      JSON.stringify(items),
      ts,
      ts,
      ts
    )
    .run();
  return { action: 'created', id };
}

// -----------------------------------------------------------------------------
// markCartConverted — called from ingestPaymentIntent when a NEW paid order is
// created. Flips the matching cart (by order_number) to 'converted'. No-op when
// the cart doesn't exist (direct order without a captured /quote) or is already
// converted. Never throws back into the order ingest path.
// -----------------------------------------------------------------------------
export async function markCartConverted(
  env: Env,
  orderNumber: string,
  stripePaymentIntent?: string | null
): Promise<boolean> {
  const on = String(orderNumber ?? '').trim();
  if (!on) return false;
  try {
    const r = await env.DB.prepare(
      `UPDATE crm_carts
         SET status = 'converted', converted_at = ?, stripe_payment_intent = COALESCE(?, stripe_payment_intent), updated_at = ?
       WHERE order_number = ? AND status != 'converted'`
    )
      .bind(now(), stripePaymentIntent ?? null, now(), on)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  } catch {
    return false; // missing table before migration must not break ingest
  }
}

// -----------------------------------------------------------------------------
// markCartAbandoned — supersede a specific cart (e.g. the shopper edited the
// address, the Worker cancelled the old NSS draft and quoted a new one).
// -----------------------------------------------------------------------------
export async function markCartAbandoned(env: Env, orderNumber: string): Promise<boolean> {
  const on = String(orderNumber ?? '').trim();
  if (!on) return false;
  try {
    const r = await env.DB.prepare(
      `UPDATE crm_carts SET status = 'abandoned', abandoned_at = ?, updated_at = ?
       WHERE order_number = ? AND status = 'initiated'`
    )
      .bind(now(), now(), on)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// sweepAbandoned — hourly cron. Flips 'initiated' carts older than olderThanSec
// with no conversion to 'abandoned'. Returns how many it swept.
// -----------------------------------------------------------------------------
export async function sweepAbandoned(env: Env, olderThanSec: number): Promise<number> {
  try {
    const cutoff = now() - Math.max(0, olderThanSec);
    const r = await env.DB.prepare(
      `UPDATE crm_carts SET status = 'abandoned', abandoned_at = ?, updated_at = ?
       WHERE status = 'initiated' AND initiated_at < ?`
    )
      .bind(now(), now(), cutoff)
      .run();
    return r.meta?.changes ?? 0;
  } catch {
    return 0;
  }
}
