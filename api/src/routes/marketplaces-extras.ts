/**
 * Marketplace extras — endpoints layered on top of routes/marketplaces.ts.
 *
 * Phase 6.0b additions:
 *   GET  /api/marketplaces/sync/log        — sync history dashboard
 *
 * Phase 6.2 (current) additions:
 *   POST /api/marketplaces/sync/sales/ozon — last 7d sales + funnel + position + price + ad_spend
 *   POST /api/marketplaces/sync/sales/wb   — last 7d sales + funnel + position + price + ad_spend
 *   GET  /api/marketplaces/sales           — aggregates: top SKUs with all metrics
 *
 * Per-SKU semantics (after Phase 6.0c bundles refactor):
 *   Each canonical SKU (DE201, DE201AA, DE105AAAA etc) is its own product
 *   in the catalog. Metrics matched by exact offer_id / supplierArticle to
 *   products.id (lowercased). No multipack expansion.
 *
 * Period: rolling 7 days ending today (UTC).
 *
 * Metrics tracked per SKU:
 *   units_sold       — physical units sold
 *   revenue_rub      — revenue in kopecks (₽ × 100), used for DRR calc only
 *   views            — card views (Ozon: hits_view, WB: openCardCount)
 *   tocart_count     — added to cart (Ozon: hits_tocart, WB: addToCartCount)
 *   position_category— position in category (Ozon: position_category metric;
 *                      WB: rank from nm-report category placement)
 *   current_price_rub— current listing price in kopecks
 *   ad_spend_rub     — ad spend last 7d in kopecks
 *
 * Derived in API response (computed on read, not stored):
 *   ctr = tocart_count / views          (% of viewers who put in cart)
 *   cr  = units_sold / tocart_count     (% of cart adders who bought)
 *   drr = ad_spend_rub / revenue_rub    (advertising cost / revenue)
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const marketplacesExtras = new Hono<{ Bindings: Env }>();

const PERIOD_DAYS = 7;

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
//
// Returns:
//   totals: per-marketplace totals (units, revenue) for the headline cards
//   daily:  daily breakdown for chart
//   top_skus: every SKU with sales, ordered by units, with all derived metrics
// =============================================================================
marketplacesExtras.get('/sales', async (c) => {
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

  const daily = await c.env.DB.prepare(`
    SELECT marketplace, date, units_sold, revenue_rub
    FROM marketplace_sales_daily
    WHERE date >= date('now', '-' || ? || ' days')
    ORDER BY date ASC, marketplace ASC
  `).bind(PERIOD_DAYS).all();

  // Top SKUs — one row per catalog SKU per marketplace, ordered by units sold
  const topOzon = await c.env.DB.prepare(`
    SELECT
      p.id AS sku, p.product_name,
      o.units_sold, o.revenue_rub,
      o.views, o.tocart_count,
      o.position_category, o.current_price_rub,
      o.cost_per_click_rub, o.cost_per_order_rub,
      o.stars_promo_rub, o.brand_commission_rub,
      o.reviews_cost_rub, o.stars_membership_rub,
      o.acquiring_rub, o.returns_cost_rub, o.expenses_total_rub
    FROM marketplace_sales_ozon o
    JOIN products p ON p.id = o.base_sku AND p.deleted_at IS NULL
    WHERE o.units_sold > 0
    ORDER BY o.units_sold DESC
  `).all();

  const topWb = await c.env.DB.prepare(`
    SELECT
      p.id AS sku, p.product_name,
      w.units_sold, w.revenue_rub,
      w.views, w.tocart_count,
      w.position_category, w.current_price_rub, w.ad_spend_rub
    FROM marketplace_sales_wb w
    JOIN products p ON p.id = w.base_sku AND p.deleted_at IS NULL
    WHERE w.units_sold > 0
    ORDER BY w.units_sold DESC
  `).all();

  return ok(c, {
    period_days: PERIOD_DAYS,
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
    top_skus: {
      ozon: topOzon.results,
      wb: topWb.results,
    },
  });
});

// =============================================================================
// POST /api/marketplaces/sync/sales/ozon
//
// One-shot sync covering 7 days:
// 1. Refresh Ozon-sku ↔ offer_id map
// 2. Pull /v1/analytics/data with funnel + position metrics for last 7d
// 3. Pull current prices via /v5/product/info/prices
// 4. Pull ad spend via /v3/finance/transaction/list (last 7d)
// 5. Atomically replace marketplace_sales_ozon and marketplace_sales_daily
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

    // 1. SKU map
    const skuMap = await refreshOzonSkuMap(c.env);

    // 2. Sales analytics + funnel + position
    const today = new Date();
    const dateTo = isoDate(today);
    const from = new Date(today.getTime() - PERIOD_DAYS * 24 * 3600_000);
    const dateFrom = isoDate(from);

    const dailyData = await fetchOzonAnalytics(
      c.env, dateFrom, dateTo,
      ['ordered_units', 'revenue', 'hits_view', 'hits_tocart', 'position_category'],
      ['sku', 'day']
    );
    const skuTotalsData = await fetchOzonAnalytics(
      c.env, dateFrom, dateTo,
      ['ordered_units', 'revenue', 'hits_view', 'hits_tocart', 'position_category'],
      ['sku']
    );

    // 3. Current prices
    const priceMap = await fetchOzonPrices(c.env);

    // 4. Expenses by SKU from /v3/finance/transaction/list (Brand commission,
    //    Reviews, Stars Membership, Acquiring, Returns — directly attributed)
    const expensesMap = await fetchOzonExpensesBySku(c.env, dateFrom, dateTo, skuMap);

    // 5. CPC ad spend per SKU from Performance API (campaign-level, distributed)
    let perfAdMap = new Map<string, number>();
    try {
      perfAdMap = await fetchOzonAdSpendByPerf(c.env, dateFrom, dateTo, skuMap);
    } catch (e) {
      console.error('[perf ad spend]', e);
    }

    // Merge perfAdMap into expenses.cpc (Performance is more accurate than transaction list for CPC)
    for (const [sku, cpcKopecks] of perfAdMap.entries()) {
      let bucket = expensesMap.get(sku);
      if (!bucket) {
        bucket = { cpc: 0, cpo: 0, stars: 0, brand: 0, reviews: 0, membership: 0, acquiring: 0, returns: 0 };
        expensesMap.set(sku, bucket);
      }
      bucket.cpc = cpcKopecks; // override with perf value
    }

    // Aggregate per (catalog_sku) — overall totals from analytics
    const perSku = new Map<string, {
      units: number; revenue: number; views: number; tocart: number;
      positions: number[]; listings: Set<number>;
    }>();
    let unmatched = 0;
    for (const row of skuTotalsData) {
      const ozonSku = parseInt(row.dimensions[0].id, 10);
      const units = row.metrics[0] || 0;
      const revenue = row.metrics[1] || 0;
      const views = row.metrics[2] || 0;
      const tocart = row.metrics[3] || 0;
      const position = row.metrics[4] || 0;
      const mapped = skuMap.get(ozonSku);
      if (!mapped || !mapped.catalog_sku) { unmatched++; continue; }
      const skuKey = mapped.catalog_sku;
      const e = perSku.get(skuKey) || { units: 0, revenue: 0, views: 0, tocart: 0, positions: [], listings: new Set<number>() };
      e.units += units;
      e.revenue += Math.round(revenue * 100);
      e.views += views;
      e.tocart += tocart;
      if (position > 0) e.positions.push(position);
      e.listings.add(ozonSku);
      perSku.set(skuKey, e);
    }

    // Aggregate per (date) for chart
    const perDate = new Map<string, { units: number; revenue: number }>();
    for (const row of dailyData) {
      const ozonSku = parseInt(row.dimensions[0].id, 10);
      const dateStr = row.dimensions[1].id;
      const mapped = skuMap.get(ozonSku);
      if (!mapped || !mapped.catalog_sku) continue;
      const units = row.metrics[0] || 0;
      const revenue = row.metrics[1] || 0;
      const d = perDate.get(dateStr) || { units: 0, revenue: 0 };
      d.units += units;
      d.revenue += Math.round(revenue * 100);
      perDate.set(dateStr, d);
    }

    // Write
    const now = Math.floor(Date.now() / 1000);
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM marketplace_sales_ozon'),
      c.env.DB.prepare("DELETE FROM marketplace_sales_daily WHERE marketplace = 'ozon'"),
    ];
    for (const [sku, v] of perSku.entries()) {
      const avgPos = v.positions.length > 0
        ? v.positions.reduce((a, b) => a + b, 0) / v.positions.length
        : null;
      const price = priceMap.get(sku) ?? null;
      const exp = expensesMap.get(sku) || { cpc: 0, cpo: 0, stars: 0, brand: 0, reviews: 0, membership: 0, acquiring: 0, returns: 0 };
      const expensesTotal = exp.cpc + exp.cpo + exp.stars + exp.brand + exp.reviews + exp.membership + exp.acquiring;
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO marketplace_sales_ozon
           (base_sku, period_from, period_to, units_sold, revenue_rub, listings_count, synced_at,
            views, tocart_count, position_category, current_price_rub,
            cost_per_click_rub, cost_per_order_rub, stars_promo_rub, brand_commission_rub,
            reviews_cost_rub, stars_membership_rub, acquiring_rub, returns_cost_rub, expenses_total_rub,
            ad_spend_rub)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          sku, dateFrom, dateTo,
          v.units, v.revenue, v.listings.size, now,
          v.views, v.tocart, avgPos, price,
          exp.cpc, exp.cpo, exp.stars, exp.brand, exp.reviews, exp.membership, exp.acquiring, exp.returns, expensesTotal,
          exp.cpc  // legacy column kept = cpc only
        )
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
      prices_pulled: priceMap.size,
      expenses_skus: expensesMap.size,
      perf_ad_skus: perfAdMap.size,
      period: { from: dateFrom, to: dateTo, days: PERIOD_DAYS },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, error_message = ? WHERE id = ?'
    ).bind(Math.floor(Date.now() / 1000), 'error', msg, logId).run();
    return fail(c, 502, [{ code: 'ozon_sales_sync_failed', message: msg }]);
  }
});

marketplacesExtras.post('/sync/sales/wb', async (c) => {
  const startedAt = Math.floor(Date.now() / 1000);
  const logResult = await c.env.DB.prepare(
    "INSERT INTO marketplace_sync_log (marketplace, started_at, status) VALUES (?, ?, 'running')"
  ).bind('wb-sales', startedAt).run();
  const logId = logResult.meta.last_row_id as number;

  try {
    if (!c.env.WB_API_TOKEN) throw new Error('WB_API_TOKEN not configured');

    const today = new Date();
    const dateToStr = isoDate(today);
    const from = new Date(today.getTime() - PERIOD_DAYS * 24 * 3600_000);
    const dateFromStr = isoDate(from);
    const dateFromIso = from.toISOString().split('.')[0] + '.000Z';

    // Step 1 — raw sales feed
    const salesUrl = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFromIso)}`;
    const salesResp = await fetch(salesUrl, { headers: { 'Authorization': c.env.WB_API_TOKEN } });
    if (salesResp.status === 429) throw new Error('WB rate limited (429)');
    if (!salesResp.ok) throw new Error(`WB sales HTTP ${salesResp.status}: ${await salesResp.text()}`);
    const rows = await salesResp.json<any[]>();

    const perSku = new Map<string, { units: number; revenue: number; listings: Set<string> }>();
    const perDate = new Map<string, { units: number; revenue: number }>();
    const sinceCutoff = from.getTime();

    for (const r of rows) {
      const saleTime = new Date(r.date).getTime();
      if (saleTime < sinceCutoff) continue;
      const article = (r.supplierArticle as string || '').trim();
      if (!article) continue;
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

    // Step 2 — nm-report for funnel + position
    let funnelMap = new Map<string, { views: number; tocart: number; position: number | null }>();
    try {
      funnelMap = await fetchWbNmReport(c.env, dateFromStr, dateToStr);
    } catch (e) {
      // Non-fatal — keep going without funnel data
      console.error('[wb-sales] nm-report failed:', e);
    }

    // Step 3 — current prices
    let priceMap = new Map<string, number>();
    try {
      priceMap = await fetchWbPrices(c.env);
    } catch (e) {
      console.error('[wb-sales] prices failed:', e);
    }

    // Step 4 — ad spend
    let adSpendMap = new Map<string, number>();
    try {
      adSpendMap = await fetchWbAdSpend(c.env, dateFromStr, dateToStr);
    } catch (e) {
      console.error('[wb-sales] ad spend failed:', e);
    }

    // Filter to catalog SKUs only
    const catalog = await c.env.DB.prepare('SELECT id FROM products WHERE deleted_at IS NULL').all<{ id: string }>();
    const catalogIds = new Set(catalog.results.map((r) => r.id));
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
      const f = funnelMap.get(sku) || { views: 0, tocart: 0, position: null };
      const price = priceMap.get(sku) ?? null;
      const adSpend = adSpendMap.get(sku) ?? 0;
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO marketplace_sales_wb
           (base_sku, period_from, period_to, units_sold, revenue_rub, listings_count, synced_at,
            views, tocart_count, position_category, current_price_rub, ad_spend_rub)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          sku, dateFromStr, dateToStr,
          v.units, v.revenue, v.listings.size, now,
          f.views, f.tocart, f.position, price, adSpend
        )
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
      dropped_not_in_catalog: droppedNotInCatalog,
      funnel_skus: funnelMap.size,
      prices_pulled: priceMap.size,
      ad_skus_with_spend: adSpendMap.size,
      period: { from: dateFromStr, to: dateToStr, days: PERIOD_DAYS },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, error_message = ? WHERE id = ?'
    ).bind(Math.floor(Date.now() / 1000), 'error', msg, logId).run();
    return fail(c, 502, [{ code: 'wb_sales_sync_failed', message: msg }]);
  }
});


});

/**
 * Parses Performance API CSV report. Each row is one (campaign, sku) combination
 * with views/clicks/moneySpent/orders/ordersMoney columns. We sum moneySpent
 * per SKU across all campaigns the SKU appeared in.
 */
