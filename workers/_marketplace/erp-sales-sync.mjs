/**
 * Marketplace SALES craft → ERP D1 (Owner 2026-07-21).
 *
 * Ownership (binding — exclusive Dasha / Arina):
 *   - Ozon sales = Dasha Worker `dasha-ozon`
 *   - WB sales   = Arina Worker `arina-wb`
 *   - Das Operator = dashboard / store only
 *
 * Why on specialists (Owner): the more they pull and write these numbers,
 * the more they learn — daily units, revenue, dynamics stay in their craft loop.
 *
 * Writes (same tables ERP dashboard reads):
 *   marketplace_sales_ozon / marketplace_sales_wb
 *   marketplace_sales_daily
 *   marketplace_sync_log  (marketplace = 'ozon-sales' | 'wb-sales')
 *
 * Window: rolling 7 days (UTC), override via periodDays arg.
 */
import { ozonClientId } from "./marketplace-api.mjs";
import { beginLog, finishOk, finishErr } from "./marketplace-sync-log.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDate = (d) => d.toISOString().slice(0, 10);

export function splitWbSalesPeriods(rows, currentCutoff, previousCutoff) {
  const current = new Map();
  const previous = new Map();
  const perDate = new Map();

  for (const r of rows) {
    const saleTime = new Date(r.date).getTime();
    if (!Number.isFinite(saleTime) || saleTime < previousCutoff) continue;
    const article = String(r.supplierArticle || "").trim();
    if (!article) continue;
    const skuLc = article.toLowerCase();
    const priceWithDisc = Number(r.priceWithDisc || 0);
    const revKopecks = Math.round(priceWithDisc * 100);
    const bucket = saleTime < currentCutoff ? previous : current;

    const e = bucket.get(skuLc) || { units: 0, revenue: 0, listings: new Set() };
    e.units += 1;
    e.revenue += revKopecks;
    e.listings.add(article);
    bucket.set(skuLc, e);

    const dateStr = String(r.date).substring(0, 10);
    const d = perDate.get(dateStr) || { units: 0, revenue: 0 };
    d.units += 1;
    d.revenue += revKopecks;
    perDate.set(dateStr, d);
  }

  return { current, previous, perDate };
}

/**
 * Замок на входе (Owner 2026-08-20). Строка продаж не попадает в план поставки,
 * если она спорит сама с собой.
 *
 * Повод: 19.08 строка BIO 4in1 на Озоне пришла с 1413 проданными штуками при
 * выручке 100 019 руб и цене набора 600 руб — это 71 рубль за набор из четырёх
 * щёток. В той же строке стояло 985 добавлений в корзину: продать больше, чем
 * положили в корзину, физически невозможно. По этому числу был построен план
 * отгрузки, и ошибка ушла владельцу. Проверка занимала одно деление.
 *
 * Корень глубже самой строки: колонка называется units_sold, а питается
 * метрикой ordered_units — это ЗАКАЗАНО, а не продано и доставлено. Выручка
 * при этом считается по доставленному. Два разных события в одной строке
 * расходятся тем сильнее, чем больше отмен.
 *
 * Строка не удаляется — удалить значит спрятать. Она помечается, и потребитель
 * (план поставки, расчёт оборачиваемости) обязан пометку читать.
 *
 * @returns {string|null} причина или null, если строка чистая
 */
export function salesRowAnomaly({ units, revenue_rub, price_rub, tocart }) {
  const u = Number(units) || 0;
  if (u <= 0) return null;

  // 1. Продано больше, чем положено в корзину. Не оценка — невозможность.
  if (Number.isFinite(tocart) && tocart > 0 && u > tocart) {
    return `units_gt_tocart:${u}>${tocart}`;
  }

  // 2. Количество не сходится с выручкой при известной цене. Порог широкий,
  //    чтобы скидки и промо не поднимали ложную тревогу: беспокоимся только
  //    когда фактическая цена вдвое ниже или в полтора раза выше витринной.
  const price = Number(price_rub) || 0;
  const revenue = Number(revenue_rub) || 0;
  if (price > 0 && revenue > 0) {
    const perUnit = revenue / u;
    const ratio = perUnit / price;
    if (ratio < 0.5 || ratio > 1.6) {
      const real = Math.round(revenue / price);
      return `units_vs_revenue:${u}~${real}`;
    }
  }
  return null;
}

