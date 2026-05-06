// =============================================================================
// Marketplace stocks routes (Phase 6.0)
//
// Pulls fresh stock snapshots from Ozon Seller API and Wildberries Statistics
// API into D1 tables marketplace_stocks_ozon / marketplace_stocks_wb.
//
// Multipack convention (Das Experten product line):
//   no suffix    = 1 unit per listing
//   suffix AA    = 2 units per listing
//   suffix AAAA  = 4 units per listing
//
// Aggregation to canonical SKU happens at read time:
//   physical_units = SUM(qty * pack_factor)
//
// Read endpoint (no API call out — pure D1 read):
//   GET /api/marketplaces/stocks
//     → { sku → { ozon, wb, ozon_listings, wb_listings } } per canonical SKU
//   GET /api/marketplaces/sync/status
//     → last sync attempt per marketplace
//
// Sync endpoints (live calls out to marketplaces):
//   POST /api/marketplaces/sync/ozon
//   POST /api/marketplaces/sync/wb
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const marketplaces = new Hono<{ Bindings: Env }>();

// -----------------------------------------------------------------------------
// Article parser — strips multipack suffix, returns canonical sku + multiplier.
// -----------------------------------------------------------------------------
function parseArticle(article: string | null | undefined): { base_sku: string | null; pack_factor: 1 | 2 | 4 } {
  if (!article) return { base_sku: null, pack_factor: 1 };
  const a = article.trim().toUpperCase();
  const m = a.match(/^(DE\d+)(AA|AAAA)?$/);
  if (!m) return { base_sku: null, pack_factor: 1 };
  const base = m[1].toLowerCase();
  const suffix = m[2];
  const factor = suffix === 'AAAA' ? 4 : suffix === 'AA' ? 2 : 1;
  return { base_sku: base, pack_factor: factor };
}

// =============================================================================
// GET /api/marketplaces/stocks
// Aggregated per canonical SKU. Multipack listings already multiplied by
// pack_factor at read time. Used by /warehouses page columns.
// =============================================================================
marketplaces.get('/stocks', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT
      p.id AS sku,
      p.product_name,
      COALESCE(o.units, 0)    AS ozon,
      COALESCE(o.listings, 0) AS ozon_listings,
      COALESCE(w.units, 0)    AS wb,
      COALESCE(w.listings, 0) AS wb_listings
    FROM products p
    LEFT JOIN (
      SELECT base_sku,
             SUM(fbo_available * pack_factor) AS units,
             COUNT(*) AS listings
      FROM marketplace_stocks_ozon
      GROUP BY base_sku
    ) o ON o.base_sku = p.id
    LEFT JOIN (
      SELECT base_sku,
             SUM(quantity * pack_factor) AS units,
             COUNT(*) AS listings
      FROM marketplace_stocks_wb
      GROUP BY base_sku
    ) w ON w.base_sku = p.id
    WHERE p.deleted_at IS NULL
    ORDER BY p.id
  `).all();

  // Last sync timestamps for both marketplaces
  const lastSync = await c.env.DB.prepare(`
    SELECT marketplace, MAX(finished_at) AS finished_at
    FROM marketplace_sync_log
    WHERE status = 'ok'
    GROUP BY marketplace
  `).all<{ marketplace: string; finished_at: number }>();

  const syncedAt: Record<string, number | null> = { ozon: null, wb: null };
  for (const row of lastSync.results) syncedAt[row.marketplace] = row.finished_at;

  return ok(c, {
    count: result.results.length,
    synced_at: syncedAt,
    products: result.results,
  });
});

// =============================================================================
// GET /api/marketplaces/sync/status
// =============================================================================
marketplaces.get('/sync/status', async (c) => {
  const log = await c.env.DB.prepare(`
    SELECT marketplace, started_at, finished_at, status, rows_synced, error_message
    FROM marketplace_sync_log
    ORDER BY started_at DESC
    LIMIT 10
  `).all();
  return ok(c, { recent: log.results });
});

// =============================================================================
// POST /api/marketplaces/sync/ozon
// =============================================================================
marketplaces.post('/sync/ozon', async (c) => {
  const startedAt = Math.floor(Date.now() / 1000);
  const logId = await beginSync(c.env, 'ozon', startedAt);

  try {
    if (!c.env.OZON_CLIENT_ID || !c.env.OZON_API_KEY) {
      throw new Error('OZON_CLIENT_ID / OZON_API_KEY secrets not configured');
    }

    const res = await fetch('https://api-seller.ozon.ru/v4/product/info/stocks', {
      method: 'POST',
      headers: {
        'Client-Id': c.env.OZON_CLIENT_ID,
        'Api-Key': c.env.OZON_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter: { visibility: 'ALL' }, limit: 200, cursor: '' }),
    });

    if (!res.ok) throw new Error(`Ozon HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json<{ items: any[] }>();
    const items = data.items || [];

    const rows: Array<{
      offer_id: string; product_id: number; base_sku: string; pack_factor: number;
      fbo_available: number; fbo_reserved: number; fbs_available: number;
    }> = [];
    const skipped: string[] = [];

    for (const item of items) {
      const offerId = item.offer_id || '';
      const { base_sku, pack_factor } = parseArticle(offerId);
      if (!base_sku) { skipped.push(offerId); continue; }

      let fboAvail = 0, fboRes = 0, fbsAvail = 0;
      for (const s of item.stocks || []) {
        if (s.type === 'fbo') {
          fboAvail += s.present || 0;
          fboRes   += s.reserved || 0;
        } else if (s.type === 'fbs') {
          fbsAvail += s.present || 0;
        }
      }
      rows.push({
        offer_id: offerId, product_id: item.product_id || 0,
        base_sku, pack_factor,
        fbo_available: fboAvail, fbo_reserved: fboRes, fbs_available: fbsAvail,
      });
    }

    // Replace whole table inside one batch (atomic-ish for D1)
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM marketplace_stocks_ozon'),
    ];
    const now = Math.floor(Date.now() / 1000);
    for (const r of rows) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO marketplace_stocks_ozon
           (offer_id, product_id, base_sku, pack_factor,
            fbo_available, fbo_reserved, fbs_available, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          r.offer_id, r.product_id, r.base_sku, r.pack_factor,
          r.fbo_available, r.fbo_reserved, r.fbs_available, now
        )
      );
    }
    await c.env.DB.batch(stmts);

    await finishSync(c.env, logId, 'ok', rows.length, null);
    return ok(c, { synced: rows.length, skipped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishSync(c.env, logId, 'error', 0, msg);
    return fail(c, 502, [{ code: 'ozon_sync_failed', message: msg }]);
  }
});

