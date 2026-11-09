// Owner 2026-11-08 + Dasha's 24/26/30 October instructions: observe actual
// boosting, overlapping prices and lost support. No Ozon write endpoints.
import { readActionProducts } from '../../api/src/lib/ozon-actions';
import { loadDailyBaskets, BASKETS_KEY } from './baskets';

export const REPORT_KEY = 'ozon:promotion-monitor:latest';
type Env = { DB: D1Database; OZON_API_KEY?: string; OZON_CLIENT_ID?: string;
  OZON_SELLER_API_KEY?: string; OZON_SELLER_CLIENT_ID?: string };
export type RequestOzon = (path: string, body?: unknown) => Promise<any>;
const number = (v: unknown): number | null => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const positive = (v: unknown) => { const n = number(v); return n != null && n > 0 ? n : null; };
export function actionStatus(a: any, at: number) {
  const start = Date.parse(a.date_start), end = Date.parse(a.date_end);
  return !Number.isFinite(start) || !Number.isFinite(end) ? 'unknown' : at < start ? 'future' : at >= end ? 'ended' : 'active';
}
export function officialBoost(description: unknown): number | null {
  const text = String(description ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const matches = [...text.matchAll(/акционный бустинг в поиске и категории\s*[—–:\-]?\s*(\d+(?:[.,]\d+)?)\s*%/gi)];
  const levels = [...new Set(matches.map(m => Number(m[1]!.replace(',', '.'))))];
  return levels.length === 1 && levels[0]! > 0 && levels[0]! <= 100 ? levels[0]! : null;
}
export function summarizeBoost(memberships: any[]) {
  const current = memberships.filter(m => m.is_boost !== false && m.status === 'active');
  const active = current.filter(m => m.is_quarantined === false && m.alert_max_action_price_failed !== true);
  const measured = active.map(m => m.action_type === 'ELASTIC_BOOSTING' ? number(m.current_boost) : positive(m.official_boost) ?? positive(m.current_boost)).filter((n): n is number => n != null && n >= 0);
  // A zero in a non-elastic action does not establish no support. Never sum
  // percentages or infer a numeric boost from a title, discount or price.
  const value = measured.length ? Math.max(...measured) : null;
  const terms = active.some(m => m.action_type !== 'ELASTIC_BOOSTING' && positive(m.official_boost) != null);
  return { value, value_kind: terms ? 'terms' : value != null ? 'api' : 'unknown', status: active.length ? 'active' : current.length || memberships.some(m => m.status === 'unknown') ? 'unknown' : 'none',
    basis: value != null ? `Максимум уровней действующих акций: ${measured.join(', ')}%; ${terms ? 'включает заявленный % из официальных условий, не измеренный общий эффект' : 'товарный current_boost API'}; проценты не складываются` : active.length ? 'Участие подтверждено; фактический % API не подтвердил' : current.length ? 'Участие есть; применение поддержки не подтверждено из-за карантина, неизвестного статуса или ошибки цены' : 'Действующее участие в бустинге не найдено', memberships };
}
export async function readSameCutoffSales(request: RequestOzon, at: number) {
  // Armenia has UTC+4 throughout this comparison. Half-open windows use one
  // captured cutoff, not end-of-day aggregates or the time of response.
  const day = 86400000, todayStart = Math.floor((at + 4 * 3600000) / day) * day - 4 * 3600000;
  const yesterdayStart = todayStart - day, yesterdayEnd = at - day;
  const totals = new Map<string, { today: number; yesterday: number; cancelled_today: number; cancelled_yesterday: number; buyout_today: number; buyout_yesterday: number }>();
  const add = (posting: any, seen: Set<string>) => {
    const key = String(posting.posting_number ?? '');
    if (!key) throw Error('Ozon order has no posting number');
    if (seen.has(key)) throw Error('Ozon order pagination duplicated a posting');
    seen.add(key);
    if (typeof posting.status !== 'string' || !posting.status.trim()) throw Error('Ozon order status unavailable');
    const ts = Date.parse(posting.created_at || '');
    if (!Number.isFinite(ts)) throw Error('Ozon order timestamp unavailable');
    const period = ts >= todayStart && ts < at ? 'today' : ts >= yesterdayStart && ts < yesterdayEnd ? 'yesterday' : null;
    if (!period) return;
    if (!Array.isArray(posting.products)) throw Error('Ozon order products unavailable');
    for (const p of posting.products) {
      const sku = String(p.offer_id ?? '').trim().toLowerCase(), qty = number(p.quantity);
      if (!sku || qty == null || qty < 0) throw Error('Ozon order SKU/quantity unavailable');
      const row = totals.get(sku) ?? { today: 0, yesterday: 0, cancelled_today: 0, cancelled_yesterday: 0, buyout_today: 0, buyout_yesterday: 0 };
      const field: keyof typeof row = posting.status === 'cancelled' ? `cancelled_${period}` : posting.is_marketplace_buyout === true ? `buyout_${period}` : period;
      row[field] += qty;
      totals.set(sku, row);
    }
  };
  const filter = { since: new Date(yesterdayStart).toISOString(), to: new Date(at).toISOString() };
  let cursor = '', fboComplete = false;
  const cursors = new Set(['']), fboSeen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const data = await request('/v3/posting/fbo/list', { dir: 'ASC', filter, limit: 100, cursor, with: { analytics_data: false, financial_data: false } });
    if (!Array.isArray(data.postings) || typeof data.has_next !== 'boolean') throw Error('Invalid Ozon FBO order response');
    data.postings.forEach((p: any) => add(p, fboSeen));
    if (!data.has_next) { fboComplete = true; break; }
    if (!data.cursor || cursors.has(data.cursor)) throw Error('Incomplete Ozon FBO pagination');
    cursor = data.cursor; cursors.add(cursor);
  }
  if (!fboComplete) throw Error('Incomplete Ozon FBO orders');
  let fbsCursor = '', fbsComplete = false;
  const fbsCursors = new Set(['']);
  const fbsSeen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const data = await request('/v4/posting/fbs/list', { dir: 'ASC', filter, limit: 100, cursor: fbsCursor, with: { analytics_data: false, financial_data: false } });
    if (!Array.isArray(data?.postings) || typeof data.has_next !== 'boolean') throw Error('Invalid Ozon FBS order response');
    data.postings.forEach((p: any) => add(p, fbsSeen));
    if (!data.has_next) { fbsComplete = true; break; }
    if (!data.cursor || fbsCursors.has(data.cursor)) throw Error('Incomplete Ozon FBS pagination');
    fbsCursor = data.cursor; fbsCursors.add(fbsCursor);
  }
  if (!fbsComplete) throw Error('Incomplete Ozon FBS orders');
  return { totals, coverage: { fbo_postings: fboSeen.size, fbs_postings: fbsSeen.size, today_start: new Date(todayStart).toISOString(), yesterday_start: new Date(yesterdayStart).toISOString(), yesterday_cutoff: new Date(yesterdayEnd).toISOString(), basis: 'Заказанные единицы FBO + FBS по времени создания; отмены отдельно' } };
}

