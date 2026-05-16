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
    products: Array<{
      product_id: number;
      offer_id: string;
      name: string;
      price: number;
      action_price: number;
      discount_pct: number;
      stock: number;
      min_stock: number;
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

  // 4. Build response
  const now = new Date().toISOString();
  const actions = actionsWithProducts.map((aw) => {
    const productsOut = aw.products.map((p) => {
      const info = infoMap.get(p.id);
      const discountPct =
        p.price > 0 ? Math.round(((p.price - p.action_price) / p.price) * 100) : 0;
      return {
        product_id: p.id,
        offer_id: info?.offer_id || '',
        name: info?.name || '',
        price: p.price,
        action_price: p.action_price,
        discount_pct: discountPct,
        stock: p.stock,
        min_stock: p.min_stock,
      };
    });
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
      products: productsOut,
    };
  });

  // Sort actions: by days_left asc (most urgent first), then by total_units desc
  actions.sort((a, b) => {
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

export default promos;
