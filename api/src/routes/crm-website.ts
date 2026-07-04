// =============================================================================
// Website CRM routes — /api/crm/website/*  (Phase 12.0)
//
// Orders/customers of the dasexperten.com storefront (Stripe checkout), stored
// in D1 (crm_customers / crm_orders) with raw JSON archived to R2. Sits next to
// /api/crm/* which serves the .ru storefront (Yandex KIT) — the /crm page
// switches between the two sources.
//
// POST /webhook/stripe            ← Stripe payment_intent.succeeded / charge.refunded
//                                    (signature-verified with STRIPE_WEBHOOK_SECRET)
// GET  /stats                     ← KPI tiles for the .com source
// GET  /orders?page&limit&search&sort&dir
// GET  /orders/:number
// GET  /customers?page&limit&search&sort&dir
// GET  /customers/:id             ← profile + their orders
// POST /sync/stripe               ← run the reconciliation poller now (admin)
// POST /backfill/wix              ← 44 historical Wix orders + 35 members (admin)
// POST /backfill/retailcrm        ← ~1507 RetailCRM customers (admin)
// POST /import                    ← generic canonical {customers[],orders[]} (admin)
//
// Read endpoints are open like the rest of /api/crm/* (SSO is BACKLOG item M);
// mutations use the same admin bearer as /admin/*.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import {
  verifyStripeSignature,
  ingestPaymentIntent,
  pollStripeOrders,
  backfillWix,
  backfillRetailCrm,
  upsertOrder,
  upsertCustomer,
  type CanonicalOrder,
  type CanonicalCustomer,
} from '../lib/crm-website';

const site = new Hono<{ Bindings: Env }>();
const ADMIN_SECRET = 'das-admin-2026-migrations';

function isAdmin(auth: string | undefined): boolean {
  return auth === `Bearer ${ADMIN_SECRET}`;
}

// -----------------------------------------------------------------------------
// Stripe webhook — register in the Stripe dashboard as
//   https://dasoperator-api.dasexperten.workers.dev/api/crm/website/webhook/stripe
// with events payment_intent.succeeded + charge.refunded, then
//   wrangler secret put STRIPE_WEBHOOK_SECRET
// Until the secret is set the endpoint answers 503 — the hourly poller keeps
// the CRM complete either way.
// -----------------------------------------------------------------------------
site.post('/webhook/stripe', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return fail(c, 503, [{ code: 'not_configured', message: 'STRIPE_WEBHOOK_SECRET not set' }]);
  }
  const raw = await c.req.text();
  const valid = await verifyStripeSignature(raw, c.req.header('Stripe-Signature'), c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return fail(c, 403, [{ code: 'bad_signature', message: 'Stripe-Signature verification failed' }]);
  }

  let event: any = null;
  try {
    event = JSON.parse(raw);
  } catch {
    return fail(c, 400, [{ code: 'bad_json', message: 'body is not JSON' }]);
  }

  const type = String(event?.type ?? '');
  const obj = event?.data?.object ?? {};
  let result = 'skipped:unhandled_event';
  let ref: string | null = null;

  try {
    if (type === 'payment_intent.succeeded') {
      ref = obj?.id ?? null;
      const r = await ingestPaymentIntent(c.env, obj);
      result = r.action;
    } else if (type === 'charge.refunded') {
      ref = typeof obj?.payment_intent === 'string' ? obj.payment_intent : obj?.payment_intent?.id ?? null;
      if (ref) {
        // Delegate the state transition to the poller logic by re-ingesting a
        // narrow window around this PI — keeps refund math in one place.
        const r = await pollStripeOrders(c.env, { sinceEpoch: Number(obj?.created ?? 0) - 90 * 86400 });
        result = `refund_sweep:${r.refund_updates}`;
      } else {
        result = 'skipped:no_payment_intent';
      }
    }
  } catch (err) {
    result = 'error:' + (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }

  // Log every delivery (same discipline as loyalty_webhook_log) and answer 200
  // so Stripe doesn't retry storms on our processing hiccups — the poller heals.
  await c.env.DB.prepare(
    'INSERT INTO crm_webhook_log (id, source, event_type, ref, payload, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
    .bind('cw_' + crypto.randomUUID(), 'stripe', type, ref, raw.slice(0, 4000), result, Math.floor(Date.now() / 1000))
    .run();

  return ok(c, { processed: !result.startsWith('skipped') && !result.startsWith('error'), result });
});