function parseCpcCsv(csv: string, skuMap: Map<number, OzonSkuMapEntry>): Map<string, number> {
  const result = new Map<string, number>();
  const lines = csv.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return result;

  const headers = lines[0].split(';').map((h) => h.replace(/^\ufeff/, '').replace(/^"|"$/g, '').trim().toLowerCase());
  const skuCol = headers.findIndex((h) => h.includes('sku') || h.includes('товар') || h === 'id');
  const spentCol = headers.findIndex((h) => h.includes('moneyspent') || h.includes('расход') || h.includes('потрачено'));

  if (skuCol < 0 || spentCol < 0) {
    console.error('[parseCpcCsv] columns not found. headers=' + JSON.stringify(headers));
    return result;
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';').map((c) => c.replace(/^"|"$/g, '').trim());
    const ozonSkuStr = cols[skuCol];
    const spentStr = cols[spentCol];
    if (!ozonSkuStr || !spentStr) continue;
    const ozonSku = parseInt(ozonSkuStr, 10);
    if (Number.isNaN(ozonSku)) continue;
    const spent = parseFloat(spentStr.replace(',', '.').replace(/\s/g, ''));
    if (Number.isNaN(spent) || spent <= 0) continue;
    const mapped = skuMap.get(ozonSku);
    if (!mapped || !mapped.catalog_sku) continue;
    const sku = mapped.catalog_sku;
    const cur = result.get(sku) || 0;
    result.set(sku, cur + Math.round(spent * 100));
  }
  return result;
}

