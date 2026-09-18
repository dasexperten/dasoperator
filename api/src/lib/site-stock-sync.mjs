/**
 * Наличие Ozon → витрина dasexperten.ru (Владелец 2026-08-24).
 *
 * «Наличие товара сайт берёт из Озона. Даша проверяет каждые три часа оба
 * варианта: есть одноштучный — сайт продаёт его, нет — двухштучный; количество
 * передаётся на сайт, пишется там, где что есть.»
 *
 * Что делает каждый прогон:
 *   1. Снимает остатки всех товаров кабинета (v4/product/info/stocks, как в
 *      erp-stocks-sync): доступно = max(0, fbo_present − fbo_reserved) —
 *      тот же контракт, что у /api/stock-sync.php с рождения.
 *   2. Для БАЗОВЫХ вариантов, чей упаковочный собрат есть в кабинете
 *      (DE206 при DE206AA), досылает имя и цену карточки Озона
 *      (v4/product/info/prices) — сайт заведёт одноштучный сам; цену
 *      СУЩЕСТВУЮЩЕЙ строки сайт не перезаписывает никогда (§3.4).
 *   3. POST https://dasexperten.ru/api/stock-sync.php, X-Sync-Token из
 *      секрета SITE_SYNC_TOKEN (значение — SECRETS/dasexperten-ru-admin-token.md).
 *
 * Витрина дальше сама перещёлкивает кнопку на одноштучный при его наличии
 * (pricing.js: flipVariants) и возвращается к упаковке, когда одноштучный
 * кончился. Отказ любого шага не роняет сиденье — возвращается error.
 */
import { ozonClientId } from "../../../workers/_marketplace/marketplace-api.mjs";

const OZ_STOCKS = "https://api-seller.ozon.ru/v4/product/info/stocks";
// Живой замер 24.08.2026: v4/product/info/prices отдаёт 404 page not found —
// метод снят; живой — v5 (в permissions токена есть оба, но живёт только v5).
const OZ_PRICES = "https://api-seller.ozon.ru/v5/product/info/prices";
const SITE_SYNC = "https://dasexperten.ru/api/stock-sync.php";

// Артикулы, которые Ozon ПРОДАЁТ, но Ozon Доставка отгрузить не может.
//
// Остаток кабинета и отгружаемость — разные вещи, и выяснилось это дорого.
// 05.09.2026: у DE205AA free_to_sell 997 на двенадцати складах, а
// v2/delivery/checkout отвечает OUT_OF_STOCK в любом пункте выдачи и даже на
// одну штуку. Витрина честно продавала по числу из кабинета — и три оплаченных
// заказа остались без отправления (DE260905-9848, DE260905-9715, DE260830-8459).
// Соседние артикулы того же заказа checkout берёт спокойно: дело в самом
// артикуле, а не в пункте, количестве или географии.
//
// Пока причина у Ozon не названа, витрина не должна брать за него деньги.
// Ноль здесь = кнопка «нет в наличии», и товар вернётся в продажу сам, когда
// строку отсюда уберут. Причина и дата живут рядом со списком: список без даты
// живёт вечно и тихо режет продажи.
const NOT_SHIPPABLE = {
  DE205AA: "05.09.2026 · checkout Ozon Доставки отвечает OUT_OF_STOCK при free_to_sell 997",
};

function ozonHeaders(env) {
  const key = String(env.OZON_API_KEY || env.DASHA_OZON_API_KEY || "").trim();
  const clientId = String(env.OZON_CLIENT_ID || env.DASHA_OZON_CLIENT_ID || ozonClientId(env) || "").trim();
  if (!key || !clientId) throw new Error("Ozon credentials missing (OZON_API_KEY / OZON_CLIENT_ID)");
  return {
    "Client-Id": clientId,
    "Api-Key": key,
    "Content-Type": "application/json",
    "User-Agent": "dasha-ozon/site-stock (+dasexperten fleet)",
  };
}