export async function runPromotionMonitor(env: Env, requestOverride?: RequestOzon) {
  const at = Date.now(), snapshot_at = new Date(at).toISOString();
  const request: RequestOzon = requestOverride ?? (async (path, body) => {
    // An explicit read allowlist also protects this read-only monitor if an old
    // mutable config from promozon_db is still present.
    if (!['/v1/actions', '/v2/actions/products', '/v2/actions/candidates', '/v3/product/info/list', '/v5/product/info/prices', '/v3/posting/fbo/list', '/v4/posting/fbs/list', '/v1/analytics/data'].includes(path)) throw Error('Ozon monitor read endpoint not allowed');
    const key = env.OZON_API_KEY || env.OZON_SELLER_API_KEY, client = env.OZON_CLIENT_ID || env.OZON_SELLER_CLIENT_ID;
    if (!key || !client) throw Error('Ozon monitor credentials unavailable');
    const r = await fetch('https://api-seller.ozon.ru' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Client-Id': client, 'Api-Key': key, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw Error(`Ozon read ${path}: HTTP ${r.status}`);
    return r.json();
  });
  const previousRow = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(REPORT_KEY).first<{ value: string }>();
  let previous: any = null;
  if (previousRow) { try { previous = JSON.parse(previousRow.value); } catch { /* no baseline comparison */ } }
  const catalog = new Map<number, any>();
  let cursor = '', catalogComplete = false;
  const cursors = new Set(['']);
  for (let page = 0; page < 100; page++) {
    const data = await request('/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 1000, cursor });
    if (!Array.isArray(data.items)) throw Error('Ozon product catalog unavailable');
    for (const p of data.items) {
      if (!p.product_id || !p.offer_id) throw Error('Ozon product identity unavailable');
      catalog.set(Number(p.product_id), { product_id: Number(p.product_id), offer_id: p.offer_id, name: p.name || p.offer_id,
        seller_price: positive(p.price?.marketing_seller_price), base_price: positive(p.price?.price), min_price: positive(p.price?.min_price), currency: p.price?.currency_code ?? null,
        strategies: p.price_strategy_enabled ?? null, marketing_actions: p.marketing_actions ?? null, memberships: [], issues: [] });
    }
    if (!data.cursor) { if (typeof data.total === 'number' && catalog.size < data.total) throw Error('Ozon catalog truncated'); catalogComplete = true; break; }
    if (cursors.has(data.cursor)) throw Error('Ozon catalog pagination repeated');
    cursor = data.cursor; cursors.add(cursor);
  }
  if (!catalogComplete) throw Error('Ozon product catalog incomplete');
  const ids = [...catalog.keys()];
  const sourceMap = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 1000) {
    const info = await request('/v3/product/info/list', { product_id: ids.slice(i, i + 1000).map(String) });
    if (!Array.isArray(info.items)) throw Error('Ozon product names unavailable');
    for (const p of info.items) if (catalog.has(Number(p.id))) {
      const id = Number(p.id);
      catalog.get(id).name = p.name || catalog.get(id).offer_id;
      for (const source of p.sources ?? []) {
        const sku = String(source.sku ?? '');
        if (!/^\d+$/.test(sku) || Number(sku) <= 0) throw Error('Ozon product source SKU unavailable');
        if (sourceMap.has(sku) && sourceMap.get(sku) !== id) throw Error('Ozon product source SKU mapping conflicts');
        sourceMap.set(sku, id);
      }
    }
  }
  const actionsData = await request('/v1/actions');
  if (!Array.isArray(actionsData.result)) throw Error('Ozon action list unavailable');
  for (const a of actionsData.result) {
    const status = actionStatus(a, at);
    if (status === 'ended') continue;
    const products = await readActionProducts((path, body) => request(path, body), Number(a.id));
    for (const p of products as any[]) {
      const row = catalog.get(p.id);
      if (!row) throw Error('Promotion member missing from full catalog');
      row.memberships.push({ action_id: a.id, title: a.title, status, date_start: a.date_start, date_end: a.date_end,
        official_boost: officialBoost(a.description), is_boost: String(a.action_type ?? '').includes('BOOST') || /бустинг/i.test(a.title ?? '') || officialBoost(a.description) != null,
        action_type: a.action_type, funding: a.funding ?? a.funding_type ?? null, action_price: number(p.action_price),
        current_boost: number(p.current_boost), min_boost: number(p.min_boost), max_boost: number(p.max_boost),
        price_min_elastic: number(p.price_min_elastic), price_max_elastic: number(p.price_max_elastic),
        is_quarantined: p.is_quarantined ?? null, add_mode: p.add_mode ?? null, alert_max_action_price_failed: p.alert_max_action_price_failed ?? null });
    }
  }
  let sales: Awaited<ReturnType<typeof readSameCutoffSales>> | null = null, sales_error: string | undefined;
  try { sales = await readSameCutoffSales(request, at); } catch (e) { sales_error = e instanceof Error ? e.message : 'Ozon sales unavailable'; }
  const baskets = await loadDailyBaskets(env.DB, request, sourceMap, ids, Date.now());
  const rows = [...catalog.values()].map(row => {
    const boost = summarizeBoost(row.memberships), active = row.memberships.filter((m: any) => m.status === 'active' && !m.is_quarantined);
    if (row.memberships.some((m: any) => m.is_quarantined)) row.issues.push('Карантин в акции');
    if (row.memberships.some((m: any) => m.alert_max_action_price_failed)) row.issues.push('Ozon сообщил о несоответствии цены акции');
    if (row.seller_price != null && row.min_price != null && row.seller_price < row.min_price) row.issues.push('Цена продавца ниже min_price; требуется проверка действующего исключения');
    const prices = active.map((m: any) => positive(m.action_price)).filter((n: number | null) => n != null);
    if (new Set(prices).size > 1) row.issues.push('Разные цены в пересекающихся акциях; финансирование и влияние требуют проверки');
    const prev = previous?.rows?.find((p: any) => p.product_id === row.product_id);
    for (const old of prev?.boost?.memberships ?? []) {
      if (old.status === 'active' && !old.is_quarantined && !active.some((m: any) => m.action_id === old.action_id)) row.issues.push(`Потеря участия / окончание акции ${old.action_id}`);
    }
    if (boost.value != null && prev?.boost?.value != null && boost.value < prev.boost.value) row.issues.push(`Снижение подтверждённого бустинга: ${prev.boost.value}% → ${boost.value}%`);
    const s = sales?.totals.get(String(row.offer_id).trim().toLowerCase());
    const today_units = sales ? s?.today ?? 0 : null, yesterday_units = sales ? s?.yesterday ?? 0 : null;
    const delta_units = today_units != null && yesterday_units != null ? today_units - yesterday_units : null;
    const basket = baskets.snapshot?.by_product[String(row.product_id)];
    const { memberships: _, ...rest } = row;
    return { ...rest, boost, today_units, yesterday_units, delta_units, delta_pct: yesterday_units && delta_units != null ? delta_units / yesterday_units * 100 : null,
      today_baskets: basket?.today ?? null, yesterday_baskets: basket?.yesterday ?? null,
      delta_baskets_pct: basket?.today != null && basket.yesterday != null && basket.yesterday > 0 ? (basket.today - basket.yesterday) / basket.yesterday * 100 : null,
      cancelled_today: sales ? s?.cancelled_today ?? 0 : null, cancelled_yesterday: sales ? s?.cancelled_yesterday ?? 0 : null,
      buyout_today: sales ? s?.buyout_today ?? 0 : null, buyout_yesterday: sales ? s?.buyout_yesterday ?? 0 : null };
  });
  // Missing prices/order IDs may not silently vanish from the all-SKU table.
  if (sales) for (const sku of sales.totals.keys()) if (!rows.some(r => String(r.offer_id).trim().toLowerCase() === sku)) throw Error('Ordered SKU missing from Ozon catalog');
  const report = { snapshot_at, sales_as_of: snapshot_at, timezone: 'Asia/Yerevan', cutoff: new Date(at + 4 * 3600000).toISOString().slice(11, 16),
    baskets_available: Boolean(baskets.snapshot), baskets_as_of: baskets.snapshot?.as_of ?? null,
    baskets_period: baskets.snapshot?.period ?? null, baskets_stale: baskets.stale, baskets_error: baskets.error,
    baskets_basis: 'Добавления в корзину за сутки МСК: сегодня неполный день, вчера полный; не сравнение за одинаковые часы',
    sales_available: sales !== null, sales_scope: 'FBO + FBS', sales_error, rows, coverage: { products: rows.length, actions: actionsData.result.length,
      baskets: baskets.snapshot?.coverage ?? null, basket_storage_key: BASKETS_KEY,
      prior_snapshot_at: previous?.snapshot_at ?? null, orders: sales?.coverage ?? null,
      gaps: ['Проценты неэластичных акций без current_boost не установлены', 'Стратегии, скидки от количества и персональные разрешённые минимумы требуют предметной проверки'],
      mode: 'read_only', actions_taken: 0 } };
  await env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(REPORT_KEY, JSON.stringify(report), at).run();
  return report;
}