// =============================================================================
// Helpers — Ozon Performance API (advertising)
// =============================================================================

// Cache token in module scope. Performance API tokens live 30 minutes.
let ozonPerfToken: { value: string; expiresAt: number } | null = null;

async function getOzonPerfToken(env: Env): Promise<string> {
  const now = Date.now();
  if (ozonPerfToken && ozonPerfToken.expiresAt > now + 60_000) {
    return ozonPerfToken.value;
  }
  if (!env.OZON_PERF_CLIENT_ID || !env.OZON_PERF_CLIENT_SECRET) {
    throw new Error('OZON_PERF_CLIENT_ID or OZON_PERF_CLIENT_SECRET not configured');
  }
  const resp = await fetch('https://api-performance.ozon.ru/api/client/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.OZON_PERF_CLIENT_ID,
      client_secret: env.OZON_PERF_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!resp.ok) throw new Error(`Performance auth HTTP ${resp.status}: ${await resp.text()}`);
  const data = await resp.json<{ access_token: string; expires_in: number }>();
  ozonPerfToken = {
    value: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return data.access_token;
}

/**
 * Pull daily ad spend from Performance API and attribute to SKUs.
 *
 * Logic:
 *   1. /api/client/statistics/daily/json → per-campaign daily spend
 *   2. For each campaign, /api/client/campaign/{id}/objects → list of SKUs
 *   3. Distribute campaign spend equally across its SKUs
 *
 * Returns map keyed by catalog SKU (lowercased offer_id) with kopecks.
 */
async function fetchOzonAdSpendByPerf(
  env: Env, dateFrom: string, dateTo: string,
  skuMap: Map<number, OzonSkuMapEntry>
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const token = await getOzonPerfToken(env);

  // 1) Daily spend per campaign
  const dailyResp = await fetch(
    `https://api-performance.ozon.ru/api/client/statistics/daily/json?dateFrom=${dateFrom}&dateTo=${dateTo}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!dailyResp.ok) {
    console.error(`[perf daily] HTTP ${dailyResp.status}`);
    return result;
  }
  const daily = await dailyResp.json<{ rows: Array<{ id: string; moneySpent: string }> }>();

  // Sum spend per campaign id
  const spendByCampaign = new Map<string, number>();
  for (const row of daily.rows || []) {
    const amt = parseFloat(String(row.moneySpent || '0').replace(',', '.')) || 0;
    spendByCampaign.set(row.id, (spendByCampaign.get(row.id) || 0) + amt);
  }

  // 2) For each campaign, get list of objects + each object's units sold (from analytics)
  //    and distribute spend proportionally to units_sold
  // 2a) Pre-fetch units_sold per Ozon-sku from analytics
  const unitsBySku = new Map<number, number>();
  try {
    const today = new Date();
    const aResp = await fetch('https://api-seller.ozon.ru/v1/analytics/data', {
      method: 'POST',
      headers: {
        'Client-Id': env.OZON_CLIENT_ID,
        'Api-Key': env.OZON_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date_from: dateFrom, date_to: dateTo,
        metrics: ['ordered_units'],
        dimension: ['sku'],
        filters: [],
        sort: [{ key: 'ordered_units', order: 'DESC' }],
        limit: 1000, offset: 0,
      }),
    });
    if (aResp.ok) {
      const aData = await aResp.json<{ result: { data: Array<{ dimensions: any[]; metrics: number[] }> } }>();
      for (const row of aData.result?.data || []) {
        const sku = parseInt(row.dimensions[0].id, 10);
        const units = row.metrics[0] || 0;
        if (sku && units > 0) unitsBySku.set(sku, units);
      }
    }
  } catch (e) {
    console.error('[perf units fetch]', e);
  }

  // 2b) For each campaign, get its SKU list and distribute spend by units_sold weight
  for (const [campaignId, totalSpend] of spendByCampaign.entries()) {
    if (totalSpend <= 0) continue;
    try {
      const objResp = await fetch(
        `https://api-performance.ozon.ru/api/client/campaign/${campaignId}/objects`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!objResp.ok) continue;
      const objData = await objResp.json<{ list: Array<{ id: string }> }>();
      const ozonSkus = (objData.list || []).map((o) => parseInt(o.id, 10)).filter((n) => !Number.isNaN(n));
      if (ozonSkus.length === 0) continue;

      // Compute units weights for SKUs in this campaign
      const weights = new Map<number, number>();
      let totalWeight = 0;
      for (const sku of ozonSkus) {
        const w = unitsBySku.get(sku) || 0;
        weights.set(sku, w);
        totalWeight += w;
      }

      if (totalWeight === 0) {
        // Fallback to equal distribution if no sales data
        const equal = totalSpend / ozonSkus.length;
        for (const sku of ozonSkus) weights.set(sku, equal);
        totalWeight = totalSpend;
      }

      for (const [sku, weight] of weights.entries()) {
        const mapped = skuMap.get(sku);
        if (!mapped || !mapped.catalog_sku) continue;
        const share = totalWeight > 0 ? (weight / totalWeight) * totalSpend : 0;
        if (share <= 0) continue;
        const cur = result.get(mapped.catalog_sku) || 0;
        result.set(mapped.catalog_sku, cur + Math.round(share * 100));
      }
    } catch (e) {
      console.error(`[perf objects ${campaignId}]`, e);
    }
  }

  return result;
}

