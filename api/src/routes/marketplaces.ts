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

export default marketplaces;