// =============================================================================
// POST /api/marketplaces/sync/wb
// WB Statistics endpoint is heavily rate-limited (~1 req/min).
// =============================================================================
marketplaces.post('/sync/wb', async (c) => {
  const startedAt = Math.floor(Date.now() / 1000);
  const logId = await beginSync(c.env, 'wb', startedAt);

  try {
    if (!c.env.WB_API_TOKEN) throw new Error('WB_API_TOKEN secret not configured');

    // dateFrom = beginning of current month is safe — WB returns full snapshot anyway.
    const now = new Date();
    const dateFrom = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
    const url = `https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=${encodeURIComponent(dateFrom)}`;

    const res = await fetch(url, { headers: { 'Authorization': c.env.WB_API_TOKEN } });
    if (res.status === 429) throw new Error('WB rate limited (429) — try again in 60-180s');
    if (!res.ok) throw new Error(`WB HTTP ${res.status}: ${await res.text()}`);
    const rows = await res.json<any[]>();

    // Aggregate warehouse-level rows by supplierArticle
    const agg = new Map<string, {
      nm_id: number; quantity: number; in_to: number; in_from: number; full: number;
    }>();
    for (const r of rows) {
      const art = r.supplierArticle || '';
      const cur = agg.get(art) || { nm_id: 0, quantity: 0, in_to: 0, in_from: 0, full: 0 };
      cur.nm_id = r.nmId || 0;
      cur.quantity   += r.quantity || 0;
      cur.in_to      += r.inWayToClient || 0;
      cur.in_from    += r.inWayFromClient || 0;
      cur.full       += r.quantityFull || 0;
      agg.set(art, cur);
    }

    const final: Array<[string, number, string, number, number, number, number, number]> = [];
    const skipped: string[] = [];
    for (const [art, v] of agg.entries()) {
      const { base_sku, pack_factor } = parseArticle(art);
      if (!base_sku) { skipped.push(art); continue; }
      final.push([art, v.nm_id, base_sku, pack_factor, v.quantity, v.in_to, v.in_from, v.full]);
    }

    const ts = Math.floor(Date.now() / 1000);
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM marketplace_stocks_wb'),
    ];
    for (const r of final) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO marketplace_stocks_wb
           (supplier_article, nm_id, base_sku, pack_factor,
            quantity, in_way_to_client, in_way_from_client, quantity_full, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(...r, ts)
      );
    }
    await c.env.DB.batch(stmts);

    await finishSync(c.env, logId, 'ok', final.length, null);
    return ok(c, { synced: final.length, skipped, raw_rows: rows.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishSync(c.env, logId, 'error', 0, msg);
    return fail(c, 502, [{ code: 'wb_sync_failed', message: msg }]);
  }
});

// -----------------------------------------------------------------------------
// Sync log helpers
// -----------------------------------------------------------------------------
async function beginSync(env: Env, mp: 'ozon' | 'wb', startedAt: number): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO marketplace_sync_log (marketplace, started_at, status) VALUES (?, ?, 'running')`
  ).bind(mp, startedAt).run();
  return r.meta.last_row_id as number;
}

async function finishSync(env: Env, logId: number, status: 'ok' | 'error', rows: number, err: string | null) {
  await env.DB.prepare(
    `UPDATE marketplace_sync_log SET finished_at = ?, status = ?, rows_synced = ?, error_message = ? WHERE id = ?`
  ).bind(Math.floor(Date.now() / 1000), status, rows, err, logId).run();
}

export default marketplaces;