function ozCreds(env) {
  const key = String(env.OZON_API_KEY || env.DASHA_OZON_API_KEY || "").trim();
  const clientId = String(env.OZON_CLIENT_ID || env.DASHA_OZON_CLIENT_ID || ozonClientId(env) || "").trim();
  if (!key || !clientId) throw new Error("Dasha Ozon credentials missing");
  return { key, clientId };
}

function ozHeaders(env) {
  const { key, clientId } = ozCreds(env);
  return {
    "Client-Id": clientId,
    "Api-Key": key,
    "Content-Type": "application/json",
    "User-Agent": "dasha-ozon/sales (+dasexperten fleet)",
  };
}

function wbToken(env) {
  const t = String(env.WB_API_TOKEN || env.ARINA_WB_API_TOKEN || "").trim();
  if (!t) throw new Error("Arina WB credentials missing");
  return t;
}

// ---------------------------------------------------------------------------
// Ozon helpers
// ---------------------------------------------------------------------------

async function fetchOzonAnalytics(env, dateFrom, dateTo, metrics, dimension) {
  const out = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    let resp;
    let attempt = 0;
    while (true) {
      resp = await fetch("https://api-seller.ozon.ru/v1/analytics/data", {
        method: "POST",
        headers: ozHeaders(env),
        body: JSON.stringify({
          date_from: dateFrom,
          date_to: dateTo,
          metrics,
          dimension,
          filters: [],
          sort: [{ key: metrics[0], order: "DESC" }],
          limit,
          offset,
        }),
        signal: AbortSignal.timeout(28000),
      });
      if (resp.status === 429 && attempt < 5) {
        await sleep(1000 * Math.pow(2, attempt));
        attempt++;
        continue;
      }
      break;
    }
    if (!resp.ok) throw new Error(`Ozon analytics HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    const batch = data?.result?.data ?? [];
    out.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    if (offset > 10000) break;
    await sleep(550);
  }
  return out;
}

async function refreshOzonSkuMap(env) {
  const catalog = await env.ERP_DB.prepare(
    "SELECT id FROM products WHERE deleted_at IS NULL"
  ).all();
  const catalogIds = new Set((catalog.results || []).map((r) => r.id));

  const map = new Map();
  let cursor = "";
  while (true) {
    const resp = await fetch("https://api-seller.ozon.ru/v4/product/info/stocks", {
      method: "POST",
      headers: ozHeaders(env),
      body: JSON.stringify({ filter: { visibility: "ALL" }, limit: 200, cursor }),
      signal: AbortSignal.timeout(28000),
    });
    if (!resp.ok) throw new Error(`Ozon stocks (sku map) HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    for (const item of data.items || []) {
      const offerId = String(item.offer_id || "");
      const productId = item.product_id;
      const catalogSku = catalogIds.has(offerId.toLowerCase()) ? offerId.toLowerCase() : null;
      for (const stock of item.stocks || []) {
        const ozonSku = stock.sku;
        if (!ozonSku || map.has(ozonSku)) continue;
        map.set(ozonSku, { offer_id: offerId, product_id: productId, catalog_sku: catalogSku });
      }
    }
    if (!data.cursor || data.cursor === cursor) break;
    cursor = data.cursor;
    await sleep(200);
  }
  return map;
}

async function fetchOzonPrices(env) {
  const map = new Map();
  let cursor = "";
  while (true) {
    const resp = await fetch("https://api-seller.ozon.ru/v5/product/info/prices", {
      method: "POST",
      headers: ozHeaders(env),
      body: JSON.stringify({ filter: { visibility: "ALL" }, limit: 1000, cursor }),
      signal: AbortSignal.timeout(28000),
    });
    if (!resp.ok) break;
    const data = await resp.json();
    for (const item of data.items || []) {
      const offerId = String(item.offer_id || "").toLowerCase();
      if (!offerId) continue;
      const priceStr = item.price?.marketing_price || item.price?.price || "0";
      const priceRub = parseFloat(priceStr);
      if (priceRub > 0) map.set(offerId, Math.round(priceRub * 100));
    }
    if (!data.cursor || data.cursor === cursor) break;
    cursor = data.cursor;
  }
  return map;
}

