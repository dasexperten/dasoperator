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

const CACHE_KEY = 'ozon:actions:v17';
const CACHE_TTL_SEC = 30 * 60; // 30 min
const AUTO_ZERO_FLAG_PREFIX = 'ozon:promos:auto-zeroed:';
const AUTO_ZERO_FLAG_TTL_SEC = 365 * 24 * 60 * 60; // 1 year — flag is durable

// Patch a single product inside the cached payload in-place. Much faster than
// invalidating the whole cache and triggering a 15s rebuild on the next GET.
// Returns true if the patch was applied, false if the cache miss / wasn't found.
async function patchCachedProduct(
  env: Env,
  actionId: number,
  productId: number,
  patch: Partial<CachedActionsPayload['actions'][number]['products'][number]>,
): Promise<boolean> {
  try {
    const cached = await env.CACHE.get(CACHE_KEY);
    if (!cached) return false;
    const payload = JSON.parse(cached) as CachedActionsPayload;
    let touched = false;
    for (const a of payload.actions) {
      if (a.action_id !== actionId) continue;
      for (let i = 0; i < a.products.length; i++) {
        if (a.products[i].product_id === productId) {
          a.products[i] = { ...a.products[i], ...patch };
          touched = true;
          break;
        }
      }
      if (touched) break;
    }
    if (!touched) return false;
    await env.CACHE.put(CACHE_KEY, JSON.stringify(payload), {
      expirationTtl: CACHE_TTL_SEC,
    });
    return true;
  } catch {
    return false;
  }
}

// Remove a single product from the cached payload (when product is deactivated).
async function removeCachedProduct(
  env: Env,
  actionId: number,
  productId: number,
): Promise<boolean> {
  try {
    const cached = await env.CACHE.get(CACHE_KEY);
    if (!cached) return false;
    const payload = JSON.parse(cached) as CachedActionsPayload;
    let touched = false;
    for (const a of payload.actions) {
      if (a.action_id !== actionId) continue;
      const before = a.products.length;
      a.products = a.products.filter((p) => p.product_id !== productId);
      if (a.products.length !== before) {
        a.participating_products_count = a.products.length;
        a.deciding_count = a.products.filter((p) => p.is_deciding_price).length;
        a.total_units_left = a.products.reduce((s, p) => s + p.stock, 0);
        touched = true;
      }
      break;
    }
    if (!touched) return false;
    await env.CACHE.put(CACHE_KEY, JSON.stringify(payload), {
      expirationTtl: CACHE_TTL_SEC,
    });
    return true;
  } catch {
    return false;
  }
}

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
  min_boost?: number;
  max_boost?: number;
  price_min_elastic?: number; // price floor to qualify for min boost level
  price_max_elastic?: number; // price floor to qualify for max boost level
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
    is_participating: boolean;
    participating_products_count: number;
    potential_products_count: number;
    total_units_left: number;
    auto_zeroed_at: string | null;
    deciding_count: number;
    products: Array<{
      product_id: number;
      offer_id: string;
      name: string;
      price: number;
      action_price: number;
      discount_pct: number;
      stock: number;
      min_stock: number;
      min_price: number | null;
      current_price: number;
      is_deciding_price: boolean;
      sold_count: number | null;
      sold_source: 'manual' | 'portal' | 'analytics' | null;
      left_to_sell: number | null;
      refill_rule: { threshold: number; target: number } | null;
      // Boost slider data (from Ozon /v1/actions/products)
      price_min_elastic: number | null; // price floor for min boost (e.g. 742)
      price_max_elastic: number | null; // price floor for max boost (e.g. 623)
      current_boost: number | null;     // current boost % (0..max_boost)
      min_boost: number | null;         // action's minimum boost % (e.g. 15)
      max_boost: number | null;         // action's maximum boost % (e.g. 55)
      // FBO warehouse stock (what's actually in Ozon fulfillment centers)
      fbo_present: number | null;       // units available across FBO warehouses
      fbo_reserved: number | null;      // units in pending orders
      // Cluster FBO for regional Распродажа actions (single specific warehouse)
      cluster_fbo_present: number | null;   // units at the action's region
      cluster_fbo_days: number | null;      // days of cover at this region's pace
      cluster_fbo_warehouse: string | null; // canonical warehouse name (e.g. АЛМАТЫ_2_РФЦ)
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

// Fetch per-SKU current displayed price + minimum price floor from Ozon.
// We use `marketing_seller_price` (the post-auto-promo price buyers actually
// see) rather than `price.price` (the seller's base price before active promos
// are applied). Min price (price.min_price) is the seller-set floor below which
// Ozon blocks. Uses /v5/product/info/prices with product_id filter; paginates.
async function fetchAllProductPriceInfo(
  env: Env,
  productIds: number[],
): Promise<Map<number, { current_price: number; min_price: number | null }>> {
  const map = new Map<number, { current_price: number; min_price: number | null }>();
  if (productIds.length === 0) return map;
  const chunkSize = 1000;
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const chunk = productIds.slice(i, i + chunkSize);
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const resp = await ozonRequest<{
        items?: Array<{
          product_id: number;
          offer_id?: string;
          price?: {
            price?: number | string;
            min_price?: number | string;
            marketing_seller_price?: number | string;
          };
        }>;
        cursor?: string;
        total?: number;
      }>(env, '/v5/product/info/prices', 'POST', {
        filter: { product_id: chunk.map(String), visibility: 'ALL' },
        limit: 1000,
        cursor,
      });
      const items = resp.items || [];
      for (const it of items) {
        if (!it || typeof it.product_id !== 'number') continue;
        const rawMkt = it.price?.marketing_seller_price;
        const rawBase = it.price?.price;
        const rawMin = it.price?.min_price;
        const mkt = typeof rawMkt === 'string' ? Number(rawMkt) : rawMkt;
        const base = typeof rawBase === 'string' ? Number(rawBase) : rawBase;
        const min = typeof rawMin === 'string' ? Number(rawMin) : rawMin;
        const minVal = typeof min === 'number' && Number.isFinite(min) && min > 0 ? min : null;
        // Prefer marketing_seller_price (post-auto-promo). Fall back to base
        // price if marketing is zero/missing (rare — usually for SKUs with no
        // active promos at all).
        const mktVal = typeof mkt === 'number' && Number.isFinite(mkt) && mkt > 0 ? mkt : 0;
        const baseVal = typeof base === 'number' && Number.isFinite(base) ? base : 0;
        map.set(it.product_id, { current_price: mktVal || baseVal, min_price: minVal });
      }
      if (!resp.cursor || resp.cursor === '' || items.length === 0) break;
      cursor = resp.cursor;
    }
  }
  return map;
}

