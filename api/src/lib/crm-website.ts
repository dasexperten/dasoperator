// =============================================================================
// Website CRM — dasexperten.com orders → D1 + R2 customer database (Phase 12.0)
//
// Order source is the Stripe checkout Worker `dasexperten-checkout` (.com/.de
// storefront). That Worker is NOT in this repo, so ingestion talks to Stripe
// directly and never depends on the checkout code:
//   1. POST /api/crm/website/webhook/stripe  — payment_intent.succeeded (live)
//   2. hourly reconciliation poller          — lists PaymentIntents since the
//      crm_sync_state cursor, catches anything the webhook missed
// Both paths converge on upsertWebsiteOrder(), which is idempotent by
// stripe_payment_intent / (source, order_number).
//
// The checkout Worker stores order data on the PaymentIntent itself:
//   metadata: order_number (NSS draft), email, items, subtotal_cents,
//             fee_cents (shipping), lang        + pi.shipping = ship-to
// (see dasexperten.com/BACKLOGS/2026-07-03_order-confirmation-emails.md).
// Every metadata key is parsed defensively — a missing key degrades a field,
// never drops the order.
//
// Storage split (ADR-001): D1 = queryable CRM rows, R2 (CUSTOMERS_DB =
// das-loyalty-customers, keys under crm/) = raw JSON snapshot of every order
// and customer for replay/audit. R2 writes are best-effort: a missing binding
// or R2 hiccup never fails an ingest.
// =============================================================================

import type { Env } from '../types';
import { normalizePhone } from './loyalty';