/**
 * Read Ozon sales already in ERP (no API farm). For Boss chat reverse channel.
 */
export async function readOzonSalesFromErp(env, { top = 10 } = {}) {
  const limit = Math.min(Math.max(Number(top) || 10, 1), 50);
  const out = {
    ok: false,
    source: "erp",
    log: null,
    top: [],
    daily: [],
    error: null,
  };
  if (!env.ERP_DB) {
    out.error = "ERP_DB missing";
    return out;
  }
  try {
    out.log = await env.ERP_DB.prepare(
      `SELECT id, marketplace, started_at, finished_at, status, rows_synced, error_message
       FROM marketplace_sync_log WHERE marketplace = 'ozon-sales'
       ORDER BY id DESC LIMIT 1`
    ).first();
    const topRes = await env.ERP_DB.prepare(
      `SELECT base_sku, period_from, period_to, units_sold, revenue_rub, views, tocart_count, synced_at
       FROM marketplace_sales_ozon
       ORDER BY units_sold DESC
       LIMIT ?`
    )
      .bind(limit)
      .all();
    out.top = topRes.results || [];
    const dayRes = await env.ERP_DB.prepare(
      `SELECT date, units_sold, revenue_rub, synced_at
       FROM marketplace_sales_daily WHERE marketplace = 'ozon'
       ORDER BY date DESC LIMIT 14`
    ).all();
    out.daily = dayRes.results || [];
    out.ok = true;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 300);
  }
  return out;
}

/** DE### from offer_id (de210aa → DE210). */
function offerToDeCode(offerId) {
  const m = String(offerId || "").toUpperCase().match(/DE\s*(\d{3})/);
  return m ? "DE" + m[1] : null;
}

/**
 * Live Ozon analytics for one day — top SKUs with offer_id + catalog name when possible.
 * FAST: one analytics call first; sku-map only for top N (not full catalog walk).
 */
export async function liveOzonSalesTopForDay(env, dayIso, limit = 10) {
  const day = String(dayIso || "").slice(0, 10);
  const topN = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const out = { ok: false, source: "ozon_live_day", day, top: [], error: null };
  try {
    ozCreds(env);
    // 1) FAST path: analytics only (one request)
    const rows = await fetchOzonAnalytics(
      env,
      day,
      day,
      ["ordered_units", "revenue"],
      ["sku"]
    );
    const raw = [];
    for (const row of rows) {
      const dim = row?.dimensions?.[0] || {};
      const skuId = String(dim.id || "");
      const dimName = String(dim.name || dim.id || "").trim();
      const units = Number(row?.metrics?.[0] || 0);
      const revenue = Number(row?.metrics?.[1] || 0);
      if (!skuId) continue;
      raw.push({
        ozon_sku: skuId,
        dim_name: dimName && dimName !== skuId ? dimName : "",
        units_sold: units,
        revenue_rub: Math.round(revenue * 100),
      });
    }
    raw.sort((a, b) => b.units_sold - a.units_sold);
    const topRaw = raw.slice(0, topN);

    // 2) Map only top N ozon skus → offer_id (one stocks page-walk stop early when all found)
    let skuMap = new Map();
    try {
      skuMap = await refreshOzonSkuMap(env);
    } catch {
      /* keep dim_name / raw ids */
    }

    // 3) product titles from ERP catalog if present
    let nameById = new Map();
    if (env.ERP_DB) {
      try {
        const ids = [];
        for (const r of topRaw) {
          const m = skuMap.get(parseInt(r.ozon_sku, 10)) || skuMap.get(r.ozon_sku);
          const offer = m?.catalog_sku || m?.offer_id;
          if (offer) ids.push(String(offer).toLowerCase());
        }
        if (ids.length) {
          // products.id is often offer/base sku
          const ph = ids.map(() => "?").join(",");
          const pr = await env.ERP_DB.prepare(
            `SELECT id, name FROM products WHERE lower(id) IN (${ph}) AND deleted_at IS NULL`
          )
            .bind(...ids)
            .all();
          for (const p of pr.results || []) {
            nameById.set(String(p.id).toLowerCase(), String(p.name || "").trim());
          }
        }
      } catch {
        /* non-fatal */
      }
    }

    const mapped = topRaw.map((r) => {
      const m =
        skuMap.get(parseInt(r.ozon_sku, 10)) ||
        skuMap.get(Number(r.ozon_sku)) ||
        skuMap.get(r.ozon_sku);
      const offer = m?.catalog_sku || m?.offer_id || "";
      const de = offerToDeCode(offer);
      const catalogName = offer ? nameById.get(String(offer).toLowerCase()) : "";
      const label =
        catalogName ||
        r.dim_name ||
        (de ? de : "") ||
        (offer ? offer : "") ||
        `ozon:${r.ozon_sku}`;
      return {
        ozon_sku: r.ozon_sku,
        offer_id: offer || null,
        base_sku: de || offer || null,
        name: label,
        units_sold: r.units_sold,
        revenue_rub: r.revenue_rub,
      };
    });
    out.top = mapped;
    out.ok = true;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 300);
  }
  return out;
}