// Fetch FBO warehouse stock per SKU. Returns total `present` units across all
// warehouses (Ozon aggregates by type=fbo). Used to show "what's actually
// available to fulfill orders" alongside the promo's Left-to-sell counter.
// Per-warehouse FBO stock map. Returns:
//   sku → warehouse_name → { present, reserved }
// Uses Ozon /v2/analytics/stock_on_warehouses which gives stock per RFC.
// SKU here is the marketplace SKU (numeric, different from product_id).
async function fetchPerWarehouseStock(
  env: Env,
): Promise<Map<number, Map<string, { present: number; reserved: number }>>> {
  const map = new Map<number, Map<string, { present: number; reserved: number }>>();
  let offset = 0;
  const limit = 1000;
  for (let page = 0; page < 30; page++) {
    let resp: {
      result?: {
        rows?: Array<{
          sku: number;
          warehouse_name: string;
          free_to_sell_amount?: number;
          reserved_amount?: number;
        }>;
      };
    };
    try {
      resp = await ozonRequest<typeof resp>(
        env,
        '/v2/analytics/stock_on_warehouses',
        'POST',
        { limit, offset, warehouse_type: 'ALL' },
      );
    } catch {
      break;
    }
    const rows = resp.result?.rows || [];
    if (rows.length === 0) break;
    for (const r of rows) {
      if (!r.sku || !r.warehouse_name) continue;
      let bySku = map.get(r.sku);
      if (!bySku) {
        bySku = new Map();
        map.set(r.sku, bySku);
      }
      bySku.set(r.warehouse_name, {
        present: r.free_to_sell_amount || 0,
        reserved: r.reserved_amount || 0,
      });
    }
    if (rows.length < limit) break;
    offset += rows.length;
  }
  return map;
}

// Daily sales rate per SKU per warehouse, last 30 days.
// Returns sku → warehouse_name → daily_avg_units.
// Uses /v1/analytics/data with dimension by sku + warehouse_name.
async function fetchPerWarehouseSalesRate(
  env: Env,
): Promise<Map<number, Map<string, number>>> {
  const map = new Map<number, Map<string, number>>();
  const dateTo = new Date().toISOString().slice(0, 10);
  const dateFrom = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let offset = 0;
  const limit = 1000;
  for (let page = 0; page < 30; page++) {
    let resp: {
      result?: {
        data?: Array<{
          dimensions: Array<{ id: string; name: string }>;
          metrics: number[];
        }>;
      };
    };
    try {
      resp = await ozonRequest<typeof resp>(env, '/v1/analytics/data', 'POST', {
        date_from: dateFrom,
        date_to: dateTo,
        dimension: ['sku', 'warehouse_name'],
        metrics: ['ordered_units'],
        offset,
        limit,
      });
    } catch {
      break;
    }
    const data = resp.result?.data || [];
    if (data.length === 0) break;
    for (const row of data) {
      const skuStr = row.dimensions?.[0]?.id;
      const wh = row.dimensions?.[1]?.name;
      const units = row.metrics?.[0];
      if (!skuStr || !wh || typeof units !== 'number') continue;
      const sku = Number(skuStr);
      if (!sku) continue;
      const perDay = units / 30;
      let bySku = map.get(sku);
      if (!bySku) {
        bySku = new Map();
        map.set(sku, bySku);
      }
      bySku.set(wh, perDay);
    }
    if (data.length < limit) break;
    offset += data.length;
  }
  return map;
}

// Determine which warehouse this Распродажа is for, by parsing the title.
// Returns the canonical warehouse_name as it appears in stock_on_warehouses.
function extractRegionWarehouse(title: string): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  if (!t.includes('распродажа')) return null;
  // Map of region keywords → canonical warehouse_name in Ozon
  const map: Array<{ key: string; wh: string }> = [
    { key: 'алматы', wh: 'АЛМАТЫ_2_РФЦ' },
    { key: 'астана', wh: 'АСТАНА_РФЦ' },
    { key: 'минск', wh: 'МИНСК_МПСЦ' },
    { key: 'красноярск', wh: 'КРАСНОЯРСК_МРФЦ' },
    { key: 'новороссийск', wh: 'НОВОРОССИЙСК_РФЦ' },
    { key: 'воронеж', wh: 'ВОРОНЕЖ_РФЦ' },
    { key: 'шушары', wh: 'СПБ_ШУШАРЫ_РФЦ' },
  ];
  for (const { key, wh } of map) {
    if (t.includes(key)) return wh;
  }
  return null;
}

