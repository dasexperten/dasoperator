/**
 * Marketplace extras — endpoints layered on top of routes/marketplaces.ts.
 *
 * Phase 6.0b additions:
 *   GET  /api/marketplaces/sync/log        — sync history dashboard
 *
 * Phase 6.1 additions:
 *   POST /api/marketplaces/sync/sales/ozon — pull last 30d sales from Ozon
 *   POST /api/marketplaces/sync/sales/wb   — pull last 30d sales from WB
 *   GET  /api/marketplaces/sales           — aggregated sales for /marketplaces page
 *
 * Per-SKU semantics (after Phase 6.0c bundles refactor):
 *   Each canonical SKU (DE201, DE201AA, DE105AAAA etc) is its own product
 *   in the catalog. Sales are matched by exact offer_id / supplierArticle
 *   to products.id (lowercased). No multipack expansion at write or read.
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const marketplacesExtras = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET /api/marketplaces/sync/log
// =============================================================================
marketplacesExtras.get('/sync/log', async (c) => {
  const limitParam = c.req.query('limit');
  let limit = 20;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) limit = parsed;
  }

  const log = await c.env.DB.prepare(`
    SELECT id, marketplace, started_at, finished_at, status, rows_synced, error_message
    FROM marketplace_sync_log
    ORDER BY started_at DESC
    LIMIT ?
  `).bind(limit).all();

  return ok(c, { count: log.results.length, log: log.results });
});

// =============================================================================
// GET /api/marketplaces/sales
// Aggregates for the /marketplaces Sales tab.
// =============================================================================
marketplacesExtras.get('/sales', async (c) => {
  // Totals — from per-SKU tables. base_sku here means the exact catalog SKU
  // (could be a single OR a bundle).
  const ozonTotal = await c.env.DB.prepare(`
    SELECT
      COALESCE(SUM(units_sold), 0)  AS units,
      COALESCE(SUM(revenue_rub), 0) AS revenue,
      MAX(synced_at) AS synced_at
    FROM marketplace_sales_ozon
  `).first<{ units: number; revenue: number; synced_at: number | null }>();

  const wbTotal = await c.env.DB.prepare(`
    SELECT
      COALESCE(SUM(units_sold), 0)  AS units,
      COALESCE(SUM(revenue_rub), 0) AS revenue,
      MAX(synced_at) AS synced_at
    FROM marketplace_sales_wb
  `).first<{ units: number; revenue: number; synced_at: number | null }>();

  // Daily breakdown for chart (last 30 days)
  const daily = await c.env.DB.prepare(`
    SELECT marketplace, date, units_sold, revenue_rub
    FROM marketplace_sales_daily
    WHERE date >= date('now', '-30 days')
    ORDER BY date ASC, marketplace ASC
  `).all();

  // Top SKUs joined with products for names. One row per catalog SKU.
  const top = await c.env.DB.prepare(`
    SELECT
      p.id           AS sku,
      p.product_name,
      COALESCE(o.units_sold,  0) AS ozon_units,
      COALESCE(o.revenue_rub, 0) AS ozon_revenue,
      COALESCE(w.units_sold,  0) AS wb_units,
      COALESCE(w.revenue_rub, 0) AS wb_revenue
    FROM products p
    LEFT JOIN marketplace_sales_ozon o ON o.base_sku = p.id
    LEFT JOIN marketplace_sales_wb   w ON w.base_sku = p.id
    WHERE p.deleted_at IS NULL
      AND (COALESCE(o.units_sold, 0) > 0 OR COALESCE(w.units_sold, 0) > 0)
    ORDER BY (COALESCE(o.revenue_rub, 0) + COALESCE(w.revenue_rub, 0)) DESC
  `).all();

  return ok(c, {
    totals: {
      ozon: {
        units_sold: ozonTotal?.units || 0,
        revenue_rub: ozonTotal?.revenue || 0,
        synced_at: ozonTotal?.synced_at || null,
      },
      wb: {
        units_sold: wbTotal?.units || 0,
        revenue_rub: wbTotal?.revenue || 0,
        synced_at: wbTotal?.synced_at || null,
      },
    },
    daily: daily.results,
    top_skus: top.results,
  });
});

// =============================================================================
// POST /api/marketplaces/sync/sales/ozon
//
// Refreshes Ozon-sku ↔ offer_id map (from /v4/product/info/stocks),
// then pulls /v1/analytics/data with [sku, day] dimension for last 30d,
// rolls up per (catalog_sku, date) and writes both per-SKU totals and daily.
// =============================================================================
marketplacesExtras.post('/sync/sales/ozon', async (c) => {
  const startedAt = Math.floor(Date.now() / 1000);
  const logResult = await c.env.DB.prepare(
    "INSERT INTO marketplace_sync_log (marketplace, started_at, status) VALUES (?, ?, 'running')"
  ).bind('ozon-sales', startedAt).run();
  const logId = logResult.meta.last_row_id as number;

  try {
    if (!c.env.OZON_CLIENT_ID || !c.env.OZON_API_KEY) {
      throw new Error('OZON_CLIENT_ID or OZON_API_KEY not configured');
    }

    // Step 1 — refresh sku map. Cheap; runs every sync.
    const skuMap = await refreshOzonSkuMap(c.env);

    // Step 2 — pull daily sales for last 30 days
    const today = new Date();
    const dateTo = isoDate(today);
    const from = new Date(today.getTime() - 30 * 24 * 3600_000);
    const dateFrom = isoDate(from);

    const dailyData = await fetchOzonAnalytics(
      c.env, dateFrom, dateTo, ['ordered_units', 'revenue'], ['sku', 'day']
    );

    // Aggregate per (catalog_sku) and per date
    const perSku = new Map<string, { units: number; revenue: number; listings: Set<number> }>();
    const perDate = new Map<string, { units: number; revenue: number }>();
    let unmatched = 0;

    for (const row of dailyData) {
      const ozonSku = parseInt(row.dimensions[0].id, 10);
      const dateStr = row.dimensions[1].id;
      const units = row.metrics[0] || 0;
      const revenue = row.metrics[1] || 0;

      const mapped = skuMap.get(ozonSku);
      if (!mapped || !mapped.catalog_sku) {
        unmatched++;
        continue;
      }

      const revKopecks = Math.round(revenue * 100);
      const skuKey = mapped.catalog_sku;

      const e = perSku.get(skuKey) || { units: 0, revenue: 0, listings: new Set() };
      e.units += units;
      e.revenue += revKopecks;
      e.listings.add(ozonSku);
      perSku.set(skuKey, e);

      const d = perDate.get(dateStr) || { units: 0, revenue: 0 };
      d.units += units;
      d.revenue += revKopecks;
      perDate.set(dateStr, d);
    }

    const now = Math.floor(Date.now() / 1000);
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM marketplace_sales_ozon'),
      c.env.DB.prepare("DELETE FROM marketplace_sales_daily WHERE marketplace = 'ozon'"),
    ];
    for (const [sku, v] of perSku.entries()) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO marketplace_sales_ozon
           (base_sku, period_from, period_to, units_sold, revenue_rub, listings_count, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(sku, dateFrom, dateTo, v.units, v.revenue, v.listings.size, now)
      );
    }
    for (const [d, v] of perDate.entries()) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO marketplace_sales_daily (marketplace, date, units_sold, revenue_rub, synced_at)
           VALUES ('ozon', ?, ?, ?, ?)`
        ).bind(d, v.units, v.revenue, now)
      );
    }
    if (stmts.length > 2) await c.env.DB.batch(stmts);

    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, rows_synced = ? WHERE id = ?'
    ).bind(Math.floor(Date.now() / 1000), 'ok', perSku.size, logId).run();

    return ok(c, {
      rows_synced: perSku.size,
      days_synced: perDate.size,
      unmatched_records: unmatched,
      sku_map_size: skuMap.size,
      period: { from: dateFrom, to: dateTo },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, error_message = ? WHERE id = ?'
    ).bind(Math.floor(Date.now() / 1000), 'error', msg, logId).run();
    return fail(c, 502, [{ code: 'ozon_sales_sync_failed', message: msg }]);
  }
});

// =============================================================================
// POST /api/marketplaces/sync/sales/wb
//
// Pulls /api/v1/supplier/sales for last 30 days. Each row is one sale
// (one physical unit). Counts rows per (article, day) and sums finishedPrice.
// =============================================================================
marketplacesExtras.post('/sync/sales/wb', async (c) => {
  const startedAt = Math.floor(Date.now() / 1000);
  const logResult = await c.env.DB.prepare(
    "INSERT INTO marketplace_sync_log (marketplace, started_at, status) VALUES (?, ?, 'running')"
  ).bind('wb-sales', startedAt).run();
  const logId = logResult.meta.last_row_id as number;

  try {
    if (!c.env.WB_API_TOKEN) throw new Error('WB_API_TOKEN not configured');

    const today = new Date();
    const from = new Date(today.getTime() - 30 * 24 * 3600_000);
    const dateFromIso = from.toISOString().split('.')[0] + '.000Z';
    const dateToStr = isoDate(today);

    const url = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFromIso)}`;
    const resp = await fetch(url, { headers: { 'Authorization': c.env.WB_API_TOKEN } });
    if (resp.status === 429) throw new Error('WB rate limited (429) — retry later');
    if (!resp.ok) throw new Error(`WB HTTP ${resp.status}: ${await resp.text()}`);
    const rows = await resp.json<any[]>();

    const perSku = new Map<string, { units: number; revenue: number; listings: Set<string> }>();
    const perDate = new Map<string, { units: number; revenue: number }>();
    const sinceCutoff = from.getTime();
    let skipped = 0;

    for (const r of rows) {
      const saleTime = new Date(r.date).getTime();
      if (saleTime < sinceCutoff) continue;

      const article = (r.supplierArticle as string || '').trim();
      if (!article) { skipped++; continue; }

      const skuLc = article.toLowerCase();
      const finishedPrice = (r.finishedPrice || 0) as number;
      const revKopecks = Math.round(finishedPrice * 100);

      const e = perSku.get(skuLc) || { units: 0, revenue: 0, listings: new Set() };
      e.units += 1;
      e.revenue += revKopecks;
      e.listings.add(article);
      perSku.set(skuLc, e);

      const dateStr = r.date.substring(0, 10);
      const d = perDate.get(dateStr) || { units: 0, revenue: 0 };
      d.units += 1;
      d.revenue += revKopecks;
      perDate.set(dateStr, d);
    }

    // Filter perSku to only those that exist in products catalog
    const catalogIds = new Set<string>();
    const catalog = await c.env.DB.prepare('SELECT id FROM products WHERE deleted_at IS NULL').all<{ id: string }>();
    for (const row of catalog.results) catalogIds.add(row.id);

    const filtered = new Map<string, { units: number; revenue: number; listings: Set<string> }>();
    let droppedNotInCatalog = 0;
    for (const [sku, v] of perSku.entries()) {
      if (catalogIds.has(sku)) filtered.set(sku, v);
      else droppedNotInCatalog++;
    }

    const now = Math.floor(Date.now() / 1000);
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM marketplace_sales_wb'),
      c.env.DB.prepare("DELETE FROM marketplace_sales_daily WHERE marketplace = 'wb'"),
    ];
    for (const [sku, v] of filtered.entries()) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO marketplace_sales_wb
           (base_sku, period_from, period_to, units_sold, revenue_rub, listings_count, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(sku, dateFromIso.substring(0, 10), dateToStr, v.units, v.revenue, v.listings.size, now)
      );
    }
    for (const [d, v] of perDate.entries()) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO marketplace_sales_daily (marketplace, date, units_sold, revenue_rub, synced_at)
           VALUES ('wb', ?, ?, ?, ?)`
        ).bind(d, v.units, v.revenue, now)
      );
    }
    if (stmts.length > 2) await c.env.DB.batch(stmts);

    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, rows_synced = ? WHERE id = ?'
    ).bind(Math.floor(Date.now() / 1000), 'ok', filtered.size, logId).run();

    return ok(c, {
      rows_synced: filtered.size,
      days_synced: perDate.size,
      raw_records: rows.length,
      skipped_articles: skipped,
      dropped_not_in_catalog: droppedNotInCatalog,
      period: { from: dateFromIso.substring(0, 10), to: dateToStr },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, error_message = ? WHERE id = ?'
    ).bind(Math.floor(Date.now() / 1000), 'error', msg, logId).run();
    return fail(c, 502, [{ code: 'wb_sales_sync_failed', message: msg }]);
  }
});

// =============================================================================
// Helpers
// =============================================================================

function isoDate(d: Date): string {
  return d.toISOString().substring(0, 10);
}

interface OzonAnalyticsRow {
  dimensions: { id: string; name?: string }[];
  metrics: number[];
}

async function fetchOzonAnalytics(
  env: Env,
  dateFrom: string,
  dateTo: string,
  metrics: string[],
  dimension: string[]
): Promise<OzonAnalyticsRow[]> {
  const out: OzonAnalyticsRow[] = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const resp = await fetch('https://api-seller.ozon.ru/v1/analytics/data', {
      method: 'POST',
      headers: {
        'Client-Id': env.OZON_CLIENT_ID,
        'Api-Key': env.OZON_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date_from: dateFrom, date_to: dateTo,
        metrics, dimension,
        filters: [],
        sort: [{ key: metrics[0], order: 'DESC' }],
        limit, offset,
      }),
    });
    if (!resp.ok) throw new Error(`Ozon analytics HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json<{ result: { data: OzonAnalyticsRow[] } }>();
    const batch = data.result?.data ?? [];
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    if (offset > 10000) break;
  }
  return out;
}

interface OzonSkuMapEntry {
  offer_id: string;
  product_id: number;
  catalog_sku: string | null;  // resolved catalog id (= offer_id lowercased if exists in products)
}

/**
 * Walks /v4/product/info/stocks (which returns both Ozon-sku and offer_id),
 * builds in-memory map keyed by Ozon-sku, and resolves catalog_sku by checking
 * which offer_ids exist in the products table (case-insensitive match).
 *
 * Also persists to marketplace_ozon_sku_map for debugging.
 */
