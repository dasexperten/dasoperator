import { wbRead } from "./wb-egress.mjs";
/**
 * Marketplace stocks craft → ERP D1 (Owner 2026-07-21).
 *
 * Ownership (binding):
 *   - Ozon stocks  = Dasha Worker `dasha-ozon`
 *   - WB stocks    = Arina Worker `arina-wb`
 *   - Das Operator = dashboard / store only — does NOT own this craft
 *
 * Writes:
 *   marketplace_stocks_ozon / marketplace_stocks_wb
 *   marketplace_sync_log (marketplace = 'ozon' | 'wb')
 *
 * Controlled cadence only (daily at 00:30 Yerevan). No standing firehose.
 */
import { parseMarketplaceArticle } from "./marketplace-articles.mjs";
import { ozonClientId } from "./marketplace-api.mjs";
import { beginLog, finishOk, finishErr } from "./marketplace-sync-log.mjs";
import { fetchOzonRead, retryAfterMilliseconds } from "./ozon-read-retry.mjs";

const OZ_STOCKS = "https://api-seller.ozon.ru/v4/product/info/stocks";
// Old statistics-api supplier/stocks is DEAD (WB PLUG-404-20260720).
// Replacement: seller-analytics warehouse_remains async report.
const WB_WH_CREATE = "https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains";
// Кластерный срез FBO. Ozon сам отдаёт cluster_name на /v1/analytics/stocks,
// поэтому карта склад→кластер на этом пути не нужна вовсе.
const OZ_PRODUCT_LIST = "https://api-seller.ozon.ru/v3/product/list";
const OZ_PRODUCT_INFO = "https://api-seller.ozon.ru/v3/product/info/list";
const OZ_CLUSTER_STOCKS = "https://api-seller.ozon.ru/v1/analytics/stocks";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Dasha — pull Ozon FBO/FBS stocks into ERP.
 * Requires OZON_API_KEY + OZON_CLIENT_ID with Seller stocks role.
 */
export async function syncOzonStocksToErp(env) {
  const out = { marketplace: "ozon", rows_synced: 0, unmatched: [], error: null, owner: "dasha-ozon" };
  if (!env.ERP_DB) {
    out.error = "ERP_DB binding missing on dasha-ozon";
    return out;
  }
  const { logId } = await beginLog(env, "ozon");
  try {
    const key = String(env.OZON_API_KEY || env.DASHA_OZON_API_KEY || "").trim();
    const clientId = String(env.OZON_CLIENT_ID || env.DASHA_OZON_CLIENT_ID || ozonClientId(env) || "").trim();
    if (!key || !clientId) throw new Error("Dasha Ozon credentials missing (OZON_API_KEY / OZON_CLIENT_ID)");

    const headers = {
      "Client-Id": clientId,
      "Api-Key": key,
      "Content-Type": "application/json",
      "User-Agent": "dasha-ozon/stocks (+dasexperten fleet)",
    };

    let cursor = "";
    let total = 0;
    const unmatched = [];

    while (true) {
      const { response: resp, attempts } = await fetchOzonRead(OZ_STOCKS, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { visibility: "ALL" }, limit: 200, cursor }),
      }, { timeoutMs: 28000 });
      if (!resp.ok) {
        const retryAfter = retryAfterMilliseconds(resp.headers);
        throw new Error(`Ozon stocks HTTP ${resp.status} after ${attempts} attempt(s)${retryAfter === null ? "" : `; retry-after ${retryAfter}ms`}: ${(await resp.text()).slice(0, 400)}`);
      }
      const data = await resp.json();
      const items = Array.isArray(data.items) ? data.items : [];
      const now = Math.floor(Date.now() / 1000);
      const stmts = [];

      for (const item of items) {
        const offerId = String(item.offer_id || "");
        const { baseSku, packFactor } = parseMarketplaceArticle(offerId);
        if (!baseSku) {
          unmatched.push(offerId);
          continue;
        }
        const stocks = Array.isArray(item.stocks) ? item.stocks : [];
        const fboAv = stocks.filter((s) => s.type === "fbo").reduce((sum, s) => sum + (s.present || 0), 0);
        const fboRe = stocks.filter((s) => s.type === "fbo").reduce((sum, s) => sum + (s.reserved || 0), 0);
        const fbsAv = stocks.filter((s) => s.type === "fbs").reduce((sum, s) => sum + (s.present || 0), 0);

        stmts.push(
          env.ERP_DB.prepare(`
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
          `).bind(
            offerId,
            item.product_id ?? null,
            baseSku,
            packFactor,
            fboAv,
            fboRe,
            fbsAv,
            now
          )
        );
      }

      if (stmts.length) {
        await env.ERP_DB.batch(stmts);
        total += stmts.length;
      }

      const next = data.cursor || "";
      if (!next || next === cursor || items.length === 0) break;
      cursor = next;
    }

    // Вторая половина того же ремесла — срез по кластерам. Ошибка здесь
    // красит весь прогон в красное: тихая дыра в этом месте уже стоила
    // тридцати восьми дней плана поставки по июльским остаткам.
    const cluster = await syncOzonClusterStocks(env, headers);
    out.cluster_rows = cluster.rows;
    out.clusters = cluster.clusters;
    out.cluster_skus = cluster.skus;
    out.unmatched = unmatched.slice(0, 40);
    out.rows_synced = total;
    if (cluster.error) {
      out.error = `cluster split: ${cluster.error}`;
      await finishErr(env, logId, `offers ok (${total}), cluster split failed: ${cluster.error}`);
      return out;
    }

    await finishOk(env, logId, total + cluster.rows);
    return out;
  } catch (e) {
    const msg = String(e?.message || e);
    out.error = msg;
    await finishErr(env, logId, msg);
    return out;
  }
}

