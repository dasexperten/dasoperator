/**
 * External warehouse stocks routes — Phase 7.x F4 / Skladbot integration.
 *
 * Reads stock data that an external fulfillment partner (F4 Lyubertsy, on Skladbot WMS)
 * keeps for our products, and lets ops compare it side-by-side with our internal ledger.
 *
 * Endpoints:
 *   - GET  /api/external-stocks                  — latest snapshot, all warehouses
 *   - GET  /api/external-stocks?warehouse_id=lbr — filter to one warehouse
 *   - POST /api/external-stocks/sync             — pull /v1/products from Skladbot for all
 *                                                  external-integrated warehouses; idempotent.
 *
 * The token to call Skladbot lives in the F4_SKLADBOT_TOKEN Worker secret.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const externalStocks = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /api/external-stocks
// Latest snapshot per (warehouse_id, vendor_code, marketplace).
// Optional ?warehouse_id=lbr filter.
// Optional ?product_id=de201 filter.
// ---------------------------------------------------------------------------
externalStocks.get('/', async (c) => {
  const whFilter = c.req.query('warehouse_id');
  const productFilter = c.req.query('product_id');

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (whFilter) {
    where.push('es.warehouse_id = ?');
    params.push(whFilter);
  }
  if (productFilter) {
    where.push('es.product_id = ?');
    params.push(productFilter.toLowerCase());
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT es.*
    FROM external_stocks es
    INNER JOIN (
      SELECT warehouse_id, external_vendor_code, COALESCE(marketplace, '') AS mp_norm,
             MAX(synced_at) AS max_synced
      FROM external_stocks
      GROUP BY warehouse_id, external_vendor_code, mp_norm
    ) latest
      ON es.warehouse_id = latest.warehouse_id
      AND es.external_vendor_code = latest.external_vendor_code
      AND COALESCE(es.marketplace, '') = latest.mp_norm
      AND es.synced_at = latest.max_synced
    ${whereClause}
    ORDER BY es.external_vendor_code, es.marketplace
  `;

  const stmt = params.length ? c.env.DB.prepare(sql).bind(...params) : c.env.DB.prepare(sql);
  const result = await stmt.all();
  return ok(c, { stocks: result.results });
});

// ---------------------------------------------------------------------------
// GET /api/external-stocks/by-product
// Returns { [product_id]: { [warehouse_id]: { amount, reserve, repair, synced_at } } }
// Convenience for UI rendering of the `1146 (1140)` format on the warehouses page.
// ---------------------------------------------------------------------------
externalStocks.get('/by-product', async (c) => {
  const sql = `
    SELECT es.product_id, es.warehouse_id, es.external_vendor_code,
           SUM(es.amount) AS amount,
           SUM(es.reserve_amount) AS reserve_amount,
           SUM(es.repair_amount) AS repair_amount,
           MAX(es.synced_at) AS synced_at
    FROM external_stocks es
    INNER JOIN (
      SELECT warehouse_id, external_vendor_code, COALESCE(marketplace, '') AS mp_norm,
             MAX(synced_at) AS max_synced
      FROM external_stocks
      GROUP BY warehouse_id, external_vendor_code, mp_norm
    ) latest
      ON es.warehouse_id = latest.warehouse_id
      AND es.external_vendor_code = latest.external_vendor_code
      AND COALESCE(es.marketplace, '') = latest.mp_norm
      AND es.synced_at = latest.max_synced
    WHERE es.product_id IS NOT NULL
    GROUP BY es.product_id, es.warehouse_id
    ORDER BY es.product_id, es.warehouse_id
  `;
  const result = await c.env.DB.prepare(sql).all();
  return ok(c, { rows: result.results });
});

// ---------------------------------------------------------------------------
// POST /api/external-stocks/sync
// Pull /v1/products from Skladbot for every external-integrated warehouse,
// upsert into external_stocks, update warehouses.external_sync_at.
//
// Body (optional): { warehouse_id?: string }  to sync just one warehouse.
//
// Auth: requires F4_SKLADBOT_TOKEN to be set as Worker secret.
// ---------------------------------------------------------------------------
externalStocks.post('/sync', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { warehouse_id?: string };

  const token = c.env.F4_SKLADBOT_TOKEN;
  if (!token) {
    return fail(c, 500, 'config_error', 'F4_SKLADBOT_TOKEN secret not set');
  }

  // 1. Fetch external-integrated warehouses
  const whSql = body.warehouse_id
    ? 'SELECT id, external_provider, external_customer_id FROM warehouses WHERE id = ? AND external_provider IS NOT NULL AND deleted_at IS NULL'
    : 'SELECT id, external_provider, external_customer_id FROM warehouses WHERE external_provider IS NOT NULL AND deleted_at IS NULL';
  const whStmt = body.warehouse_id ? c.env.DB.prepare(whSql).bind(body.warehouse_id) : c.env.DB.prepare(whSql);
  const whResult = await whStmt.all();
  const warehouses = whResult.results as Array<{ id: string; external_provider: string; external_customer_id: number }>;

  if (warehouses.length === 0) {
    return ok(c, { synced: [], message: 'No external-integrated warehouses found' });
  }

  const now = Math.floor(Date.now() / 1000);
  const synced: Array<{ warehouse_id: string; rows: number; provider: string }> = [];

  // 2. Build SKU map (vendor_code uppercase -> product_id lowercase) — only need our products
  const ourProducts = await c.env.DB.prepare(
    'SELECT id FROM products WHERE deleted_at IS NULL'
  ).all();
  const ourIds = new Set((ourProducts.results as Array<{ id: string }>).map((p) => p.id));

  for (const wh of warehouses) {
    if (wh.external_provider !== 'f4_skladbot') continue;

    // 3. Pull from Skladbot
    const resp = await fetch('https://api.skladbot.ru/v1/products', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ customer_id: wh.external_customer_id, limit: 500 }),
    });

    if (!resp.ok) {
      synced.push({ warehouse_id: wh.id, rows: 0, provider: wh.external_provider });
      continue;
    }

    const payload = await resp.json() as {
      data: Record<string, Array<{
        name: string;
        vendor_code: string | null;
        product_id: number;
        system_product_id: number;
        barcode: string | null;
        marketplace: { id: number; text: string } | null;
        amount: number;
        reserve_amount: number;
        nominale_amount: number;
        repair_amount: number;
        cis_unused_total_amount: number;
      }>>;
    };

    // 4. Clear today's snapshot for this warehouse, then insert fresh
    await c.env.DB.prepare('DELETE FROM external_stocks WHERE warehouse_id = ?').bind(wh.id).run();

    // Flatten + insert (D1 has 100-variable limit, so insert one row at a time via batch)
    const inserts: D1PreparedStatement[] = [];
    for (const variants of Object.values(payload.data)) {
      for (const v of variants) {
        if (!v.vendor_code) continue;
        const productId = ourIds.has(v.vendor_code.toLowerCase()) ? v.vendor_code.toLowerCase() : null;
        inserts.push(
          c.env.DB.prepare(`
            INSERT INTO external_stocks (
              warehouse_id, product_id, external_vendor_code,
              external_system_product_id, external_product_id,
              marketplace, barcode, amount, reserve_amount,
              nominale_amount, repair_amount, cis_unused_total_amount,
              raw_json, synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            wh.id, productId, v.vendor_code,
            v.system_product_id || 0, v.product_id || 0,
            v.marketplace?.text || null, v.barcode || null,
            v.amount || 0, v.reserve_amount || 0,
            v.nominale_amount || 0, v.repair_amount || 0,
            v.cis_unused_total_amount || 0,
            JSON.stringify(v), now
          )
        );
      }
    }

    // Batch insert
    if (inserts.length > 0) {
      await c.env.DB.batch(inserts);
    }

    // Mark warehouse synced
    await c.env.DB.prepare('UPDATE warehouses SET external_sync_at = ? WHERE id = ?')
      .bind(now, wh.id).run();

    synced.push({ warehouse_id: wh.id, rows: inserts.length, provider: wh.external_provider });
  }

  return ok(c, { synced });
});

export default externalStocks;