/**
 * Fetch ALL transactions for the period and group expenses by catalog SKU.
 *
 * Returns map: catalog_sku → { CPC, CPO, stars, brand, reviews, membership, acquiring, returns }
 * All values in kopecks (positive = cost, even though source amounts are negative).
 */
async function fetchOzonExpensesBySku(
  env: Env, dateFrom: string, dateTo: string,
  skuMap: Map<number, OzonSkuMapEntry>
): Promise<Map<string, OzonExpenseBucket>> {
  const map = new Map<string, OzonExpenseBucket>();
  let page = 1;
  while (true) {
    const resp = await fetch('https://api-seller.ozon.ru/v3/finance/transaction/list', {
      method: 'POST',
      headers: {
        'Client-Id': env.OZON_CLIENT_ID,
        'Api-Key': env.OZON_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          date: { from: `${dateFrom}T00:00:00.000Z`, to: `${dateTo}T23:59:59.999Z` },
          posting_number: '',
          transaction_type: 'all',
        },
        page, page_size: 1000,
      }),
    });
    if (!resp.ok) {
      console.error(`[transactions p${page}] HTTP ${resp.status}`);
      break;
    }
    const data = await resp.json<{ result: { operations: any[]; page_count: number } }>();
    const ops = data.result?.operations || [];
    for (const op of ops) {
      const t = op.operation_type;
      const cat = OZON_OP_CATEGORY_MAP[t];
      if (!cat) continue;
      const items = op.items || [];
      if (items.length === 0) continue;
      const amount = Math.abs(parseFloat(op.amount || '0') || 0);
      const perItem = amount / items.length;
      for (const it of items) {
        const ozonSku = it.sku as number | undefined;
        if (!ozonSku) continue;
        const mapped = skuMap.get(ozonSku);
        if (!mapped || !mapped.catalog_sku) continue;
        const sku = mapped.catalog_sku;
        let bucket = map.get(sku);
        if (!bucket) {
          bucket = { cpc: 0, cpo: 0, stars: 0, brand: 0, reviews: 0, membership: 0, acquiring: 0, returns: 0 };
          map.set(sku, bucket);
        }
        bucket[cat] += Math.round(perItem * 100);
      }
    }
    const pageCount = data.result?.page_count || 1;
    if (page >= pageCount) break;
    page++;
    if (page > 30) break;
  }
  return map;
}