/**
 * Ключ `fbo_stocks_cluster.base_sku` — это НЕ разобранный base_sku, а offer_id,
 * приведённый к нижнему регистру со снятыми разделителями: суффикс кратности
 * остаётся в ключе (de207aa, de120aaaa). Так писал прежний хозяин ремесла в ERP
 * до 2026-07-20, и по этому ключу с таблицей склеиваются fbo_sales_cluster,
 * дозор Юстины №20 и runFboCalc. Разобрать его до de207 — тихо сломать все три.
 */
export const normClusterSku = (s) =>
  String(s || "").toLowerCase().replace(/[\s_-]+/g, "").trim();

/** Чистая функция: строки analytics/stocks → Map("<sku>\0<кластер>" → штуки). */
export function aggregateOzonClusterRows(items) {
  const agg = new Map();
  const clusters = new Set();
  let skipped = 0;
  for (const it of items || []) {
    const sku = normClusterSku(it?.offer_id);
    if (!sku) {
      skipped++;
      continue;
    }
    const cluster = String(it?.cluster_name || "").trim() || "UNKNOWN";
    const units = Number(it?.available_stock_count || 0) || 0;
    clusters.add(cluster);
    const key = sku + "\u0000" + cluster;
    agg.set(key, (agg.get(key) || 0) + units);
  }
  return { agg, clusters, skipped };
}

async function ozonJson(url, headers, body, timeout = 28000) {
  const { response: r, attempts } = await fetchOzonRead(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, { timeoutMs: timeout });
  if (!r.ok) {
    const path = url.replace("https://api-seller.ozon.ru", "");
    const retryAfter = retryAfterMilliseconds(r.headers);
    throw new Error(`Ozon ${path} HTTP ${r.status} after ${attempts} attempt(s)${retryAfter === null ? "" : `; retry-after ${retryAfter}ms`}: ${(await r.text()).slice(0, 300)}`);
  }
  return r.json();
}

/**
 * Все живые sku-идентификаторы Ozon. product/list отдаёт по одному sku на товар,
 * а sources[] в info/list — по одному на схему (FBO и FBS), и на счёте это 85
 * против 47. Взять только первый значит потерять часть кластерных строк.
 */
async function ozonSkuIds(headers) {
  const productIds = [];
  const skus = new Set();
  let lastId = "";
  for (let page = 0; page < 20; page++) {
    const d = await ozonJson(OZ_PRODUCT_LIST, headers, {
      filter: { visibility: "ALL" },
      limit: 1000,
      last_id: lastId,
    });
    const items = d?.result?.items || [];
    for (const it of items) {
      if (it.product_id) productIds.push(it.product_id);
      if (it.sku) skus.add(String(it.sku));
    }
    lastId = d?.result?.last_id || "";
    if (!lastId || items.length === 0) break;
  }
  for (let i = 0; i < productIds.length; i += 1000) {
    const d = await ozonJson(OZ_PRODUCT_INFO, headers, {
      product_id: productIds.slice(i, i + 1000),
    });
    const items = d?.items || d?.result?.items || [];
    for (const it of items) {
      if (it.sku) skus.add(String(it.sku));
      for (const src of it.sources || []) if (src.sku) skus.add(String(src.sku));
    }
  }
  return Array.from(skus);
}

