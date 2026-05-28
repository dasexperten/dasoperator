/**
 * Marketplace stocks routes.
 *
 * Three responsibilities:
 *   - GET /api/marketplaces/stocks — aggregated view per canonical SKU
 *   - POST /api/marketplaces/sync/ozon — pull fresh data from Ozon Seller API
 *   - POST /api/marketplaces/sync/wb   — pull fresh data from Wildberries API
 *   - GET /api/marketplaces/health — last successful sync timestamps
 *
 * Sync endpoints update marketplace_stocks_ozon / marketplace_stocks_wb tables
 * by upserting per-article rows. The marketplace_sync_log table records each
 * attempt for ops visibility.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { parseMarketplaceArticle } from '../lib/marketplace-articles';

const marketplaces = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /api/marketplaces/stocks
// Returns aggregated marketplace stock per canonical SKU.
//   { stocks: [ { base_sku, ozon_units, wb_units, ozon_synced_at, wb_synced_at } ] }
// ---------------------------------------------------------------------------
marketplaces.get('/stocks', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT
      p.id AS base_sku,
      COALESCE(oz.qty, 0) AS ozon_units,
      COALESCE(wb.qty, 0) AS wb_units,
      oz.synced_at AS ozon_synced_at,
      wb.synced_at AS wb_synced_at
    FROM products p
    LEFT JOIN (
      SELECT LOWER(offer_id) AS sku_lc,
             SUM(fbo_available) AS qty,
             MAX(synced_at) AS synced_at
      FROM marketplace_stocks_ozon
      GROUP BY LOWER(offer_id)
    ) oz ON oz.sku_lc = p.id
    LEFT JOIN (
      SELECT LOWER(supplier_article) AS sku_lc,
             SUM(quantity) AS qty,
             MAX(synced_at) AS synced_at
      FROM marketplace_stocks_wb
      GROUP BY LOWER(supplier_article)
    ) wb ON wb.sku_lc = p.id
    WHERE p.deleted_at IS NULL
    ORDER BY p.id
  `).all();

  return ok(c, { stocks: rows.results });
});

// ---------------------------------------------------------------------------
// GET /api/marketplaces/health
// Latest sync log entries for both marketplaces.
// ---------------------------------------------------------------------------
marketplaces.get('/health', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT marketplace, started_at, finished_at, status, rows_synced, error_message
    FROM marketplace_sync_log
    WHERE id IN (
      SELECT MAX(id) FROM marketplace_sync_log GROUP BY marketplace
    )
  `).all();

  const byMarketplace: Record<string, unknown> = { ozon: null, wb: null };
  for (const r of rows.results as Array<Record<string, unknown>>) {
    byMarketplace[r.marketplace as string] = r;
  }
  return ok(c, byMarketplace);
});

// ---------------------------------------------------------------------------
// POST /api/marketplaces/sync/ozon
// Pulls all stocks from Ozon Seller API and upserts into marketplace_stocks_ozon.
// ---------------------------------------------------------------------------
marketplaces.post('/sync/ozon', async (c) => {
  const startedAt = Math.floor(Date.now() / 1000);

  const logResult = await c.env.DB.prepare(
    'INSERT INTO marketplace_sync_log (marketplace, started_at, status) VALUES (?, ?, ?)'
  ).bind('ozon', startedAt, 'running').run();
  const logId = logResult.meta.last_row_id;

  try {
    const clientId = c.env.OZON_CLIENT_ID;
    const apiKey = c.env.OZON_API_KEY;
    if (!clientId || !apiKey) {
      throw new Error('OZON_CLIENT_ID or OZON_API_KEY not configured');
    }

    let cursor = '';
    let totalSynced = 0;
    const unmatched: string[] = [];

    while (true) {
      const resp = await fetch('https://api-seller.ozon.ru/v4/product/info/stocks', {
        method: 'POST',
        headers: {
          'Client-Id': clientId,
          'Api-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filter: { visibility: 'ALL' }, limit: 200, cursor }),
      });
      if (!resp.ok) {
        throw new Error(`Ozon API ${resp.status}: ${await resp.text()}`);
      }
      const data = (await resp.json()) as {
        items: Array<{
          offer_id: string;
          product_id: number;
          stocks: Array<{ type: string; present: number; reserved: number }>;
        }>;
        cursor: string;
      };

      const now = Math.floor(Date.now() / 1000);
      const stmts = [];
      for (const item of data.items) {
        const { baseSku, packFactor } = parseMarketplaceArticle(item.offer_id);
        if (!baseSku) {
          unmatched.push(item.offer_id);
          continue;
        }
        const fboAv = item.stocks
          .filter((s) => s.type === 'fbo')
          .reduce((sum, s) => sum + (s.present || 0), 0);
        const fboRe = item.stocks
          .filter((s) => s.type === 'fbo')
          .reduce((sum, s) => sum + (s.reserved || 0), 0);
        const fbsAv = item.stocks
          .filter((s) => s.type === 'fbs')
          .reduce((sum, s) => sum + (s.present || 0), 0);

        stmts.push(
          c.env.DB.prepare(`
            INSERT INTO marketplace_stocks_ozon
              (offer_id, product_id, base_sku, pack_factor, fbo_available, fbo_reserved, fbs_available, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(offer_id) DO UPDATE SET
              product_id = excluded.product_id,
              base_sku = excluded.base_sku,
              pack_factor = excluded.pack_factor,
              fbo_available = excluded.fbo_available,
              fbo_reserved = excluded.fbo_reserved,
              fbs_available = excluded.fbs_available,
              synced_at = excluded.synced_at
          `).bind(item.offer_id, item.product_id, baseSku, packFactor, fboAv, fboRe, fbsAv, now)
        );
      }
      if (stmts.length > 0) {
        await c.env.DB.batch(stmts);
        totalSynced += stmts.length;
      }

      if (!data.cursor || data.cursor === cursor) break;
      cursor = data.cursor;
    }

    const finishedAt = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, rows_synced = ? WHERE id = ?'
    ).bind(finishedAt, 'ok', totalSynced, logId).run();

    return ok(c, { rows_synced: totalSynced, unmatched, finished_at: finishedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, error_message = ? WHERE id = ?'
    ).bind(Math.floor(Date.now() / 1000), 'error', message, logId).run();
    return fail(c, 500, [{ code: 'ozon_sync_failed', message }]);
  }
});

// ---------------------------------------------------------------------------
// POST /api/marketplaces/sync/wb
// Pulls stocks from Wildberries Statistics API and upserts into marketplace_stocks_wb.
// Aggregates per supplierArticle (sums across all WB physical warehouses).
// ---------------------------------------------------------------------------
marketplaces.post('/sync/wb', async (c) => {
  const startedAt = Math.floor(Date.now() / 1000);

  const logResult = await c.env.DB.prepare(
    'INSERT INTO marketplace_sync_log (marketplace, started_at, status) VALUES (?, ?, ?)'
  ).bind('wb', startedAt, 'running').run();
  const logId = logResult.meta.last_row_id;

  try {
    const wbToken = c.env.WB_API_TOKEN;
    if (!wbToken) throw new Error('WB_API_TOKEN not configured');

    // dateFrom is REQUIRED by WB API but it returns full snapshot regardless.
    // We use 30 days back to cover any delayed warehouse updates.
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const url = `https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=${encodeURIComponent(since)}`;
    const resp = await fetch(url, { headers: { Authorization: wbToken } });
    if (!resp.ok) {
      throw new Error(`WB API ${resp.status}: ${await resp.text()}`);
    }
    const rows = (await resp.json()) as Array<{
      supplierArticle: string;
      nmId: number;
      quantity: number;
      inWayToClient: number;
      inWayFromClient: number;
      quantityFull: number;
    }>;

    // Aggregate per article (WB returns per-warehouse rows, we collapse to one row per article)
    type Agg = {
      nm_id: number;
      base_sku: string;
      pack_factor: 1 | 2 | 4;
      quantity: number;
      in_way_to_client: number;
      in_way_from_client: number;
      quantity_full: number;
    };
    const byArticle: Map<string, Agg> = new Map();
    const unmatched: Set<string> = new Set();

    for (const r of rows) {
      const { baseSku, packFactor } = parseMarketplaceArticle(r.supplierArticle);
      if (!baseSku) {
        unmatched.add(r.supplierArticle);
        continue;
      }
      let a = byArticle.get(r.supplierArticle);
      if (!a) {
        a = {
          nm_id: r.nmId,
          base_sku: baseSku,
          pack_factor: packFactor,
          quantity: 0,
          in_way_to_client: 0,
          in_way_from_client: 0,
          quantity_full: 0,
        };
        byArticle.set(r.supplierArticle, a);
      }
      a.quantity += r.quantity || 0;
      a.in_way_to_client += r.inWayToClient || 0;
      a.in_way_from_client += r.inWayFromClient || 0;
      a.quantity_full += r.quantityFull || 0;
    }

    const now = Math.floor(Date.now() / 1000);
    const stmts = [];
    for (const [article, v] of byArticle) {
      stmts.push(
        c.env.DB.prepare(`
          INSERT INTO marketplace_stocks_wb
            (supplier_article, nm_id, base_sku, pack_factor, quantity, in_way_to_client, in_way_from_client, quantity_full, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(supplier_article) DO UPDATE SET
            nm_id = excluded.nm_id,
            base_sku = excluded.base_sku,
            pack_factor = excluded.pack_factor,
            quantity = excluded.quantity,
            in_way_to_client = excluded.in_way_to_client,
            in_way_from_client = excluded.in_way_from_client,
            quantity_full = excluded.quantity_full,
            synced_at = excluded.synced_at
        `).bind(
          article, v.nm_id, v.base_sku, v.pack_factor,
          v.quantity, v.in_way_to_client, v.in_way_from_client, v.quantity_full, now
        )
      );
    }
    if (stmts.length > 0) await c.env.DB.batch(stmts);

    const finishedAt = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, rows_synced = ? WHERE id = ?'
    ).bind(finishedAt, 'ok', stmts.length, logId).run();

    return ok(c, { rows_synced: stmts.length, unmatched: Array.from(unmatched), finished_at: finishedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await c.env.DB.prepare(
      'UPDATE marketplace_sync_log SET finished_at = ?, status = ?, error_message = ? WHERE id = ?'
    ).bind(Math.floor(Date.now() / 1000), 'error', message, logId).run();
    return fail(c, 500, [{ code: 'wb_sync_failed', message }]);
  }
});

// ===========================================================================
// HOME / PULSE ENDPOINTS — Phase 9.x marketplace pulse cards
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /api/marketplaces/pulse/sku-spotlight
// Card 3 — Top & bottom SKUs by units sold, combined Ozon + WB.
// ---------------------------------------------------------------------------
marketplaces.get('/pulse/sku-spotlight', async (c) => {
  const meta = await c.env.DB.prepare(`
    SELECT
      (SELECT MIN(period_from) FROM marketplace_sales_ozon) AS period_from,
      (SELECT MAX(period_to)   FROM marketplace_sales_ozon) AS period_to,
      MAX(synced_at) AS synced_at
    FROM (
      SELECT synced_at FROM marketplace_sales_ozon
      UNION ALL
      SELECT synced_at FROM marketplace_sales_wb
    )
  `).first<{ period_from: string | null; period_to: string | null; synced_at: number | null }>();

  const top = await c.env.DB.prepare(`
    SELECT s.base_sku,
           p.product_name,
           SUM(s.units_sold)        AS units_sold,
           SUM(s.revenue_rub) / 100 AS revenue_rub,
           SUM(s.ozon_units)        AS ozon_units,
           SUM(s.wb_units)          AS wb_units
    FROM (
      SELECT base_sku, units_sold, revenue_rub,
             units_sold AS ozon_units, 0 AS wb_units
      FROM marketplace_sales_ozon
      UNION ALL
      SELECT base_sku, units_sold, revenue_rub,
             0 AS ozon_units, units_sold AS wb_units
      FROM marketplace_sales_wb
    ) s
    LEFT JOIN products p ON p.id = s.base_sku AND p.deleted_at IS NULL
    GROUP BY s.base_sku, p.product_name
    HAVING units_sold > 0
    ORDER BY units_sold DESC
    LIMIT 5
  `).all<{ base_sku: string; product_name: string | null; units_sold: number; revenue_rub: number; ozon_units: number; wb_units: number }>();

  const bottom = await c.env.DB.prepare(`
    SELECT p.id AS base_sku, p.product_name AS product_name,
           COALESCE(s.units_sold, 0) AS units_sold
    FROM products p
    LEFT JOIN (
      SELECT base_sku, SUM(units_sold) AS units_sold FROM (
        SELECT base_sku, units_sold FROM marketplace_sales_ozon
        UNION ALL
        SELECT base_sku, units_sold FROM marketplace_sales_wb
      )
      GROUP BY base_sku
    ) s ON s.base_sku = p.id
    WHERE p.deleted_at IS NULL
      AND COALESCE(s.units_sold, 0) = 0
    ORDER BY p.id
    LIMIT 5
  `).all<{ base_sku: string; product_name: string | null; units_sold: number }>();

  return ok(c, {
    period: { from: meta?.period_from ?? null, to: meta?.period_to ?? null },
    synced_at: meta?.synced_at ?? null,
    top: top.results,
    bottom: bottom.results,
  });
});

// ---------------------------------------------------------------------------
// GET /api/marketplaces/pulse/sku-funnel/:base_sku
// Card 9 — Conversion funnel for a single SKU.
// Returns Views → Cart → Orders for Ozon and WB separately, plus a combined.
// ---------------------------------------------------------------------------
marketplaces.get('/pulse/sku-funnel/:base_sku', async (c) => {
  const baseSku = c.req.param('base_sku').toLowerCase();

  const ozon = await c.env.DB.prepare(`
    SELECT views, tocart_count, units_sold, revenue_rub / 100 AS revenue_rub, period_from, period_to
    FROM marketplace_sales_ozon
    WHERE base_sku = ?
  `).bind(baseSku).first<{ views: number | null; tocart_count: number | null; units_sold: number; revenue_rub: number; period_from: string; period_to: string } | null>();

  const wb = await c.env.DB.prepare(`
    SELECT views, tocart_count, units_sold, revenue_rub / 100 AS revenue_rub, period_from, period_to
    FROM marketplace_sales_wb
    WHERE base_sku = ?
  `).bind(baseSku).first<{ views: number | null; tocart_count: number | null; units_sold: number; revenue_rub: number; period_from: string; period_to: string } | null>();

  // Read product display name if present
  const product = await c.env.DB.prepare(
    'SELECT id, product_name AS name FROM products WHERE id = ? AND deleted_at IS NULL'
  ).bind(baseSku).first<{ id: string; name: string | null }>();

  const period = ozon?.period_from || wb?.period_from
    ? { from: ozon?.period_from ?? wb?.period_from, to: ozon?.period_to ?? wb?.period_to }
    : { from: null, to: null };

  const ozonFunnel = ozon ? {
    views: ozon.views ?? 0,
    cart: ozon.tocart_count ?? 0,
    orders: ozon.units_sold ?? 0,
    revenue_rub: ozon.revenue_rub ?? 0,
  } : null;

  const wbFunnel = wb ? {
    views: wb.views ?? 0,
    cart: wb.tocart_count ?? 0,
    orders: wb.units_sold ?? 0,
    revenue_rub: wb.revenue_rub ?? 0,
  } : null;

  const combined = {
    views: (ozonFunnel?.views ?? 0) + (wbFunnel?.views ?? 0),
    cart: (ozonFunnel?.cart ?? 0) + (wbFunnel?.cart ?? 0),
    orders: (ozonFunnel?.orders ?? 0) + (wbFunnel?.orders ?? 0),
    revenue_rub: (ozonFunnel?.revenue_rub ?? 0) + (wbFunnel?.revenue_rub ?? 0),
  };

  return ok(c, {
    base_sku: baseSku,
    product_name: product?.name ?? null,
    period,
    ozon: ozonFunnel,
    wb: wbFunnel,
    combined,
  });
});

// ---------------------------------------------------------------------------
// GET /api/marketplaces/pulse/daily-trend
// Card 6 — last 30 days, day-by-day, by marketplace.
// For each day: revenue, units, plus Δ vs same weekday previous week.
// ---------------------------------------------------------------------------
marketplaces.get('/pulse/daily-trend', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT marketplace, date, units_sold, revenue_rub / 100 AS revenue_rub, synced_at
    FROM marketplace_sales_daily
    WHERE date >= date('now', '-44 days')
    ORDER BY date ASC
  `).all<{ marketplace: 'ozon' | 'wb' | 'site'; date: string; units_sold: number; revenue_rub: number; synced_at: number }>();

  // Build maps for quick week-ago lookup
  const byKey = new Map<string, { units_sold: number; revenue_rub: number }>();
  for (const r of rows.results) {
    byKey.set(`${r.marketplace}|${r.date}`, { units_sold: r.units_sold, revenue_rub: r.revenue_rub });
  }

  // Find last 30 dates that actually have any data
  const allDates = Array.from(new Set(rows.results.map(r => r.date))).sort();
  const last30 = allDates.slice(-30);

  function deltaVsLastWeek(mp: 'ozon' | 'wb' | 'site', date: string, value: number) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    const prev = byKey.get(`${mp}|${d.toISOString().slice(0, 10)}`);
    if (!prev) return null;
    if (prev.revenue_rub === 0) return null;
    return Math.round(((value - prev.revenue_rub) / prev.revenue_rub) * 1000) / 10; // %, 1 decimal
  }

  const days = last30.map(date => {
    const oz = byKey.get(`ozon|${date}`) || { units_sold: 0, revenue_rub: 0 };
    const w  = byKey.get(`wb|${date}`)   || { units_sold: 0, revenue_rub: 0 };
    const s  = byKey.get(`site|${date}`) || { units_sold: 0, revenue_rub: 0 };
    return {
      date,
      ozon: { units: oz.units_sold, revenue_rub: oz.revenue_rub, delta_pct: deltaVsLastWeek('ozon', date, oz.revenue_rub) },
      wb:   { units: w.units_sold,  revenue_rub: w.revenue_rub,  delta_pct: deltaVsLastWeek('wb',   date, w.revenue_rub) },
      site: { units: s.units_sold,  revenue_rub: s.revenue_rub,  delta_pct: deltaVsLastWeek('site', date, s.revenue_rub) },
    };
  });

  // 30d totals per marketplace + 30d-vs-prev-30d delta
  // last30 already computed above; prev30 = 30 dates immediately before last30
  const prev30 = allDates.slice(Math.max(0, allDates.length - 60), Math.max(0, allDates.length - 30));

  function sumOver(dateList: string[], mp: 'ozon' | 'wb' | 'site') {
    let units = 0;
    let revenue = 0;
    for (const date of dateList) {
      const r = byKey.get(`${mp}|${date}`);
      if (r) { units += r.units_sold; revenue += r.revenue_rub; }
    }
    return { units, revenue_rub: revenue };
  }

  function pctChange(curr: number, prev: number): number | null {
    if (prev === 0) return null;
    return Math.round(((curr - prev) / prev) * 1000) / 10;
  }

  const totals30d = (['ozon', 'wb', 'site'] as const).reduce<Record<string, { units: number; revenue_rub: number; delta_pct: number | null; prev_revenue_rub: number }>>((acc, mp) => {
    const curr = sumOver(last30, mp);
    const prev = sumOver(prev30, mp);
    acc[mp] = {
      units: curr.units,
      revenue_rub: curr.revenue_rub,
      delta_pct: pctChange(curr.revenue_rub, prev.revenue_rub),
      prev_revenue_rub: prev.revenue_rub,
    };
    return acc;
  }, {});

  return ok(c, {
    days,
    totals_30d: {
      ozon: totals30d.ozon,
      wb:   totals30d.wb,
      site: totals30d.site,
    },
    history_complete: allDates.length >= 14,  // tells UI whether week-over-week deltas are reliable
    days_available: allDates.length,
  });
});

// ---------------------------------------------------------------------------
// GET /api/marketplaces/pulse/sales-today
// Card 1 — today's sales by marketplace, with Δ vs yesterday.
// ---------------------------------------------------------------------------
marketplaces.get('/pulse/sales-today', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT marketplace, date, units_sold, revenue_rub / 100 AS revenue_rub
    FROM marketplace_sales_daily
    WHERE date >= date('now', '-3 days')
    ORDER BY date DESC
  `).all<{ marketplace: 'ozon' | 'wb'; date: string; units_sold: number; revenue_rub: number }>();

  const byKey = new Map<string, { units: number; revenue: number; date: string }>();
  for (const r of rows.results) {
    if (!byKey.has(r.marketplace)) {
      byKey.set(r.marketplace, { units: r.units_sold, revenue: r.revenue_rub, date: r.date });
    }
  }
  // For each marketplace, locate "today's row" (= most recent) and "previous day"
  function pulseFor(mp: 'ozon' | 'wb' | 'site') {
    const all = rows.results.filter(r => r.marketplace === mp);
    if (all.length === 0) return { revenue_rub: 0, units: 0, delta_pct: null, last_date: null };
    const today = all[0];
    const prev = all[1];
    const delta = prev && prev.revenue_rub > 0
      ? Math.round(((today.revenue_rub - prev.revenue_rub) / prev.revenue_rub) * 1000) / 10
      : null;
    return {
      revenue_rub: today.revenue_rub,
      units: today.units_sold,
      delta_pct: delta,
      last_date: today.date,
    };
  }

  const ozon = pulseFor('ozon');
  const wb = pulseFor('wb');
  const site = pulseFor('site');

  // Spark: latest 60 days (current 30d + previous 30d for month-over-month overlay).
  // Front-end takes last 30 as the foreground line and the 30 before as the ghost line.
  const spark = await c.env.DB.prepare(`
    SELECT date,
           SUM(revenue_rub) / 100 AS revenue_rub,
           SUM(CASE WHEN marketplace = 'ozon' THEN revenue_rub ELSE 0 END) / 100 AS ozon_revenue_rub,
           SUM(CASE WHEN marketplace = 'wb'   THEN revenue_rub ELSE 0 END) / 100 AS wb_revenue_rub,
           SUM(CASE WHEN marketplace = 'site' THEN revenue_rub ELSE 0 END) / 100 AS site_revenue_rub,
           SUM(units_sold) AS units
    FROM marketplace_sales_daily
    WHERE date >= date('now', '-59 days')
    GROUP BY date
    ORDER BY date ASC
    LIMIT 60
  `).all<{ date: string; revenue_rub: number; ozon_revenue_rub: number; wb_revenue_rub: number; site_revenue_rub: number; units: number }>();

  // Freshness: latest successful sales sync (whichever feed) + whether the most
  // recent attempt of any sales feed was a rate-limit (429). Powers the
  // "Updated X ago" stamp; amber when the last attempt was throttled.
  const freshRow = await c.env.DB.prepare(`
    SELECT MAX(finished_at) AS last_ok
    FROM marketplace_sync_log
    WHERE marketplace IN ('ozon-sales','wb-sales') AND status = 'ok'
  `).first<{ last_ok: number | null }>();

  const lastAttempts = await c.env.DB.prepare(`
    SELECT marketplace, status, error_message
    FROM marketplace_sync_log
    WHERE marketplace IN ('ozon-sales','wb-sales')
      AND started_at = (
        SELECT MAX(started_at) FROM marketplace_sync_log AS s
        WHERE s.marketplace = marketplace_sync_log.marketplace
      )
    GROUP BY marketplace
  `).all<{ marketplace: string; status: string; error_message: string | null }>();

  const throttled = (lastAttempts.results || []).some(
    (r) => r.status !== 'ok' && /429|rate limit/i.test(r.error_message || '')
  );

  return ok(c, {
    ozon,
    wb,
    site,
    combined: {
      revenue_rub: ozon.revenue_rub + wb.revenue_rub + site.revenue_rub,
      units: ozon.units + wb.units + site.units,
    },
    spark: spark.results,
    freshness: {
      last_success_at: freshRow?.last_ok ?? null,
      throttled,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/marketplaces/pulse/refresh
// Manual on-demand refresh of the three sales feeds. Fires Ozon sales + Site
// (no rate limit) together, then WB sales once (WB may 429 — that's fine, the
// stamp goes amber, never an error). No long inter-call sleeps: this is a
// single user-triggered pull, not the cron's stocks+sales chain. Returns the
// fresh freshness object so the UI can update the stamp immediately.
// ---------------------------------------------------------------------------
// TEMP DIAG — reconcile WB price fields for a single day vs cabinet. Remove after.
marketplaces.get('/diag/wb-day/:date', async (c) => {
  const date = c.req.param('date'); // YYYY-MM-DD
  const wbToken = c.env.WB_API_TOKEN;
  if (!wbToken) return c.json({ success: false, error: 'no token' });
  const url = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${date}T00:00:00`;
  const resp = await fetch(url, { headers: { Authorization: wbToken } });
  if (!resp.ok) return c.json({ success: false, http: resp.status, body: (await resp.text()).slice(0, 200) });
  const rows = await resp.json() as any[];
  const d = rows.filter((r) => String(r.date || '').slice(0, 10) === date);
  const sum = (f: string) => Math.round(d.reduce((a, r) => a + (Number(r[f]) || 0), 0) * 100) / 100;
  const sample = d[0] ? Object.keys(d[0]) : [];
  return c.json({ success: true, result: {
    date, rows_total: rows.length, rows_day: d.length, fields: sample,
    sums: {
      totalPrice: sum('totalPrice'),
      priceWithDisc: sum('priceWithDisc'),
      finishedPrice: sum('finishedPrice'),
      forPay: sum('forPay'),
    },
  }});
});

marketplaces.post('/pulse/refresh', async (c) => {
  const selfPost = (path: string) =>
    c.env.SELF.fetch(new Request(`https://internal${path}`, { method: 'POST' }))
      .then((r) => r.status)
      .catch(() => 0);

  // Ozon sales + Site run in parallel (neither is rate-limited).
  const [ozonStatus, siteStatus] = await Promise.all([
    selfPost('/api/marketplaces/sync/sales/ozon'),
    c.env.SELF.fetch(new Request('https://internal/api/crm/sync-site-sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })).then((r) => r.status).catch(() => 0),
  ]);

  // WB sales last, on its own (strict 1 req/min limit). A 429 here is expected
  // and non-fatal — the UI reflects it as "WB busy, retrying".
  const wbStatus = await selfPost('/api/marketplaces/sync/sales/wb');

  const freshRow = await c.env.DB.prepare(`
    SELECT MAX(finished_at) AS last_ok
    FROM marketplace_sync_log
    WHERE marketplace IN ('ozon-sales','wb-sales') AND status = 'ok'
  `).first<{ last_ok: number | null }>();

  const wbThrottled = wbStatus === 429 || wbStatus === 0;

  return ok(c, {
    triggered: { ozon: ozonStatus, wb: wbStatus, site: siteStatus },
    freshness: {
      last_success_at: freshRow?.last_ok ?? null,
      throttled: wbThrottled,
    },
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/marketplaces/backfill-sales
//
// One-shot historical backfill of marketplace_sales_daily.
// Pulls daily sales from WB Statistics API and Ozon Analytics API for a
// configurable window (default: 30 days ending yesterday) and upserts into
// marketplace_sales_daily as (marketplace, date) → (units_sold, revenue_rub).
//
// Body (optional): { from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }
// Defaults: from = 30 days ago, to = yesterday (UTC).
//
// Idempotent: ON CONFLICT REPLACE on PRIMARY KEY (marketplace, date).
// Existing rows from cron get overwritten with backfill values — safe because
// both come from same APIs.
// ════════════════════════════════════════════════════════════════════════════
marketplaces.post('/backfill-sales', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { from?: string; to?: string };
  const today = new Date();
  const defFrom = new Date(today.getTime() - 30 * 86400 * 1000);
  const defTo = new Date(today.getTime() - 1 * 86400 * 1000);
  const isoDate = (d: Date) => d.toISOString().slice(0, 10);
  const from = body.from ?? isoDate(defFrom);
  const to   = body.to   ?? isoDate(defTo);

  const result: { wb: any; ozon: any } = { wb: {}, ozon: {} };

  // ── WB Statistics: /api/v1/supplier/sales gives one row per sale, must aggregate ──
  try {
    const wbToken = c.env.WB_API_TOKEN;
    if (!wbToken) throw new Error('WB_API_TOKEN not configured');

    const url = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${from}T00:00:00`;
    const resp = await fetch(url, { headers: { Authorization: wbToken } });
    if (!resp.ok) throw new Error(`WB HTTP ${resp.status}: ${await resp.text()}`);
    const sales: any[] = await resp.json();

    // Aggregate by date (sales row has `date` like "2026-04-13T10:23:45")
    const byDate: Record<string, { units: number; rev: number }> = {};
    for (const s of sales) {
      const d = String(s.date || '').slice(0, 10);
      if (!d || d < from || d > to) continue;
      // forPay = amount actually received by seller (already net of WB fees)
      // priceWithDisc = gross sale price with discount applied
      // Use priceWithDisc for revenue, as our cron uses gross.
      const rev = Math.round(Number(s.priceWithDisc || 0) * 100); // → kopecks
      byDate[d] = byDate[d] || { units: 0, rev: 0 };
      byDate[d].units += 1;
      byDate[d].rev += rev;
    }

    const now = Math.floor(Date.now() / 1000);
    const stmts: any[] = [];
    for (const [date, agg] of Object.entries(byDate)) {
      stmts.push(c.env.DB.prepare(`
        INSERT INTO marketplace_sales_daily (marketplace, date, units_sold, revenue_rub, synced_at)
        VALUES ('wb', ?, ?, ?, ?)
        ON CONFLICT (marketplace, date) DO UPDATE SET
          units_sold = excluded.units_sold,
          revenue_rub = excluded.revenue_rub,
          synced_at = excluded.synced_at
      `).bind(date, agg.units, agg.rev, now));
    }
    if (stmts.length > 0) await c.env.DB.batch(stmts);

    result.wb = { ok: true, days_written: stmts.length, raw_sales_rows: sales.length, from, to };
  } catch (e: any) {
    result.wb = { ok: false, error: String(e?.message || e) };
  }

  // ── Ozon Analytics: /v1/analytics/data with daily grouping ──
  try {
    const clientId = c.env.OZON_CLIENT_ID;
    const apiKey = c.env.OZON_API_KEY;
    if (!clientId || !apiKey) throw new Error('OZON credentials not configured');

    const resp = await fetch('https://api-seller.ozon.ru/v1/analytics/data', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        date_from: from,
        date_to: to,
        metrics: ['ordered_units', 'revenue'],
        dimension: ['day'],
        limit: 1000,
        offset: 0,
      }),
    });
    if (!resp.ok) throw new Error(`Ozon HTTP ${resp.status}: ${await resp.text()}`);
    const j: any = await resp.json();
    const rows: any[] = j?.result?.data || [];

    const now = Math.floor(Date.now() / 1000);
    const stmts: any[] = [];
    for (const r of rows) {
      // r.dimensions = [{ id: "2026-04-13", name: "..." }], r.metrics = [units, revenue]
      const date = r?.dimensions?.[0]?.id;
      if (!date) continue;
      const units = Math.round(Number(r.metrics?.[0] || 0));
      const rev = Math.round(Number(r.metrics?.[1] || 0) * 100); // → kopecks
      stmts.push(c.env.DB.prepare(`
        INSERT INTO marketplace_sales_daily (marketplace, date, units_sold, revenue_rub, synced_at)
        VALUES ('ozon', ?, ?, ?, ?)
        ON CONFLICT (marketplace, date) DO UPDATE SET
          units_sold = excluded.units_sold,
          revenue_rub = excluded.revenue_rub,
          synced_at = excluded.synced_at
      `).bind(date, units, rev, now));
    }
    if (stmts.length > 0) await c.env.DB.batch(stmts);

    result.ozon = { ok: true, days_written: stmts.length, raw_rows: rows.length, from, to };
  } catch (e: any) {
    result.ozon = { ok: false, error: String(e?.message || e) };
  }

  return c.json({ success: true, result });
});


// ════════════════════════════════════════════════════════════════════════════
// POST /api/marketplaces/backfill-wb-missing
//
// Smart WB-only retry. Looks at marketplace_sales_daily, finds the gap
// between earliest WB date and any earlier date that has Ozon data (or a
// supplied `from`), and pulls WB sales for that gap only. Designed to be
// poked repeatedly when WB rate-limits — each successful call fills more
// days, failures don't retry the whole window.
// ════════════════════════════════════════════════════════════════════════════
marketplaces.post('/backfill-wb-missing', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { from?: string };
  // Determine target window
  const ozonEarliest = await c.env.DB.prepare(
    "SELECT MIN(date) as d FROM marketplace_sales_daily WHERE marketplace = 'ozon'"
  ).first<{ d: string | null }>();
  const wbEarliest = await c.env.DB.prepare(
    "SELECT MIN(date) as d FROM marketplace_sales_daily WHERE marketplace = 'wb'"
  ).first<{ d: string | null }>();

  const from = body.from ?? ozonEarliest?.d ?? '';
  const toExclusive = wbEarliest?.d ?? '';
  if (!from || !toExclusive || from >= toExclusive) {
    return c.json({ success: true, result: { skipped: true, reason: 'no gap', from, toExclusive } });
  }

  try {
    const wbToken = c.env.WB_API_TOKEN;
    if (!wbToken) throw new Error('WB_API_TOKEN not configured');

    const url = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${from}T00:00:00`;
    const resp = await fetch(url, { headers: { Authorization: wbToken } });
    if (!resp.ok) throw new Error(`WB HTTP ${resp.status}`);
    const sales: any[] = await resp.json();

    const byDate: Record<string, { units: number; rev: number }> = {};
    for (const s of sales) {
      const d = String(s.date || '').slice(0, 10);
      if (!d || d < from || d >= toExclusive) continue;
      const rev = Math.round(Number(s.priceWithDisc || 0) * 100);
      byDate[d] = byDate[d] || { units: 0, rev: 0 };
      byDate[d].units += 1;
      byDate[d].rev += rev;
    }

    const now = Math.floor(Date.now() / 1000);
    const stmts: any[] = [];
    for (const [date, agg] of Object.entries(byDate)) {
      stmts.push(c.env.DB.prepare(`
        INSERT INTO marketplace_sales_daily (marketplace, date, units_sold, revenue_rub, synced_at)
        VALUES ('wb', ?, ?, ?, ?)
        ON CONFLICT (marketplace, date) DO UPDATE SET
          units_sold = excluded.units_sold,
          revenue_rub = excluded.revenue_rub,
          synced_at = excluded.synced_at
      `).bind(date, agg.units, agg.rev, now));
    }
    if (stmts.length > 0) await c.env.DB.batch(stmts);

    return c.json({ success: true, result: {
      ok: true, days_written: stmts.length, raw_sales_rows: sales.length,
      from, toExclusive,
    }});
  } catch (e: any) {
    return c.json({ success: true, result: {
      ok: false, error: String(e?.message || e),
      from, toExclusive,
    }});
  }
});


export default marketplaces;