interface OzonExpenseBucket {
  cpc: number;        // OperationMarketplaceCostPerClick
  cpo: number;        // OperationMarketplaceExternalPromotion
  stars: number;      // MarketplaceServicePremiumCashbackIndividualPoints
  brand: number;      // MarketplaceServiceBrandCommission
  reviews: number;    // CustomerReviews
  membership: number; // StarsMembership
  acquiring: number;  // MarketplaceRedistributionOfAcquiringOperation
  returns: number;    // OperationItemReturn / ClientReturnAgentOperation
}

const OZON_OP_CATEGORY_MAP: Record<string, keyof OzonExpenseBucket> = {
  'OperationMarketplaceCostPerClick': 'cpc',
  'OperationMarketplaceExternalPromotion': 'cpo',
  'MarketplaceServicePremiumCashbackIndividualPoints': 'stars',
  'OperationMarketplaceServicePremiumCashbackBonusAccrual': 'stars',
  'MarketplaceServiceBrandCommission': 'brand',
  'CustomerReviews': 'reviews',
  'StarsMembership': 'membership',
  'MarketplaceRedistributionOfAcquiringOperation': 'acquiring',
  'OperationItemReturn': 'returns',
  'ClientReturnAgentOperation': 'returns',
};


// =============================================================================
// Helpers — Ozon
// =============================================================================