/**
 * Даша — кластерный срез остатков Ozon → ERP fbo_stocks_cluster.
 *
 * Эта половина ремесла упала на пол 2026-07-21, когда у ERP сняли Ozon-кроны:
 * агрегат по offer_id переехал на место Даши и тикал дальше, а срез по
 * кластерам остался мёртвым кодом в dasoperator-api и замер на 20 июля. План
 * поставки при этом продолжал читать таблицу как живую — 38 дней подряд
 * (Владелец 2026-08-29).
 */
export async function syncOzonClusterStocks(env, headers) {
  const out = { rows: 0, clusters: 0, skus: 0, error: null };
  try {
    const skus = await ozonSkuIds(headers);
    out.skus = skus.length;
    if (!skus.length) throw new Error("product/list не отдал ни одного sku");

    const items = [];
    for (let i = 0; i < skus.length; i += 100) {
      const d = await ozonJson(OZ_CLUSTER_STOCKS, headers, { skus: skus.slice(i, i + 100) });
      items.push(...(d?.items || []));
    }

    const { agg, clusters } = aggregateOzonClusterRows(items);
    // Пустой ответ площадки — не повод стереть снимок. Молчаливое обнуление
    // выглядит на витрине точно так же, как распроданный склад.
    if (!agg.size) throw new Error("analytics/stocks вернул ноль строк — снимок не трогаем");

    const now = Math.floor(Date.now() / 1000);
    // Полное обновление: кластер, ушедший в ноль, должен исчезнуть, а не
    // остаться призрачным остатком в плане поставки.
    const batch = [env.ERP_DB.prepare("DELETE FROM fbo_stocks_cluster WHERE marketplace = 'ozon'")];
    const entries = [...agg.entries()];
    const PER = 19; // 19 строк × 5 переменных = 95, под потолком D1 в 100
    for (let i = 0; i < entries.length; i += PER) {
      const chunk = entries.slice(i, i + PER);
      const sql =
        "INSERT INTO fbo_stocks_cluster (marketplace, base_sku, cluster, units, synced_at) VALUES " +
        chunk.map(() => "(?, ?, ?, ?, ?)").join(", ") +
        " ON CONFLICT (marketplace, base_sku, cluster) DO UPDATE SET units = excluded.units, synced_at = excluded.synced_at";
      const params = [];
      for (const [key, units] of chunk) {
        const [sku = "", cluster = ""] = key.split("\u0000");
        params.push("ozon", sku, cluster, units, now);
      }
      batch.push(env.ERP_DB.prepare(sql).bind(...params));
    }
    // Порядок держится: срезы уходят последовательно, DELETE идёт первым.
    for (let i = 0; i < batch.length; i += 20) {
      await env.ERP_DB.batch(batch.slice(i, i + 20));
    }

    out.rows = entries.length;
    out.clusters = clusters.size;
    return out;
  } catch (e) {
    out.error = String(e?.message || e);
    return out;
  }
}

// WB warehouse_remains pseudo-rows inside warehouses[] — NOT real warehouses.
const WB_PSEUDO_TOTAL = "Всего находится на складах";
const WB_PSEUDO_TO_CLIENT = "В пути до получателей";
const WB_PSEUDO_FROM_CLIENT = "В пути возвраты на склад WB";
const WB_PSEUDO = new Set([WB_PSEUDO_TOTAL, WB_PSEUDO_TO_CLIENT, WB_PSEUDO_FROM_CLIENT]);

/**
 * SCAR 2026-07-25 (Arina): warehouse_remains rows expose ONLY
 *   { vendorCode, nmId, volume, warehouses[] }
 * There is NO top-level quantity / quantityFull / quantityWarehouse field.
 * The previous `?? r.volume` fallback silently wrote CARTON VOLUME IN LITRES
 * (0.41, 0.75 …) into marketplace_stocks_wb.quantity for weeks, and the
 * per-warehouse split — the only way to see which warehouse holds what —
 * was never read at all. `volume` is BANNED as a quantity source.
 */
