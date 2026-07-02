/**
 * dasexperten.com storefront (Stripe on Cloudflare) → ERP routes.
 *
 *   POST /api/website/sync/orders   — pull Stripe Checkout Sessions into the mirror
 *   POST /api/website/sync/catalog  — pull Stripe Products/Prices into the mirror
 *   GET  /api/website/orders        — mirrored orders + their lines
 *   GET  /api/website/unmatched-skus— SKUs seen on the storefront but absent from the ERP catalog
 *   GET  /api/website/stocks        — per-SKU ERP on-hand feed for the storefront to consume
 *   GET  /api/website/health        — last sync status + watermark
 *
 * The two sync endpoints are unauthenticated machine calls (invoked by cron via
 * the SELF binding), matching /api/marketplaces/sync/*. They return 503 when
 * STRIPE_KEY is not configured, so a missing secret degrades gracefully.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { runWebsiteOrdersSync, runWebsiteCatalogSync } from '../lib/website-pull';

const website = new Hono<{ Bindings: Env }>();

function notConfigured(c: Parameters<typeof ok>[0]) {
  return fail(c, 503, [{ code: 'website_not_configured', message: 'STRIPE_KEY missing.' }]);
}

// ---------------------------------------------------------------------------
// POST /api/website/sync/orders   body: { from?: number (unix seconds) }
// ---------------------------------------------------------------------------
website.post('/sync/orders', async (c) => {
  if (!c.env.STRIPE_KEY) return notConfigured(c);
  let from: number | undefined;
  try {
    const body = (await c.req.json().catch(() => ({}))) as { from?: number | string };
    if (body.from != null) {
      const n = typeof body.from === 'string' ? parseInt(body.from, 10) : body.from;
      if (Number.isFinite(n)) from = n;
    }
  } catch {
    /* no body — fine */
  }
  try {
    const result = await runWebsiteOrdersSync(c.env, from);
    return ok(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(c, 500, [{ code: 'website_orders_sync_failed', message }]);
  }
});

// ---------------------------------------------------------------------------
// POST /api/website/sync/catalog
// ---------------------------------------------------------------------------
website.post('/sync/catalog', async (c) => {
  if (!c.env.STRIPE_KEY) return notConfigured(c);
  try {
    const result = await runWebsiteCatalogSync(c.env);
    return ok(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(c, 500, [{ code: 'website_catalog_sync_failed', message }]);
  }
});

// ---------------------------------------------------------------------------
// GET /api/website/orders?limit=50&offset=0&payment_status=paid
// Returns orders newest-first, each with its line items nested.
// ---------------------------------------------------------------------------
website.get('/orders', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 200);
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0;
  const paymentStatus = c.req.query('payment_status');

  const site = c.req.query('site');

  let sql = `
    SELECT id, site, number, created_date, updated_date, status, payment_status,
           currency, amount_subtotal, amount_shipping, amount_tax, amount_discount,
           amount_total, buyer_email, buyer_name, ship_country, payment_intent, synced_at
    FROM website_orders
    WHERE 1=1
  `;
  const binds: unknown[] = [];
  if (paymentStatus) { sql += ` AND payment_status = ?`; binds.push(paymentStatus); }
  if (site) { sql += ` AND site = ?`; binds.push(site); }
  sql += ` ORDER BY created_date DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const orders = (await c.env.DB.prepare(sql).bind(...binds).all()).results as Array<Record<string, unknown>>;

  // Attach lines for the returned orders in one query.
  const ids = orders.map((o) => o.id as string);
  const linesByOrder: Record<string, unknown[]> = {};
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const lines = (await c.env.DB.prepare(
      `SELECT order_id, stripe_price_id, sku_raw, product_id, item_name, qty, unit_amount, line_total
       FROM website_order_lines WHERE order_id IN (${placeholders})`
    ).bind(...ids).all()).results as Array<Record<string, unknown>>;
    for (const l of lines) {
      const oid = l.order_id as string;
      (linesByOrder[oid] ||= []).push(l);
    }
  }
  for (const o of orders) o.lines = linesByOrder[o.id as string] || [];

  return ok(c, { count: orders.length, limit, offset, orders });
});

// ---------------------------------------------------------------------------
// GET /api/website/unmatched-skus
// SKUs that appeared in orders or the catalog but do not exist in products.
// ---------------------------------------------------------------------------
website.get('/unmatched-skus', async (c) => {
  const rows = (await c.env.DB.prepare(`
    SELECT sku_raw,
           SUM(cnt) AS occurrences,
           MAX(last_seen) AS last_seen,
           MAX(source) AS source
    FROM (
      SELECT sku_raw, COUNT(*) AS cnt, MAX(created_at) AS last_seen, 'order' AS source
        FROM website_order_lines WHERE product_id IS NULL AND sku_raw IS NOT NULL
        GROUP BY sku_raw
      UNION ALL
      SELECT sku_raw, COUNT(*) AS cnt, MAX(synced_at) AS last_seen, 'catalog' AS source
        FROM website_products WHERE product_id IS NULL AND sku_raw IS NOT NULL
        GROUP BY sku_raw
    )
    GROUP BY sku_raw
    ORDER BY occurrences DESC
  `).all()).results;
  return ok(c, { unmatched: rows });
});

// ---------------------------------------------------------------------------
// GET /api/website/stocks
// Per-canonical-SKU on-hand feed for the storefront / checkout Worker to read.
// Sums on_hand across all warehouses. This is the "Das Operator ERP → stock
// feed" item flagged in SECRETS/stripe.md §6.
// ---------------------------------------------------------------------------
website.get('/stocks', async (c) => {
  const rows = (await c.env.DB.prepare(`
    SELECT p.id AS sku,
           p.product_name,
           COALESCE(SUM(s.on_hand), 0) AS on_hand,
           MAX(s.updated_at) AS updated_at,
           wp.unit_amount AS stripe_unit_amount,
           wp.currency AS stripe_currency
    FROM products p
    LEFT JOIN stocks s ON s.product_id = p.id
    LEFT JOIN website_products wp ON wp.product_id = p.id AND wp.active = 1
    WHERE p.deleted_at IS NULL
    GROUP BY p.id
    ORDER BY p.id
  `).all()).results;
  return ok(c, { count: rows.length, stocks: rows });
});

// ---------------------------------------------------------------------------
// GET /api/website/health
// ---------------------------------------------------------------------------
website.get('/health', async (c) => {
  const logs = (await c.env.DB.prepare(`
    SELECT kind, started_at, finished_at, status, rows_synced, error_message
    FROM website_sync_log
    WHERE id IN (SELECT MAX(id) FROM website_sync_log GROUP BY kind)
  `).all()).results as Array<Record<string, unknown>>;

  const byKind: Record<string, unknown> = { orders: null, catalog: null };
  for (const r of logs) byKind[r.kind as string] = r;

  const wm = await c.env.DB.prepare(
    `SELECT value, updated_at FROM website_sync_state WHERE key = 'orders_watermark'`
  ).first<{ value: string; updated_at: number }>();

  const counts = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM website_orders) AS orders,
      (SELECT COUNT(*) FROM website_order_lines WHERE product_id IS NULL) AS unmatched_order_lines,
      (SELECT COUNT(*) FROM website_products) AS catalog_prices
  `).first<Record<string, number>>();

  return ok(c, {
    configured: Boolean(c.env.STRIPE_KEY),
    sync: byKind,
    orders_watermark: wm ? parseInt(wm.value, 10) : null,
    counts,
  });
});

export default website;
