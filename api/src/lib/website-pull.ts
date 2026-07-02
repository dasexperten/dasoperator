/**
 * dasexperten.com storefront (Stripe on Cloudflare) → ERP sync orchestration.
 *
 *   runWebsiteOrdersSync  — pull Checkout Sessions incrementally (created-date
 *                           watermark + cursor paging), upsert website_orders
 *                           and website_order_lines.
 *   runWebsiteCatalogSync — pull Stripe Products + Prices, upsert website_products.
 *
 * MIRROR ONLY: nothing here writes to operations/line_items. Website revenue's
 * financial truth stays in the monthly DASCOM-YYYYMM bank-settlement operations
 * on partner 'dasexperten_com' (see marketplace-pull.ts). Per-order accounting
 * is a deliberate Phase-2 item.
 *
 * Rows carry site='dasexperten_com' today; the planned dasexperten.ru move onto
 * Cloudflare will reuse the same path with a different site value.
 */
const SITE = 'dasexperten_com';
import type { Env } from '../types';
import { stripeGet, type StripeListResponse } from './stripe-client';
import {
  mapOrder,
  mapOrderLines,
  mapPrice,
  type StripeCheckoutSession,
  type StripePrice,
  type StripeProduct,
} from './website-map';

const PAGE_LIMIT = 100;
const MAX_PAGES = 10; // Worker CPU discipline; watermark resumes next tick.
const DEFAULT_BACKFILL_FROM = 1704067200; // 2024-01-01 UTC — full backfill on first run.

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function loadKnownSkus(env: Env): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT id FROM products WHERE deleted_at IS NULL`
  ).all<{ id: string }>();
  return new Set((rows.results ?? []).map((r) => String(r.id).toLowerCase()));
}

async function getWatermark(env: Env, key: string, fallback: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT value FROM website_sync_state WHERE key = ?`
  ).bind(key).first<{ value: string }>();
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

async function setWatermark(env: Env, key: string, value: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO website_sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(value), now()).run();
}

async function startLog(env: Env, kind: 'orders' | 'catalog'): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO website_sync_log (kind, started_at, status) VALUES (?, ?, 'running')`
  ).bind(kind, now()).run();
  return Number(res.meta.last_row_id);
}

async function finishLog(env: Env, id: number, rows: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE website_sync_log SET finished_at = ?, status = 'ok', rows_synced = ? WHERE id = ?`
  ).bind(now(), rows, id).run();
}