async function fetchAllStocks(env) {
  const headers = ozonHeaders(env);
  const out = {}; // offer_id -> {available, name?}
  let cursor = "";
  while (true) {
    const resp = await fetch(OZ_STOCKS, {
      method: "POST",
      headers,
      body: JSON.stringify({ filter: { visibility: "ALL" }, limit: 200, cursor }),
      signal: AbortSignal.timeout(28000),
    });
    if (!resp.ok) throw new Error(`Ozon stocks HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const offerId = String(item.offer_id || "");
      if (!offerId) continue;
      const stocks = Array.isArray(item.stocks) ? item.stocks : [];
      const fboAv = stocks.filter((s) => s.type === "fbo").reduce((n, s) => n + (s.present || 0), 0);
      const fboRe = stocks.filter((s) => s.type === "fbo").reduce((n, s) => n + (s.reserved || 0), 0);
      out[offerId] = { available: Math.max(0, fboAv - fboRe), name: String(item.name || "") };
    }
    cursor = String(data.cursor || "");
    if (!cursor || items.length === 0) break;
  }
  return out;
}

// Имена карточек: v4/product/info/stocks имён НЕ несёт (живой замер 24.08) —
// имена отдаёт v3/product/info/list по offer_id.
async function fetchNames(env, offerIds) {
  if (!offerIds.length) return {};
  const headers = ozonHeaders(env);
  const out = {};
  for (let i = 0; i < offerIds.length; i += 100) {
    const chunk = offerIds.slice(i, i + 100);
    const resp = await fetch("https://api-seller.ozon.ru/v3/product/info/list", {
      method: "POST",
      headers,
      body: JSON.stringify({ offer_id: chunk }),
      signal: AbortSignal.timeout(28000),
    });
    if (!resp.ok) throw new Error(`Ozon names HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    const items = (Array.isArray(data.items) && data.items)
      || (data.result && Array.isArray(data.result.items) && data.result.items) || [];
    for (const it of items) if (it.offer_id && it.name) out[String(it.offer_id)] = String(it.name);
  }
  return out;
}

// Цены карточек по списку offer_id. Формы ответа Ozon плавают между версиями —
// берём первое живое числовое поле цены.
async function fetchPrices(env, offerIds) {
  if (!offerIds.length) return {};
  const headers = ozonHeaders(env);
  const out = {};
  for (let i = 0; i < offerIds.length; i += 100) {
    const chunk = offerIds.slice(i, i + 100);
    const resp = await fetch(OZ_PRICES, {
      method: "POST",
      headers,
      body: JSON.stringify({ filter: { offer_id: chunk, visibility: "ALL" }, limit: 100 }),
      signal: AbortSignal.timeout(28000),
    });
    if (!resp.ok) throw new Error(`Ozon prices HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = await resp.json();
    const items = (Array.isArray(data.items) && data.items)
      || (data.result && Array.isArray(data.result.items) && data.result.items) || [];
    for (const it of items) {
      const p = it.price || {};
      const raw = p.price ?? p.marketing_price ?? p.min_price;
      const rub = Number(raw);
      if (it.offer_id && Number.isFinite(rub) && rub > 0) out[String(it.offer_id)] = Math.round(rub * 100);
    }
  }
  return out;
}

export async function syncOzonStocksToSite(env) {
  const token = String(env.SITE_SYNC_TOKEN || "").trim();
  if (!token) return { ok: false, error: "SITE_SYNC_TOKEN не задан на сиденье" };
  try {
    const offers = await fetchAllStocks(env);
    const ids = Object.keys(offers);

    // Кандидаты в одноштучные: базовый DE\d+ с живым упаковочным собратом.
    const idSet = new Set(ids);
    const singles = ids.filter(
      (id) => /^DE\d+$/.test(id) && (idSet.has(id + "AA") || idSet.has(id + "AAAA"))
    );
    const prices = await fetchPrices(env, singles);
    const names = await fetchNames(env, singles);

    const stock = {};
    for (const id of ids) if (/^DE\d+/.test(id)) stock[id] = offers[id].available;
    // Гасим ПОСЛЕ сборки, а не вместо неё: в журнал должно попасть и то, что
    // кабинет по этому артикулу показывает остаток. Иначе через месяц никто не
    // поймёт, почему товар с тысячей штук не продаётся на витрине.
    const blocked = [];
    for (const id of Object.keys(NOT_SHIPPABLE)) {
      if (stock[id] === undefined) continue;
      blocked.push(`${id}: кабинет ${stock[id]} → 0 (${NOT_SHIPPABLE[id]})`);
      stock[id] = 0;
    }
    if (blocked.length) console.log("[site-stock-sync] закрыты как неотгружаемые:", blocked.join(" · "));
    const upsert = singles
      .filter((id) => prices[id] && names[id])
      .map((id) => ({ sku: id, name: names[id], price_kop: prices[id] }));

    const resp = await fetch(SITE_SYNC, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Token": token },
      body: JSON.stringify({
        source: "ozon:v4/product/info/stocks",
        synced_at: Math.floor(Date.now() / 1000),
        stock,
        upsert,
      }),
      signal: AbortSignal.timeout(28000),
    });
    const body = await resp.json().catch(async () => ({ raw: (await resp.text()).slice(0, 200) }));
    if (!resp.ok || !body.ok) {
      return { ok: false, error: `site HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 300)}` };
    }
    return {
      ok: true,
      offers: ids.length,
      pushed: Object.keys(stock).length,
      singles_offered: upsert.map((u) => u.sku),
      site: { updated: body.updated, upserted: body.upserted, rejected: body.upsert_rejected, not_in_feed: body.not_in_feed },
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
