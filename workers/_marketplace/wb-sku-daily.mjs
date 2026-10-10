// WB library — lasting day-by-day history per product (Owner 2026-10-10).
// Table wb_sku_daily (db/migrations/0114_wb_sku_daily.sql). The nightly WB sales run
// calls writeWbSkuDaily after its 7-day snapshot. Each source upserts only its own
// columns, so a source that failed tonight leaves earlier days untouched and the next
// night fills the gap; a missing value stays NULL, never zero.

const DAY = 86400000;
const MSK = 3 * 3600000;

// WB reports days in Moscow time.
export const mskDate = (ms) => new Date(ms + MSK).toISOString().slice(0, 10);
const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10);

function daysBetween(first, last) {
  const out = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Build the upsert statements.
 * @param input.now          run time, ms
 * @param input.salesFrom    ms the sales request started from (dateFrom)
 * @param input.salesRows    WB statistics /supplier/sales rows
 * @param input.catalogIds   Set of products.id (lowercase)
 * @param input.adFrom       first day (YYYY-MM-DD) of the advertising read, or null
 * @param input.adByDay      Map day → Map sku → kopecks, or null when the ad read failed
 * @param input.dayFunnel    Map sku → { views, tocart, orders } for yesterday, or null
 * @param input.priceMap     Map sku → kopecks read this morning, or null
 */
export function buildWbSkuDaily(input) {
  const { now, salesFrom, salesRows, catalogIds, adFrom, adByDay, dayFunnel, priceMap } = input;
  const yesterday = addDays(mskDate(now), -1);
  // The first requested day is partial (the request starts mid-day); today is not over.
  const salesDays = daysBetween(addDays(mskDate(salesFrom), 1), yesterday);
  const firstSalesDay = salesDays[0];

  const sales = new Map(); // day|sku → { units, revenue }
  const skus = new Set();
  for (const r of salesRows || []) {
    const day = String(r.date || '').slice(0, 10);
    if (!day || day < firstSalesDay || day > yesterday) continue;
    const sku = String(r.supplierArticle || '').trim().toLowerCase();
    if (!catalogIds.has(sku)) continue;
    skus.add(sku);
    const key = `${day}|${sku}`;
    const e = sales.get(key) || { units: 0, revenue: 0 };
    e.units += 1;
    e.revenue += Math.round(Number(r.priceWithDisc || 0) * 100);
    sales.set(key, e);
  }
  for (const dayMap of adByDay?.values() || []) for (const sku of dayMap.keys()) if (catalogIds.has(sku)) skus.add(sku);
  for (const sku of dayFunnel?.keys() || []) if (catalogIds.has(sku)) skus.add(sku);

  const rows = { sales: [], ad: [], funnel: [], price: [] };
  for (const day of salesDays)
    for (const sku of skus) {
      const e = sales.get(`${day}|${sku}`) || { units: 0, revenue: 0 };
      rows.sales.push([day, sku, e.units, e.revenue]);
    }
  if (adByDay && adFrom)
    for (const day of daysBetween(adFrom, yesterday))
      for (const sku of skus) rows.ad.push([day, sku, adByDay.get(day)?.get(sku) || 0]);
  for (const [sku, f] of dayFunnel || [])
    if (catalogIds.has(sku)) rows.funnel.push([yesterday, sku, f.views ?? null, f.tocart ?? null, f.orders ?? null]);
  for (const [sku, price] of priceMap || [])
    if (catalogIds.has(sku)) rows.price.push([yesterday, sku, price]);
  return { yesterday, firstSalesDay, rows };
}

const SQL = {
  sales: `INSERT INTO wb_sku_daily (date, base_sku, units_sold, revenue_kopecks, sales_synced_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (date, base_sku) DO UPDATE SET units_sold = excluded.units_sold,
      revenue_kopecks = excluded.revenue_kopecks, sales_synced_at = excluded.sales_synced_at`,
  ad: `INSERT INTO wb_sku_daily (date, base_sku, ad_spend_kopecks, ad_synced_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (date, base_sku) DO UPDATE SET ad_spend_kopecks = excluded.ad_spend_kopecks,
      ad_synced_at = excluded.ad_synced_at`,
  funnel: `INSERT INTO wb_sku_daily (date, base_sku, views, tocart, orders, funnel_synced_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (date, base_sku) DO UPDATE SET views = excluded.views, tocart = excluded.tocart,
      orders = excluded.orders, funnel_synced_at = excluded.funnel_synced_at`,
  price: `INSERT INTO wb_sku_daily (date, base_sku, price_kopecks, price_synced_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (date, base_sku) DO UPDATE SET price_kopecks = excluded.price_kopecks,
      price_synced_at = excluded.price_synced_at`,
};

export async function writeWbSkuDaily(env, input) {
  const built = buildWbSkuDaily(input);
  const at = Math.floor(input.now / 1000);
  const stmts = [];
  for (const [kind, list] of Object.entries(built.rows))
    for (const values of list) stmts.push(env.ERP_DB.prepare(SQL[kind]).bind(...values, at));
  for (let i = 0; i < stmts.length; i += 40) await env.ERP_DB.batch(stmts.slice(i, i + 40));
  return {
    days: `${built.firstSalesDay}..${built.yesterday}`,
    sales_rows: built.rows.sales.length,
    ad_rows: built.rows.ad.length,
    funnel_rows: built.rows.funnel.length,
    price_rows: built.rows.price.length,
  };
}