function aggregateWbRows(rows) {
  const byArticle = new Map();
  const byWarehouse = [];
  const unmatched = new Set();

  for (const r of rows) {
    const article = String(r.vendorCode || r.saName || r.supplierArticle || r.sa || r.article || "").trim();
    if (!article) continue;
    const { baseSku, packFactor } = parseMarketplaceArticle(article);
    if (!baseSku) {
      unmatched.add(article);
      continue;
    }
    const nm = Number(r.nmId || r.nmID || r.nmid || 0) || 0;

    let onWarehouses = 0;
    let toClient = 0;
    let fromClient = 0;
    let realSum = 0;

    const list = Array.isArray(r.warehouses) ? r.warehouses : [];
    for (const w of list) {
      const name = String(w.warehouseName || w.officeName || "").trim();
      const qty = Number(w.quantity ?? 0) || 0;
      if (name === WB_PSEUDO_TOTAL) { onWarehouses = qty; continue; }
      if (name === WB_PSEUDO_TO_CLIENT) { toClient = qty; continue; }
      if (name === WB_PSEUDO_FROM_CLIENT) { fromClient = qty; continue; }
      if (WB_PSEUDO.has(name) || !name) continue;
      realSum += qty;
      byWarehouse.push({ supplier_article: article, nm_id: nm, base_sku: baseSku, warehouse: name, quantity: qty });
    }

    // Trust the WB total row; fall back to the sum of real warehouses.
    const quantity = onWarehouses || realSum;

    let a = byArticle.get(article);
    if (!a) {
      a = {
        nm_id: nm,
        base_sku: baseSku,
        pack_factor: packFactor,
        quantity: 0,
        in_way_to_client: 0,
        in_way_from_client: 0,
        quantity_full: 0,
      };
      byArticle.set(article, a);
    }
    a.quantity += quantity;
    a.in_way_to_client += toClient;
    a.in_way_from_client += fromClient;
    a.quantity_full += quantity + toClient + fromClient;
    if (nm && !a.nm_id) a.nm_id = nm;
  }

  return { byArticle, byWarehouse, unmatched };
}

function parseCsv(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(sep).map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx];
    });
    rows.push({
      vendorCode: obj.vendorCode || obj.saName || obj["Артикул продавца"] || obj.sa,
      nmId: obj.nmId || obj.nmID || obj["Артикул WB"],
      quantity: obj.quantity || obj["Количество"] || obj.quantityWarehouse || obj["Доступно"],
      inWayToClient: obj.inWayToClient || obj["В пути к клиенту"] || obj.toClient,
      inWayFromClient: obj.inWayFromClient || obj["В пути от клиента"] || obj.fromClient,
      quantityFull: obj.quantityFull || obj["Полное количество"],
      warehouseName: obj.warehouseName || obj["Склад"] || obj.officeName,
    });
  }
  return rows;
}

/**
 * Arina — pull WB FBO stocks via warehouse_remains (new path).
 * Never calls deprecated statistics-api /supplier/stocks.
 */