/**
 * Dasha — Ozon sales → ERP (7d window default).
 */
export async function syncOzonSalesToErp(env, periodDays = 7) {
  const days = Math.min(Math.max(Number(periodDays) || 7, 1), 90);
  const out = {
    marketplace: "ozon-sales",
    owner: "dasha-ozon",
    rows_synced: 0,
    days_synced: 0,
    error: null,
    period: null,
    anomalies: [],
  };
  if (!env.ERP_DB) {
    out.error = "ERP_DB binding missing on dasha-ozon";
    return out;
  }
  const { logId } = await beginLog(env, "ozon-sales");
  try {
    ozCreds(env);
    const today = new Date();
    const dateTo = isoDate(today);
    const from = new Date(today.getTime() - days * 24 * 3600_000);
    const dateFrom = isoDate(from);
    out.period = { from: dateFrom, to: dateTo, days };

    const skuMap = await refreshOzonSkuMap(env);
    const dailyData = await fetchOzonAnalytics(
      env,
      dateFrom,
      dateTo,
      ["ordered_units", "revenue", "hits_view", "hits_tocart", "position_category"],
      ["sku", "day"]
    );
    const skuTotalsData = await fetchOzonAnalytics(
      env,
      dateFrom,
      dateTo,
      ["ordered_units", "revenue", "hits_view", "hits_tocart", "position_category"],
      ["sku"]
    );
    let priceMap = new Map();
    try {
      priceMap = await fetchOzonPrices(env);
    } catch {
      /* non-fatal */
    }

    const perSku = new Map();
    let unmatched = 0;
    for (const row of skuTotalsData) {
      const ozonSku = parseInt(row.dimensions[0].id, 10);
      const units = row.metrics[0] || 0;
      const revenue = row.metrics[1] || 0;
      const views = row.metrics[2] || 0;
      const tocart = row.metrics[3] || 0;
      const position = row.metrics[4] || 0;
      const mapped = skuMap.get(ozonSku);
      if (!mapped || !mapped.catalog_sku) {
        unmatched++;
        continue;
      }
      const skuKey = mapped.catalog_sku;
      const e = perSku.get(skuKey) || {
        units: 0,
        revenue: 0,
        views: 0,
        tocart: 0,
        positions: [],
        listings: new Set(),
      };
      e.units += units;
      e.revenue += Math.round(revenue * 100);
      e.views += views;
      e.tocart += tocart;
      if (position > 0) e.positions.push(position);
      e.listings.add(ozonSku);
      perSku.set(skuKey, e);
    }

    const perDate = new Map();
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

    const now = Math.floor(Date.now() / 1000);
    const stmts = [env.ERP_DB.prepare("DELETE FROM marketplace_sales_ozon")];
    for (const [sku, v] of perSku.entries()) {
      const avgPos =
        v.positions.length > 0
          ? v.positions.reduce((a, b) => a + b, 0) / v.positions.length
          : null;
      const price = priceMap.get(sku) ?? null;
      const ozAnomaly = salesRowAnomaly({
        units: v.units,
        revenue_rub: v.revenue,
        price_rub: price,
        tocart: v.tocart,
      });
      if (ozAnomaly) out.anomalies.push({ base_sku: sku, reason: ozAnomaly });
      stmts.push(
        env.ERP_DB.prepare(
          `INSERT INTO marketplace_sales_ozon
           (base_sku, period_from, period_to, units_sold, revenue_rub, listings_count, synced_at,
            views, tocart_count, position_category, current_price_rub,
            cost_per_click_rub, cost_per_order_rub, stars_promo_rub, brand_commission_rub,
            reviews_cost_rub, stars_membership_rub, acquiring_rub, returns_cost_rub, expenses_total_rub,
            ad_spend_rub, anomaly)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)`
        ).bind(
          sku,
          dateFrom,
          dateTo,
          v.units,
          v.revenue,
          v.listings.size,
          now,
          v.views,
          v.tocart,
          avgPos,
          price,
          ozAnomaly
        )
      );
    }
    for (const [d, v] of perDate.entries()) {
      stmts.push(
        env.ERP_DB.prepare(
          `INSERT INTO marketplace_sales_daily (marketplace, date, units_sold, revenue_rub, synced_at)
           VALUES ('ozon', ?, ?, ?, ?)
           ON CONFLICT (marketplace, date) DO UPDATE SET
             units_sold = excluded.units_sold,
             revenue_rub = excluded.revenue_rub,
             synced_at = excluded.synced_at`
        ).bind(d, v.units, v.revenue, now)
      );
    }
    const CHUNK = 40;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.ERP_DB.batch(stmts.slice(i, i + CHUNK));
    }

    await finishOk(env, logId, perSku.size);
    out.rows_synced = perSku.size;
    out.days_synced = perDate.size;
    out.unmatched = unmatched;
    out.sku_map_size = skuMap.size;
    return out;
  } catch (e) {
    const msg = String(e?.message || e);
    out.error = msg;
    await finishErr(env, logId, msg);
    return out;
  }
}