async function errorLog(env: Env, id: number, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE website_sync_log SET finished_at = ?, status = 'error', error_message = ? WHERE id = ?`
  ).bind(now(), message, id).run();
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrdersSyncResult {
  pages: number;
  orders_upserted: number;
  unmatched_lines: number;
  watermark: number;
}

/**
 * Pull Checkout Sessions created after the watermark. `fromOverride` (unix
 * seconds) resets the watermark for a manual backfill.
 */
export async function runWebsiteOrdersSync(
  env: Env,
  fromOverride?: number
): Promise<OrdersSyncResult> {
  const key = env.STRIPE_KEY;
  if (!key) throw new Error('STRIPE_KEY not configured');

  const logId = await startLog(env, 'orders');
  try {
    const known = await loadKnownSkus(env);
    let watermark =
      fromOverride ?? (await getWatermark(env, 'orders_watermark', DEFAULT_BACKFILL_FROM));
    let startingAfter: string | undefined;
    let pages = 0;
    let ordersUpserted = 0;
    let unmatchedLines = 0;
    let maxCreated = watermark;

    while (pages < MAX_PAGES) {
      const resp = await stripeGet<StripeListResponse<StripeCheckoutSession>>(
        key,
        '/checkout/sessions',
        {
          limit: PAGE_LIMIT,
          created: { gte: watermark },
          expand: ['data.line_items', 'data.line_items.data.price'],
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        }
      );
      const sessions = resp.data ?? [];
      pages += 1;
      if (sessions.length === 0) break;

      const ts = now();
      const stmts: D1PreparedStatement[] = [];
      for (const s of sessions) {
        const o = mapOrder(s, SITE);
        const raw = JSON.stringify(s).slice(0, 100000);
        stmts.push(
          env.DB.prepare(
            `INSERT INTO website_orders
               (id, site, source, number, created_date, updated_date, status, payment_status,
                fulfillment_status, currency, amount_subtotal, amount_shipping, amount_tax,
                amount_discount, amount_total, buyer_email, buyer_name, ship_country,
                payment_intent, raw_json, synced_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               site = excluded.site,
               number = excluded.number,
               updated_date = excluded.updated_date,
               status = excluded.status,
               payment_status = excluded.payment_status,
               currency = excluded.currency,
               amount_subtotal = excluded.amount_subtotal,
               amount_shipping = excluded.amount_shipping,
               amount_tax = excluded.amount_tax,
               amount_discount = excluded.amount_discount,
               amount_total = excluded.amount_total,
               buyer_email = excluded.buyer_email,
               buyer_name = excluded.buyer_name,
               ship_country = excluded.ship_country,
               payment_intent = excluded.payment_intent,
               raw_json = excluded.raw_json,
               synced_at = excluded.synced_at,
               updated_at = excluded.updated_at`
          ).bind(
            o.id, o.site, o.source, o.number, o.created_date, ts, o.status, o.payment_status,
            o.currency, o.amount_subtotal, o.amount_shipping, o.amount_tax,
            o.amount_discount, o.amount_total, o.buyer_email, o.buyer_name, o.ship_country,
            o.payment_intent, raw, ts, ts, ts
          )
        );

        // Rebuild lines for this order (handles edited/refunded orders).
        stmts.push(env.DB.prepare(`DELETE FROM website_order_lines WHERE order_id = ?`).bind(o.id));
        const lines = mapOrderLines(s, known);
        for (const l of lines) {
          if (!l.product_id) unmatchedLines += 1;
          stmts.push(
            env.DB.prepare(
              `INSERT INTO website_order_lines
                 (id, order_id, stripe_price_id, stripe_product_id, sku_raw, product_id,
                  item_name, qty, unit_amount, line_total, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              l.id, l.order_id, l.stripe_price_id, l.stripe_product_id, l.sku_raw,
              l.product_id, l.item_name, l.qty, l.unit_amount, l.line_total, ts, ts
            )
          );
        }

        if (o.created_date > maxCreated) maxCreated = o.created_date;
        ordersUpserted += 1;
      }

      // D1 batches cap around 100 statements; chunk to stay safe.
      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50));
      }

      // Advance watermark as we go so the next tick resumes even if we stop early.
      if (maxCreated > watermark) {
        await setWatermark(env, 'orders_watermark', maxCreated);
      }

      const last = sessions[sessions.length - 1];
      if (!resp.has_more || !last) break;
      startingAfter = last.id;
    }

    await finishLog(env, logId, ordersUpserted);
    return { pages, orders_upserted: ordersUpserted, unmatched_lines: unmatchedLines, watermark: maxCreated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await errorLog(env, logId, message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Catalog (products + prices)
// ---------------------------------------------------------------------------

export interface CatalogSyncResult {
  products: number;
  prices_upserted: number;
  unmatched: number;
}

export async function runWebsiteCatalogSync(env: Env): Promise<CatalogSyncResult> {
  const key = env.STRIPE_KEY;
  if (!key) throw new Error('STRIPE_KEY not configured');

  const logId = await startLog(env, 'catalog');
  try {
    const known = await loadKnownSkus(env);

    // Fetch all products first (small catalog: ~17), into a lookup map.
    const productById = new Map<string, StripeProduct>();
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await stripeGet<StripeListResponse<StripeProduct>>(key, '/products', {
        limit: PAGE_LIMIT,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const data = resp.data ?? [];
      for (const p of data) productById.set(p.id, p);
      const last = data[data.length - 1];
      if (!resp.has_more || !last) break;
      startingAfter = last.id;
    }

    // Then all prices, mapping each to a website_products row.
    let pricesUpserted = 0;
    let unmatched = 0;
    startingAfter = undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp: StripeListResponse<StripePrice> = await stripeGet(key, '/prices', {
        limit: PAGE_LIMIT,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const data: StripePrice[] = resp.data ?? [];
      if (data.length === 0) break;

      const ts = now();
      const stmts: D1PreparedStatement[] = [];
      for (const price of data) {
        const row = mapPrice(price, productById, known);
        if (!row.product_id) unmatched += 1;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO website_products
               (stripe_price_id, stripe_product_id, sku_raw, product_id, name,
                unit_amount, currency, active, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(stripe_price_id) DO UPDATE SET
               stripe_product_id = excluded.stripe_product_id,
               sku_raw = excluded.sku_raw,
               product_id = excluded.product_id,
               name = excluded.name,
               unit_amount = excluded.unit_amount,
               currency = excluded.currency,
               active = excluded.active,
               synced_at = excluded.synced_at`
          ).bind(
            row.stripe_price_id, row.stripe_product_id, row.sku_raw, row.product_id,
            row.name, row.unit_amount, row.currency, row.active, ts
          )
        );
      }
      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50));
      }
      pricesUpserted += data.length;

      const last = data[data.length - 1];
      if (!resp.has_more || !last) break;
      startingAfter = last.id;
    }

    await finishLog(env, logId, pricesUpserted);
    return { products: productById.size, prices_upserted: pricesUpserted, unmatched };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await errorLog(env, logId, message);
    throw err;
  }
}