// -----------------------------------------------------------------------------
// Stats — KPI strip for the .com source on /crm
// -----------------------------------------------------------------------------
site.get('/stats', async (c) => {
  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthEpoch = Math.floor(monthStart.getTime() / 1000);

    const totals = await c.env.DB.prepare(
      `SELECT COUNT(*) AS orders_total,
              COALESCE(SUM(total_cents), 0) AS revenue_cents,
              COALESCE(SUM(CASE WHEN placed_at >= ?1 THEN 1 ELSE 0 END), 0) AS orders_this_month,
              COALESCE(SUM(CASE WHEN placed_at >= ?1 THEN total_cents ELSE 0 END), 0) AS revenue_this_month_cents
       FROM crm_orders
       WHERE financial_status IN ('paid','partially_refunded')`
    ).bind(monthEpoch).first<any>();

    const custTotals = await c.env.DB.prepare(
      `SELECT COUNT(*) AS customers_total,
              SUM(CASE WHEN orders_count > 0 THEN 1 ELSE 0 END) AS buyers,
              SUM(CASE WHEN orders_count >= 2 THEN 1 ELSE 0 END) AS repeat_buyers,
              SUM(CASE WHEN source = 'website' THEN 1 ELSE 0 END) AS from_website,
              SUM(CASE WHEN source = 'wix' THEN 1 ELSE 0 END) AS from_wix,
              SUM(CASE WHEN source = 'retailcrm' THEN 1 ELSE 0 END) AS from_retailcrm
       FROM crm_customers`
    ).first<any>();

    // Top SKUs across website orders (items is a JSON array column)
    const topSkus = await c.env.DB.prepare(
      `SELECT json_extract(je.value, '$.sku') AS sku,
              COALESCE(json_extract(je.value, '$.name'), json_extract(je.value, '$.sku')) AS name,
              SUM(CAST(COALESCE(json_extract(je.value, '$.qty'), 1) AS INTEGER)) AS units
       FROM crm_orders, json_each(crm_orders.items) je
       WHERE crm_orders.financial_status IN ('paid','partially_refunded')
       GROUP BY sku ORDER BY units DESC LIMIT 5`
    ).all<any>();

    const monthly = await c.env.DB.prepare(
      `SELECT strftime('%Y-%m', placed_at, 'unixepoch') AS month,
              COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue_cents
       FROM crm_orders WHERE financial_status IN ('paid','partially_refunded')
       GROUP BY month ORDER BY month`
    ).all<any>();

    const lastSync = await c.env.DB.prepare(
      "SELECT value, updated_at FROM crm_sync_state WHERE key = 'stripe:last_created'"
    ).first<{ value: string; updated_at: number }>();

    const ordersTotal = Number(totals?.orders_total ?? 0);
    const revenueCents = Number(totals?.revenue_cents ?? 0);
    return ok(c, {
      source: 'd1:crm_orders (stripe:dasexperten.com)',
      currency: 'USD',
      orders_total: ordersTotal,
      revenue_total_cents: revenueCents,
      aov_cents: ordersTotal ? Math.round(revenueCents / ordersTotal) : 0,
      orders_this_month: Number(totals?.orders_this_month ?? 0),
      revenue_this_month_cents: Number(totals?.revenue_this_month_cents ?? 0),
      customers_total: Number(custTotals?.customers_total ?? 0),
      buyers_count: Number(custTotals?.buyers ?? 0),
      repeat_buyers: Number(custTotals?.repeat_buyers ?? 0),
      customers_by_source: {
        website: Number(custTotals?.from_website ?? 0),
        wix: Number(custTotals?.from_wix ?? 0),
        retailcrm: Number(custTotals?.from_retailcrm ?? 0),
      },
      top_skus: topSkus.results ?? [],
      monthly: monthly.results ?? [],
      stripe_poller: lastSync
        ? { cursor: Number(lastSync.value), last_run_at: lastSync.updated_at }
        : null,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    // First hit before /admin/migrate/crm-website has run → tables missing
    if (msg.includes('no such table')) {
      return fail(c, 503, [{ code: 'not_migrated', message: 'Run POST /admin/migrate/crm-website first' }]);
    }
    return fail(c, 500, [{ code: 'internal_error', message: msg }]);
  }
});

// -----------------------------------------------------------------------------
// Orders list — response mirrors /api/crm/orders so the /crm page can render
// either source with the same table component. Amounts are in CENTS + currency.
// -----------------------------------------------------------------------------
site.get('/orders', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const rawLimit = Number(c.req.query('limit') ?? 50);
  const limit = [20, 50, 100].includes(rawLimit) ? rawLimit : 50;
  const search = (c.req.query('search') ?? '').trim();
  const sortKey = (c.req.query('sort') ?? 'date').toLowerCase();
  const asc = (c.req.query('dir') ?? 'desc').toLowerCase() === 'asc';

  const ORDER_BY: Record<string, string> = {
    date: 'placed_at',
    total: 'total_cents',
    status: 'financial_status',
    number: 'order_number',
  };
  const orderCol = ORDER_BY[sortKey] ?? 'placed_at';
  const dir = asc ? 'ASC' : 'DESC';

  try {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (search) {
      where.push('(order_number LIKE ?1 OR customer_name LIKE ?1 OR email LIKE ?1 OR ship_country LIKE ?1)');
      binds.push(`%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM crm_orders ${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>();
    const rows = await c.env.DB.prepare(
      `SELECT id, source, order_number, stripe_payment_intent, customer_id, customer_name,
              email, currency, subtotal_cents, shipping_cents, total_cents,
              financial_status, fulfillment_status, payment_method, lang,
              ship_country, ship_city, items, placed_at
       FROM crm_orders ${whereSql}
       ORDER BY ${orderCol} ${dir} LIMIT ? OFFSET ?`
    )
      .bind(...binds, limit, (page - 1) * limit)
      .all<any>();

    const totalCount = Number(total?.n ?? 0);
    const orders = (rows.results ?? []).map((o) => ({
      id: o.order_number,
      number: String(o.order_number),
      source: o.source,
      customer_name: o.customer_name ?? o.email ?? '—',
      customer_id: o.customer_id,
      email: o.email,
      // `total` mirrors the KIT feed (major units) so the shared table renders;
      // *_cents keep the exact figures for anything that needs them.
      total: Math.round(Number(o.total_cents ?? 0) / 100),
      total_cents: Number(o.total_cents ?? 0),
      subtotal_cents: Number(o.subtotal_cents ?? 0),
      shipping_cents: Number(o.shipping_cents ?? 0),
      currency: o.currency,
      status: o.financial_status,
      fulfillment_status: o.fulfillment_status,
      payment_method: o.payment_method,
      lang: o.lang,
      ship_country: o.ship_country,
      ship_city: o.ship_city,
      items: JSON.parse(o.items ?? '[]'),
      stripe_payment_intent: o.stripe_payment_intent,
      created_at: o.placed_at ? new Date(o.placed_at * 1000).toISOString() : '—',
    }));

    return ok(c, {
      source: 'd1:crm_orders (stripe:dasexperten.com)',
      pagination: { page, limit, total_count: totalCount, total_pages: Math.max(1, Math.ceil(totalCount / limit)) },
      search,
      orders,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('no such table')) {
      return fail(c, 503, [{ code: 'not_migrated', message: 'Run POST /admin/migrate/crm-website first' }]);
    }
    return fail(c, 500, [{ code: 'internal_error', message: msg }]);
  }
});

site.get('/orders/:number', async (c) => {
  const number = c.req.param('number');
  const row = await c.env.DB.prepare('SELECT * FROM crm_orders WHERE order_number = ? ORDER BY placed_at DESC')
    .bind(number)
    .first<any>();
  if (!row) return fail(c, 404, [{ code: 'not_found', message: `no order ${number}` }]);
  return ok(c, { ...row, items: JSON.parse(row.items ?? '[]') });
});

// -----------------------------------------------------------------------------
// Customers list — shape mirrors /api/crm/customers (KIT source)
// -----------------------------------------------------------------------------
site.get('/customers', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const rawLimit = Number(c.req.query('limit') ?? 50);
  const limit = [20, 50, 100].includes(rawLimit) ? rawLimit : 50;
  const search = (c.req.query('search') ?? '').trim();
  const sortKey = (c.req.query('sort') ?? 'spent').toLowerCase();
  const asc = (c.req.query('dir') ?? 'desc').toLowerCase() === 'asc';
  const sourceFilter = (c.req.query('source') ?? '').trim(); // website | wix | retailcrm

  const ORDER_BY: Record<string, string> = {
    spent: 'total_spent_cents',
    orders: 'orders_count',
    name: 'first_name',
    registered: 'created_at',
    last_order: 'last_order_at',
  };
  const orderCol = ORDER_BY[sortKey] ?? 'total_spent_cents';
  const dir = asc ? 'ASC' : 'DESC';

  try {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (search) {
      binds.push(`%${search}%`);
      where.push(`(first_name LIKE ?${binds.length} OR last_name LIKE ?${binds.length} OR email LIKE ?${binds.length} OR phone LIKE ?${binds.length})`);
    }
    if (['website', 'wix', 'retailcrm', 'manual'].includes(sourceFilter)) {
      binds.push(sourceFilter);
      where.push(`source = ?${binds.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM crm_customers ${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>();
    const rows = await c.env.DB.prepare(
      `SELECT id, email, phone, first_name, last_name, country_code, city, lang, source,
              orders_count, total_spent_cents, currency, first_order_at, last_order_at, created_at
       FROM crm_customers ${whereSql}
       ORDER BY ${orderCol} ${dir} LIMIT ? OFFSET ?`
    )
      .bind(...binds, limit, (page - 1) * limit)
      .all<any>();

    const totalCount = Number(total?.n ?? 0);
    const customers = (rows.results ?? []).map((cu) => ({
      id: cu.id,
      name: [cu.first_name, cu.last_name].filter(Boolean).join(' ') || cu.email || '—',
      email: cu.email,
      phone: cu.phone,
      country: cu.country_code,
      city: cu.city,
      lang: cu.lang,
      source: cu.source,
      orders_count: Number(cu.orders_count ?? 0),
      total_spent: Math.round(Number(cu.total_spent_cents ?? 0) / 100),
      total_spent_cents: Number(cu.total_spent_cents ?? 0),
      currency: cu.currency,
      average_order: cu.orders_count ? Math.round(cu.total_spent_cents / cu.orders_count / 100) : 0,
      created_at: cu.created_at ? new Date(cu.created_at * 1000).toISOString() : '—',
      last_order_at: cu.last_order_at ? new Date(cu.last_order_at * 1000).toISOString() : null,
    }));

    return ok(c, {
      source: 'd1:crm_customers (dasexperten.com)',
      pagination: { page, limit, total_count: totalCount, total_pages: Math.max(1, Math.ceil(totalCount / limit)) },
      search,
      customers,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (msg.includes('no such table')) {
      return fail(c, 503, [{ code: 'not_migrated', message: 'Run POST /admin/migrate/crm-website first' }]);
    }
    return fail(c, 500, [{ code: 'internal_error', message: msg }]);
  }
});

site.get('/customers/:id', async (c) => {
  const id = c.req.param('id');
  const cu = await c.env.DB.prepare('SELECT * FROM crm_customers WHERE id = ?').bind(id).first<any>();
  if (!cu) return fail(c, 404, [{ code: 'not_found', message: `no customer ${id}` }]);
  const orders = await c.env.DB.prepare(
    `SELECT source, order_number, currency, total_cents, financial_status, fulfillment_status, items, placed_at
     FROM crm_orders WHERE customer_id = ? ORDER BY placed_at DESC LIMIT 100`
  )
    .bind(id)
    .all<any>();
  return ok(c, {
    ...cu,
    tags: JSON.parse(cu.tags ?? '[]'),
    external_ids: JSON.parse(cu.external_ids ?? '{}'),
    orders: (orders.results ?? []).map((o) => ({ ...o, items: JSON.parse(o.items ?? '[]') })),
  });
});

// -----------------------------------------------------------------------------
// Admin: manual poller run + backfills + generic import
// -----------------------------------------------------------------------------
site.use('/sync/*', adminGuard);
site.use('/backfill/*', adminGuard);
site.use('/import', adminGuard);

async function adminGuard(c: any, next: any) {
  if (!isAdmin(c.req.header('Authorization'))) {
    return fail(c, 403, [{ code: 'forbidden', message: 'admin secret required' }]);
  }
  await next();
  return;
}

// Body {since?: unix epoch} — omit for cursor-based incremental, pass e.g.
// {"since": 1735689600} once after deploy to pull the whole Stripe history.
site.post('/sync/stripe', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return fail(c, 503, [{ code: 'not_configured', message: 'STRIPE_SECRET_KEY not set' }]);
  }
  const body = await c.req.json<{ since?: number }>().catch(() => ({} as any));
  const r = await pollStripeOrders(c.env, body?.since ? { sinceEpoch: Number(body.since) } : {});
  return ok(c, r);
});

site.post('/backfill/wix', async (c) => {
  try {
    const r = await backfillWix(c.env);
    return ok(c, r);
  } catch (e) {
    return fail(c, 502, [{ code: 'wix_backfill_failed', message: e instanceof Error ? e.message : String(e) }]);
  }
});

site.post('/backfill/retailcrm', async (c) => {
  try {
    const r = await backfillRetailCrm(c.env);
    return ok(c, r);
  } catch (e) {
    return fail(c, 502, [{ code: 'retailcrm_backfill_failed', message: e instanceof Error ? e.message : String(e) }]);
  }
});

site.post('/import', async (c) => {
  const body = await c.req
    .json<{ customers?: CanonicalCustomer[]; orders?: CanonicalOrder[] }>()
    .catch(() => null);
  if (!body || (!body.customers?.length && !body.orders?.length)) {
    return fail(c, 400, [{ code: 'bad_request', message: 'body must contain customers[] and/or orders[]' }]);
  }
  let customersDone = 0;
  let ordersDone = 0;
  const errors: string[] = [];
  for (const cu of body.customers ?? []) {
    try {
      await upsertCustomer(c.env, cu, { fillOnly: cu.source !== 'website' });
      customersDone++;
    } catch (e) {
      errors.push(`customer ${cu.email ?? cu.phone}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const o of body.orders ?? []) {
    try {
      await upsertOrder(c.env, o);
      ordersDone++;
    } catch (e) {
      errors.push(`order ${o.order_number}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ok(c, { customers_imported: customersDone, orders_imported: ordersDone, errors });
});

export default site;