interface OzonAnalyticsRow {
  dimensions: { id: string; name?: string }[];
  metrics: number[];
}

async function fetchOzonAnalytics(
  env: Env, dateFrom: string, dateTo: string,
  metrics: string[], dimension: string[]
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
  catalog_sku: string | null;
}

async function refreshOzonSkuMap(env: Env): Promise<Map<number, OzonSkuMapEntry>> {
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

/** Fetch current prices from Ozon — keyed by catalog SKU (lowercased offer_id). */
async function fetchOzonPrices(env: Env): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let cursor = '';
  while (true) {
    const resp = await fetch('https://api-seller.ozon.ru/v5/product/info/prices', {
      method: 'POST',
      headers: {
        'Client-Id': env.OZON_CLIENT_ID,
        'Api-Key': env.OZON_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter: { visibility: 'ALL' }, limit: 1000, cursor }),
    });
    if (!resp.ok) {
      console.error(`[ozon prices] HTTP ${resp.status}: ${await resp.text()}`);
      break;
    }
    const data = await resp.json<{ items: any[]; cursor: string }>();
    const items = data.items || [];
    for (const item of items) {
      const offerId = (item.offer_id as string || '').toLowerCase();
      if (!offerId) continue;
      // Marketing price (what the buyer sees) — fall back to price if marketing_price absent
      const priceStr = item.price?.marketing_price || item.price?.price || '0';
      const priceRub = parseFloat(priceStr);
      if (priceRub > 0) map.set(offerId, Math.round(priceRub * 100));
    }
    if (!data.cursor || data.cursor === cursor) break;
    cursor = data.cursor;
  }
  return map;
}