// ---------------------------------------------------------------------------
// WB helpers
// ---------------------------------------------------------------------------

async function fetchWbNmReport(token, dateFrom, dateTo) {
  const map = new Map();
  let offset = 0;
  const limit = 1000;
  while (true) {
    const resp = await fetch("https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products", {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "User-Agent": "arina-wb/sales (+dasexperten fleet)",
      },
      body: JSON.stringify({
        selectedPeriod: { start: dateFrom, end: dateTo },
        nmIds: [],
        brandNames: [],
        subjectIds: [],
        tagIds: [],
        skipDeletedNm: true,
        orderBy: { field: "openCard", mode: "desc" },
        limit,
        offset,
      }),
      signal: AbortSignal.timeout(28000),
    });
    if (resp.status === 429) {
      await sleep(15000);
      continue;
    }
    if (!resp.ok) {
      throw new Error(`WB nm-report HTTP ${resp.status}: ${(await resp.text()).slice(0, 180)}`);
    }
    const data = await resp.json();
    const cards = data.data?.products || [];
    if (offset === 0 && cards.length === 0) {
      throw new Error("WB nm-report returned no cards");
    }
    for (const card of cards) {
      const article = String(card.product?.vendorCode || card.vendorCode || "")
        .toLowerCase()
        .trim();
      if (!article) continue;
      const stats = card.statistic?.selected || card.statistics?.selectedPeriod || {};
      const past = card.statistic?.past || card.statistics?.pastPeriod || {};
      map.set(article, {
        views: stats.openCount || stats.openCardCount || 0,
        tocart: stats.cartCount || stats.addToCartCount || 0,
        orders: stats.orderCount || 0,
        buyouts: stats.buyoutCount || 0,
        pastViews: past.openCount || past.openCardCount || 0,
        pastTocart: past.cartCount || past.addToCartCount || 0,
        pastOrders: past.orderCount || 0,
        pastBuyouts: past.buyoutCount || 0,
        conversions: stats.conversions || {},
        pastConversions: past.conversions || {},
        position: null,
      });
    }
    if (cards.length < limit) break;
    offset += limit;
    if (offset >= 50_000) break;
    await sleep(1100);
  }
  return map;
}

