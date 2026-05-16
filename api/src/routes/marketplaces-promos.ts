/**
 * Marketplace promotional actions (акции Ozon, WB и т.д.)
 *
 * GET /api/marketplaces/ozon/actions
 *   Returns participating Ozon actions with per-SKU quotas:
 *     - action_id, title, type, date_start, date_end, days_left
 *     - total_units_left (sum of remaining quota)
 *     - products: [ { product_id, offer_id (SKU), name, price, action_price,
 *                     discount_pct, stock (quota), min_stock } ]
 *
 * Cached in KV (das-cache) for 30 minutes.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const promos = new Hono<{ Bindings: Env }>();

const CACHE_KEY = 'ozon:actions:v1';
const CACHE_TTL_SEC = 30 * 60; // 30 min
const AUTO_ZERO_FLAG_PREFIX = 'ozon:promos:auto-zeroed:';
const AUTO_ZERO_FLAG_TTL_SEC = 365 * 24 * 60 * 60; // 1 year — flag is durable

interface OzonActionRaw {
  id: number;
  title: string;
  action_type: string;
  date_start: string;
  date_end: string;
  potential_products_count: number;
  participating_products_count: number;
  is_participating: boolean;
  is_voucher_action: boolean;
  banned_products_count: number;
  with_targeting: boolean;
}

interface OzonActionProduct {
  id: number;
  price: number;
  action_price: number;
  max_action_price: number;
  add_mode: string;
  stock: number; // remaining quota for this action
  min_stock: number;
  current_boost?: number;
  alert_max_action_price_failed?: boolean;
}

interface OzonProductInfo {
  id: number;
  offer_id: string;
  name: string;
  sources?: Array<{ sku: number; source: string }>;
}

interface CachedActionsPayload {
  generated_at: string;
  total_actions: number;
  participating_count: number;
  total_units_left: number;
  total_skus_in_promos: number;
  actions: Array<{
    action_id: number;
    title: string;
    action_type: string;
    date_start: string;
    date_end: string;
    days_left: number;
    is_voucher_action: boolean;
    participating_products_count: number;
    total_units_left: number;
    auto_zeroed_at: string | null;
    products: Array<{
      product_id: number;
      offer_id: string;
      name: string;
      price: number;
      action_price: number;
      discount_pct: number;
      stock: number;
      min_stock: number;
      sold_count: number | null; // null = unknown, will be set after first manual save
      left_to_sell: number | null; // = stock - sold_count when sold_count known
    }>;
  }>;
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  return Math.max(0, Math.ceil((to - from) / 86400000));
}

async function ozonRequest<T>(
  env: Env,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    'Client-Id': env.OZON_CLIENT_ID,
    'Api-Key': env.OZON_API_KEY,
    'Content-Type': 'application/json',
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`https://api-seller.ozon.ru${path}`, init);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Ozon ${path} HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

async function fetchAllProductInfo(
  env: Env,
  productIds: number[],
): Promise<Map<number, OzonProductInfo>> {
  const map = new Map<number, OzonProductInfo>();
  if (productIds.length === 0) return map;
  // /v3/product/info/list accepts up to 1000 product_ids per call
  const chunkSize = 500;
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const chunk = productIds.slice(i, i + chunkSize);
    const resp = await ozonRequest<{
      items?: OzonProductInfo[];
      result?: { items?: OzonProductInfo[] };
    }>(env, '/v3/product/info/list', 'POST', {
      product_id: chunk.map(String),
    });
    const items = resp.items || resp.result?.items || [];
    for (const it of items) {
      if (it && it.id) map.set(it.id, it);
    }
  }
  return map;
}
// ---------------------------------------------------------------------------
// Sold-count tracking — Ozon does NOT expose how many units were sold under
// a specific action via API. We persist the delta locally per (action, product):
//
//   When Aram saves a "left_to_sell" value in the UI, we compute
//   sold_count = stock - left_to_sell and store it. On subsequent fetches we
//   compute left_to_sell = stock - sold_count for display. Stock changes
//   propagate the same delta to "left to sell" automatically.
// ---------------------------------------------------------------------------
const SOLD_COUNT_TTL_SEC = 90 * 24 * 3600;
function soldCountKey(actionId: number, productId: number): string {
  return `ozon:promo:sold:${actionId}:${productId}`;
}

async function getSoldCount(
  env: Env,
  actionId: number,
  productId: number,
): Promise<number | null> {
  try {
    const v = await env.CACHE.get(soldCountKey(actionId, productId));
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function setSoldCount(
  env: Env,
  actionId: number,
  productId: number,
  soldCount: number,
): Promise<void> {
  try {
    await env.CACHE.put(soldCountKey(actionId, productId), String(soldCount), {
      expirationTtl: SOLD_COUNT_TTL_SEC,
    });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Sales analytics — sum ordered_units per Ozon `sku` since a given date.
// Used to compute sold_count for promo products when no manual override exists.
//
// Returns Map<sku_id, ordered_units>. The action's product_id maps to multiple
// Ozon sku IDs (FBO + FBS variants). Caller sums across all variants of one
// product.
// ---------------------------------------------------------------------------
interface AnalyticsRow {
  dimensions: Array<{ id: string; name: string }>;
  metrics: number[];
}

async function fetchSalesSince(
  env: Env,
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const limit = 1000;
  let offset = 0;
  // Cap iterations defensively (Ozon paginates; 10 pages = 10k SKUs)
  for (let i = 0; i < 10; i++) {
    const resp = await ozonRequest<{
      result?: { data?: AnalyticsRow[]; totals?: number[] };
    }>(env, '/v1/analytics/data', 'POST', {
      date_from: dateFrom,
      date_to: dateTo,
      metrics: ['ordered_units'],
      dimension: ['sku'],
      filters: [],
      limit,
      offset,
    });
    const rows = resp.result?.data ?? [];
    for (const row of rows) {
      const sku = row.dimensions?.[0]?.id;
      const units = Number(row.metrics?.[0] ?? 0);
      if (sku) result.set(sku, units);
    }
    if (rows.length < limit) break;
    offset += rows.length;
  }
  return result;
}

function isoDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  // YYYY-MM-DD in UTC
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


// ---------------------------------------------------------------------------
// AUTO-ZERO POLICY
// For "Распродажа" actions only (clearance/stock-clearing sales — matched by
// "распродажа" substring in title, case-insensitive): on first detection,
// automatically set all products' stock to 0. Ozon enforces a per-SKU
// min_stock floor on STOCK_DISCOUNT actions, so the only "way out" without
// committing to that floor is stock=0.
//
// Default policy for Распродажа: opt out by zeroing on first sighting.
// Aram raises individual SKUs manually when needed.
//
// Other STOCK_DISCOUNT actions (Максимальный бустинг, Эластичный бустинг,
// boosting variants) are NOT auto-zeroed — they remain fully editable like
// any other promo.
//
// Flag stored in KV — once zeroed, never touched again so manual raises stick.
// ---------------------------------------------------------------------------
async function autoZeroStockDiscount(
  env: Env,
  actionsWithProducts: Array<{
    raw: OzonActionRaw;
    products: OzonActionProduct[];
  }>,
): Promise<Map<number, string>> {
  const flagsByAction = new Map<number, string>();

  for (const aw of actionsWithProducts) {
    // Auto-zero rule applies only to "Распродажа" actions
    // (clearance/stock-clearing sales — case-insensitive match in title).
    // Other STOCK_DISCOUNT actions like "Максимальный бустинг" are not auto-zeroed —
    // they remain editable like any other promo.
    if (aw.raw.action_type !== 'STOCK_DISCOUNT') continue;
    const titleLower = (aw.raw.title || '').toLowerCase();
    if (!titleLower.includes('распродажа')) continue;

    const flagKey = AUTO_ZERO_FLAG_PREFIX + aw.raw.id;
    let existingFlag: string | null = null;
    try {
      existingFlag = await env.CACHE.get(flagKey);
    } catch {
      // ignore
    }

    if (existingFlag) {
      flagsByAction.set(aw.raw.id, existingFlag);
      continue;
    }

    // First time we see this STOCK_DISCOUNT action — zero out every product with stock > 0
    const toZero = aw.products.filter((p) => p.stock > 0);
    let zeroedAnything = false;

    if (toZero.length > 0) {
      // Ozon /v1/actions/products/activate accepts up to ~100 products per call
      const batchSize = 100;
      for (let i = 0; i < toZero.length; i += batchSize) {
        const batch = toZero.slice(i, i + batchSize);
        try {
          await ozonRequest(env, '/v1/actions/products/activate', 'POST', {
            action_id: aw.raw.id,
            products: batch.map((p) => ({
              product_id: p.id,
              action_price: p.action_price,
              stock: 0,
            })),
          });
          zeroedAnything = true;
        } catch (e) {
          // Log but continue — partial failure shouldn't block the whole response
          console.error(
            `auto-zero batch failed for action ${aw.raw.id}:`,
            e instanceof Error ? e.message : e,
          );
        }
      }
      // Reflect change in-memory so the response shows the new state
      if (zeroedAnything) {
        for (const p of aw.products) {
          if (p.stock > 0) p.stock = 0;
        }
      }
    }

    const ts = new Date().toISOString();
    try {
      await env.CACHE.put(flagKey, ts, { expirationTtl: AUTO_ZERO_FLAG_TTL_SEC });
    } catch {
      // ignore — if KV write fails we'll just zero again next refresh,
      // which is idempotent (already-zero products won't be re-touched)
    }
    flagsByAction.set(aw.raw.id, ts);
  }

  return flagsByAction;
}

async function buildPayload(env: Env): Promise<CachedActionsPayload> {
  // 1. Fetch all actions
  const actionsResp = await ozonRequest<{ result: OzonActionRaw[] }>(
    env,
    '/v1/actions',
    'GET',
  );
  const allActions = actionsResp.result || [];
  const participating = allActions.filter((a) => a.is_participating);

  // 2. Fetch products for each participating action
  type ActionWithProducts = {
    raw: OzonActionRaw;
    products: OzonActionProduct[];
  };
  const actionsWithProducts: ActionWithProducts[] = [];
  for (const a of participating) {
    let allProds: OzonActionProduct[] = [];
    let offset = 0;
    const limit = 1000;
    // paginate
    while (true) {
      const r = await ozonRequest<{
        result: { products?: OzonActionProduct[]; total?: number };
      }>(env, '/v1/actions/products', 'POST', {
        action_id: a.id,
        limit,
        offset,
      });
      const prods = r.result?.products || [];
      allProds = allProds.concat(prods);
      if (prods.length < limit) break;
      offset += prods.length;
    }
    actionsWithProducts.push({ raw: a, products: allProds });
  }

  // 3. Collect all unique product_ids and fetch SKU info in one batch
  const uniqueIds = new Set<number>();
  for (const a of actionsWithProducts) {
    for (const p of a.products) uniqueIds.add(p.id);
  }
  const infoMap = await fetchAllProductInfo(env, Array.from(uniqueIds));

  // 4. Apply auto-zero policy for STOCK_DISCOUNT actions (first-time-seen only)
  const autoZeroedMap = await autoZeroStockDiscount(env, actionsWithProducts);

  // 4b. Fetch sales data once (covers the broadest action window)
  //     We compute earliest action start across all participating actions and
  //     pull ordered_units per Ozon sku from that date to today. For each
  //     product in an action, sold_count = sum of ordered_units for that
  //     product's sku variants within the action's window.
  //     This is best-effort and may be off when an SKU sold at multiple
  //     price tiers — manual override (via UI save) still takes precedence.
  let salesBySku: Map<string, number> = new Map();
  try {
    const today = new Date();
    let earliest: Date | null = null;
    for (const aw of actionsWithProducts) {
      if (!aw.raw.date_start) continue;
      const d = new Date(aw.raw.date_start);
      if (!earliest || d < earliest) earliest = d;
    }
    // Cap window at 30 days max — long actions (e.g. "Эластичный бустинг.
    // Без ограничения срока действия") would otherwise sum all-time sales
    // and make left_to_sell unrealistically low. 30 days approximates the
    // current cycle since last stock adjustment.
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000);
    if (!earliest || earliest < thirtyDaysAgo) earliest = thirtyDaysAgo;
    salesBySku = await fetchSalesSince(env, isoDate(earliest), isoDate(today));
  } catch {
    // Analytics is non-fatal — fall back to null sold_count when unavailable
    salesBySku = new Map();
  }

  // 5. Build response
  const now = new Date().toISOString();
  const actions = await Promise.all(
    actionsWithProducts.map(async (aw) => {
      const productsOut = await Promise.all(
        aw.products.map(async (p) => {
          const info = infoMap.get(p.id);
          const discountPct =
            p.price > 0 ? Math.round(((p.price - p.action_price) / p.price) * 100) : 0;
          // Sold count priority:
          //   1. Manual override stored in KV (Aram typed in UI)
          //   2. Computed from analytics: sum ordered_units across this product's
          //      Ozon sku variants since the action started
          const manualSold = await getSoldCount(env, aw.raw.id, p.id);
          let soldCount: number | null = manualSold;
          if (soldCount == null && info?.sources && info.sources.length > 0) {
            let sum = 0;
            let anyData = false;
            for (const src of info.sources) {
              const v = salesBySku.get(String(src.sku));
              if (v != null) {
                sum += v;
                anyData = true;
              }
            }
            if (anyData) soldCount = sum;
          }
          const leftToSell = soldCount != null ? Math.max(0, p.stock - soldCount) : null;
          return {
            product_id: p.id,
            offer_id: info?.offer_id || '',
            name: info?.name || '',
            price: p.price,
            action_price: p.action_price,
            discount_pct: discountPct,
            stock: p.stock,
            min_stock: p.min_stock,
            sold_count: soldCount,
            left_to_sell: leftToSell,
          };
        }),
      );
      productsOut.sort((a, b) => b.stock - a.stock);
      const totalUnits = productsOut.reduce((s, p) => s + p.stock, 0);
      return {
        action_id: aw.raw.id,
        title: aw.raw.title,
        action_type: aw.raw.action_type,
        date_start: aw.raw.date_start,
        date_end: aw.raw.date_end,
        days_left: daysBetween(now, aw.raw.date_end),
        is_voucher_action: aw.raw.is_voucher_action,
        participating_products_count: aw.raw.participating_products_count,
        total_units_left: totalUnits,
        auto_zeroed_at: autoZeroedMap.get(aw.raw.id) || null,
        products: productsOut,
      };
    }),
  );

  // Sort actions by priority bucket, then by days_left within each bucket:
  //   bucket 1 — "Эластичный бустинг" (always first, no expiry pressure)
  //   bucket 2 — "Максимальный бустинг" (and "Максимальный бустинг: усиление")
  //   bucket 3 — any other promotion
  //   bucket 4 — "Распродажа" actions (auto-zeroed clearance; least interesting day-to-day)
  function bucket(title: string): number {
    const t = title.toLowerCase();
    if (t.includes('эластичный бустинг')) return 1;
    if (t.includes('максимальный бустинг')) return 2;
    if (t.includes('распродажа')) return 4;
    return 3;
  }
  actions.sort((a, b) => {
    const ba = bucket(a.title);
    const bb = bucket(b.title);
    if (ba !== bb) return ba - bb;
    if (a.days_left !== b.days_left) return a.days_left - b.days_left;
    return b.total_units_left - a.total_units_left;
  });

  const grandTotal = actions.reduce((s, a) => s + a.total_units_left, 0);
  const allSkus = new Set<string>();
  for (const a of actions) for (const p of a.products) if (p.offer_id) allSkus.add(p.offer_id);

  return {
    generated_at: now,
    total_actions: allActions.length,
    participating_count: participating.length,
    total_units_left: grandTotal,
    total_skus_in_promos: allSkus.size,
    actions,
  };
}

// ---------------------------------------------------------------------------
// GET /api/marketplaces/ozon/actions
// ---------------------------------------------------------------------------
promos.get('/ozon/actions', async (c) => {
  const force = c.req.query('refresh') === '1';

  // Try cache
  if (!force) {
    try {
      const cached = await c.env.CACHE.get(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedActionsPayload;
        return ok(c, { ...parsed, _cached: true });
      }
    } catch {
      // ignore cache errors
    }
  }

  // Fetch fresh
  try {
    const payload = await buildPayload(c.env);
    try {
      await c.env.CACHE.put(CACHE_KEY, JSON.stringify(payload), {
        expirationTtl: CACHE_TTL_SEC,
      });
    } catch {
      // cache write failed — still return data
    }
    return ok(c, { ...payload, _cached: false });
  } catch (e) {
    return fail(c, 502, e instanceof Error ? e.message : 'Ozon API error');
  }
});

// ---------------------------------------------------------------------------
// POST /api/marketplaces/ozon/actions/:actionId/stock
//
// Update for ONE product in an action. Body accepts either of two modes:
//
//   Mode A — set total quota directly:
//     { product_id, stock: <new_total>, current_stock: <prev>, action_price? }
//     If current_stock provided AND current sold_count is known, sold_count
//     stays the same (left_to_sell shifts by same delta as stock).
//
//   Mode B — set "left to sell" (Ozon column "Осталось продать"):
//     { product_id, left_to_sell: N, current_stock: <prev>, current_left?: <prev>, action_price? }
//     We compute sold_count = current_stock - (current_left ?? unknown)
//     and new_stock = sold_count + N, then push that to Ozon.
//
//     If current_left was not provided, we assume sold_count = current_stock - 0 (all unsold)
//     on first save → new_stock = N. Subsequent saves use the stored sold_count.
//
// In both modes we persist sold_count so the next refresh shows correct
// left_to_sell.
// ---------------------------------------------------------------------------
promos.post('/ozon/actions/:actionId/stock', async (c) => {
  const actionId = Number(c.req.param('actionId'));
  if (!actionId || Number.isNaN(actionId)) return fail(c, 400, 'invalid action_id');

  let body: {
    product_id?: number;
    stock?: number;
    left_to_sell?: number;
    current_stock?: number;
    current_left?: number;
    action_price?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid JSON body');
  }
  const productId = Number(body.product_id);
  if (!productId || Number.isNaN(productId)) return fail(c, 400, 'product_id required');

  // Compute target stock based on input mode
  let targetStock: number;
  let newSoldCount: number | null = null;

  const stored = await getSoldCount(c.env, actionId, productId);

  if (typeof body.left_to_sell === 'number') {
    // Mode B — user edited "left to sell"
    const newLeft = Number(body.left_to_sell);
    if (Number.isNaN(newLeft) || newLeft < 0)
      return fail(c, 400, 'left_to_sell must be a non-negative number');

    // Determine sold_count: either from stored, or from provided current_stock & current_left
    let soldCount: number;
    if (
      typeof body.current_stock === 'number' &&
      typeof body.current_left === 'number'
    ) {
      soldCount = Math.max(0, body.current_stock - body.current_left);
    } else if (stored != null) {
      soldCount = stored;
    } else {
      // Unknown sold_count; assume 0 (first save establishes the baseline)
      soldCount = 0;
    }
    targetStock = soldCount + newLeft;
    newSoldCount = soldCount;
  } else if (typeof body.stock === 'number') {
    // Mode A — user edited "stock" (quantity in promo)
    targetStock = Number(body.stock);
    if (Number.isNaN(targetStock) || targetStock < 0)
      return fail(c, 400, 'stock must be a non-negative number');
    // sold_count stays unchanged (delta moves left_to_sell symmetrically)
    newSoldCount = stored; // keep as-is, no change
  } else {
    return fail(c, 400, 'either stock or left_to_sell required');
  }

  const productPayload: Record<string, unknown> = {
    product_id: productId,
    stock: targetStock,
  };
  if (typeof body.action_price === 'number' && body.action_price > 0) {
    productPayload.action_price = body.action_price;
  }

  try {
    const resp = await ozonRequest<{
      result?: { product_ids?: number[]; rejected?: Array<{ product_id: number; reason: string }> };
    }>(c.env, '/v1/actions/products/activate', 'POST', {
      action_id: actionId,
      products: [productPayload],
    });

    const accepted = resp.result?.product_ids ?? [];
    const rejected = resp.result?.rejected ?? [];

    if (rejected.length > 0) {
      // Cache stays — nothing was changed at Ozon
      const r = rejected[0];
      return fail(c, 409, `Ozon rejected: ${r.reason}`);
    }

    // Persist sold_count (so left_to_sell can be computed on next refresh)
    if (newSoldCount != null) {
      await setSoldCount(c.env, actionId, productId, newSoldCount);
    }

    // Invalidate cache so next GET pulls fresh data
    try {
      await c.env.CACHE.delete(CACHE_KEY);
    } catch {
      // ignore
    }

    return ok(c, {
      action_id: actionId,
      product_id: productId,
      new_stock: targetStock,
      sold_count: newSoldCount,
      left_to_sell: newSoldCount != null ? Math.max(0, targetStock - newSoldCount) : null,
      accepted_count: accepted.length,
    });
  } catch (e) {
    return fail(c, 502, e instanceof Error ? e.message : 'Ozon API error');
  }
});

export default promos;
