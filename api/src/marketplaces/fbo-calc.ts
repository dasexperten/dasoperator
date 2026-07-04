// api/src/marketplaces/fbo-calc.ts
//
// FBO supply planning — V2 velocity math (approved 2026-07-04).
//
//   v        = sales_30d / active_days      Product Velocity, units/day.
//              active_days = span first_sale..last_sale in the window, min 1 —
//              a SKU that stocked out on day 12 shows its true speed, not a
//              30-day-diluted one.
//   demand30 = v * 30                       normalized monthly demand
//   K        = stock / demand30             coefficient on TRUE demand
//   boost(v) = 1.2 + 0.8 * min(1, v/V_FAST) velocity amplifier, 1.2..2.0:
//              fast movers earn freedom (up to 60 days of coverage), slow
//              movers stay lean (36 days).
//   target   = demand30 * boost(v)
//   to_ship  = ceil(max(0, target - stock) / pack) * pack, and never less
//              than ONE carton in a shipping zone — presence floor: a slow
//              SKU with live sales keeps its shelf.
//
//   zones (on normalized K):
//           K < 0.8            -> 'toship'     (deficit, ship)
//           0.8 <= K <= 1.2    -> 'default'    (normal, ship 0)
//           K > 1.2            -> 'overstock'  (blocked; auto-releases next run)
//           stock = 0, sales>0 -> 'stockout'   (priority alarm, ships)
//           sales = 0          -> 'default', K undefined, ship 0
//
//   V_FAST = 3.0 units/day is a PLACEHOLDER: recalibrate to the 80th
//   percentile of real per-cell velocities after the first production sync.
//
//   packaging (base units per master carton, detected from normalized sku):
//           de2## paste 72, de2## set 36, de1## brush 288, de1## set 144,
//           unknown pattern -> ship 0, counted separately.
//
// Reads fbo_stocks_cluster / fbo_sales_cluster (written by fbo-sync.ts),
// returns the exact JSON shape the /marketplaces frontend already expects
// (reverse-engineered from the deployed bundle), and logs to fbo_calc_runs.
//
// Deliberately deferred: Ozon paid-storage SKU exclusion. The overstock zone
// (K > 1.2) already blocks shipping into slow clusters, which was the
// economic purpose of that manual Excel step. Revisit if storage fees appear
// on SKUs the calculator still wants to ship.

export interface FboCalcEnv { DB: D1Database }

export type Zone = 'toship' | 'stockout' | 'overstock' | 'default';

export interface FboSkuRow {
  sku: string;
  stock: number;
  sales_30d: number;
  k: number | null;
  velocity: number;
  zone: Zone;
  to_ship: number;
  unknown_pack: boolean;
}

export interface FboCluster {
  cluster: string;
  sales: number;
  oos: number;
  to_ship: number;
  skus: FboSkuRow[];
}

export interface FboStatus {
  marketplace: 'ozon' | 'wb';
  run_date: string;
  generated_at: number;
  sku_count: number;
  stocks_rows: number;
  sales_rows: number;
  to_ship_units: number;
  to_ship_count: number;
  oos_count: number;
  overstock_count: number;
  unknown_cluster_count: number;
  unknown_pack_count: number;
  clusters: FboCluster[];
}

const K_DEFICIT = 0.8;
const K_OVERSTOCK = 1.2;
const V_FAST = 3.0;      // units/day; recalibrate to p80 after first sync
const MIN_ACTIVE_DAYS = 10;   // velocity damper: a 1-2 day sales burst is not a
                              // sustained rate — first prod run had 1-day spans
                              // inflating v 30x (48 sold -> 1440 to_ship)
const MIN_FLOOR_SALES = 5;    // presence floor only for cells with real demand:
                              // 1-3 stray sales were earning a full 288-unit carton
const BOOST_MIN = 1.2;   // 36 days of coverage for the slow tail
const BOOST_MAX = 2.0;   // 60 days of coverage for proven hits

// base_sku arrives normalized (lowercase, no spaces): de201, de201aa, de119aaaa
export function packSize(sku: string): number | null {
  const m = /^de([12])\d{2}([a-z]*)\d*$/.exec(sku);
  if (!m) return null;
  const isSet = (m[2] ?? '').length > 0;
  return m[1] === '2' ? (isSet ? 36 : 72) : (isSet ? 144 : 288);
}

// V2.1: while stock is live the SKU is "active" up to the window end — only a
// stocked-out cell truncates at last_sale (it stopped selling because it ran
// dry, not because demand died). MIN_ACTIVE_DAYS damps burst spans either way.
export function velocity(
  sales: number,
  firstSale: string | null,
  lastSale: string | null,
  stock: number,
  windowEnd: string,
): number {
  if (sales <= 0) return 0;
  let days = 30; // no dates -> conservative full-window denominator
  if (firstSale) {
    const end = stock > 0 ? windowEnd : (lastSale || windowEnd);
    const span = (Date.parse(end) - Date.parse(firstSale)) / 86400_000;
    days = Math.max(1, Math.round(span) + 1); // inclusive span
  }
  return sales / Math.max(days, MIN_ACTIVE_DAYS);
}

export function boost(v: number): number {
  return BOOST_MIN + (BOOST_MAX - BOOST_MIN) * Math.min(1, v / V_FAST);
}

export function classify(stock: number, v: number): { k: number | null; zone: Zone } {
  if (v <= 0) return { k: null, zone: 'default' };
  if (stock <= 0) return { k: 0, zone: 'stockout' };
  const k = stock / (v * 30);
  if (k < K_DEFICIT) return { k, zone: 'toship' };
  if (k > K_OVERSTOCK) return { k, zone: 'overstock' };
  return { k, zone: 'default' };
}