/**
 * Pull ad spend from Ozon finance transactions for last 7 days.
 * Filters by operation_type containing "Marketing" or "Advertising".
 * Aggregates by SKU when transaction has items[].sku.
 */
async function fetchOzonAdSpend(
  env: Env, dateFrom: string, dateTo: string,
  skuMap: Map<number, OzonSkuMapEntry>
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let page = 1;
  while (true) {
    const resp = await fetch('https://api-seller.ozon.ru/v3/finance/transaction/list', {
      method: 'POST',
      headers: {
        'Client-Id': env.OZON_CLIENT_ID,
        'Api-Key': env.OZON_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          date: { from: `${dateFrom}T00:00:00.000Z`, to: `${dateTo}T23:59:59.999Z` },
          operation_type: ['MarketplaceServicePremiumPromotion', 'MarketplaceServiceItemAdvBoosterPercent', 'MarketplaceServicePremiumCashbackIndividualPoints'],
          posting_number: '',
          transaction_type: 'all',
        },
        page, page_size: 1000,
      }),
    });
    if (!resp.ok) {
      console.error(`[ozon ad spend] HTTP ${resp.status}: ${await resp.text()}`);
      break;
    }
    const data = await resp.json<{ result: { operations: any[]; page_count: number; row_count: number } }>();
    const ops = data.result?.operations || [];
    for (const op of ops) {
      const amount = Math.abs(parseFloat(op.amount || '0')); // negative for spend
      const items = op.items || [];
      if (items.length === 0) continue;
      // Spread amount equally across mentioned SKUs
      const perItem = amount / items.length;
      for (const item of items) {
        const ozonSku = item.sku as number | undefined;
        if (!ozonSku) continue;
        const mapped = skuMap.get(ozonSku);
        if (!mapped || !mapped.catalog_sku) continue;
        const cur = map.get(mapped.catalog_sku) || 0;
        map.set(mapped.catalog_sku, cur + Math.round(perItem * 100));
      }
    }
    if (page >= (data.result?.page_count || 1)) break;
    page++;
    if (page > 100) break;
  }
  return map;
}