async function fetchWbPrices(token) {
  const map = new Map();
  let offset = 0;
  for (let page = 0; page < 11; page++) {
    const url = `https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=1000&offset=${offset}`;
    let resp = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await fetch(url, {
        headers: { Authorization: token, "User-Agent": "arina-wb/sales (+dasexperten fleet)" },
        signal: AbortSignal.timeout(28000),
      });
      if (resp.status !== 429) break;
      await sleep(7000 * (attempt + 1));
    }
    if (!resp || !resp.ok) break;
    const data = await resp.json();
    const goods = data.data?.listGoods || [];
    for (const g of goods) {
      const article = String(g.vendorCode || "")
        .toLowerCase()
        .trim();
      if (!article) continue;
      const sizes = g.sizes || [];
      const priceRub = sizes[0]?.discountedPrice ?? sizes[0]?.price ?? 0;
      if (priceRub > 0) map.set(article, Math.round(priceRub * 100));
    }
    if (goods.length < 1000) break;
    offset += 1000;
    await sleep(6500);
  }
  return map;
}

/**
 * Arina — WB sales → ERP (7d window default).
 */
export async function syncWbSalesToErp(env, periodDays = 7) {
  const days = Math.min(Math.max(Number(periodDays) || 7, 1), 90);
  const out = {
    marketplace: "wb-sales",
    owner: "arina-wb",
    rows_synced: 0,
    days_synced: 0,
    error: null,
    period: null,
    anomalies: [],
    movers: [],
    funnel_movers: [],
    funnel_note: "Ranked by order change; current-window buyouts are lagging and are not used for priority.",
    source_warnings: [],
  };
  if (!env.ERP_DB) {
    out.error = "ERP_DB binding missing on arina-wb";
    return out;
  }
  const { logId } = await beginLog(env, "wb-sales");
  try {
    const token = wbToken(env);
    const today = new Date();
    const dateToStr = isoDate(today);
    const from = new Date(today.getTime() - days * 24 * 3600_000);
    const previousFrom = new Date(today.getTime() - days * 2 * 24 * 3600_000);
    const dateFromStr = isoDate(from);
    const previousFromStr = isoDate(previousFrom);
    const dateFromIso = previousFrom.toISOString().split(".")[0] + ".000Z";
    out.period = { from: dateFromStr, to: dateToStr, days, previous_from: previousFromStr };

    const salesUrl = `https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=${encodeURIComponent(dateFromIso)}`;
    const salesResp = await fetch(salesUrl, {
      headers: { Authorization: token, "User-Agent": "arina-wb/sales (+dasexperten fleet)" },
      signal: AbortSignal.timeout(28000),
    });
    if (salesResp.status === 429) throw new Error("WB rate limited (429)");
    if (!salesResp.ok) throw new Error(`WB sales HTTP ${salesResp.status}: ${(await salesResp.text()).slice(0, 300)}`);
    const rows = await salesResp.json();
    if (!Array.isArray(rows)) throw new Error("WB sales: unexpected payload");

    const sinceCutoff = from.getTime();
    const previousCutoff = previousFrom.getTime();
    const { current: perSku, previous: previousPerSku, perDate } =
      splitWbSalesPeriods(rows, sinceCutoff, previousCutoff);

    let funnelMap = new Map();
    try {
      funnelMap = await fetchWbNmReport(token, dateFromStr, dateToStr);
    } catch (e) {
      out.source_warnings.push(`funnel: ${String(e?.message || e)}`);
    }
    let priceMap = new Map();
    try {
      priceMap = await fetchWbPrices(token);
    } catch (e) {
      out.source_warnings.push(`prices: ${String(e?.message || e)}`);
    }

    const catalog = await env.ERP_DB.prepare(
      "SELECT id FROM products WHERE deleted_at IS NULL"
    ).all();
    const catalogIds = new Set((catalog.results || []).map((r) => r.id));
    const filtered = new Map();
    let dropped = 0;
    for (const [sku, v] of perSku.entries()) {
      if (catalogIds.has(sku)) filtered.set(sku, v);
      else dropped++;
    }

    out.movers = Array.from(filtered, ([base_sku, current]) => {
      const previous = previousPerSku.get(base_sku) || { units: 0, revenue: 0 };
      return {
        base_sku,
        units: current.units,
        prev_units: previous.units,
        units_delta: current.units - previous.units,
        revenue_rub: Math.round(current.revenue / 100),
        prev_revenue_rub: Math.round(previous.revenue / 100),
        revenue_delta_rub: Math.round((current.revenue - previous.revenue) / 100),
      };
    })
      .sort((a, b) => a.revenue_delta_rub - b.revenue_delta_rub)
      .slice(0, 10);

    out.funnel_movers = Array.from(filtered.keys(), (base_sku) => {
      const f = funnelMap.get(base_sku) || {};
      return {
        base_sku,
        views: f.views || 0,
        prev_views: f.pastViews || 0,
        carts: f.tocart || 0,
        prev_carts: f.pastTocart || 0,
        orders: f.orders || 0,
        prev_orders: f.pastOrders || 0,
        buyouts: f.buyouts || 0,
        prev_buyouts: f.pastBuyouts || 0,
        add_to_cart_pct: f.conversions?.addToCartPercent || 0,
        prev_add_to_cart_pct: f.pastConversions?.addToCartPercent || 0,
        cart_to_order_pct: f.conversions?.cartToOrderPercent || 0,
        prev_cart_to_order_pct: f.pastConversions?.cartToOrderPercent || 0,
        buyout_pct: f.conversions?.buyoutPercent || 0,
        prev_buyout_pct: f.pastConversions?.buyoutPercent || 0,
      };
    })
      .sort((a, b) => (a.orders - a.prev_orders) - (b.orders - b.prev_orders))
      .slice(0, 10);

    const now = Math.floor(Date.now() / 1000);
    const stmts = [env.ERP_DB.prepare("DELETE FROM marketplace_sales_wb")];
    for (const [sku, v] of filtered.entries()) {
      const f = funnelMap.get(sku) || { views: 0, tocart: 0, position: null };
      const price = priceMap.get(sku) ?? null;
      const prev = previousPerSku.get(sku) || { units: 0, revenue: 0 };
      const wbAnomaly = salesRowAnomaly({
        units: f.orders || 0,
        revenue_rub: 0,
        price_rub: 0,
        tocart: f.tocart,
      });
      if (wbAnomaly) out.anomalies.push({ base_sku: sku, reason: wbAnomaly });
      stmts.push(
        env.ERP_DB.prepare(
          `INSERT INTO marketplace_sales_wb
           (base_sku, period_from, period_to, units_sold, revenue_rub, listings_count, synced_at,
            views, tocart_count, position_category, current_price_rub, ad_spend_rub,
            prev_period_units_sold, prev_period_revenue_rub, anomaly)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
        ).bind(
          sku,
          dateFromStr,
          dateToStr,
          v.units,
          v.revenue,
          v.listings.size,
          now,
          f.views,
          f.tocart,
          f.position,
          price,
          prev.units,
          prev.revenue,
          wbAnomaly
        )
      );
    }
    for (const [d, v] of perDate.entries()) {
      stmts.push(
        env.ERP_DB.prepare(
          `INSERT INTO marketplace_sales_daily (marketplace, date, units_sold, revenue_rub, synced_at)
           VALUES ('wb', ?, ?, ?, ?)
           ON CONFLICT (marketplace, date) DO UPDATE SET
             units_sold = excluded.units_sold,
             revenue_rub = excluded.revenue_rub,
             synced_at = excluded.synced_at`
        ).bind(d, v.units, v.revenue, now)
      );
    }
    const CHUNK = 40;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.ERP_DB.batch(stmts.slice(i, i + CHUNK));
    }

    await finishOk(env, logId, filtered.size);
    out.rows_synced = filtered.size;
    out.days_synced = perDate.size;
    out.raw_records = rows.length;
    out.dropped_not_in_catalog = dropped;
    return out;
  } catch (e) {
    const msg = String(e?.message || e);
    out.error = msg;
    await finishErr(env, logId, msg);
    return out;
  }
}