async function fetchAllProductFboStock(
  env: Env,
  productIds: number[],
): Promise<Map<number, { present: number; reserved: number }>> {
  const map = new Map<number, { present: number; reserved: number }>();
  if (productIds.length === 0) return map;
  const chunkSize = 500;
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const chunk = productIds.slice(i, i + chunkSize);
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const resp = await ozonRequest<{
        items?: Array<{
          product_id: number;
          stocks?: Array<{ type: string; present?: number; reserved?: number }>;
        }>;
        cursor?: string;
      }>(env, '/v4/product/info/stocks', 'POST', {
        filter: { product_id: chunk.map(String), visibility: 'ALL' },
        last_id: cursor,
        limit: 1000,
      });
      const items = resp.items || [];
      for (const it of items) {
        if (!it || typeof it.product_id !== 'number') continue;
        let present = 0;
        let reserved = 0;
        for (const s of it.stocks || []) {
          if (s.type === 'fbo') {
            present += typeof s.present === 'number' ? s.present : 0;
            reserved += typeof s.reserved === 'number' ? s.reserved : 0;
          }
        }
        map.set(it.product_id, { present, reserved });
      }
      if (!resp.cursor || resp.cursor === '' || items.length === 0) break;
      cursor = resp.cursor;
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
// Refill rules — per-product autopilot for promo "left to sell" quotas.
//
// Rule shape: { threshold: number, target: number }
//   - threshold: if left_to_sell drops below this, refill is triggered
//   - target:    cron pushes left_to_sell back up to this value
// Both must be positive; target must be > threshold (otherwise refill would
// re-trigger immediately). Stored durably in KV (no TTL). Deleting the key
// = no rule.
// ---------------------------------------------------------------------------
function refillRuleKey(actionId: number, productId: number): string {
  return `ozon:promo:refill:${actionId}:${productId}`;
}

interface RefillRule {
  threshold: number;
  target: number;
}

async function getRefillRule(
  env: Env,
  actionId: number,
  productId: number,
): Promise<RefillRule | null> {
  try {
    const v = await env.CACHE.get(refillRuleKey(actionId, productId));
    if (!v) return null;
    const parsed = JSON.parse(v) as Partial<RefillRule>;
    if (
      typeof parsed.threshold === 'number' &&
      typeof parsed.target === 'number' &&
      parsed.threshold >= 0 &&
      parsed.target > parsed.threshold
    ) {
      return { threshold: parsed.threshold, target: parsed.target };
    }
    return null;
  } catch {
    return null;
  }
}

async function setRefillRule(
  env: Env,
  actionId: number,
  productId: number,
  rule: RefillRule | null,
): Promise<void> {
  const key = refillRuleKey(actionId, productId);
  try {
    if (rule == null) {
      await env.CACHE.delete(key);
    } else {
      await env.CACHE.put(key, JSON.stringify(rule));
    }
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
// Ozon Seller Portal scraper — fetches accurate "Осталось продать" values
// that aren't exposed in the public API.
//
// Endpoint: /api/site/global-seller-products/v1/action/{id}/products/active
// Auth: session cookies (Worker secret OZON_PORTAL_COOKIES).
// Anti-bot: server returns 307 redirects with __rr=N appended that must be
// followed while preserving updated __Secure-ETC cookie from Set-Cookie header.
// Cloudflare Worker fetch() follows redirects but doesn't auto-rotate cookies
// across them, so we follow manually up to 5 hops.
//
// Returns Map<product_id, { sold: number, isSoldOut: boolean }>
// where sold = quantity - remainingActionStock for each product.
// ---------------------------------------------------------------------------
interface PortalProduct {
  id: string;
  offerId: string;
  quantity: string;
  remainingActionStock: string;
  isActionStockSold: boolean;
}

async function fetchOzonPortalProducts(
  env: Env,
  actionId: number,
): Promise<Map<number, { sold: number; isSoldOut: boolean }>> {
  const result = new Map<number, { sold: number; isSoldOut: boolean }>();
  if (!env.OZON_PORTAL_COOKIES) return result;

  let cookies = env.OZON_PORTAL_COOKIES;
  const baseUrl = `https://seller.ozon.ru/api/site/global-seller-products/v1/action/${actionId}/products/active`;
  let limit = 100;
  let offset = 0;

  for (let page = 0; page < 5; page++) {
    let url = `${baseUrl}?offset=${offset}&limit=${limit}`;
    let body: string | null = null;

    // Follow up to 5 redirects manually, carrying updated cookies
    for (let hop = 0; hop < 6; hop++) {
      const resp = await fetch(url, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'ru,en;q=0.9',
          'accept-encoding': 'gzip, deflate, br, zstd',
          cookie: cookies,
          priority: 'u=1, i',
          referer: `https://seller.ozon.ru/app/highlights/${actionId}`,
          'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-origin',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
          'x-o3-company-id': '374116',
          'x-o3-language': 'ru',
        },
        redirect: 'manual',
      });

      // Pick up Set-Cookie updates (esp. __Secure-ETC rotates each hop)
      const setCookie = resp.headers.get('set-cookie');
      if (setCookie) {
        // Set-Cookie may bundle multiple cookies separated by comma. Split conservatively.
        const newCookies = setCookie
          .split(/,(?=[^;]+=[^;]+)/) // split on comma followed by name=value pattern
          .map((c) => c.split(';')[0].trim())
          .filter(Boolean);
        for (const nc of newCookies) {
          const [name] = nc.split('=');
          if (!name) continue;
          // Replace existing or append
          const re = new RegExp(`(^|;\\s*)${name}=[^;]*`);
          if (re.test(cookies)) {
            cookies = cookies.replace(re, (_, prefix) => `${prefix}${nc}`);
          } else {
            cookies = `${cookies}; ${nc}`;
          }
        }
      }

      if (resp.status === 200) {
        body = await resp.text();
        break;
      }
      if (resp.status === 307 || resp.status === 302 || resp.status === 301) {
        const loc = resp.headers.get('location');
        if (!loc) break;
        url = loc.startsWith('http') ? loc : `https://seller.ozon.ru${loc}`;
        continue;
      }
      // Auth failure or other — abort and return whatever we have
      return result;
    }
    if (!body) break;

    let parsed: { products?: PortalProduct[]; total?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      break;
    }
    const products = parsed.products ?? [];
    for (const p of products) {
      const pid = Number(p.id);
      const qty = Number(p.quantity || '0');
      const remaining = Number(p.remainingActionStock || '0');
      const sold = Math.max(0, qty - remaining);
      result.set(pid, { sold, isSoldOut: !!p.isActionStockSold });
    }
    if (products.length < limit) break;
    offset += products.length;
  }

  return result;
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

    // ALWAYS check current state — Ozon may have added new products to the
    // action after our initial purge, in which case those new SKUs would
    // still be participating. We want every Распродажа to stay EMPTY across
    // the board, indefinitely.
    // NOTE: For STOCK_DISCOUNT actions, /v1/actions/products/activate with
    // stock=0 silently succeeds but doesn't actually change anything (Ozon
    // returns empty product_ids). The only way to truly remove products is
    // via /v1/actions/products/deactivate.
    const toRemove = aw.products.filter((p) => p.stock > 0);
    let removedAnything = false;

    if (toRemove.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < toRemove.length; i += batchSize) {
        const batch = toRemove.slice(i, i + batchSize);
        try {
          await ozonRequest(env, '/v1/actions/products/deactivate', 'POST', {
            action_id: aw.raw.id,
            product_ids: batch.map((p) => p.id),
          });
          removedAnything = true;
        } catch (e) {
          console.error(
            `auto-zero (deactivate) batch failed for action ${aw.raw.id}:`,
            e instanceof Error ? e.message : e,
          );
        }
      }
      if (removedAnything) {
        // Reflect change in-memory: zero stock so UI shows them as "zeroed".
        // They'll be gone from the products list on next refresh anyway, but
        // setting stock=0 keeps the current response consistent.
        for (const p of aw.products) {
          if (p.stock > 0) p.stock = 0;
        }
      }
    }

    const ts = existingFlag || new Date().toISOString();
    if (!existingFlag) {
      try {
        await env.CACHE.put(flagKey, ts, { expirationTtl: AUTO_ZERO_FLAG_TTL_SEC });
      } catch {
        // ignore
      }
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

  // We render BOTH participating actions and actions where we have candidates
  // (potential_products_count > 0). The user can toggle individual SKUs in
  // or out via per-product activate/deactivate buttons.
  // EXCEPT: the general "Распродажа стока. Май" (the country-wide stock clearance)
  // — Aram never uses it, so hide it from the view entirely.
  const relevant = allActions.filter((a) => {
    const title = (a.title || '').toLowerCase();
    // Hide non-regional Распродажа стока (regional ones have a city name, e.g.
    // "Распродажа стока АЛМАТЫ_2_РФЦ"). The general one has just "Май" or "стока." period.
    if (
      title.includes('распродажа стока') &&
      !title.match(/(алматы|астана|минск|краснояр|шушары|новороссийск|воронеж)/i)
    ) {
      return false;
    }
    return a.is_participating || (a.potential_products_count || 0) > 0;
  });

  // 2. Fetch products for each action — /products for participating,
  //    /candidates for the rest. Both return the same shape.
  type ActionWithProducts = {
    raw: OzonActionRaw;
    products: OzonActionProduct[];
    is_candidate_list: boolean; // true when we pulled from /candidates
  };
  const actionsWithProducts: ActionWithProducts[] = [];
  for (const a of relevant) {
    let allProds: OzonActionProduct[] = [];
    let offset = 0;
    const limit = 1000;
    const endpoint = a.is_participating
      ? '/v1/actions/products'
      : '/v1/actions/candidates';
    while (true) {
      const r = await ozonRequest<{
        result: { products?: OzonActionProduct[]; total?: number };
      }>(env, endpoint, 'POST', {
        action_id: a.id,
        limit,
        offset,
      });
      const prods = r.result?.products || [];
      allProds = allProds.concat(prods);
      if (prods.length < limit) break;
      offset += prods.length;
    }
    actionsWithProducts.push({
      raw: a,
      products: allProds,
      is_candidate_list: !a.is_participating,
    });
  }

  // 3. Collect all unique product_ids and fetch SKU info + min_price in parallel
  const uniqueIds = new Set<number>();
  for (const a of actionsWithProducts) {
    for (const p of a.products) uniqueIds.add(p.id);
  }
  const idArr = Array.from(uniqueIds);
  const [infoMap, priceInfoMap, fboStockMap, perWhStock, perWhSales] = await Promise.all([
    fetchAllProductInfo(env, idArr),
    fetchAllProductPriceInfo(env, idArr).catch(
      () => new Map<number, { current_price: number; min_price: number | null }>(),
    ),
    fetchAllProductFboStock(env, idArr).catch(
      () => new Map<number, { present: number; reserved: number }>(),
    ),
    fetchPerWarehouseStock(env).catch(
      () => new Map<number, Map<string, { present: number; reserved: number }>>(),
    ),
    fetchPerWarehouseSalesRate(env).catch(() => new Map<number, Map<string, number>>()),
  ]);

  // Overlay name with our D1 products.product_name (single source of truth).
  // Ozon's name is whatever the catalog card says, often legacy. Marketplace
  // UI should reflect the renames we apply in ERP.
  try {
    const offerIds = Array.from(
      new Set(
        Array.from(infoMap.values())
          .map((it) => (it.offer_id || '').toLowerCase())
          .filter((s) => s.length > 0),
      ),
    );
    if (offerIds.length > 0) {
      const placeholders = offerIds.map(() => '?').join(',');
      const rows = await env.DB.prepare(
        `SELECT id, product_name FROM products WHERE deleted_at IS NULL AND id IN (${placeholders})`,
      ).bind(...offerIds).all<{ id: string; product_name: string }>();
      const dbNames = new Map<string, string>();
      for (const r of rows.results ?? []) {
        if (r.id && r.product_name) dbNames.set(r.id.toLowerCase(), r.product_name);
      }
      for (const [pid, info] of infoMap.entries()) {
        const ours = dbNames.get((info.offer_id || '').toLowerCase());
        if (ours) infoMap.set(pid, { ...info, name: ours });
      }
    }
  } catch (e) {
    // Best-effort overlay — never break the actions response if DB query fails.
    console.error('[promos] product_name overlay failed:', e);
  }

  // 4. (Removed: autoZeroStockDiscount — Распродажа actions are now shown as
  //    candidate lists with per-SKU toggle, not auto-deactivated.)

  // 4b. Fetch portal data per action (PRIMARY source of accurate "Осталось продать")
  //     Ozon Seller Portal endpoint returns remainingActionStock per product —
  //     this is the same value shown in the seller's UI. We fetch one request
  //     per action with the session cookies stored in Worker secret
  //     OZON_PORTAL_COOKIES. If the secret is missing or session expired,
  //     fall through to analytics (less accurate but always available).
  //
  //     ADDITIONALLY: check KV for VPS-ingested portal data (key prefix
  //     ozon:promo:portal:...). The VPS scraper bypasses Cloudflare's TLS
  //     fingerprint problem and POSTs results to /ozon/portal-ingest.
  const portalDataByAction = new Map<
    number,
    Map<number, { sold: number; isSoldOut: boolean }>
  >();
  try {
    // First try VPS-ingested data from KV
    for (const aw of actionsWithProducts) {
      const productMap = new Map<number, { sold: number; isSoldOut: boolean; warehouseStock?: number | null }>();
      for (const p of aw.products) {
        try {
          const stored = await env.CACHE.get(
            `ozon:promo:portal:${aw.raw.id}:${p.id}`,
          );
          if (stored) {
            const parsed = JSON.parse(stored) as {
              sold: number;
              is_sold_out: boolean;
              warehouse_stock?: number | null;
            };
            productMap.set(p.id, {
              sold: parsed.sold,
              isSoldOut: parsed.is_sold_out,
              warehouseStock: typeof parsed.warehouse_stock === 'number' ? parsed.warehouse_stock : null,
            });
          }
        } catch {
          // skip individual product on error
        }
      }
      if (productMap.size > 0) {
        portalDataByAction.set(aw.raw.id, productMap);
      }
    }

    // Then try direct Worker-side scrape for any action not covered by VPS data
    await Promise.all(
      actionsWithProducts.map(async (aw) => {
        if (portalDataByAction.has(aw.raw.id)) return; // VPS data already present
        const portalMap = await fetchOzonPortalProducts(env, aw.raw.id);
        if (portalMap.size > 0) {
          portalDataByAction.set(aw.raw.id, portalMap);
        }
      }),
    );
  } catch {
    // Portal scraping is non-fatal — fall back to analytics
  }

  // 4c. Fetch analytics-based sales (FALLBACK when portal data missing)
  //     We compute earliest action start across all participating actions and
  //     pull ordered_units per Ozon sku from that date to today.
  //
  //     Cap window at 30 days max — long actions (e.g. "Эластичный бустинг.
  //     Без ограничения срока действия") would otherwise sum all-time sales
  //     and make left_to_sell unrealistically low. 30 days approximates the
  //     current cycle since last stock adjustment.
  //
  //     Manual override (via UI save) takes precedence over both portal and
  //     analytics — Aram's explicit input is always honored.
  //
  //     Per-action sales windows:
  //       - Finite actions (≤90 days): from date_start to today
  //         → analytics shows actual "sold in this promo"
  //       - Unlimited actions (>90 days, e.g. Эластичный бустинг):
  //         last 30 days only (avoids summing all-time sales as "promo sold")
  //         — though for unlimited, manual baseline usually wins anyway.
  //
  //     Sequential execution to stay under Ozon Analytics rate limit
  //     (Promise.all blasting 10× paginated calls hit empty-response 429s).
  const salesByActionAndSku: Map<number, Map<string, number>> = new Map();
  {
    const today = new Date();
    const todayIso = isoDate(today);
    for (const aw of actionsWithProducts) {
      try {
        const ds = aw.raw.date_start ? new Date(aw.raw.date_start) : null;
        const de = aw.raw.date_end ? new Date(aw.raw.date_end) : null;
        const durationMs = ds && de ? de.getTime() - ds.getTime() : 0;
        const isFiniteWin = durationMs > 0 && durationMs <= 90 * 86400000;
        const dateFrom =
          isFiniteWin && ds
            ? ds
            : new Date(today.getTime() - 30 * 86400000);
        const map = await fetchSalesSince(env, isoDate(dateFrom), todayIso);
        salesByActionAndSku.set(aw.raw.id, map);
      } catch {
        salesByActionAndSku.set(aw.raw.id, new Map());
      }
    }
  }

  // 5. Build response
  const now = new Date().toISOString();
  const actions = await Promise.all(
    actionsWithProducts.map(async (aw) => {
      const portalMap = portalDataByAction.get(aw.raw.id);
      // For regional Распродажа, look up cluster_fbo from the specific warehouse
      // mentioned in the action title (e.g. АЛМАТЫ_2_РФЦ).
      const regionWh = extractRegionWarehouse(aw.raw.title);
      const productsOut = await Promise.all(
        aw.products.map(async (p) => {
          const info = infoMap.get(p.id);
          // Look up cluster FBO + turnover when this is a regional action
          let cluster_fbo_present: number | null = null;
          let cluster_fbo_days: number | null = null;
          let cluster_fbo_warehouse: string | null = null;
          if (regionWh && info) {
            // Find the SKU number for this product. Ozon source types: 'sds'
            // (Direct Sales = FBO), 'fbs' (sellers stock). FBO SKU is what
            // stock_on_warehouses uses. Prefer GENERAL shipment_type SKU.
            const sources = info.sources || [];
            const fboSource =
              sources.find(
                (s) =>
                  (s.source === 'sds' || s.source === 'fbo') &&
                  (!('shipment_type' in s) ||
                    (s as { shipment_type?: string }).shipment_type ===
                      'SHIPMENT_TYPE_GENERAL'),
              ) || sources.find((s) => s.source === 'sds' || s.source === 'fbo');
            const sku = fboSource?.sku;
            if (sku) {
              const whStock = perWhStock.get(sku)?.get(regionWh);
              const whSalesPerDay = perWhSales.get(sku)?.get(regionWh) || 0;
              if (whStock) {
                cluster_fbo_present = whStock.present;
                cluster_fbo_warehouse = regionWh;
                if (whSalesPerDay > 0 && whStock.present > 0) {
                  cluster_fbo_days = Math.round(whStock.present / whSalesPerDay);
                } else if (whStock.present === 0) {
                  cluster_fbo_days = 0;
                }
              } else {
                cluster_fbo_present = 0;
                cluster_fbo_warehouse = regionWh;
              }
            }
          }
          const discountPct =
            p.price > 0 ? Math.round(((p.price - p.action_price) / p.price) * 100) : 0;
          // Sold count priority:
          //   1. Manual override stored in KV (Aram typed in UI)
          //   2. Ozon Seller Portal (accurate "Осталось продать" via session)
          //      — but only when portal returns a non-zero value. A bare 0 from
          //      stale-cookie portal scrape is indistinguishable from "no data"
          //      and routinely masks real analytics counts. Fall through to
          //      analytics in that case.
          //   3. Analytics ordered_units (less accurate fallback, but reliable)
          const manualSold = await getSoldCount(env, aw.raw.id, p.id);
          let soldCount: number | null = manualSold;
          let soldSource: 'manual' | 'portal' | 'analytics' | null = manualSold != null ? 'manual' : null;
          if (soldCount == null && portalMap && portalMap.has(p.id)) {
            const pd = portalMap.get(p.id)!;
            if (pd.sold > 0) {
              soldCount = pd.sold;
              soldSource = 'portal';
            }
          }
          if (soldCount == null && info?.sources && info.sources.length > 0) {
            let sum = 0;
            let anyData = false;
            const actionSales = salesByActionAndSku.get(aw.raw.id);
            if (actionSales) {
              for (const src of info.sources) {
                const v = actionSales.get(String(src.sku));
                if (v != null) {
                  sum += v;
                  anyData = true;
                }
              }
            }
            if (anyData) {
              soldCount = sum;
              soldSource = 'analytics';
            }
          }
          // If Ozon Analytics gives 0 stock (boosting promos have no quota) but
          // we have warehouse_stock from portal — use it as stock for visibility.
          const portalEntry = portalMap?.get(p.id);
          const effectiveStock = (p.stock === 0 && portalEntry?.warehouseStock != null && portalEntry.warehouseStock > 0)
            ? portalEntry.warehouseStock
            : p.stock;
          // Action duration classification for left_to_sell:
          //   > 90 days: unlimited (Эластичный бустинг). Ozon `stock` is total
          //              FBO inventory, NOT remaining quota — manual baseline
          //              subtraction is the design (sold_count from KV).
          //   ≤ 90 days: finite (Максимальный бустинг, Распродажа). Ozon `stock`
          //              already represents remaining quota (auto-decremented
          //              by Ozon as sales happen). Subtracting sold_count would
          //              double-count. Show stock directly; sold_count stays
          //              informational only.
          const actionDurationMs =
            aw.raw.date_start && aw.raw.date_end
              ? new Date(aw.raw.date_end).getTime() - new Date(aw.raw.date_start).getTime()
              : 0;
          const isFiniteAction =
            actionDurationMs > 0 && actionDurationMs <= 90 * 86400000;
          const leftToSell = isFiniteAction
            ? (effectiveStock > 0 ? effectiveStock : null)
            : (soldCount != null
                ? Math.max(0, effectiveStock - soldCount)
                : (effectiveStock > 0 ? effectiveStock : null));
          const priceInfo = priceInfoMap.get(p.id);
          const minPrice = priceInfo?.min_price ?? null;
          const currentPrice = priceInfo?.current_price ?? 0;
          const isDeciding =
            currentPrice > 0 && Math.abs(p.action_price - currentPrice) < 0.5;
          const refillRule = await getRefillRule(env, aw.raw.id, p.id);
          // Helper: number-or-null normalizer
          const numOrNull = (v: unknown): number | null =>
            typeof v === 'number' && Number.isFinite(v) ? v : null;
          return {
            product_id: p.id,
            offer_id: info?.offer_id || '',
            name: info?.name || '',
            price: p.price,
            action_price: p.action_price,
            discount_pct: discountPct,
            stock: effectiveStock,
            min_stock: p.min_stock,
            min_price: minPrice,
            current_price: currentPrice,
            is_deciding_price: isDeciding,
            sold_count: soldCount,
            sold_source: soldSource,
            left_to_sell: leftToSell,
            refill_rule: refillRule,
            price_min_elastic: numOrNull(p.price_min_elastic),
            price_max_elastic: numOrNull(p.price_max_elastic),
            current_boost: numOrNull(p.current_boost),
            min_boost: numOrNull(p.min_boost),
            max_boost: numOrNull(p.max_boost),
            fbo_present: fboStockMap.get(p.id)?.present ?? null,
            fbo_reserved: fboStockMap.get(p.id)?.reserved ?? null,
            cluster_fbo_present,
            cluster_fbo_days,
            cluster_fbo_warehouse,
          };
        }),
      );
      // Sort by SKU (offer_id) alphabetically + numerically so the row order
      // stays stable when stock or left_to_sell changes. Natural sort handles
      // mixed letters/digits like DE101 vs DE112 vs DE205AA correctly.
      productsOut.sort((a, b) =>
        (a.offer_id || '').localeCompare(b.offer_id || '', undefined, {
          numeric: true,
          sensitivity: 'base',
        }),
      );
      const totalUnits = productsOut.reduce((s, p) => s + p.stock, 0);
      const decidingCount = productsOut.reduce(
        (s, p) => s + (p.is_deciding_price ? 1 : 0),
        0,
      );
      return {
        action_id: aw.raw.id,
        title: aw.raw.title,
        action_type: aw.raw.action_type,
        date_start: aw.raw.date_start,
        date_end: aw.raw.date_end,
        days_left: daysBetween(now, aw.raw.date_end),
        is_voucher_action: aw.raw.is_voucher_action,
        is_participating: aw.raw.is_participating,
        participating_products_count: aw.raw.participating_products_count,
        potential_products_count: aw.raw.potential_products_count,
        total_units_left: totalUnits,
        deciding_count: decidingCount,
        auto_zeroed_at: null,
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
    // Participating actions ALWAYS appear before candidate-only ones
    if (a.is_participating !== b.is_participating) {
      return a.is_participating ? -1 : 1;
    }
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
    participating_count: allActions.filter((a) => a.is_participating).length,
    total_units_left: grandTotal,
    total_skus_in_promos: allSkus.size,
    actions,
  };
}

// ---------------------------------------------------------------------------
// GET /api/marketplaces/ozon/debug-portal/:actionId — diagnostic only
// Returns raw portal scrape output to debug session issues.
// Remove or restrict after troubleshooting.
// ---------------------------------------------------------------------------
promos.get('/ozon/debug-portal/:actionId', async (c) => {
  const actionId = Number(c.req.param('actionId'));
  if (!actionId) return fail(c, 400, 'bad action_id');

  if (!c.env.OZON_PORTAL_COOKIES) {
    return ok(c, { error: 'OZON_PORTAL_COOKIES secret not set' });
  }

  // Inline minimal version with verbose logging
  let cookies = c.env.OZON_PORTAL_COOKIES;
  const baseUrl = `https://seller.ozon.ru/api/site/global-seller-products/v1/action/${actionId}/products/active`;
  const log: Array<{ hop: number; url: string; status: number; bodyPreview?: string }> = [];

  let url = `${baseUrl}?offset=0&limit=20`;
  for (let hop = 0; hop < 6; hop++) {
    const resp = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'ru,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br, zstd',
        cookie: cookies,
        priority: 'u=1, i',
        referer: `https://seller.ozon.ru/app/highlights/${actionId}`,
        'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
        'x-o3-company-id': '374116',
        'x-o3-language': 'ru',
      },
      redirect: 'manual',
    });

    const setCookie = resp.headers.get('set-cookie');
    if (setCookie) {
      const newCookies = setCookie
        .split(/,(?=[^;]+=[^;]+)/)
        .map((c) => c.split(';')[0].trim())
        .filter(Boolean);
      for (const nc of newCookies) {
        const [name] = nc.split('=');
        if (!name) continue;
        const re = new RegExp(`(^|;\\s*)${name}=[^;]*`);
        if (re.test(cookies)) {
          cookies = cookies.replace(re, (_, prefix) => `${prefix}${nc}`);
        } else {
          cookies = `${cookies}; ${nc}`;
        }
      }
    }

    const entry: { hop: number; url: string; status: number; bodyPreview?: string; location?: string; setCookie?: string } = {
      hop,
      url,
      status: resp.status,
    };

    if (resp.status === 200) {
      const body = await resp.text();
      entry.bodyPreview = body.substring(0, 200);
      log.push(entry);
      try {
        const j = JSON.parse(body);
        const sample = (j.products || []).slice(0, 5).map((p: PortalProduct) => ({
          offerId: p.offerId,
          quantity: p.quantity,
          remaining: p.remainingActionStock,
        }));
        return ok(c, { success: true, log, total: j.total, sample });
      } catch (e) {
        return ok(c, { success: false, log, parseError: String(e) });
      }
    }
    if (resp.status === 307 || resp.status === 302 || resp.status === 301) {
      const loc = resp.headers.get('location');
      entry.location = loc || undefined;
      entry.setCookie = setCookie?.substring(0, 100) || undefined;
      log.push(entry);
      if (!loc) return ok(c, { success: false, log, error: 'no location' });
      url = loc.startsWith('http') ? loc : `https://seller.ozon.ru${loc}`;
      continue;
    }
    entry.bodyPreview = (await resp.text()).substring(0, 200);
    log.push(entry);
    return ok(c, { success: false, log, error: `unexpected status ${resp.status}` });
  }

  return ok(c, { success: false, log, error: 'max hops exceeded' });
});

// ---------------------------------------------------------------------------
// POST /api/marketplaces/ozon/portal-ingest
//
// Receives portal scrape results from the VPS-side scraper. The VPS runs a
// Python script every 30 min that fetches Ozon Seller Portal pages with
// session cookies (which CF Workers cannot — TLS fingerprint blocked).
//
// Body: {
//   secret: string,  // shared secret (env.OZON_PORTAL_INGEST_SECRET)
//   data: [
//     { action_id: number, products: [{ product_id, sold, is_sold_out }, ...] },
//     ...
//   ]
// }
//
// We store each (action, product) sold count in KV under the same key used
// by manual overrides (ozon:promo:sold:{action}:{product}) so buildPayload
// picks them up automatically at the top priority slot.
// ---------------------------------------------------------------------------
promos.post('/ozon/portal-ingest', async (c) => {
  let body: {
    secret?: string;
    data?: Array<{
      action_id: number;
      products: Array<{ product_id: number; sold: number; is_sold_out: boolean; warehouse_stock?: number }>;
    }>;
  };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid JSON');
  }

  const expectedSecret = c.env.OZON_PORTAL_INGEST_SECRET;
  if (!expectedSecret || body.secret !== expectedSecret) {
    return fail(c, 401, 'unauthorized');
  }
  if (!Array.isArray(body.data)) {
    return fail(c, 400, 'data must be an array');
  }

  let totalProducts = 0;
  let actionsCount = 0;
  for (const action of body.data) {
    if (!action.action_id || !Array.isArray(action.products)) continue;
    actionsCount++;
    for (const p of action.products) {
      if (typeof p.product_id !== 'number' || typeof p.sold !== 'number') continue;
      // Store sold count under "manual override" key — but with a different
      // value scheme so we know it came from portal (vs typed by Aram).
      // Actually we just store the number; sold_source will be 'portal' because
      // buildPayload checks portal data first via fetchOzonPortalProducts.
      // But VPS-ingested data won't hit that path. So store under a separate key
      // namespace and have buildPayload check it.
      await c.env.CACHE.put(
        `ozon:promo:portal:${action.action_id}:${p.product_id}`,
        JSON.stringify({ sold: p.sold, is_sold_out: p.is_sold_out, warehouse_stock: typeof p.warehouse_stock === 'number' ? p.warehouse_stock : null, ts: Date.now() }),
        { expirationTtl: 24 * 3600 }, // 24h — covers gap between scraper runs
      );
      totalProducts++;
    }
  }

  // Invalidate the main actions cache so next GET returns fresh data
  try {
    await c.env.CACHE.delete(CACHE_KEY);
  } catch {
    // ignore
  }

  return ok(c, {
    ingested: totalProducts,
    actions: actionsCount,
    received_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /api/marketplaces/ozon/actions
// ---------------------------------------------------------------------------
promos.get('/ozon/actions', async (c) => {
  const force = c.req.query('refresh') === '1';

  // Tell browser/CDN never to cache this response — it depends on D1
  // product_name overlays that can change at any moment via product
  // renames. The KV cache inside this Worker is the only cache layer.
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  // Try cache
  if (!force) {
    try {
      const cached = await c.env.CACHE.get(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedActionsPayload;
        // Re-apply D1 product_name overlay on cached data so renames take
        // effect immediately without forcing a full Ozon refetch.
        try {
          const offerIds = Array.from(
            new Set(
              parsed.actions.flatMap((a) =>
                a.products.map((p) => (p.offer_id || '').toLowerCase()).filter((s) => s),
              ),
            ),
          );
          if (offerIds.length > 0) {
            const placeholders = offerIds.map(() => '?').join(',');
            const rows = await c.env.DB.prepare(
              `SELECT id, product_name FROM products WHERE deleted_at IS NULL AND id IN (${placeholders})`,
            ).bind(...offerIds).all<{ id: string; product_name: string }>();
            const dbNames = new Map<string, string>();
            for (const r of rows.results ?? []) {
              if (r.id && r.product_name) dbNames.set(r.id.toLowerCase(), r.product_name);
            }
            for (const a of parsed.actions) {
              for (const p of a.products) {
                const ours = dbNames.get((p.offer_id || '').toLowerCase());
                if (ours) p.name = ours;
              }
            }
          }
        } catch (e) {
          console.error('[promos] cached overlay failed:', e);
        }
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

    // Patch cache in-place so next GET is instant (no full rebuild needed).
    const leftToSell =
      newSoldCount != null ? Math.max(0, targetStock - newSoldCount) : null;
    const patch: Partial<CachedActionsPayload['actions'][number]['products'][number]> = {
      stock: targetStock,
    };
    if (newSoldCount != null) patch.sold_count = newSoldCount;
    if (leftToSell != null) patch.left_to_sell = leftToSell;
    if (typeof body.action_price === 'number' && body.action_price > 0) {
      patch.action_price = body.action_price;
    }
    await patchCachedProduct(c.env, actionId, productId, patch);

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

// ---------------------------------------------------------------------------
// POST /api/marketplaces/ozon/actions/:actionId/refill-rule
//
// Set or clear an autopilot rule for a single product. Body:
//   { product_id, threshold: N, target: M }  → save rule (M must be > N >= 0)
//   { product_id, clear: true }              → delete rule
// ---------------------------------------------------------------------------
promos.post('/ozon/actions/:actionId/refill-rule', async (c) => {
  const actionId = Number(c.req.param('actionId'));
  if (!actionId || Number.isNaN(actionId)) return fail(c, 400, 'invalid action_id');

  let body: { product_id?: number; threshold?: number; target?: number; clear?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid JSON body');
  }
  const productId = Number(body.product_id);
  if (!productId || Number.isNaN(productId)) return fail(c, 400, 'product_id required');

  if (body.clear === true) {
    await setRefillRule(c.env, actionId, productId, null);
    await patchCachedProduct(c.env, actionId, productId, { refill_rule: null });
    return ok(c, { action_id: actionId, product_id: productId, cleared: true });
  }

  const threshold = Number(body.threshold);
  const target = Number(body.target);
  if (!Number.isFinite(threshold) || threshold < 0) {
    return fail(c, 400, 'threshold must be >= 0');
  }
  if (!Number.isFinite(target) || target <= 0) {
    return fail(c, 400, 'target must be > 0');
  }
  if (target <= threshold) {
    return fail(c, 400, 'target must be greater than threshold');
  }

  await setRefillRule(c.env, actionId, productId, { threshold, target });
  await patchCachedProduct(c.env, actionId, productId, {
    refill_rule: { threshold, target },
  });
  return ok(c, {
    action_id: actionId,
    product_id: productId,
    refill_rule: { threshold, target },
  });
});

// ---------------------------------------------------------------------------
// POST /api/marketplaces/ozon/actions/:actionId/price
//
// Update the action_price for ONE product without touching stock. Used by the
// boost slider in the UI. Body:
//   { product_id, action_price, current_stock }
// We re-send the existing stock so Ozon keeps the quota unchanged.
// ---------------------------------------------------------------------------
promos.post('/ozon/actions/:actionId/price', async (c) => {
  const actionId = Number(c.req.param('actionId'));
  if (!actionId || Number.isNaN(actionId)) return fail(c, 400, 'invalid action_id');

  let body: { product_id?: number; action_price?: number; current_stock?: number };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'invalid JSON body');
  }
  const productId = Number(body.product_id);
  const newPrice = Number(body.action_price);
  const currentStock = Number(body.current_stock);
  if (!productId || Number.isNaN(productId)) return fail(c, 400, 'product_id required');
  if (!Number.isFinite(newPrice) || newPrice <= 0)
    return fail(c, 400, 'action_price must be > 0');
  if (!Number.isFinite(currentStock) || currentStock < 0)
    return fail(c, 400, 'current_stock required');

  try {
    const resp = await ozonRequest<{
      result?: {
        product_ids?: number[];
        rejected?: Array<{ product_id: number; reason: string }>;
      };
    }>(c.env, '/v1/actions/products/activate', 'POST', {
      action_id: actionId,
      products: [
        {
          product_id: productId,
          stock: currentStock,
          action_price: newPrice,
        },
      ],
    });
    const rejected = resp.result?.rejected ?? [];
    if (rejected.length > 0) {
      return fail(c, 409, `Ozon rejected: ${rejected[0].reason}`);
    }
    // Patch cache: update action_price + recompute is_deciding_price relative
    // to current_price (which we keep unchanged — Ozon may take seconds to
    // propagate it to the displayed price anyway).
    await patchCachedProduct(c.env, actionId, productId, {
      action_price: newPrice,
    });
    return ok(c, {
      action_id: actionId,
      product_id: productId,
      action_price: newPrice,
    });
  } catch (e) {
    return fail(c, 502, e instanceof Error ? e.message : 'Ozon API error');
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/marketplaces/ozon/actions/:actionId/products/:productId
//
// Removes a single product from the action via Ozon /v1/actions/products/deactivate.
// Also clears the refill rule (no point keeping a rule for a product no
// longer in the action) and busts the cache so next GET reflects the change.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// POST /api/marketplaces/ozon/actions/:actionId/products/:productId/activate
//
// Adds a single product to the action (e.g. toggling a Распродажа candidate
// into the active list). Optionally accepts {action_price, stock} in body to
// override Ozon's suggested values. After success, force a partial cache
// invalidation so next GET picks up the new participating state.
// ---------------------------------------------------------------------------
promos.post('/ozon/actions/:actionId/products/:productId/activate', async (c) => {
  const actionId = Number(c.req.param('actionId'));
  const productId = Number(c.req.param('productId'));
  if (!actionId || Number.isNaN(actionId)) return fail(c, 400, 'invalid action_id');
  if (!productId || Number.isNaN(productId)) return fail(c, 400, 'invalid product_id');

  let body: { action_price?: number; stock?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // body is optional
  }

  try {
    const product: Record<string, number> = { product_id: productId };
    if (typeof body.action_price === 'number' && body.action_price > 0) {
      product.action_price = body.action_price;
    }
    if (typeof body.stock === 'number' && body.stock >= 0) {
      product.stock = body.stock;
    }
    const resp = await ozonRequest<{
      result?: {
        product_ids?: number[];
        rejected?: Array<{ product_id: number; reason: string }>;
      };
    }>(c.env, '/v1/actions/products/activate', 'POST', {
      action_id: actionId,
      products: [product],
    });
    const accepted = resp.result?.product_ids ?? [];
    const rejected = resp.result?.rejected ?? [];
    if (rejected.length > 0) {
      return fail(c, 409, `Ozon rejected: ${rejected[0].reason}`);
    }
    if (accepted.length === 0) {
      return fail(c, 409, 'Ozon silently rejected — товар не подходит для этой акции');
    }
    // Invalidate cache fully because we don't have the full product details
    // in the response — next GET will pull fresh.
    try {
      await c.env.CACHE.delete(CACHE_KEY);
    } catch {
      // ignore
    }
    return ok(c, { action_id: actionId, product_id: productId, activated: true });
  } catch (e) {
    return fail(c, 502, e instanceof Error ? e.message : 'Ozon API error');
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/marketplaces/ozon/actions/:actionId/products/:productId
//
// Removes a single product from the action via Ozon /v1/actions/products/deactivate.
// Also clears the refill rule (no point keeping a rule for a product no
// longer in the action) and busts the cache so next GET reflects the change.
// ---------------------------------------------------------------------------
promos.delete('/ozon/actions/:actionId/products/:productId', async (c) => {
  const actionId = Number(c.req.param('actionId'));
  const productId = Number(c.req.param('productId'));
  if (!actionId || Number.isNaN(actionId)) return fail(c, 400, 'invalid action_id');
  if (!productId || Number.isNaN(productId)) return fail(c, 400, 'invalid product_id');

  try {
    const resp = await ozonRequest<{
      result?: {
        product_ids?: number[];
        rejected?: Array<{ product_id: number; reason: string }>;
      };
    }>(c.env, '/v1/actions/products/deactivate', 'POST', {
      action_id: actionId,
      product_ids: [productId],
    });
    const rejected = resp.result?.rejected ?? [];
    if (rejected.length > 0) {
      return fail(c, 409, `Ozon rejected: ${rejected[0].reason}`);
    }
    // Clear refill rule + bust cache fully (next GET will refetch and the
    // product may still appear in the candidates list, which is correct).
    await setRefillRule(c.env, actionId, productId, null);
    try {
      await c.env.CACHE.delete(CACHE_KEY);
    } catch {
      // ignore
    }
    return ok(c, { action_id: actionId, product_id: productId, removed: true });
  } catch (e) {
    return fail(c, 502, e instanceof Error ? e.message : 'Ozon API error');
  }
});

// ---------------------------------------------------------------------------
// runPromoRefillSweep — called from the */15 cron handler.
//
// 1. List all rules in KV (prefix ozon:promo:refill:)
// 2. Group by action_id
// 3. For each action, fetch fresh product state from Ozon
// 4. For each rule: if current left_to_sell < threshold, push stock up so
//    new left_to_sell = target (= sold_count + target)
// 5. Invalidate main cache if any refill happened
// ---------------------------------------------------------------------------
export async function runPromoRefillSweep(env: Env): Promise<{
  rules_checked: number;
  refills_triggered: number;
  refills: Array<{ action_id: number; product_id: number; from: number; to: number }>;
  errors: string[];
}> {
  const errors: string[] = [];
  const refills: Array<{ action_id: number; product_id: number; from: number; to: number }> = [];

  // 1. List all rule keys
  let allKeys: string[] = [];
  try {
    let cursor: string | undefined = undefined;
    for (let page = 0; page < 20; page++) {
      const r: { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string } =
        await env.CACHE.list({ prefix: 'ozon:promo:refill:', cursor });
      allKeys = allKeys.concat(r.keys.map((k) => k.name));
      if (r.list_complete || !r.cursor) break;
      cursor = r.cursor;
    }
  } catch (e) {
    errors.push(`list rules: ${e instanceof Error ? e.message : String(e)}`);
    return { rules_checked: 0, refills_triggered: 0, refills, errors };
  }

  // 2. Group rules by action_id
  const rulesByAction = new Map<
    number,
    Array<{ productId: number; threshold: number; target: number }>
  >();
  for (const key of allKeys) {
    const parts = key.split(':');
    // ozon:promo:refill:{actionId}:{productId}
    if (parts.length !== 5) continue;
    const aid = Number(parts[3]);
    const pid = Number(parts[4]);
    if (!aid || !pid) continue;
    const rule = await getRefillRule(env, aid, pid);
    if (!rule) continue;
    let arr = rulesByAction.get(aid);
    if (!arr) {
      arr = [];
      rulesByAction.set(aid, arr);
    }
    arr.push({ productId: pid, threshold: rule.threshold, target: rule.target });
  }
  const rulesChecked = Array.from(rulesByAction.values()).reduce((s, a) => s + a.length, 0);
  if (rulesChecked === 0) {
    return { rules_checked: 0, refills_triggered: 0, refills, errors };
  }

  // 3 & 4. For each action with rules, fetch fresh state and evaluate
  for (const [actionId, rules] of rulesByAction.entries()) {
    try {
      // Fetch action products (same pagination pattern as buildPayload)
      let allProds: OzonActionProduct[] = [];
      let offset = 0;
      const limit = 1000;
      while (true) {
        const r = await ozonRequest<{
          result: { products?: OzonActionProduct[]; total?: number };
        }>(env, '/v1/actions/products', 'POST', {
          action_id: actionId,
          limit,
          offset,
        });
        const prods = r.result?.products || [];
        allProds = allProds.concat(prods);
        if (prods.length < limit) break;
        offset += prods.length;
      }
      const prodById = new Map(allProds.map((p) => [p.id, p]));

      for (const rule of rules) {
        const p = prodById.get(rule.productId);
        if (!p) continue; // product no longer in action
        const sold = await getSoldCount(env, actionId, rule.productId);
        if (sold == null) {
          // sold_count unknown — can't evaluate. Skip.
          continue;
        }
        const left = Math.max(0, p.stock - sold);
        if (left >= rule.threshold) continue; // above threshold, no refill

        // Trigger refill: new_stock such that left_to_sell becomes target
        const newStock = sold + rule.target;
        try {
          const resp = await ozonRequest<{
            result?: {
              product_ids?: number[];
              rejected?: Array<{ product_id: number; reason: string }>;
            };
          }>(env, '/v1/actions/products/activate', 'POST', {
            action_id: actionId,
            products: [
              {
                product_id: rule.productId,
                stock: newStock,
                action_price: p.action_price,
              },
            ],
          });
          const rej = resp.result?.rejected ?? [];
          if (rej.length > 0) {
            errors.push(
              `refill rejected action=${actionId} pid=${rule.productId}: ${rej[0].reason}`,
            );
            continue;
          }
          refills.push({
            action_id: actionId,
            product_id: rule.productId,
            from: left,
            to: rule.target,
          });
        } catch (e) {
          errors.push(
            `refill action=${actionId} pid=${rule.productId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      errors.push(
        `fetch action=${actionId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 5. Invalidate cache so next GET shows fresh stock numbers
  if (refills.length > 0) {
    try {
      await env.CACHE.delete(CACHE_KEY);
    } catch {
      // ignore
    }
  }

  return {
    rules_checked: rulesChecked,
    refills_triggered: refills.length,
    refills,
    errors,
  };
}

export default promos;