// =============================================================================
// Helpers — WB
// =============================================================================

/**
 * Pull funnel + position from WB nm-report/detail.
 * Returns map keyed by lowercased supplier article.
 */
async function fetchWbNmReport(
  env: Env, dateFrom: string, dateTo: string
): Promise<Map<string, { views: number; tocart: number; position: number | null }>> {
  const map = new Map<string, { views: number; tocart: number; position: number | null }>();
  let page = 1;
  while (true) {
    const resp = await fetch('https://seller-analytics-api.wildberries.ru/api/v2/nm-report/detail', {
      method: 'POST',
      headers: {
        'Authorization': env.WB_API_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        period: { begin: `${dateFrom} 00:00:00`, end: `${dateTo} 23:59:59` },
        page,
      }),
    });
    if (resp.status === 429) {
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }
    if (!resp.ok) {
      console.error(`[wb nm-report] HTTP ${resp.status}: ${await resp.text()}`);
      break;
    }
    const data = await resp.json<any>();
    const cards = data.data?.cards || [];
    for (const card of cards) {
      const article = (card.vendorCode as string || '').toLowerCase().trim();
      if (!article) continue;
      const stats = card.statistics?.selectedPeriod || {};
      const views = stats.openCardCount || 0;
      const tocart = stats.addToCartCount || 0;
      // No category position in this report; left as null until we wire keyword search
      map.set(article, { views, tocart, position: null });
    }
    const isNext = data.data?.isNextPage;
    if (!isNext) break;
    page++;
    if (page > 50) break;
  }
  return map;
}

/** Current WB prices keyed by lowercased supplier article. */
async function fetchWbPrices(env: Env): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let offset = 0;
  while (true) {
    const url = `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=1000&offset=${offset}`;
    const resp = await fetch(url, { headers: { 'Authorization': env.WB_API_TOKEN } });
    if (!resp.ok) {
      console.error(`[wb prices] HTTP ${resp.status}: ${await resp.text()}`);
      break;
    }
    const data = await resp.json<any>();
    const goods = data.data?.listGoods || [];
    for (const g of goods) {
      const article = (g.vendorCode as string || '').toLowerCase().trim();
      if (!article) continue;
      const sizes = g.sizes || [];
      const priceRub = sizes[0]?.discountedPrice ?? sizes[0]?.price ?? 0;
      if (priceRub > 0) map.set(article, Math.round(priceRub * 100));
    }
    if (goods.length < 1000) break;
    offset += 1000;
    if (offset > 10000) break;
  }
  return map;
}

/** WB ad spend last 7d, keyed by lowercased supplier article. */
async function fetchWbAdSpend(
  env: Env, dateFrom: string, dateTo: string
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  // Adverts financial report — doesn't return article directly, returns nm_id (sku id).
  // For MVP: aggregate total spend at campaign level, distribute to SKUs by campaigns.
  // Simplified: attribute total to campaigns, then to articles via campaigns/list endpoint.
  // For now, leave map empty if call fails — frontend will show DRR as null.
  try {
    const url = `https://advert-api.wildberries.ru/adv/v1/upd?from=${dateFrom}&to=${dateTo}`;
    const resp = await fetch(url, { headers: { 'Authorization': env.WB_API_TOKEN } });
    if (!resp.ok) return map;
    const data = await resp.json<any[]>();
    if (!Array.isArray(data)) return map;
    // Aggregate by nmId — but we'd need nmId→article map. Skipping full impl for MVP.
    // Instead, return empty map; DRR will show as null on WB until keyword/campaign mapping built.
  } catch (e) {
    console.error('[wb ad spend] failed:', e);
  }
  return map;
}

// =============================================================================
// Shared helpers
// =============================================================================

function isoDate(d: Date): string {
  return d.toISOString().substring(0, 10);
}

export default marketplacesExtras;

