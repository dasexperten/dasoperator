// Owner 2026-11-09: basket additions must be visible. Ozon Seller Analytics
// supplies Moscow calendar days; never relabel them as same-hour order windows.
type RequestOzon = (path: string, body?: unknown) => Promise<any>;
export const BASKETS_KEY = 'ozon:promotion-monitor:baskets:latest';
const LEASE_KEY = 'ozon:promotion-monitor:baskets:attempt';
// Seller API FAQ: /v1/analytics/data is limited to one request per minute.
const MIN_INTERVAL_MS = 60000;
export function basketDays(at: number) {
  const day = 86400000;
  const today = new Date(at + 3 * 3600000).toISOString().slice(0, 10);
  const yesterday = new Date(at + 3 * 3600000 - day).toISOString().slice(0, 10);
  return { today, yesterday, timezone: 'Europe/Moscow', today_complete: false, yesterday_complete: true };
}
export type BasketSnapshot = {
  period: ReturnType<typeof basketDays>; as_of: string;
  by_product: Record<string, { today: number | null; yesterday: number | null }>;
  coverage: { metric: string; analytics_rows: number; mapped_products: number; unmapped_products: number[]; days_observed: string[]; source_timestamp: unknown;
    resolved_source_skus: string[]; ignored_zero_unmapped_skus: string[] };
};
export async function readDailyBaskets(request: RequestOzon, sourceMap: Map<string, number>, productIds: number[], at: number, expectedOffers?: Map<number, string>): Promise<BasketSnapshot> {
  if (!sourceMap.size) throw Error('Ozon basket product mapping unavailable');
  const period = basketDays(at), limit = 1000;
  const response = await request('/v1/analytics/data', {
    date_from: period.yesterday, date_to: period.today,
    metrics: ['hits_tocart'], dimension: ['sku', 'day'], filters: [],
    sort: [{ key: 'hits_tocart', order: 'DESC' }], limit, offset: 0,
  });
  const data = response?.result?.data;
  if (!Array.isArray(data)) throw Error('Ozon basket analytics response unavailable');
  if (!data.length) throw Error('Ozon daily basket data has not been returned');
  // 48 products × 2 days fit in one page. A full page is not proof of complete
  // coverage; do not save partial counts or hammer the one-request/minute API.
  if (data.length >= limit) throw Error('Ozon basket analytics incomplete: another page is required');
  // Analytics can include historical listing SKUs missing from current sources.
  // Resolve nonzero historical aliases through Ozon's exact SKU lookup, never
  // through a product-name guess or a root-SKU/pack merge.
  const unresolved = [...new Set<string>(data.filter((r: any) => typeof r?.metrics?.[0] === 'number' && r.metrics[0] > 0)
    .map((r: any) => String(r?.dimensions?.[0]?.id ?? '')).filter((sku: string) => !sourceMap.has(sku)))];
  const resolved: string[] = [];
  for (const sku of unresolved) {
    if (!/^\d+$/.test(sku)) throw Error('Ozon basket source SKU invalid');
    const info = await request('/v3/product/info/list', { sku: [sku] });
    const items = info?.items;
    const id = Number(items?.[0]?.id);
    if (!Array.isArray(items) || items.length !== 1 || !productIds.includes(id)
      || (expectedOffers && items[0].offer_id !== expectedOffers.get(id))) {
      throw Error(`Ozon basket SKU mapping unavailable: ${sku}`);
    }
    sourceMap.set(sku, Number(items[0].id));
    resolved.push(sku);
  }
  const days = new Set<string>(data.map((r: any) => r?.dimensions?.[1]?.id));
  const mapped = new Set(sourceMap.values()), by_product: BasketSnapshot['by_product'] = {};
  // If Ozon did not return an entire day, freshness/zero activity is ambiguous.
  // Keep that day unknown instead of manufacturing zeros for the whole shop.
  for (const id of productIds) if (mapped.has(id)) by_product[String(id)] = {
    today: days.has(period.today) ? 0 : null, yesterday: days.has(period.yesterday) ? 0 : null };
  const seen = new Set<string>(), ignoredZero = new Set<string>();
  for (const row of data) {
    const sku = String(row?.dimensions?.[0]?.id ?? ''), date = row?.dimensions?.[1]?.id;
    if (!sku || (date !== period.today && date !== period.yesterday)) throw Error('Ozon basket SKU/day is invalid');
    const key = sku + ':' + date;
    if (seen.has(key)) throw Error('Ozon basket analytics duplicated a SKU/day');
    seen.add(key);
    const count = row?.metrics?.[0];
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0 || !Number.isInteger(count)) throw Error('Ozon basket count unavailable');
    const id = sourceMap.get(sku);
    // Zero-valued historical rows add no baskets to any product. Record their
    // missing identity explicitly; do not let them blank valid current data.
    if (id == null && count === 0) { ignoredZero.add(sku); continue; }
    if (id == null || !by_product[String(id)]) throw Error(`Ozon basket SKU mapping unavailable: ${sku}`);
    const day = date === period.today ? 'today' : 'yesterday';
    by_product[String(id)]![day] = (by_product[String(id)]![day] ?? 0) + count;
  }
  return { period, as_of: new Date(at).toISOString(), by_product,
    coverage: { metric: 'hits_tocart', analytics_rows: data.length, mapped_products: Object.keys(by_product).length,
      unmapped_products: productIds.filter(id => !mapped.has(id)), days_observed: [...days].sort(),
      source_timestamp: response.timestamp ?? response.result?.timestamp ?? null,
      resolved_source_skus: resolved, ignored_zero_unmapped_skus: [...ignoredZero] } };
}

export async function loadDailyBaskets(db: D1Database, request: RequestOzon, sourceMap: Map<string, number>, productIds: number[], at: number, expectedOffers?: Map<number, string>) {
  const saved = await db.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(BASKETS_KEY).first<{ value: string }>();
  let cached: BasketSnapshot | null = null;
  if (saved) { try { cached = JSON.parse(saved.value); } catch { /* invalid cache cannot become zero */ } }
  if (cached?.period.today !== basketDays(at).today) cached = null;
  if (cached && at - Date.parse(cached.as_of) < MIN_INTERVAL_MS) return { snapshot: cached, stale: false, error: undefined };
  // Atomic shared claim across the timer and interactive ERP refresh. Keep the
  // attempt timestamp even on failure so a 429 cannot become a retry loop.
  const claim = await db.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE crm_sync_state.updated_at <= ? RETURNING key`).bind(LEASE_KEY, String(at), at, at - MIN_INTERVAL_MS).first();
  if (!claim) return { snapshot: cached, stale: Boolean(cached), error: cached ? 'Показан последний успешный срез корзин' : 'Корзины обновляются; запрос ограничен Ozon' };
  try {
    const snapshot = await readDailyBaskets(request, sourceMap, productIds, at, expectedOffers);
    await db.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .bind(BASKETS_KEY, JSON.stringify(snapshot), at).run();
    return { snapshot, stale: false, error: undefined };
  } catch (e) {
    return { snapshot: cached, stale: Boolean(cached), error: e instanceof Error ? e.message : 'Ozon baskets unavailable' };
  }
}