export function shipAmount(stock: number, v: number, zone: Zone, pack: number | null, sales: number): number {
  if (pack === null) return 0;                       // unknown packaging — flag, never guess
  if (zone !== 'toship' && zone !== 'stockout') return 0;
  if (sales < MIN_FLOOR_SALES) return 0;             // noise cells don't earn a carton
  const target = v * 30 * boost(v);
  const raw = Math.ceil(Math.max(0, target - stock) / pack) * pack;
  return Math.max(pack, raw);                        // presence floor: one carton minimum
}

export async function runFboCalc(env: FboCalcEnv, mp: 'ozon' | 'wb'): Promise<FboStatus> {
  const [stocksQ, salesQ] = await Promise.all([
    env.DB.prepare('SELECT base_sku, cluster, units FROM fbo_stocks_cluster WHERE marketplace = ?')
      .bind(mp).all<{ base_sku: string; cluster: string; units: number }>(),
    env.DB.prepare('SELECT base_sku, cluster, units_30d, first_sale, last_sale FROM fbo_sales_cluster WHERE marketplace = ?')
      .bind(mp).all<{ base_sku: string; cluster: string; units_30d: number; first_sale: string | null; last_sale: string | null }>(),
  ]);

  // Full outer join on (sku, cluster): stock without sales and sales without
  // stock are both real states (dead stock vs sold-out listing).
  type Cell = { stock: number; sales: number; first: string | null; last: string | null };
  const cells = new Map<string, Cell>();
  const key = (s: string, c: string) => `${s}\u0000${c}`;
  for (const r of stocksQ.results) {
    const cell = cells.get(key(r.base_sku, r.cluster)) || { stock: 0, sales: 0, first: null, last: null };
    cell.stock += r.units;
    cells.set(key(r.base_sku, r.cluster), cell);
  }
  for (const r of salesQ.results) {
    const cell = cells.get(key(r.base_sku, r.cluster)) || { stock: 0, sales: 0, first: null, last: null };
    cell.sales += r.units_30d;
    cell.first = r.first_sale;
    cell.last = r.last_sale;
    cells.set(key(r.base_sku, r.cluster), cell);
  }

  const status_run_date = new Date().toISOString().slice(0, 10); // = sales window end
  const byCluster = new Map<string, FboSkuRow[]>();
  const skuSet = new Set<string>();
  let toShipUnits = 0, toShipCount = 0, oos = 0, overstock = 0, unknownPack = 0;

  for (const [k, cell] of cells) {
    const [sku = '', cluster = ''] = k.split('\u0000');
    skuSet.add(sku);
    const v = velocity(cell.sales, cell.first, cell.last, cell.stock, status_run_date);
    const { k: coef, zone } = classify(cell.stock, v);
    const pack = packSize(sku);
    // UNKNOWN cluster rows are displayed but never shipped — geography
    // unconfirmed means the carton has no address.
    const to_ship = cluster === 'UNKNOWN' ? 0 : shipAmount(cell.stock, v, zone, pack, cell.sales);
    if (pack === null) unknownPack++;
    if (zone === 'stockout') oos++;
    if (zone === 'overstock') overstock++;
    if (to_ship > 0) { toShipUnits += to_ship; toShipCount++; }
    const row: FboSkuRow = {
      sku: sku.toUpperCase(),
      stock: cell.stock,
      sales_30d: cell.sales,
      k: coef === null ? null : Math.round(coef * 100) / 100,
      velocity: Math.round(v * 100) / 100,
      zone,
      to_ship,
      unknown_pack: pack === null,
    };
    if (!byCluster.has(cluster)) byCluster.set(cluster, []);
    byCluster.get(cluster)!.push(row);
  }

  const zoneRank: Record<Zone, number> = { stockout: 0, toship: 1, default: 2, overstock: 3 };
  const clusters: FboCluster[] = [...byCluster.entries()].map(([cluster, skus]) => {
    skus.sort((a, b) => zoneRank[a.zone] - zoneRank[b.zone] || a.sku.localeCompare(b.sku));
    return {
      cluster,
      sales: skus.reduce((n, s) => n + s.sales_30d, 0),
      oos: skus.filter((s) => s.zone === 'stockout').length,
      to_ship: skus.reduce((n, s) => n + s.to_ship, 0),
      skus,
    };
  });
  clusters.sort((a, b) => b.to_ship - a.to_ship || b.sales - a.sales);

  const status: FboStatus = {
    marketplace: mp,
    run_date: status_run_date,
    generated_at: Math.floor(Date.now() / 1000),
    sku_count: skuSet.size,
    stocks_rows: stocksQ.results.length,
    sales_rows: salesQ.results.length,
    to_ship_units: toShipUnits,
    to_ship_count: toShipCount,
    oos_count: oos,
    overstock_count: overstock,
    unknown_cluster_count: byCluster.get('UNKNOWN')?.length || 0,
    unknown_pack_count: unknownPack,
    clusters,
  };

  await env.DB.prepare(
    'INSERT INTO fbo_calc_runs (marketplace, run_date, sku_count, stocks_rows, sales_rows, ' +
    'to_ship_units, to_ship_count, oos_count, overstock_count, unknown_cluster_count, status, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    mp, status.run_date, status.sku_count, status.stocks_rows, status.sales_rows,
    status.to_ship_units, status.to_ship_count, status.oos_count, status.overstock_count,
    status.unknown_cluster_count, 'ok', status.generated_at,
  ).run();

  return status;
}
