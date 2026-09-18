/**
 * wb-ryazan-watch — daily cancellation watch on the Ryazan (Tyushevskoe) pool.
 *
 * Owner 2026-08-08 (Arina): the warehouse has been closed since the 29 July
 * strike, yet WB kept selling from its stock. On 5-7 August WB cancelled 25
 * pre-strike Ryazan orders retroactively while accepting 8 new ones. The open
 * question is whether the new orders ship or follow the same path.
 *
 * The watch is deliberately narrow. It does not judge the warehouse, it records
 * one fact per day: for every order placed against Ryazan since the reopening
 * signal, is it still alive, cancelled, or bought out. A cancellation of a NEW
 * order is the evidence that WB sells goods it cannot ship — and that is what
 * turns a general force-majeure certificate into an addressed claim.
 *
 * Read-only against WB. Writes only to organizacia D1.
 */

import { wbFetch } from "./marketplace-api.mjs";

export const RYAZAN_WAREHOUSE = "Рязань (Тюшевское)";
// The day Ryazan stock came back onto the shelf after six days of zero orders.
export const WATCH_FROM = "2026-08-05";

const STATS = "https://statistics-api.wildberries.ru";

async function ensureTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS wb_ryazan_watch (
        checked_on TEXT NOT NULL,
        srid TEXT NOT NULL,
        order_date TEXT,
        vendor_code TEXT,
        nm_id INTEGER,
        region TEXT,
        price REAL,
        is_cancel INTEGER,
        is_bought INTEGER,
        last_change TEXT,
        PRIMARY KEY (checked_on, srid)
      )`
    )
    .run();
}

/**
 * One pass. Returns the counts plus the srids that flipped to cancelled —
 * those are the ones worth a letter.
 */
export async function runRyazanWatch(env, { from = WATCH_FROM } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  const orders = await wbFetch(env, STATS, "/api/v1/supplier/orders", {
    query: `dateFrom=${from}T00:00:00&flag=0`,
  });
  if (!orders.ok || !Array.isArray(orders.body)) {
    return { error: `orders ${orders.status}`, checked_on: today };
  }
  const sales = await wbFetch(env, STATS, "/api/v1/supplier/sales", {
    query: `dateFrom=${from}T00:00:00&flag=0`,
  });
  const bought = new Set(
    Array.isArray(sales.body) ? sales.body.map((r) => r.srid).filter(Boolean) : []
  );

  // Only orders PLACED after the reopening signal. Pre-strike orders carry the
  // old backlog and would drown the signal we are actually watching for.
  const rows = orders.body.filter(
    (r) => r.warehouseName === RYAZAN_WAREHOUSE && String(r.date || "") >= from
  );

  const watched = rows.map((r) => ({
    srid: r.srid,
    order_date: r.date,
    vendor_code: r.supplierArticle || null,
    nm_id: r.nmId || null,
    region: r.regionName || null,
    price: r.finishedPrice ?? null,
    is_cancel: r.isCancel ? 1 : 0,
    is_bought: bought.has(r.srid) ? 1 : 0,
    last_change: r.lastChangeDate || null,
  }));

  const db = env.DB;
  let stored = 0;
  if (db && watched.length) {
    await ensureTable(db);
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO wb_ryazan_watch
       (checked_on, srid, order_date, vendor_code, nm_id, region, price,
        is_cancel, is_bought, last_change)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    );
    await db.batch(
      watched.map((w) =>
        stmt.bind(
          today,
          w.srid,
          w.order_date,
          w.vendor_code,
          w.nm_id,
          w.region,
          w.price,
          w.is_cancel,
          w.is_bought,
          w.last_change
        )
      )
    );
    stored = watched.length;
  }

  const cancelled = watched.filter((w) => w.is_cancel);
  const result = {
    checked_on: today,
    warehouse: RYAZAN_WAREHOUSE,
    watch_from: from,
    tracked: watched.length,
    cancelled: cancelled.length,
    bought: watched.filter((w) => w.is_bought).length,
    open: watched.filter((w) => !w.is_cancel && !w.is_bought).length,
    stored,
    cancelled_skus: cancelled.map((w) => `${w.vendor_code}·${w.srid.slice(0, 12)}`),
  };
  console.log("[arina-wb:ryazan-watch] " + JSON.stringify(result));
  return result;
}