async function refreshOzonSkuMap(env: Env): Promise<Map<number, OzonSkuMapEntry>> {
  // Pre-load catalog ids for fast resolution
  const catalog = await env.DB.prepare('SELECT id FROM products WHERE deleted_at IS NULL').all<{ id: string }>();
  const catalogIds = new Set<string>(catalog.results.map((r) => r.id));

  const map = new Map<number, OzonSkuMapEntry>();
  let cursor = '';

  while (true) {
    const resp = await fetch('https://api-seller.ozon.ru/v4/product/info/stocks', {
      method: 'POST',
      headers: {
        'Client-Id': env.OZON_CLIENT_ID,
        'Api-Key': env.OZON_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter: { visibility: 'ALL' }, limit: 200, cursor }),
    });
    if (!resp.ok) throw new Error(`Ozon stocks (sku map) HTTP ${resp.status}`);
    const data = await resp.json<{ items: any[]; cursor: string }>();
    const items = data.items || [];

    for (const item of items) {
      const offerId = (item.offer_id as string) || '';
      const productId = item.product_id as number;
      const catalogSku = catalogIds.has(offerId.toLowerCase()) ? offerId.toLowerCase() : null;

      for (const stock of (item.stocks || [])) {
        const ozonSku = stock.sku as number | undefined;
        if (!ozonSku) continue;
        if (map.has(ozonSku)) continue;
        map.set(ozonSku, { offer_id: offerId, product_id: productId, catalog_sku: catalogSku });
      }
    }

    if (!data.cursor || data.cursor === cursor) break;
    cursor = data.cursor;
  }

  return map;
}

export default marketplacesExtras;