// -----------------------------------------------------------------------------
// DDL — single source shared by db/migrations/0060_crm_website.sql and
// POST /admin/migrate/crm-website. Pure IF NOT EXISTS, safe to re-run.
// -----------------------------------------------------------------------------
export const CRM_WEBSITE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS crm_customers (
    id                TEXT PRIMARY KEY,
    email             TEXT UNIQUE,
    phone             TEXT,
    first_name        TEXT,
    last_name         TEXT,
    company           TEXT,
    country_code      TEXT,
    state_code        TEXT,
    city              TEXT,
    zip               TEXT,
    address1          TEXT,
    address2          TEXT,
    lang              TEXT,
    marketing_consent INTEGER NOT NULL DEFAULT 0,
    tags              TEXT,
    notes             TEXT,
    source            TEXT NOT NULL DEFAULT 'website'
                      CHECK (source IN ('website','wix','retailcrm','manual')),
    external_ids      TEXT,
    orders_count      INTEGER NOT NULL DEFAULT 0,
    total_spent_cents INTEGER NOT NULL DEFAULT 0,
    currency          TEXT NOT NULL DEFAULT 'USD',
    first_order_at    INTEGER,
    last_order_at     INTEGER,
    r2_key            TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_crm_customers_phone  ON crm_customers(phone)`,
  `CREATE INDEX IF NOT EXISTS idx_crm_customers_source ON crm_customers(source)`,
  `CREATE INDEX IF NOT EXISTS idx_crm_customers_spent  ON crm_customers(total_spent_cents)`,
  `CREATE TABLE IF NOT EXISTS crm_orders (
    id                   TEXT PRIMARY KEY,
    source               TEXT NOT NULL DEFAULT 'website'
                         CHECK (source IN ('website','wix','manual')),
    order_number         TEXT NOT NULL,
    stripe_payment_intent TEXT,
    customer_id          TEXT REFERENCES crm_customers(id),
    customer_name        TEXT,
    email                TEXT,
    phone                TEXT,
    currency             TEXT NOT NULL DEFAULT 'USD',
    subtotal_cents       INTEGER NOT NULL DEFAULT 0,
    shipping_cents       INTEGER NOT NULL DEFAULT 0,
    discount_cents       INTEGER NOT NULL DEFAULT 0,
    tax_cents            INTEGER NOT NULL DEFAULT 0,
    total_cents          INTEGER NOT NULL DEFAULT 0,
    financial_status     TEXT NOT NULL DEFAULT 'paid'
                         CHECK (financial_status IN ('pending','paid','partially_refunded','refunded','failed')),
    fulfillment_status   TEXT NOT NULL DEFAULT 'submitted'
                         CHECK (fulfillment_status IN ('unfulfilled','submitted','shipped','delivered','cancelled')),
    payment_method       TEXT,
    lang                 TEXT,
    ship_name            TEXT,
    ship_country         TEXT,
    ship_state           TEXT,
    ship_city            TEXT,
    ship_zip             TEXT,
    ship_address1        TEXT,
    ship_address2        TEXT,
    shipping_method      TEXT,
    tracking_number      TEXT,
    tracking_url         TEXT,
    items                TEXT,
    raw_r2_key           TEXT,
    placed_at            INTEGER,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_orders_source_number
     ON crm_orders(source, order_number)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_orders_pi
     ON crm_orders(stripe_payment_intent) WHERE stripe_payment_intent IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_crm_orders_customer ON crm_orders(customer_id, placed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_crm_orders_placed   ON crm_orders(placed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_crm_orders_email    ON crm_orders(email)`,
  `CREATE TABLE IF NOT EXISTS crm_webhook_log (
    id         TEXT PRIMARY KEY,
    source     TEXT NOT NULL DEFAULT 'stripe',
    event_type TEXT,
    ref        TEXT,
    payload    TEXT,
    result     TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_crm_webhook_ref ON crm_webhook_log(ref, created_at)`,
  `CREATE TABLE IF NOT EXISTS crm_sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

// -----------------------------------------------------------------------------
// Canonical shapes
// -----------------------------------------------------------------------------
export interface CanonicalItem {
  sku: string;
  name?: string | undefined;
  qty: number;
  unit_cents?: number | undefined;
  total_cents?: number | undefined;
}

export interface CanonicalOrder {
  source: 'website' | 'wix' | 'manual';
  order_number: string;
  stripe_payment_intent?: string | null;
  customer_name?: string | null;
  email?: string | null;
  phone?: string | null;
  currency: string;
  subtotal_cents: number;
  shipping_cents: number;
  discount_cents?: number;
  tax_cents?: number;
  total_cents: number;
  financial_status: 'pending' | 'paid' | 'partially_refunded' | 'refunded' | 'failed';
  fulfillment_status?: 'unfulfilled' | 'submitted' | 'shipped' | 'delivered' | 'cancelled';
  payment_method?: string | null;
  lang?: string | null;
  ship_name?: string | null;
  ship_country?: string | null;
  ship_state?: string | null;
  ship_city?: string | null;
  ship_zip?: string | null;
  ship_address1?: string | null;
  ship_address2?: string | null;
  shipping_method?: string | null;
  items: CanonicalItem[];
  placed_at: number;
}

export interface CanonicalCustomer {
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  country_code?: string | null;
  state_code?: string | null;
  city?: string | null;
  zip?: string | null;
  address1?: string | null;
  address2?: string | null;
  lang?: string | null;
  marketing_consent?: boolean;
  tags?: string[];
  notes?: string | null;
  source: 'website' | 'wix' | 'retailcrm' | 'manual';
  external_ids?: Record<string, string | number>;
}

export function normEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase();
  return e.includes('@') ? e : null;
}

const now = () => Math.floor(Date.now() / 1000);

// -----------------------------------------------------------------------------
// R2 snapshot writes — best-effort, never throw into the ingest path
// -----------------------------------------------------------------------------
async function r2Put(env: Env, key: string, body: unknown): Promise<string | null> {
  if (!env.CUSTOMERS_DB) return null;
  try {
    await env.CUSTOMERS_DB.put(key, JSON.stringify(body, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });
    return key;
  } catch (e) {
    console.error(`[crm-website] R2 put failed for ${key}:`, e);
    return null;
  }
}

async function snapshotCustomer(env: Env, customerId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM crm_customers WHERE id = ?')
    .bind(customerId)
    .first<Record<string, unknown>>();
  if (!row) return;
  const key = `crm/customers/${customerId}.json`;
  const written = await r2Put(env, key, { snapshot_at: now(), customer: row });
  if (written && row.r2_key !== key) {
    await env.DB.prepare('UPDATE crm_customers SET r2_key = ? WHERE id = ?').bind(key, customerId).run();
  }
}

// -----------------------------------------------------------------------------
// Customer upsert
//
// Identity resolution order: email → phone. Website orders update contact +
// address fields; backfills (wix/retailcrm) only FILL GAPS on existing rows so
// live checkout data always wins over historical imports.
// -----------------------------------------------------------------------------
export async function upsertCustomer(
  env: Env,
  cust: CanonicalCustomer,
  opts: { fillOnly?: boolean } = {}
): Promise<{ id: string; created: boolean }> {
  const email = normEmail(cust.email);
  const phone = normalizePhone(cust.phone);
  const ts = now();

  let existing: { id: string; external_ids: string | null; tags: string | null } | null = null;
  if (email) {
    existing = await env.DB.prepare('SELECT id, external_ids, tags FROM crm_customers WHERE email = ?')
      .bind(email)
      .first();
  }
  if (!existing && phone) {
    existing = await env.DB.prepare('SELECT id, external_ids, tags FROM crm_customers WHERE phone = ?')
      .bind(phone)
      .first();
  }

  const extIds = cust.external_ids ?? {};
  const tags = cust.tags ?? [];

  if (existing) {
    const mergedExt = { ...(safeJson<Record<string, unknown>>(existing.external_ids) ?? {}), ...extIds };
    const mergedTags = Array.from(new Set([...(safeJson<string[]>(existing.tags) ?? []), ...tags]));
    if (opts.fillOnly) {
      // COALESCE(existing, incoming): imports never overwrite live checkout data
      await env.DB.prepare(
        `UPDATE crm_customers SET
           phone = COALESCE(phone, ?), email = COALESCE(email, ?),
           first_name = COALESCE(first_name, ?), last_name = COALESCE(last_name, ?),
           company = COALESCE(company, ?), country_code = COALESCE(country_code, ?),
           state_code = COALESCE(state_code, ?), city = COALESCE(city, ?),
           zip = COALESCE(zip, ?), address1 = COALESCE(address1, ?), address2 = COALESCE(address2, ?),
           lang = COALESCE(lang, ?), notes = COALESCE(notes, ?),
           external_ids = ?, tags = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(
          phone, email,
          cust.first_name ?? null, cust.last_name ?? null,
          cust.company ?? null, cust.country_code ?? null,
          cust.state_code ?? null, cust.city ?? null,
          cust.zip ?? null, cust.address1 ?? null, cust.address2 ?? null,
          cust.lang ?? null, cust.notes ?? null,
          JSON.stringify(mergedExt), JSON.stringify(mergedTags), ts,
          existing.id
        )
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE crm_customers SET
           phone = COALESCE(?, phone), email = COALESCE(?, email),
           first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
           country_code = COALESCE(?, country_code), state_code = COALESCE(?, state_code),
           city = COALESCE(?, city), zip = COALESCE(?, zip),
           address1 = COALESCE(?, address1), address2 = COALESCE(?, address2),
           lang = COALESCE(?, lang),
           external_ids = ?, tags = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(
          phone, email,
          cust.first_name ?? null, cust.last_name ?? null,
          cust.country_code ?? null, cust.state_code ?? null,
          cust.city ?? null, cust.zip ?? null,
          cust.address1 ?? null, cust.address2 ?? null,
          cust.lang ?? null,
          JSON.stringify(mergedExt), JSON.stringify(mergedTags), ts,
          existing.id
        )
        .run();
    }
    return { id: existing.id, created: false };
  }

  const id = 'cust_' + crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO crm_customers
       (id, email, phone, first_name, last_name, company, country_code, state_code,
        city, zip, address1, address2, lang, marketing_consent, tags, notes, source,
        external_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, email, phone,
      cust.first_name ?? null, cust.last_name ?? null, cust.company ?? null,
      cust.country_code ?? null, cust.state_code ?? null, cust.city ?? null,
      cust.zip ?? null, cust.address1 ?? null, cust.address2 ?? null,
      cust.lang ?? null, cust.marketing_consent ? 1 : 0,
      JSON.stringify(tags), cust.notes ?? null, cust.source,
      JSON.stringify(extIds), ts, ts
    )
    .run();
  return { id, created: true };
}

function safeJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Recompute lifetime aggregates from WEBSITE orders (refunded excluded).
// Idempotent by construction — re-ingesting the same order changes nothing.
async function recomputeCustomerAggregates(env: Env, customerId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE crm_customers SET
       orders_count = (SELECT COUNT(*) FROM crm_orders
                        WHERE customer_id = ?1 AND source = 'website'
                          AND financial_status IN ('paid','partially_refunded')),
       total_spent_cents = (SELECT COALESCE(SUM(total_cents), 0) FROM crm_orders
                             WHERE customer_id = ?1 AND source = 'website'
                               AND financial_status IN ('paid','partially_refunded')),
       first_order_at = (SELECT MIN(placed_at) FROM crm_orders WHERE customer_id = ?1),
       last_order_at  = (SELECT MAX(placed_at) FROM crm_orders WHERE customer_id = ?1),
       updated_at = ?2
     WHERE id = ?1`
  )
    .bind(customerId, now())
    .run();
}

// -----------------------------------------------------------------------------
// Order upsert — the single convergence point for webhook, poller and backfill
// -----------------------------------------------------------------------------
export async function upsertOrder(
  env: Env,
  order: CanonicalOrder,
  raw?: unknown
): Promise<{ action: 'created' | 'updated' | 'unchanged'; order_id: string; customer_id: string | null }> {
  const ts = now();
  const email = normEmail(order.email);
  const phone = normalizePhone(order.phone);

  // Resolve/create the customer first so the order row links immediately.
  let customerId: string | null = null;
  if (email || phone) {
    const nameParts = (order.ship_name ?? order.customer_name ?? '').trim().split(/\s+/);
    const cust = await upsertCustomer(
      env,
      {
        email,
        phone,
        first_name: nameParts[0] || null,
        last_name: nameParts.slice(1).join(' ') || null,
        country_code: order.ship_country ?? null,
        state_code: order.ship_state ?? null,
        city: order.ship_city ?? null,
        zip: order.ship_zip ?? null,
        address1: order.ship_address1 ?? null,
        address2: order.ship_address2 ?? null,
        lang: order.lang ?? null,
        source: order.source === 'wix' ? 'wix' : 'website',
      },
      { fillOnly: order.source !== 'website' }
    );
    customerId = cust.id;
  }

  const existing = await env.DB.prepare(
    order.stripe_payment_intent
      ? 'SELECT id, financial_status, fulfillment_status FROM crm_orders WHERE stripe_payment_intent = ?'
      : 'SELECT id, financial_status, fulfillment_status FROM crm_orders WHERE source = ? AND order_number = ?'
  )
    .bind(...(order.stripe_payment_intent ? [order.stripe_payment_intent] : [order.source, order.order_number]))
    .first<{ id: string; financial_status: string; fulfillment_status: string }>();

  let action: 'created' | 'updated' | 'unchanged';
  let orderId: string;

  if (existing) {
    orderId = existing.id;
    if (
      existing.financial_status === order.financial_status &&
      (!order.fulfillment_status || existing.fulfillment_status === order.fulfillment_status)
    ) {
      action = 'unchanged';
    } else {
      await env.DB.prepare(
        `UPDATE crm_orders SET financial_status = ?, fulfillment_status = COALESCE(?, fulfillment_status),
                customer_id = COALESCE(customer_id, ?), updated_at = ? WHERE id = ?`
      )
        .bind(order.financial_status, order.fulfillment_status ?? null, customerId, ts, orderId)
        .run();
      action = 'updated';
    }
  } else {
    orderId = 'ord_' + crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO crm_orders
         (id, source, order_number, stripe_payment_intent, customer_id, customer_name,
          email, phone, currency, subtotal_cents, shipping_cents, discount_cents,
          tax_cents, total_cents, financial_status, fulfillment_status, payment_method,
          lang, ship_name, ship_country, ship_state, ship_city, ship_zip,
          ship_address1, ship_address2, shipping_method, items, placed_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        orderId, order.source, order.order_number, order.stripe_payment_intent ?? null,
        customerId, order.customer_name ?? order.ship_name ?? null,
        email, phone, order.currency.toUpperCase(),
        order.subtotal_cents, order.shipping_cents, order.discount_cents ?? 0,
        order.tax_cents ?? 0, order.total_cents,
        order.financial_status, order.fulfillment_status ?? 'submitted',
        order.payment_method ?? null, order.lang ?? null,
        order.ship_name ?? null, order.ship_country ?? null, order.ship_state ?? null,
        order.ship_city ?? null, order.ship_zip ?? null,
        order.ship_address1 ?? null, order.ship_address2 ?? null,
        order.shipping_method ?? null,
        JSON.stringify(order.items ?? []), order.placed_at, ts, ts
      )
      .run();
    action = 'created';
  }

  if (customerId) {
    await recomputeCustomerAggregates(env, customerId);
  }

  // R2 raw archive — the replayable source of truth for this order
  const r2Key = `crm/orders/${order.source}/${order.order_number}.json`;
  const written = await r2Put(env, r2Key, {
    snapshot_at: ts,
    order,
    customer_id: customerId,
    raw: raw ?? null,
  });
  if (written && action !== 'unchanged') {
    await env.DB.prepare('UPDATE crm_orders SET raw_r2_key = ? WHERE id = ?').bind(r2Key, orderId).run();
  }
  if (customerId) {
    await snapshotCustomer(env, customerId);
  }

  return { action, order_id: orderId, customer_id: customerId };
}

// -----------------------------------------------------------------------------
// Stripe API client (raw fetch — no SDK in Workers)
// -----------------------------------------------------------------------------
const STRIPE_BASE = 'https://api.stripe.com/v1';

async function stripeGet<T = any>(env: Env, path: string, params: Record<string, string>): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not configured');
  const url = new URL(`${STRIPE_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) throw new Error(`Stripe ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

// Stripe-Signature verification (t=…,v1=…) — WebCrypto HMAC-SHA256, 5 min tolerance.
export async function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secret: string
): Promise<boolean> {
  if (!header) return false;
  const parts = new Map(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1)] as [string, string];
    })
  );
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (!t || !v1) return false;
  const age = Math.abs(now() - Number(t));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// -----------------------------------------------------------------------------
// PaymentIntent → CanonicalOrder
// -----------------------------------------------------------------------------
function metaInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// metadata.items is whatever the checkout Worker serialized. Expected JSON
// [{sku,qty}]; tolerate "DE201x2,DE205x1" style strings as a fallback.
export function parseItemsMeta(raw: unknown): CanonicalItem[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((it: any) => it && (it.sku || it.name))
      .map((it: any) => ({
        sku: String(it.sku ?? it.name),
        name: it.name && it.sku ? String(it.name) : undefined,
        qty: Math.max(1, Number(it.qty ?? it.quantity ?? 1) || 1),
        unit_cents: metaInt(it.unit_cents ?? it.cents) ?? undefined,
      }));
  }
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const parsed = safeJson<unknown>(raw);
  if (parsed) return parseItemsMeta(parsed);
  const items: CanonicalItem[] = [];
  for (const chunk of raw.split(/[,;]+/)) {
    const m = chunk.trim().match(/^([A-Za-z0-9_-]+)\s*[x×*]\s*(\d+)$/);
    if (m) items.push({ sku: m[1] ?? chunk.trim(), qty: Number(m[2]) || 1 });
    else if (chunk.trim()) items.push({ sku: chunk.trim(), qty: 1 });
  }
  return items;
}

export function mapPaymentIntent(pi: any): CanonicalOrder {
  const md = pi?.metadata ?? {};
  const ship = pi?.shipping ?? {};
  const addr = ship?.address ?? {};
  const total = metaInt(pi?.amount_received) || metaInt(pi?.amount) || 0;
  const shippingCents = metaInt(md.fee_cents) ?? 0;
  const subtotal = metaInt(md.subtotal_cents) ?? Math.max(0, total - shippingCents);

  const charge = pi?.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const paymentMethod =
    charge?.payment_method_details?.type ??
    (Array.isArray(pi?.payment_method_types) ? pi.payment_method_types[0] : null);

  const refunded = metaInt(charge?.amount_refunded) ?? 0;
  const financial: CanonicalOrder['financial_status'] =
    pi?.status !== 'succeeded'
      ? 'pending'
      : refunded >= total && total > 0
        ? 'refunded'
        : refunded > 0
          ? 'partially_refunded'
          : 'paid';

  return {
    source: 'website',
    order_number: String(md.order_number ?? md.nss_order_number ?? md.order ?? pi?.id ?? ''),
    stripe_payment_intent: pi?.id ?? null,
    customer_name: ship?.name ?? null,
    email: md.email ?? pi?.receipt_email ?? charge?.billing_details?.email ?? null,
    phone: ship?.phone ?? charge?.billing_details?.phone ?? null,
    currency: String(pi?.currency ?? 'usd').toUpperCase(),
    subtotal_cents: subtotal,
    shipping_cents: shippingCents || Math.max(0, total - subtotal),
    total_cents: total,
    financial_status: financial,
    fulfillment_status: 'submitted', // checkout Worker auto-submits NSS fulfillment
    payment_method: paymentMethod,
    lang: md.lang ?? null,
    ship_name: ship?.name ?? null,
    ship_country: addr?.country ?? null,
    ship_state: addr?.state ?? null,
    ship_city: addr?.city ?? null,
    ship_zip: addr?.postal_code ?? null,
    ship_address1: addr?.line1 ?? null,
    ship_address2: addr?.line2 ?? null,
    items: parseItemsMeta(md.items),
    placed_at: metaInt(pi?.created) ?? now(),
  };
}

// Best-effort product-name enrichment from the ERP products table.
async function enrichItemNames(env: Env, items: CanonicalItem[]): Promise<CanonicalItem[]> {
  const skus = items.filter((i) => !i.name).map((i) => i.sku);
  if (!skus.length) return items;
  try {
    const ph = skus.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT sku, name FROM products WHERE sku IN (${ph})`)
      .bind(...skus)
      .all<{ sku: string; name: string }>();
    const bySku = new Map((rows.results ?? []).map((r) => [r.sku, r.name]));
    return items.map((i) => (i.name ? i : { ...i, name: bySku.get(i.sku) }));
  } catch {
    return items; // products table shape drift must never break ingest
  }
}

export async function ingestPaymentIntent(
  env: Env,
  pi: any
): Promise<{ action: string; order_id?: string; customer_id?: string | null }> {
  if (pi?.status !== 'succeeded') return { action: 'skipped:not_succeeded' };
  // Wix Payments processed cards through this same Stripe account until the
  // 2026-07 cutover. Those platform-created PIs carry NO checkout metadata and
  // would duplicate the source='wix' order history (the wix rows have the real
  // buyer/email/items) — only PIs stamped by our checkout Worker are orders here.
  const md = pi?.metadata ?? {};
  if (!md.order_number && !md.nss_order_number && !md.order) {
    return { action: 'skipped:not_checkout_pi' };
  }
  const order = mapPaymentIntent(pi);
  if (!order.order_number) return { action: 'skipped:no_order_number' };
  order.items = await enrichItemNames(env, order.items);
  const r = await upsertOrder(env, order, { stripe_payment_intent: pi });
  return { action: r.action, order_id: r.order_id, customer_id: r.customer_id };
}

// -----------------------------------------------------------------------------
// Reconciliation poller — hourly cron "7 * * * *" + POST /api/crm/website/sync/stripe
//
// Lists succeeded PaymentIntents created since the cursor (with a 3-day overlap
// for late captures/refunds) and re-ingests them. Idempotent, so overlap is free.
// Volume today is ~4 orders/month — a single page covers months.
// -----------------------------------------------------------------------------
const CURSOR_KEY = 'stripe:last_created';
const OVERLAP_SECONDS = 3 * 86400;

export async function pollStripeOrders(
  env: Env,
  opts: { sinceEpoch?: number } = {}
): Promise<{ scanned: number; created: number; updated: number; refund_updates: number; cursor: number }> {
  if (!env.STRIPE_SECRET_KEY) {
    return { scanned: 0, created: 0, updated: 0, refund_updates: 0, cursor: 0 };
  }

  let since = opts.sinceEpoch;
  if (!since) {
    const row = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key = ?')
      .bind(CURSOR_KEY)
      .first<{ value: string }>();
    since = row ? Number(row.value) - OVERLAP_SECONDS : now() - 90 * 86400;
  }

  let scanned = 0;
  let created = 0;
  let updated = 0;
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page++) {
    const params: Record<string, string> = {
      limit: '100',
      'created[gte]': String(Math.max(0, since)),
      'expand[]': 'data.latest_charge',
    };
    if (startingAfter) params.starting_after = startingAfter;
    const resp = await stripeGet<{ data: any[]; has_more: boolean }>(env, '/payment_intents', params);
    for (const pi of resp.data ?? []) {
      scanned++;
      try {
        const r = await ingestPaymentIntent(env, pi);
        if (r.action === 'created') created++;
        else if (r.action === 'updated') updated++;
      } catch (e) {
        console.error(`[crm-website] ingest failed for ${pi?.id}:`, e);
      }
    }
    if (!resp.has_more || !(resp.data ?? []).length) break;
    startingAfter = resp.data[resp.data.length - 1].id;
  }

  // Refund sweep — catches refunds issued on older orders inside the window.
  let refundUpdates = 0;
  try {
    const refunds = await stripeGet<{ data: any[] }>(env, '/refunds', {
      limit: '100',
      'created[gte]': String(Math.max(0, since)),
    });
    for (const rf of refunds.data ?? []) {
      const piId = typeof rf.payment_intent === 'string' ? rf.payment_intent : rf.payment_intent?.id;
      if (!piId) continue;
      const existing = await env.DB.prepare(
        'SELECT id, total_cents, financial_status, customer_id FROM crm_orders WHERE stripe_payment_intent = ?'
      )
        .bind(piId)
        .first<{ id: string; total_cents: number; financial_status: string; customer_id: string | null }>();
      if (!existing) continue;
      const full = (metaInt(rf.amount) ?? 0) >= existing.total_cents;
      const next = full ? 'refunded' : 'partially_refunded';
      if (existing.financial_status !== next && existing.financial_status !== 'refunded') {
        await env.DB.prepare('UPDATE crm_orders SET financial_status = ?, updated_at = ? WHERE id = ?')
          .bind(next, now(), existing.id)
          .run();
        if (existing.customer_id) await recomputeCustomerAggregates(env, existing.customer_id);
        refundUpdates++;
      }
    }
  } catch (e) {
    console.error('[crm-website] refund sweep failed:', e);
  }

  const cursor = now() - 60;
  await env.DB.prepare(
    `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(CURSOR_KEY, String(cursor), now())
    .run();

  return { scanned, created, updated, refund_updates: refundUpdates, cursor };
}

// -----------------------------------------------------------------------------
// Sync-state helpers — backfills persist their progress here so each HTTP
// invocation stays well under the Worker's ~1000-subrequest budget (the first
// un-chunked run died mid-import) and simply resumes on the next call.
// -----------------------------------------------------------------------------
async function getSyncState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

async function setSyncState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, value, now())
    .run();
}

async function clearSyncState(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM crm_sync_state WHERE key = ?').bind(key).run();
}

// -----------------------------------------------------------------------------
// Backfill: Wix Stores orders + Wix members  (source='wix')
//
// Uses the Wix REST API with an account-level API key. All field access is
// optional-chained — Wix payload shapes vary by API revision and a missing
// field must degrade, not abort a 44-order import.
//
// Chunked: one orders page (or one members page) per invocation; progress in
// crm_sync_state (wix:orders_cursor / wix:orders_done / wix:members_offset).
// Call repeatedly until the response says done:true. Body {reset:true} restarts.
// -----------------------------------------------------------------------------
const WIX_BASE = 'https://www.wixapis.com';

function wixHeaders(env: Env): Record<string, string> {
  if (!env.WIX_API_KEY || !env.WIX_SITE_ID) throw new Error('WIX_API_KEY / WIX_SITE_ID not configured');
  const h: Record<string, string> = {
    Authorization: env.WIX_API_KEY,
    'wix-site-id': env.WIX_SITE_ID,
    'Content-Type': 'application/json',
  };
  if (env.WIX_ACCOUNT_ID) h['wix-account-id'] = env.WIX_ACCOUNT_ID;
  return h;
}

function wixMoney(v: any): number {
  const n = parseFloat(v?.amount ?? v ?? '0');
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function mapWixOrder(o: any): CanonicalOrder {
  const contact =
    o?.recipientInfo?.contactDetails ??
    o?.shippingInfo?.logistics?.shippingDestination?.contactDetails ??
    o?.billingInfo?.contactDetails ??
    {};
  const addr =
    o?.recipientInfo?.address ??
    o?.shippingInfo?.logistics?.shippingDestination?.address ??
    o?.billingInfo?.address ??
    {};
  const ps = o?.priceSummary ?? {};
  const pay = String(o?.paymentStatus ?? 'PAID');
  const ful = String(o?.fulfillmentStatus ?? 'FULFILLED');

  return {
    source: 'wix',
    order_number: String(o?.number ?? o?.id ?? ''),
    customer_name: [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || null,
    email: o?.buyerInfo?.email ?? contact?.email ?? null,
    phone: contact?.phone ?? null,
    currency: String(o?.currency ?? 'USD').toUpperCase(),
    subtotal_cents: wixMoney(ps.subtotal),
    shipping_cents: wixMoney(ps.shipping),
    discount_cents: wixMoney(ps.discount),
    tax_cents: wixMoney(ps.tax),
    total_cents: wixMoney(ps.total),
    financial_status:
      pay === 'FULLY_REFUNDED' ? 'refunded'
      : pay === 'PARTIALLY_REFUNDED' ? 'partially_refunded'
      : pay === 'NOT_PAID' ? 'pending'
      : 'paid',
    fulfillment_status: ful === 'NOT_FULFILLED' ? 'unfulfilled' : 'shipped',
    payment_method: 'wix_payments',
    ship_name: [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || null,
    ship_country: addr?.country ?? null,
    ship_state: addr?.subdivision ?? null,
    ship_city: addr?.city ?? null,
    ship_zip: addr?.postalCode ?? null,
    ship_address1: addr?.addressLine1 ?? addr?.addressLine ?? null,
    ship_address2: addr?.addressLine2 ?? null,
    items: (o?.lineItems ?? []).map((li: any) => ({
      sku: String(li?.physicalProperties?.sku ?? li?.catalogReference?.catalogItemId ?? 'unknown'),
      name: li?.productName?.original ?? undefined,
      qty: Number(li?.quantity ?? 1) || 1,
      unit_cents: wixMoney(li?.price),
      total_cents: wixMoney(li?.totalPriceAfterTax ?? li?.totalPrice),
    })),
    placed_at: o?.createdDate ? Math.floor(new Date(o.createdDate).getTime() / 1000) : now(),
  };
}

export async function backfillWix(
  env: Env,
  opts: { reset?: boolean } = {}
): Promise<{
  phase: 'orders' | 'members';
  orders_scanned: number; orders_created: number;
  members_scanned: number; customers_touched: number;
  done: boolean;
}> {
  const headers = wixHeaders(env);
  const ORDERS_PER_RUN = 15;
  const MEMBERS_PER_RUN = 25;

  if (opts.reset) {
    await clearSyncState(env, 'wix:orders_cursor');
    await clearSyncState(env, 'wix:orders_done');
    await clearSyncState(env, 'wix:members_offset');
  }

  let ordersScanned = 0;
  let ordersCreated = 0;
  let membersScanned = 0;
  let customersTouched = 0;

  // --- Phase 1: orders (ecom v1 search, cursor-paged; site history is 44) ---
  const ordersDone = (await getSyncState(env, 'wix:orders_done')) === '1';
  if (!ordersDone) {
    const cursor = await getSyncState(env, 'wix:orders_cursor');
    const body: any = { cursorPaging: { limit: ORDERS_PER_RUN } };
    if (cursor) body.cursorPaging.cursor = cursor;
    const res = await fetch(`${WIX_BASE}/ecom/v1/orders/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Wix orders/search HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as any;
    const orders = data?.orders ?? [];
    for (const o of orders) {
      ordersScanned++;
      const mapped = mapWixOrder(o);
      if (!mapped.order_number) continue;
      const r = await upsertOrder(env, mapped, { wix_order: o });
      if (r.action === 'created') ordersCreated++;
    }
    const next = data?.metadata?.cursors?.next;
    if (next && orders.length) {
      await setSyncState(env, 'wix:orders_cursor', next);
      return { phase: 'orders', orders_scanned: ordersScanned, orders_created: ordersCreated, members_scanned: 0, customers_touched: 0, done: false };
    }
    await setSyncState(env, 'wix:orders_done', '1');
    await clearSyncState(env, 'wix:orders_cursor');
  }

  // --- Phase 2: members (35 community members → customers, source='wix') ---
  const offset = Number((await getSyncState(env, 'wix:members_offset')) ?? 0);
  const res = await fetch(
    `${WIX_BASE}/members/v1/members?fieldsets=FULL&paging.limit=${MEMBERS_PER_RUN}&paging.offset=${offset}`,
    { headers }
  );
  if (!res.ok) throw new Error(`Wix members HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  const members = data?.members ?? [];
  for (const m of members) {
    membersScanned++;
    const email = normEmail(m?.loginEmail ?? m?.contact?.emails?.[0]);
    const phone = m?.contact?.phones?.[0] ?? null;
    if (!email && !phone) continue;
    await upsertCustomer(
      env,
      {
        email,
        phone,
        first_name: m?.contact?.firstName ?? m?.profile?.nickname ?? null,
        last_name: m?.contact?.lastName ?? null,
        source: 'wix',
        external_ids: {
          ...(m?.id ? { wix_member_id: m.id } : {}),
          ...(m?.contactId ? { wix_contact_id: m.contactId } : {}),
        },
      },
      { fillOnly: true }
    );
    customersTouched++;
  }

  if (members.length === MEMBERS_PER_RUN) {
    await setSyncState(env, 'wix:members_offset', String(offset + MEMBERS_PER_RUN));
    return { phase: 'members', orders_scanned: ordersScanned, orders_created: ordersCreated, members_scanned: membersScanned, customers_touched: customersTouched, done: false };
  }

  await clearSyncState(env, 'wix:members_offset');
  await clearSyncState(env, 'wix:orders_done');
  return { phase: 'members', orders_scanned: ordersScanned, orders_created: ordersCreated, members_scanned: membersScanned, customers_touched: customersTouched, done: true };
}

// -----------------------------------------------------------------------------
// Backfill: RetailCRM customers (~1507, dasexperten.retailcrm.ru, source='retailcrm')
//
// Customers only — their RUB order history stays in RetailCRM/KIT; lifetime
// counters here track website (USD) orders exclusively. Raw rows are archived
// to R2 under crm/imports/retailcrm/ for reference.
// -----------------------------------------------------------------------------
// Chunked: processes `pages` pages of 100 per invocation (default 2 ≈ 200
// customers ≈ ~500 subrequests), resumes from crm_sync_state
// 'retailcrm:next_page'. Call repeatedly until done:true. {from_page:1} restarts.
export async function backfillRetailCrm(
  env: Env,
  opts: { fromPage?: number; pages?: number } = {}
): Promise<{ scanned: number; customers_touched: number; from_page: number; next_page: number | null; total_pages: number; done: boolean }> {
  if (!env.RETAIL_CRM_DOMAIN || !env.RETAIL_CRM_TOKEN) {
    throw new Error('RETAIL_CRM_DOMAIN / RETAIL_CRM_TOKEN not configured');
  }
  const startPage = opts.fromPage ?? Number((await getSyncState(env, 'retailcrm:next_page')) ?? 1);
  const pagesThisRun = Math.max(1, Math.min(opts.pages ?? 2, 5));

  let scanned = 0;
  let touched = 0;
  let page = startPage;
  let totalPages = startPage;
  const rawBatch: any[] = [];

  while (page <= totalPages && page < startPage + pagesThisRun) {
    const url = new URL(`https://${env.RETAIL_CRM_DOMAIN}.retailcrm.ru/api/v5/customers`);
    url.searchParams.set('apiKey', env.RETAIL_CRM_TOKEN);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', '100');
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`RetailCRM customers HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as any;
    if (!data?.success) throw new Error(`RetailCRM error: ${JSON.stringify(data).slice(0, 300)}`);
    totalPages = data?.pagination?.totalPageCount ?? 1;

    for (const cu of data?.customers ?? []) {
      scanned++;
      const email = normEmail(cu?.email);
      const phone = cu?.phones?.[0]?.number ?? null;
      if (!email && !phone) continue;
      await upsertCustomer(
        env,
        {
          email,
          phone,
          first_name: cu?.firstName ?? null,
          last_name: cu?.lastName ?? null,
          country_code: cu?.address?.countryIso ?? null,
          state_code: cu?.address?.region ?? null,
          city: cu?.address?.city ?? null,
          zip: cu?.address?.index ?? null,
          address1: cu?.address?.text ?? null,
          tags: (cu?.tags ?? []).map((t: any) => String(t?.name ?? t)).filter(Boolean),
          source: 'retailcrm',
          external_ids: cu?.id ? { retailcrm_id: cu.id } : {},
        },
        { fillOnly: true }
      );
      touched++;
      rawBatch.push(cu);
    }
    page++;
  }

  if (rawBatch.length) {
    await r2Put(env, `crm/imports/retailcrm/customers-p${startPage}-p${page - 1}.json`, {
      imported_at: now(),
      count: rawBatch.length,
      customers: rawBatch,
    });
  }

  const done = page > totalPages;
  if (done) {
    await clearSyncState(env, 'retailcrm:next_page');
  } else {
    await setSyncState(env, 'retailcrm:next_page', String(page));
  }
  return { scanned, customers_touched: touched, from_page: startPage, next_page: done ? null : page, total_pages: totalPages, done };
}