export async function syncWbStocksToErp(env) {
  const out = {
    marketplace: "wb",
    rows_synced: 0,
    unmatched: [],
    error: null,
    owner: "arina-wb",
    method: "warehouse_remains",
  };
  if (!env.ERP_DB) {
    out.error = "ERP_DB binding missing on arina-wb";
    return out;
  }
  const { logId } = await beginLog(env, "wb");
  try {
    const token = env.WB_GATEWAY ? "erp-managed" : String(env.WB_API_TOKEN || env.ARINA_WB_API_TOKEN || "").trim();
    if (!token) throw new Error("Arina WB credentials missing (WB_API_TOKEN)");

    const headers = {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": "arina-wb/stocks (+dasexperten fleet)",
    };

    // WB OpenAPI: create report is GET with groupBy* query params (POST returns 405)
    const createQs = new URLSearchParams({
      groupByBrand: "false",
      groupBySubject: "false",
      groupBySa: "true",
      groupByNm: "true",
      groupByBarcode: "false",
      groupBySize: "false",
    });
    const create = await wbRead(env, `${WB_WH_CREATE}?${createQs}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(28000),
    });
    if (!create.ok) {
      throw new Error(
        `WB warehouse_remains create HTTP ${create.status}: ${(await create.text()).slice(0, 400)}`
      );
    }
    const created = await create.json();
    const taskId =
      created?.data?.taskId ||
      created?.taskId ||
      created?.data?.task_id ||
      created?.task_id;
    if (!taskId) {
      throw new Error(`WB warehouse_remains: no taskId in response: ${JSON.stringify(created).slice(0, 300)}`);
    }
    out.task_id = taskId;

    let ready = false;
    for (let i = 0; i < 24; i++) {
      await sleep(4000);
      const st = await wbRead(env, `${WB_WH_CREATE}/tasks/${encodeURIComponent(taskId)}/status`, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
      if (!st.ok) {
        const st2 = await wbRead(env, `${WB_WH_CREATE}/tasks?taskId=${encodeURIComponent(taskId)}`, {
          headers,
          signal: AbortSignal.timeout(20000),
        });
        if (!st2.ok) {
          throw new Error(`WB warehouse_remains status HTTP ${st.status}/${st2.status}`);
        }
        const body2 = await st2.json();
        const status2 = String(body2?.data?.status || body2?.status || "").toLowerCase();
        if (["done", "ready", "completed", "success"].includes(status2)) {
          ready = true;
          break;
        }
        if (["error", "failed", "canceled"].includes(status2)) {
          throw new Error(`WB warehouse_remains task failed: ${JSON.stringify(body2).slice(0, 300)}`);
        }
        continue;
      }
      const body = await st.json();
      const status = String(body?.data?.status || body?.status || "").toLowerCase();
      if (["done", "ready", "completed", "success"].includes(status)) {
        ready = true;
        break;
      }
      if (["error", "failed", "canceled"].includes(status)) {
        throw new Error(`WB warehouse_remains task failed: ${JSON.stringify(body).slice(0, 300)}`);
      }
    }
    if (!ready) throw new Error(`WB warehouse_remains task ${taskId} not ready after polling`);

    const dl = await wbRead(env, `${WB_WH_CREATE}/tasks/${encodeURIComponent(taskId)}/download`, {
      headers,
      signal: AbortSignal.timeout(28000),
    });
    if (!dl.ok) {
      throw new Error(`WB warehouse_remains download HTTP ${dl.status}: ${(await dl.text()).slice(0, 400)}`);
    }
    const ctype = String(dl.headers.get("content-type") || "");
    let rows = [];
    if (ctype.includes("json")) {
      const j = await dl.json();
      rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.report) ? j.report : [];
    } else {
      const text = await dl.text();
      try {
        const j = JSON.parse(text);
        rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
      } catch {
        rows = parseCsv(text);
      }
    }
    if (!rows.length) {
      throw new Error("WB warehouse_remains: empty report payload");
    }

    const { byArticle, byWarehouse, unmatched } = aggregateWbRows(rows);
    const now = Math.floor(Date.now() / 1000);
    const stmts = [];
    for (const [article, v] of byArticle) {
      stmts.push(
        env.ERP_DB.prepare(`
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
          article,
          v.nm_id,
          v.base_sku,
          v.pack_factor,
          v.quantity,
          v.in_way_to_client,
          v.in_way_from_client,
          v.quantity_full,
          now
        )
      );
    }
    const CHUNK = 80;
    for (let i = 0; i < stmts.length; i += CHUNK) {
      await env.ERP_DB.batch(stmts.slice(i, i + CHUNK));
    }

    // Per-warehouse split (SCAR 2026-07-25): full refresh, so closed/burned
    // warehouses disappear instead of lingering as phantom stock.
    if (byWarehouse.length) {
      const whStmts = [
        env.ERP_DB.prepare("DELETE FROM marketplace_stocks_wb_warehouse"),
      ];
      for (const w of byWarehouse) {
        whStmts.push(
          env.ERP_DB.prepare(`
            INSERT INTO marketplace_stocks_wb_warehouse
              (supplier_article, warehouse, nm_id, base_sku, quantity, synced_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(supplier_article, warehouse) DO UPDATE SET
              nm_id = excluded.nm_id,
              base_sku = excluded.base_sku,
              quantity = excluded.quantity,
              synced_at = excluded.synced_at
          `).bind(w.supplier_article, w.warehouse, w.nm_id, w.base_sku, w.quantity, now)
        );
      }
      for (let i = 0; i < whStmts.length; i += CHUNK) {
        await env.ERP_DB.batch(whStmts.slice(i, i + CHUNK));
      }
      out.warehouse_rows = byWarehouse.length;
      out.warehouses = Array.from(new Set(byWarehouse.map((w) => w.warehouse))).sort();
    }

    await finishOk(env, logId, stmts.length);
    out.rows_synced = stmts.length;
    out.unmatched = Array.from(unmatched).slice(0, 40);
    return out;
  } catch (e) {
    const msg = String(e?.message || e);
    out.error = msg;
    await finishErr(env, logId, msg);
    return out;
  }
}
