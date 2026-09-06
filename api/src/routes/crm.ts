import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { withKvCacheStale, cacheKey } from '../lib/kv-cache';
import { normalizePhone, tierFor } from '../lib/loyalty';

// Ключ покупателя обезличенной ленты .ru — 12 hex-знаков sha256(соль+телефон).
// До 31.08.2026 он прогонялся через normalizePhone, терял буквы и превращался в
// «+4665692987»: назад его было не вернуть, кнопка показа по ключу была невозможна.
// Ключ хранится целым; настоящий телефон нормализуется как раньше.
const KEY_RE = /^[0-9a-f]{12}$/i;
function custKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  return KEY_RE.test(t) ? t.toLowerCase() : normalizePhone(t);
}
import { fetchStorefrontOrders, syncRuOrders, readSyncState, RU_SYNC_STALE_AFTER_SEC } from '../lib/crm-orders-sync';

const crm = new Hono<{ Bindings: Env }>();

// =============================================================================
// Phase 11 (2026-06-20): CRM dashboard source migrated RetailCRM -> Yandex KIT
// (orders = source of truth) + D1 loyalty ledger. RetailCRM removed from every
// read endpoint (/stats /funnel /timeline /customers). Response shapes preserved
// so web/app/crm/page.tsx renders unchanged; extra KIT-derived fields are
// additive (old UI ignores them, new widgets can use them).
//
// All four read endpoints derive from ONE cached KIT orders aggregate
// (getKitAggregate, TTL 300s): a page load triggers a single full KIT pull,
// not four. KIT exposes raw orders only, so the analytics are computed here.
// =============================================================================

const KIT_BASE = 'https://api.kit.yandex.net/v1';
// A KIT order is a realised sale when it is paid AND in a fulfilment status.
const PAID_STATUSES = new Set(['PAYMENT_FINALLY_PAID', 'PAYMENT_PAID']);
const SALE_STATUSES = new Set(['COMPLETED', 'WAIT_FOR_DELIVERY']);

interface KitOrder {
  id?: string;
  order_number?: number | string;
  status?: string;
  created_at?: string;
  total_final_price?: string;
  purchased_price?: string;
  total_price?: string;
  payment?: { status?: string; method?: string };
  client?: { phone?: string; email?: string; first_name?: string; last_name?: string };
  delivery_chunks?: Array<{ items?: Array<{ quantity?: number }> }>;
  delivery_rub?: number | string;
}

interface CustomerAgg {
  phone: string;
  name: string;
  email: string | null;
  orders_count: number;
  sales_count: number;
  total_spent: number;
  // Товары без доставки — по правилам клуба уровень считается именно от них
  // («₽ товаров без доставки», lib/loyalty.ts). total_spent доставку включает
  // и для уровня не годится: он завысил бы верхнего покупателя на её сумму.
  goods_spent: number;
  last_order: string;
}

interface KitAggregate {
  orders_total: number;
  sales_count: number;
  cancelled_count: number;
  revenue_total: number;
  units_total: number;
  customers_total: number;
  buyers_count: number;
  repeat_buyers: number;
  orders_this_month: number;
  revenue_this_month: number;
  monthly: Array<{ month: string; orders: number; sales: number; revenue: number }>;
  daily30: Array<{ date: string; orders: number }>;
  customers: CustomerAgg[];
}

/** Loyalty tier labels, RU. Module level: used by both the paged and ranked paths. */
const TIER_LABEL_RU: Record<string, string> = {
  svoy: 'Свой', tsenitel: 'Ценитель', expert: 'Эксперт', ambassador: 'Амбассадор',
};

/** KIT/витрина status → kebab-case, the shape the UI expects. */
const statusKebab = (st: string) => st.toLowerCase().replace(/_/g, '-');

function rub(v: string | undefined): number {
  const n = parseFloat(v ?? '0');
  return Number.isFinite(n) ? n : 0;
}

async function fetchKitOrdersPage(env: Env, page: number, perPage = 100) {
  const url = new URL(`${KIT_BASE}/orders`);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${env.YANDEX_KIT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`KIT API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as { total_count?: number; orders?: KitOrder[] };
}

/**
 * Заказы русской витрины. Источник — сама витрина dasexperten.ru, не Яндекс КИТ.
 *
 * Почему сменили источник (2026-08-21, распоряжение Владельца):
 *  1. КИТ отдавал 429 на каждой второй загрузке — экран показывал колесо вместо
 *     заказов, потому что одна загрузка тянула девятнадцать страниц чужого API.
 *  2. В ответе КИТ приходят фамилии, телефоны и почты россиян, и экран показывал
 *     их в системе за пределами России — трансграничная передача без уведомления
 *     по ст.12 152-ФЗ.
 *
 * Витрина отдаёт те же поля ОБЕЗЛИЧЕННЫМИ: вместо имени — номер заказа, вместо
 * телефона — необратимый ключ (SHA-256 с солью), почты нет вовсе. Повторные
 * покупки считаются, человек не восстанавливается.
 *
 * Форма ответа совпадает с формой КИТ, поэтому ниже по течению не переписано
 * ничего. Имена и телефоны вернутся отдельным запросом по кнопке — после
 * уведомления по ст.12, с записью в журнал.
 */
// Лента витрины и её кэш живут в lib/crm-orders-sync.ts (слой 3, 29.08) —
// одна копия кода на экран и на синхронизатор.
// Прежний путь через КИТ оставлен как запасной: витрина и площадка новые,
// и если они лягут, экран должен показать хоть что-то, а не пустоту.
async function fetchAllKitOrders(env: Env): Promise<{ total: number; orders: KitOrder[] }> {
  // Слой 3 (29.08.2026): статистика, клиенты и график дня считаются по этому
  // списку. Если зеркало живо — список из D1 (raw_json = позиция ленты как
  // пришла), ни одного вызова наружу; Владелец видел спиннер статистики на
  // холодном кэше, когда лента в 1.4 МБ качалась заново. Флаг
  // CRM_ORDERS_SOURCE=feed возвращает прежний путь.
  if ((env.CRM_ORDERS_SOURCE ?? 'd1') !== 'feed') {
    try {
      const state = await readSyncState(env);
      if (Number(state['ru_orders:last_ok_at'] ?? 0) > 0) {
        const rows = await env.DB.prepare('SELECT raw_json FROM crm_orders_ru ORDER BY created_at DESC').all<{ raw_json: string }>();
        const orders = (rows.results ?? []).map((r) => JSON.parse(r.raw_json) as KitOrder);
        if (orders.length) return { total: orders.length, orders };
      }
    } catch (e) {
      console.warn('[crm] зеркало D1 не ответило, падаю на ленту:', String(e));
    }
  }
  if (env.RU_FEED_TOKEN) {
    try {
      const f = await fetchStorefrontOrders(env);
      return { total: f.total, orders: f.orders as unknown as KitOrder[] };
    } catch (e) {
      console.warn('витрина .ru недоступна, падаю обратно на КИТ:', String(e));
    }
  }
  const first = await fetchKitOrdersPage(env, 1, 100);
  const total = first.total_count ?? (first.orders?.length ?? 0);
  let orders = first.orders ?? [];
  const pageCount = Math.min(40, Math.ceil(total / 100)); // hard cap 4000 orders
  const rest: number[] = [];
  for (let p = 2; p <= pageCount; p++) rest.push(p);
  // Controlled concurrency (chunks of 6) — stays under KIT's 10 req/s limit.
  for (let i = 0; i < rest.length; i += 6) {
    const chunk = rest.slice(i, i + 6);
    const pages = await Promise.all(chunk.map((p) => fetchKitOrdersPage(env, p, 100)));
    for (const pg of pages) orders = orders.concat(pg.orders ?? []);
  }
  return { total, orders };
}

function buildAggregate(total: number, orders: KitOrder[]): KitAggregate {
  const nowMonth = new Date().toISOString().slice(0, 7);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dayKeys: string[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const ordersByDay = new Map<string, number>(dayKeys.map((k) => [k, 0]));
  const monthly = new Map<string, { orders: number; sales: number; revenue: number }>();
  const allPhones = new Set<string>();
  const salesByPhone = new Map<string, number>();
  const custMap = new Map<string, CustomerAgg>();

  let salesCount = 0, cancelled = 0, revenueTotal = 0, units = 0;
  let ordersThisMonth = 0, revenueThisMonth = 0;

  for (const o of orders) {
    const created = o.created_at ?? '';
    const month = created.slice(0, 7);
    const day = created.slice(0, 10);
    const isSale = SALE_STATUSES.has(o.status ?? '') && PAID_STATUSES.has(o.payment?.status ?? '');
    const isCancelled = (o.status ?? '') === 'CANCELLED';
    const net = Math.round(rub(o.total_final_price ?? o.purchased_price));
    const phone = custKey(o.client?.phone);

    if (isCancelled) cancelled += 1;

    const m = monthly.get(month) ?? { orders: 0, sales: 0, revenue: 0 };
    m.orders += 1;
    if (isSale) { m.sales += 1; m.revenue += net; }
    monthly.set(month, m);

    if (ordersByDay.has(day)) ordersByDay.set(day, (ordersByDay.get(day) ?? 0) + 1);

    if (month === nowMonth) {
      ordersThisMonth += 1;
      if (isSale) revenueThisMonth += net;
    }

    if (isSale) {
      salesCount += 1;
      revenueTotal += net;
      for (const ch of o.delivery_chunks ?? []) {
        for (const it of ch.items ?? []) units += Number(it.quantity ?? 0);
      }
    }

    if (phone) {
      allPhones.add(phone);
      if (isSale) salesByPhone.set(phone, (salesByPhone.get(phone) ?? 0) + 1);
      const name =
        [o.client?.first_name, o.client?.last_name].filter(Boolean).join(' ') ||
        o.client?.email || '—';
      const cu = custMap.get(phone) ?? {
        phone, name, email: o.client?.email ?? null,
        orders_count: 0, sales_count: 0, total_spent: 0, goods_spent: 0, last_order: created,
      };
      cu.orders_count += 1;
      if (isSale) {
        cu.sales_count += 1;
        cu.total_spent += net;
        cu.goods_spent += Math.max(0, net - Math.round(Number(o.delivery_rub ?? 0) || 0));
      }
      if (created > cu.last_order) cu.last_order = created;
      if (cu.name === '—' && name !== '—') cu.name = name;
      custMap.set(phone, cu);
    }
  }

  let repeat = 0;
  for (const n of salesByPhone.values()) if (n >= 2) repeat += 1;

  const monthlyArr = Array.from(monthly.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, orders: v.orders, sales: v.sales, revenue: v.revenue }));
  const customers = Array.from(custMap.values()).sort((a, b) => b.total_spent - a.total_spent);

  return {
    orders_total: total,
    sales_count: salesCount,
    cancelled_count: cancelled,
    revenue_total: revenueTotal,
    units_total: units,
    customers_total: allPhones.size,
    buyers_count: salesByPhone.size,
    repeat_buyers: repeat,
    orders_this_month: ordersThisMonth,
    revenue_this_month: revenueThisMonth,
    monthly: monthlyArr,
    daily30: dayKeys.map((date) => ({ date, orders: ordersByDay.get(date) ?? 0 })),
    customers,
  };
}

// v3 — обёртка сменилась на stale-tolerant, конверт другой, старый кэш недействителен.
// v4 (02.09.2026) — в строке покупателя появилось goods_spent; на старом конверте
// его нет, и уровень посчитался бы от нуля. Ключ сменён, кэш пересчитается сам.
const KIT_AGG_KEY = cacheKey('crm:kit-agg', { v: 4 });
const KIT_AGG_TTL_SEC = 20 * 60;   // крон греет каждые 15 минут — запас 5 минут

async function getKitAggregate(env: Env) {
  return withKvCacheStale(env, KIT_AGG_KEY, KIT_AGG_TTL_SEC, async () => {
    const { total, orders } = await fetchAllKitOrders(env);
    return buildAggregate(total, orders);
  });
}

/**
 * Прогрев агрегата статистики/клиентов/графика — вызывается кроном сразу
 * после синка зеркала (слой 3, 29.08.2026). Холодный расчёт (~2.5 с по D1)
 * делает машина раз в 15 минут, а не тот, кто открыл экран. Пишет в KV в том
 * же конверте {at, data}, что withKvCacheStale, поэтому чтение не меняется.
 */
export async function warmKitAggregate(env: Env): Promise<{ orders: number; ms: number }> {
  const t0 = Date.now();
  const { total, orders } = await fetchAllKitOrders(env);
  const data = buildAggregate(total, orders);
  const envelope = JSON.stringify({ at: Math.floor(Date.now() / 1000), data });
  await env.CACHE.put(KIT_AGG_KEY, envelope, { expirationTtl: KIT_AGG_TTL_SEC });
  await env.CACHE.put(`${KIT_AGG_KEY}|lastgood`, envelope, { expirationTtl: 7 * 24 * 3600 });
  return { orders: orders.length, ms: Date.now() - t0 };
}

/**
 * Весь список заказов витрины .ru, размеченный в форму строки таблицы.
 *
 * Раньше этим занимался обход тридцати страниц Яндекс.КИТ — он давал 429 на
 * каждой сортировке, и колонки в шапке были мертвы. Источник тот же, что у
 * постраничного пути: fetchAllKitOrders сначала пробует витрину и падает на
 * КИТ только если витрина легла.
 */
async function buildRuOrderRows(env: Env): Promise<any[]> {
  const { orders: all } = await fetchAllKitOrders(env);

  const accByPhone = new Map<string, any>();
  {
    const rows = await env.DB.prepare(
      'SELECT phone, balance, pending_balance, tier, lifetime_spent FROM loyalty_accounts'
    ).all<any>();
    for (const r of rows.results ?? []) accByPhone.set(r.phone, r);
  }
  const accrualByOrder = new Map<string, any>();
  {
    const rows = await env.DB.prepare(
      "SELECT kit_order_id, points, status FROM loyalty_transactions WHERE type = 'accrual'"
    ).all<any>();
    for (const r of rows.results ?? []) accrualByOrder.set(r.kit_order_id, r);
  }

  return all.map((o: any) => {
    const phone = normalizePhone(o?.client?.phone);
    const acc = phone ? accByPhone.get(phone) : undefined;
    const accrual = accrualByOrder.get(o.id);
    let charged = 0;
    let itemsCount = 0;
    // Состав читаем тем же ruItems, что и на пути зеркала: одно правило чтения
    // позиции, чтобы запасной путь не показывал заказ иначе, чем основной.
    const itemLines = ruItems(JSON.stringify(o)).filter((it) => it.sku || it.name);
    for (const chunk of o.delivery_chunks ?? []) {
      for (const it of chunk.items ?? []) {
        charged +=
          Math.round(parseFloat(it.promocode_discount ?? '0')) +
          Math.round(parseFloat(it.loyalty_discount ?? '0')) +
          Math.round(parseFloat(it.gift_card_discount ?? '0'));
        itemsCount += Number(it.quantity ?? 0) || 0;
      }
    }
    const tierInfo = acc ? tierFor(acc.lifetime_spent) : null;
    return {
      id: o.order_number,
      number: String(o.order_number ?? ''),
      customer_name:
        [o.client?.first_name, o.client?.last_name].filter(Boolean).join(' ') ||
        o.client?.email || '—',
      total: Math.round(parseFloat(o.total_final_price ?? o.purchased_price ?? '0')),
      status: statusKebab(o.status ?? '—'),
      created_at: o.created_at ?? '—',
      items_count: itemsCount,
      items: itemLines,
      bonus_credited: accrual ? accrual.points : 0,
      bonus_credited_status: accrual ? accrual.status : null,
      bonus_charged: charged,
      loyalty_balance: acc ? acc.balance : null,
      loyalty_pending: acc ? acc.pending_balance : null,
      loyalty_level: acc ? (TIER_LABEL_RU[acc.tier] ?? acc.tier) : null,
      loyalty_privilege_pct: tierInfo ? tierInfo.percent : null,
    };
  });
}

async function loyaltyMemberCount(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM loyalty_accounts').first<{ c: number }>();
  return row?.c ?? 0;
}

crm.get('/stats', async (c) => {
  if (!c.env.YANDEX_KIT_TOKEN) {
    return fail(c, 503, [{ code: 'kit_not_configured', message: 'YANDEX_KIT_TOKEN missing.' }]);
  }
  try {
    const [aggWrap, loyaltyMembers] = await Promise.all([
      getKitAggregate(c.env),
      loyaltyMemberCount(c.env),
    ]);
    const agg = aggWrap.data;
    return ok(c, {
      source: 'dasexperten.ru (обезличено) + d1:loyalty',
      stale: aggWrap.stale,
      data_as_of: aggWrap.produced_at,
      customers_total: agg.customers_total,
      orders_total: agg.orders_total,
      orders_this_month: agg.orders_this_month,
      revenue_this_month_rub: agg.revenue_this_month,
      loyalty_members_total: loyaltyMembers,
      // --- additive KIT analytics (ignored by old UI, ready for new widgets) ---
      sales_total: agg.sales_count,
      revenue_total_rub: agg.revenue_total,
      aov_rub: agg.sales_count ? Math.round(agg.revenue_total / agg.sales_count) : 0,
      units_total: agg.units_total,
      cancelled_total: agg.cancelled_count,
      cancel_rate_pct: agg.orders_total
        ? Math.round((agg.cancelled_count / agg.orders_total) * 1000) / 10
        : 0,
      monthly: agg.monthly,
      synced_at: Math.floor(Date.now() / 1000),
    }, aggWrap.stale ? ['stale'] : []);
  } catch (e) {
    // Наружу — человеческая строка; техническая причина уезжает в details,
    // потому что раньше сырой текст исключения печатался Владельцу на экран.
    return fail(c, 502, [{
      code: 'orders_feed_unavailable',
      message: 'Витрина .ru не ответила, и сохранённой копии нет.',
      details: { reason: e instanceof Error ? e.message : String(e) },
    }]);
  }
});

// Ручной запуск синка зеркала .ru → D1 (слой 3). Тот же секрет, что у
// checkout-воркера (X-Ingest-Secret = INGEST_SECRET / BACKFILL_SECRET).
// Крон вызывает syncRuOrders напрямую из scheduled.ts; эта ручка — для рук.
crm.post('/sync-ru-orders', async (c) => {
  const h = c.req.header('X-Ingest-Secret');
  const okSecret = Boolean(h) && (h === c.env.INGEST_SECRET || h === c.env.BACKFILL_SECRET);
  if (!okSecret) return fail(c, 403, [{ code: 'forbidden', message: 'X-Ingest-Secret required.' }]);
  const report = await syncRuOrders(c.env);
  const state = await readSyncState(c.env);
  return ok(c, { report, state }, [report.ok ? 'Синк зеркала .ru выполнен' : 'Синк зеркала .ru не выполнен']);
});

crm.get('/sync-ru-orders/state', async (c) => {
  const state = await readSyncState(c.env);
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n, MAX(synced_at) AS last FROM crm_orders_ru').first<{ n: number; last: number | null }>();
  return ok(c, { state, mirror_rows: row?.n ?? 0, mirror_last_synced_at: row?.last ?? null });
});

// -----------------------------------------------------------------------------
// Экран Orders из зеркала. Форма строки — та же, что у пути через ленту
// (web/app/crm/page.tsx без правок), плюс поля оплаты/доставки для файла 5.
// -----------------------------------------------------------------------------
type MirrorRow = {
  order_number: string; storefront_id: string | null; status: string; storefront_status: string | null;
  created_at: string; paid: number; paid_at: string | null; total_rub: number; loyalty_rub: number;
  customer_key: string | null; delivery_status: string | null; delivery_order_id: string | null;
  tracking_number: string | null; delivery_provider: string | null; raw_json: string | null;
  delivery_substatus: string | null; delivery_parts_total: number;
  delivery_parts_at_point: number; delivery_parts_received: number;
};

/**
 * Состав заказа .ru из сырой строки ленты.
 *
 * Владелец 02.09.2026 просил названия товаров, как на английском экране.
 * Лента витрины их не отдаёт: в delivery_chunks[].items[] лежит одно
 * quantity — ни артикула, ни названия (перепроверено по всем 1850 строкам
 * зеркала: sku 0, name 0, title 0, offer 0, product 0, article 0). Выдумать
 * состав из числа штук нельзя, и ERP тут ничего не решает — строку должна
 * начать отдавать сама витрина, dasexperten.ru/api/erp/orders.php.
 *
 * Поэтому читаем состав наперёд: как только витрина положит в позицию имя
 * и артикул, экран покажет их сам, без новой выкатки. Ждём такую позицию:
 *   { "sku": "DE-TB-01", "name": "Зубная паста …", "quantity": 2 }
 * Синонимы приняты ради живучести: article вместо sku, title вместо name.
 * Ничего не подставляем: нет поля — нет и значения.
 */
type RuItem = { sku: string | null; name: string | null; qty: number };

type RuStockFact = {
  sku: string;
  our_stock: number;
  assembleable: number;
  our_stock_at: number | null;
  in_transit: number;
  in_transit_at: number | null;
  ozon_available: number | null;
  ozon_stock_at: number | null;
  supply_qty: number;
  supply_stage: string | null;
  supply_eta: number | null;
  supply_updated_at: number | null;
};

function ruItems(raw: string | null | undefined): RuItem[] {
  if (!raw) return [];
  try {
    const o = JSON.parse(raw) as {
      delivery_chunks?: Array<{ items?: Array<Record<string, unknown>> }>;
    };
    const out: RuItem[] = [];
    for (const ch of o.delivery_chunks ?? []) {
      for (const it of ch.items ?? []) {
        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        out.push({
          sku: str(it.sku) ?? str(it.article),
          name: str(it.name) ?? str(it.title),
          qty: Number(it.quantity ?? 0) || 0,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Штук в заказе — сумма количеств по позициям. */
function ruItemsCount(raw: string | null | undefined): number {
  return ruItems(raw).reduce((n, it) => n + it.qty, 0);
}

/**
 * Живой ответ Зины + Даши для позиций оплаченного заказа без отправления.
 *
 * Зина: склад РФ, сборка мультипака из одиночного SKU, товар в пути и активная
 * операция поставки. Даша: свежий остаток конкретного offer_id внутри Ozon.
 * Никаких обещаний из одного флага "in_transit": срок показывается только
 * когда у активной операции есть lead_time_days и расчётная дата ещё впереди.
 */
async function ruStockFacts(env: Env, itemGroups: RuItem[][]): Promise<Map<string, RuStockFact>> {
  const skus = Array.from(new Set(itemGroups.flatMap((items) => items)
    .map((it) => String(it.sku ?? '').trim().toLowerCase()).filter(Boolean)));
  const out = new Map<string, RuStockFact>();
  if (!skus.length) return out;

  const marks = skus.map(() => '?').join(',');
  const now = Math.floor(Date.now() / 1000);
  const [stockRes, ozonRes, supplyRes] = await Promise.all([
    env.DB.prepare(`
      SELECT lower(p.id) AS sku,
        COALESCE((SELECT SUM(MAX(s.on_hand, 0))
                  FROM stocks s JOIN warehouses w ON w.id = s.warehouse_id
                  WHERE s.product_id = p.id AND s.stock_state = 'on_hand'
                    AND lower(COALESCE(w.country, '')) = 'russia'
                    AND s.warehouse_id NOT IN ('ozon','wb')), 0) AS our_stock,
        COALESCE((SELECT SUM(MAX(s.on_hand, 0))
                  FROM stocks s JOIN warehouses w ON w.id = s.warehouse_id
                  WHERE s.product_id = p.base_sku AND s.stock_state = 'on_hand'
                    AND lower(COALESCE(w.country, '')) = 'russia'
                    AND s.warehouse_id NOT IN ('ozon','wb')), 0) AS base_stock,
        MAX(1, COALESCE(p.bundle_size, 1)) AS bundle_size,
        (SELECT MAX(s.updated_at) FROM stocks s JOIN warehouses w ON w.id = s.warehouse_id
         WHERE (s.product_id = p.id OR s.product_id = p.base_sku)
           AND s.stock_state = 'on_hand' AND lower(COALESCE(w.country, '')) = 'russia'
           AND s.warehouse_id NOT IN ('ozon','wb')) AS our_stock_at,
        COALESCE((SELECT SUM(MAX(s.on_hand, 0)) FROM stocks s
                  WHERE s.product_id = p.id AND s.stock_state = 'in_transit'), 0) AS in_transit_exact,
        COALESCE((SELECT SUM(MAX(s.on_hand, 0)) FROM stocks s
                  WHERE s.product_id = p.base_sku AND s.stock_state = 'in_transit'), 0) AS base_in_transit,
        COALESCE((SELECT SUM(MAX(s.on_hand, 0)) FROM stocks s
                  WHERE s.product_id = p.id AND s.stock_state = 'in_production'), 0) AS in_production_exact,
        COALESCE((SELECT SUM(MAX(s.on_hand, 0)) FROM stocks s
                  WHERE s.product_id = p.base_sku AND s.stock_state = 'in_production'), 0) AS base_in_production,
        (SELECT MAX(s.updated_at) FROM stocks s
         WHERE (s.product_id = p.id OR s.product_id = p.base_sku)
           AND s.stock_state = 'in_transit') AS in_transit_at
      FROM products p WHERE lower(p.id) IN (${marks})
    `).bind(...skus).all<any>(),
    env.DB.prepare(`
      SELECT lower(offer_id) AS sku,
             MAX(0, fbo_available - fbo_reserved) AS ozon_available,
             synced_at AS ozon_stock_at
      FROM marketplace_stocks_ozon WHERE lower(offer_id) IN (${marks})
    `).bind(...skus).all<any>(),
    env.DB.prepare(`
      SELECT lower(p.id) AS sku,
             GROUP_CONCAT(DISTINCT o.status) AS supply_stage,
             MIN(CASE WHEN o.lead_time_days > 0
                           AND o.operation_date + o.lead_time_days * 86400 >= ?
                      THEN o.operation_date + o.lead_time_days * 86400 END) AS supply_eta,
             MAX(o.updated_at) AS supply_updated_at
      FROM products p
      JOIN line_items li ON lower(li.product_id) = lower(p.id)
                         OR (p.base_sku IS NOT NULL AND lower(li.product_id) = lower(p.base_sku))
      JOIN operations o ON o.id = li.operation_id
      WHERE lower(p.id) IN (${marks}) AND o.deleted_at IS NULL
        AND o.operation_type IN ('purchase','transfer')
        AND o.status IN ('production','stocked','shipped')
      GROUP BY lower(p.id)
    `).bind(now, ...skus).all<any>(),
  ]);

  const ozon = new Map((ozonRes.results ?? []).map((r: any) => [String(r.sku), r]));
  const supply = new Map((supplyRes.results ?? []).map((r: any) => [String(r.sku), r]));
  for (const r of stockRes.results ?? []) {
    const key = String(r.sku);
    const o = ozon.get(key) as any;
    const sp = supply.get(key) as any;
    const bundle = Math.max(1, Number(r.bundle_size ?? 1));
    const baseStock = Math.max(0, Number(r.base_stock ?? 0));
    out.set(key, {
      sku: key.toUpperCase(),
      our_stock: Math.max(0, Number(r.our_stock ?? 0)),
      assembleable: bundle > 1 ? Math.floor(baseStock / bundle) : 0,
      our_stock_at: r.our_stock_at == null ? null : Number(r.our_stock_at),
      in_transit: Math.max(0, Number(r.in_transit_exact ?? 0))
        + (bundle > 1 ? Math.floor(Math.max(0, Number(r.base_in_transit ?? 0)) / bundle) : 0),
      in_transit_at: r.in_transit_at == null ? null : Number(r.in_transit_at),
      ozon_available: o == null ? null : Math.max(0, Number(o.ozon_available ?? 0)),
      ozon_stock_at: o?.ozon_stock_at == null ? null : Number(o.ozon_stock_at),
      // Количество берём из балансов stock_state, а не суммой line_items:
      // одна физическая поставка может иметь две связанные операции и иначе
      // удваивается (F4-WH-R + MP-WH-R).
      supply_qty: Math.max(0, Number(r.in_production_exact ?? 0))
        + (bundle > 1 ? Math.floor(Math.max(0, Number(r.base_in_production ?? 0)) / bundle) : 0),
      supply_stage: sp?.supply_stage ? String(sp.supply_stage) : null,
      supply_eta: sp?.supply_eta == null ? null : Number(sp.supply_eta),
      supply_updated_at: sp?.supply_updated_at == null ? null : Number(sp.supply_updated_at),
    });
  }
  return out;
}

async function ordersFromMirror(
  c: any, page: number, limit: number, search: string,
  TIER_RU: Record<string, string>, STATUS_KEBAB: (s: string) => string,
) {
  const env = c.env as Env;
  const state = await readSyncState(env);
  const lastOk = Number(state['ru_orders:last_ok_at'] ?? 0);
  if (!lastOk) return null;                               // синк ещё не бегал — лента

  const sortKey = String(c.req.query('sort') ?? '').toLowerCase();
  const sortAsc = String(c.req.query('dir') ?? 'desc').toLowerCase() === 'asc';
  const dir = sortAsc ? 'ASC' : 'DESC';

  const where: string[] = []; const binds: any[] = [];
  if (search) { where.push('(order_number LIKE ?1 OR customer_key LIKE ?1)'); binds.push(`%${search}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const cols = `order_number, storefront_id, status, storefront_status, created_at, paid, paid_at,
                total_rub, loyalty_rub, customer_key, delivery_status, delivery_order_id, tracking_number, delivery_provider,
                delivery_substatus, delivery_parts_total, delivery_parts_at_point, delivery_parts_received,
                raw_json,
                COUNT(*) OVER () AS total_n`;
  const sqlOrder: Record<string, string> = {
    total: `total_rub ${dir}, created_at DESC`,
    date: `created_at ${dir}`,
    status: `status ${dir}, created_at DESC`,
    charged: `loyalty_rub ${dir}, created_at DESC`,
  };
  const inMemory = sortKey === 'credited' || sortKey === 'balance';   // нужны данные лояльности

  // Один запрос за страницей и счётчиком (оконная COUNT) + два запроса
  // лояльности целиком, параллельно: три обращения к D1 вместо ~40.
  const pageQuery = inMemory
    ? env.DB.prepare(`SELECT ${cols} FROM crm_orders_ru ${whereSql} ORDER BY created_at DESC`).bind(...binds)
    : env.DB.prepare(`SELECT ${cols} FROM crm_orders_ru ${whereSql} ORDER BY ${sqlOrder[sortKey] ?? 'created_at DESC'} LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`)
        .bind(...binds, limit, (page - 1) * limit);
  const [pageRes, accRes, accrualRes] = await Promise.all([
    pageQuery.all<MirrorRow & { total_n: number }>(),
    env.DB.prepare('SELECT phone, balance, pending_balance, tier, lifetime_spent FROM loyalty_accounts').all<any>(),
    env.DB.prepare("SELECT kit_order_id, points, status FROM loyalty_transactions WHERE type = 'accrual'").all<any>(),
  ]);
  const rows = pageRes.results ?? [];
  const totalCount = rows[0]?.total_n ?? 0;
  if (!totalCount && !search) return null;                // пустое зеркало — лента
  const accByKey = new Map<string, any>();
  for (const a of accRes.results ?? []) accByKey.set(a.phone, a);
  const accrualByOrder = new Map<string, any>();
  for (const a of accrualRes.results ?? []) accrualByOrder.set(a.kit_order_id, a);

  // Позиции читаются один раз: ими питаются и подсказка Items, и проверка
  // наличия Зина + Даша. До feed v3 массив будет пустым — без догадок.
  const itemsByOrder = new Map(rows.map((r) => [r.order_number, ruItems(r.raw_json).filter((it) => it.sku || it.name)]));
  const stockFacts = await ruStockFacts(env, Array.from(itemsByOrder.values()));

  let orders = rows.map((r) => {
    const acc = r.customer_key ? accByKey.get(r.customer_key) : undefined;
    const accrual = r.storefront_id ? accrualByOrder.get(r.storefront_id) : undefined;
    const tierInfo = acc ? tierFor(acc.lifetime_spent) : null;
    return {
      id: r.order_number,
      number: r.order_number,
      customer_name: '—',                                 // обезличено, как и раньше
      total: r.total_rub,
      status: STATUS_KEBAB(r.status ?? '—'),
      created_at: r.created_at,
      items_count: ruItemsCount(r.raw_json),
      items: itemsByOrder.get(r.order_number) ?? [],
      stock_facts: (itemsByOrder.get(r.order_number) ?? [])
        .map((it) => stockFacts.get(String(it.sku ?? '').toLowerCase()))
        .filter(Boolean),
      bonus_credited: accrual ? accrual.points : 0,
      bonus_credited_status: accrual ? accrual.status : null,
      bonus_charged: r.loyalty_rub,
      loyalty_balance: acc ? acc.balance : null,
      loyalty_pending: acc ? acc.pending_balance : null,
      loyalty_level: acc ? (TIER_RU[acc.tier] ?? acc.tier) : null,
      loyalty_privilege_pct: tierInfo ? tierInfo.percent : null,
      // --- слой 3: оплата и доставка (файл 5 — плашка и колонки) ---
      storefront_status: r.storefront_status,
      paid: Boolean(r.paid),
      paid_at: r.paid_at,
      delivery_provider: r.delivery_provider,
      delivery_status: r.delivery_status,
      delivery_order_id: r.delivery_order_id,
      tracking_number: r.tracking_number,
      // Подстатус Ozon: статус остаётся delivering и когда посылка едет, и когда
      // она уже лежит в пункте. Невыкупленную видно только по этому полю.
      delivery_substatus: r.delivery_substatus,
      delivery_parts_total: r.delivery_parts_total,
      delivery_parts_at_point: r.delivery_parts_at_point,
      delivery_parts_received: r.delivery_parts_received,
    };
  });

  if (inMemory) {
    const mul = sortAsc ? 1 : -1;
    orders.sort((a, b) => sortKey === 'credited'
      ? (a.bonus_credited - b.bonus_credited) * mul
      : ((a.loyalty_balance ?? 0) - (b.loyalty_balance ?? 0)) * mul);
    orders = orders.slice((page - 1) * limit, page * limit);
  }

  const now = Math.floor(Date.now() / 1000);
  const stale = now - lastOk > RU_SYNC_STALE_AFTER_SEC;
  return ok(c, {
    source: 'd1:crm_orders_ru (зеркало dasexperten.ru, обезличено) + d1:loyalty',
    stale,
    data_as_of: lastOk,
    sync_error: state['ru_orders:last_error'] || null,
    pagination: { page, limit, total_count: totalCount, total_pages: Math.max(1, Math.ceil(totalCount / limit)) },
    search,
    orders,
    synced_at: now,
  }, stale ? ['Orders from mirror', 'stale'] : ['Orders from mirror']);
}

crm.get('/orders', async (c) => {
  // ===========================================================================
  // Phase 10.x: orders feed = Yandex KIT (source of truth) + наш D1 loyalty
  // ledger. RetailCRM здесь больше не используется. Форма ответа сохранена —
  // фронт web/app/crm/page.tsx работает без изменений.
  // ===========================================================================
  if (!c.env.YANDEX_KIT_TOKEN) {
    return fail(c, 503, [{ code: 'kit_not_configured', message: 'YANDEX_KIT_TOKEN missing.' }]);
  }

  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const rawLimit = Number(c.req.query('limit') ?? 50);
  const limit = [20, 50, 100].includes(rawLimit) ? rawLimit : 50;
  const search = (c.req.query('search') ?? '').trim();

  const TIER_RU: Record<string, string> = {
    svoy: 'Свой', tsenitel: 'Ценитель', expert: 'Эксперт', ambassador: 'Амбассадор',
  };
  const STATUS_KEBAB = (st: string) => st.toLowerCase().replace(/_/g, '-');

  // ===========================================================================
  // Слой 3 (Владелец 2026-08-29): экран читает зеркало crm_orders_ru в D1.
  // Ни одного внешнего вызова при открытии; свежесть — синк */15 (файл 3).
  // Флаг CRM_ORDERS_SOURCE=feed возвращает прежний путь через ленту одним
  // пушем. Пустое зеркало (синк ещё не бегал) — тихий откат на ленту.
  // ===========================================================================
  if ((c.env.CRM_ORDERS_SOURCE ?? 'd1') !== 'feed') {
    try {
      const d1 = await ordersFromMirror(c, page, limit, search, TIER_RU, STATUS_KEBAB);
      if (d1) return d1;
    } catch (e) {
      console.warn('[orders] зеркало D1 не ответило, падаю на ленту:', String(e));
    }
  }

  try {
    // -----------------------------------------------------------------------
    // Ranking mode (Variant B): rank ALL orders, not just the visible page.
    // Pull the full KIT feed once (cached 120s), enrich with loyalty, then
    // sort + paginate in memory. Active only when a sort is requested and there
    // is no search (search keeps its own scan path below).
    // -----------------------------------------------------------------------
    const sortKey = (c.req.query('sort') ?? '').toLowerCase();
    const sortAsc = (c.req.query('dir') ?? 'desc').toLowerCase() === 'asc';
    if (sortKey && !search) {
      const mul = sortAsc ? 1 : -1;
      // v2 — источник сменён с обхода тридцати страниц КИТ на витрину .ru.
      const full = await withKvCacheStale(
        c.env,
        'crm:orders-ru-feed-v2',
        120,
        async () => ({ orders: await buildRuOrderRows(c.env) }),
      );
      const sorted = [...((full.data.orders ?? []) as any[])].sort((a, b) => {
        switch (sortKey) {
          case 'total': return (a.total - b.total) * mul;
          case 'credited': return (a.bonus_credited - b.bonus_credited) * mul;
          case 'charged': return (a.bonus_charged - b.bonus_charged) * mul;
          case 'balance': return ((a.loyalty_balance ?? 0) - (b.loyalty_balance ?? 0)) * mul;
          case 'status': return String(a.status).localeCompare(String(b.status)) * mul;
          case 'date': return (new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) * mul;
          default: return 0;
        }
      });
      const totalCount = sorted.length;
      const pageRows = sorted.slice((page - 1) * limit, page * limit);
      return ok(c, {
        source: 'dasexperten.ru (обезличено) + d1:loyalty',
        stale: full.stale,
        data_as_of: full.produced_at,
        pagination: { page, limit, total_count: totalCount, total_pages: Math.max(1, Math.ceil(totalCount / limit)) },
        search: '',
        orders: pageRows,
        synced_at: Math.floor(Date.now() / 1000),
      }, full.stale ? ['Orders ranked', 'stale'] : ['Orders ranked']);
    }

    const payload = await withKvCacheStale(
      c.env,
      cacheKey('crm:orders-ru', { v: 2, page, limit, search }),
      120,
      async () => {
        // KIT: per_page до 100; search/status в API заказов не фильтруют —
        // поиск делаем сами ограниченным сканом последних страниц.
        // Витрина отдаёт весь список разом и обезличенным — постраничный обход
        // чужого API больше не нужен, отсюда и уходили 429. Страницы режем сами.
        let feedStale = false;
        const fetchKitPage = async (p: number, perPage: number) => {
          if (c.env.RU_FEED_TOKEN) {
            try {
              const feed = await fetchStorefrontOrders(c.env);
              feedStale = feedStale || Boolean(feed.stale);
              const all = feed.orders as any[];
              const from = (p - 1) * perPage;
              return { total_count: feed.total || all.length, orders: all.slice(from, from + perPage) };
            } catch (e) {
              console.warn('витрина .ru недоступна, падаю обратно на КИТ:', String(e));
            }
          }
          const url = new URL('https://api.kit.yandex.net/v1/orders');
          url.searchParams.set('page', String(p));
          url.searchParams.set('per_page', String(perPage));
          const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${c.env.YANDEX_KIT_TOKEN}` },
          });
          if (!res.ok) throw new Error(`KIT API ${res.status}: ${(await res.text()).slice(0, 200)}`);
          return (await res.json()) as { total_count?: number; orders?: any[] };
        };

        let kitOrders: any[] = [];
        let totalCount = 0;
        if (search) {
          // скан до 8 страниц по 100 (последние ~800 заказов), фильтр у нас
          const q = search.toLowerCase();
          for (let p = 1; p <= 8; p++) {
            const resp = await fetchKitPage(p, 100);
            totalCount = resp.total_count ?? totalCount;
            const batch = resp.orders ?? [];
            for (const o of batch) {
              const hay = [
                String(o.order_number ?? ''),
                o.client?.first_name, o.client?.last_name, o.client?.email, o.client?.phone,
              ].filter(Boolean).join(' ').toLowerCase();
              if (hay.includes(q)) kitOrders.push(o);
            }
            if (kitOrders.length >= limit || batch.length < 100) break;
          }
          totalCount = kitOrders.length;
          kitOrders = kitOrders.slice((page - 1) * limit, page * limit);
        } else {
          const resp = await fetchKitPage(page, limit);
          kitOrders = (resp.orders ?? []).slice(0, limit);
          totalCount = resp.total_count ?? 0;
        }

        // --- D1 enrich: балансы/уровни по телефонам + начисления по заказам ---
        const phones = Array.from(
          new Set(kitOrders.map((o) => normalizePhone(o?.client?.phone)).filter(Boolean))
        ) as string[];
        const orderIds = kitOrders.map((o) => o.id).filter(Boolean) as string[];

        const accByPhone = new Map<string, { balance: number; pending_balance: number; tier: string; lifetime_spent: number }>();
        if (phones.length) {
          const ph = phones.map(() => '?').join(',');
          const rows = await c.env.DB.prepare(
            `SELECT phone, balance, pending_balance, tier, lifetime_spent FROM loyalty_accounts WHERE phone IN (${ph})`
          ).bind(...phones).all<any>();
          for (const r of rows.results ?? []) accByPhone.set(r.phone, r);
        }

        const accrualByOrder = new Map<string, { points: number; status: string }>();
        if (orderIds.length) {
          const ph = orderIds.map(() => '?').join(',');
          const rows = await c.env.DB.prepare(
            `SELECT kit_order_id, points, status FROM loyalty_transactions
             WHERE type = 'accrual' AND kit_order_id IN (${ph})`
          ).bind(...orderIds).all<any>();
          for (const r of rows.results ?? []) accrualByOrder.set(r.kit_order_id, r);
        }

        const orders = kitOrders.map((o) => {
          const phone = normalizePhone(o?.client?.phone);
          const acc = phone ? accByPhone.get(phone) : undefined;
          const accrual = accrualByOrder.get(o.id);

          // списанное по заказу: промокод + лояльность + подарочная карта по позициям
          let charged = 0;
          for (const chunk of o.delivery_chunks ?? []) {
            for (const it of chunk.items ?? []) {
              charged +=
                Math.round(parseFloat(it.promocode_discount ?? '0')) +
                Math.round(parseFloat(it.loyalty_discount ?? '0')) +
                Math.round(parseFloat(it.gift_card_discount ?? '0'));
            }
          }

          const tierInfo = acc ? tierFor(acc.lifetime_spent) : null;
          return {
            id: o.order_number,
            number: String(o.order_number ?? ''),
            customer_name:
              [o.client?.first_name, o.client?.last_name].filter(Boolean).join(' ') ||
              o.client?.email || '—',
            total: Math.round(parseFloat(o.total_final_price ?? o.purchased_price ?? '0')),
            status: STATUS_KEBAB(o.status ?? '—'),
            created_at: o.created_at ?? '—',
            bonus_credited: accrual ? accrual.points : 0,
            bonus_credited_status: accrual ? accrual.status : null,
            bonus_charged: charged,
            loyalty_balance: acc ? acc.balance : null,
            loyalty_pending: acc ? acc.pending_balance : null,
            loyalty_level: acc ? (TIER_RU[acc.tier] ?? acc.tier) : null,
            loyalty_privilege_pct: tierInfo ? tierInfo.percent : null,
          };
        });

        return {
          source: feedStale
            ? 'dasexperten.ru (последняя целая копия — витрина сейчас не отвечает) + d1:loyalty'
            : 'dasexperten.ru (обезличено) + d1:loyalty',
          feed_stale: feedStale,
          pagination: {
            page,
            limit,
            total_count: totalCount,
            total_pages: Math.max(1, Math.ceil(totalCount / limit)),
          },
          search,
          orders,
          synced_at: Math.floor(Date.now() / 1000),
        };
      }
    );
    return ok(
      c,
      { ...payload.data, stale: payload.stale, data_as_of: payload.produced_at },
      payload.stale ? ['stale'] : [],
    );
  } catch (e) {
    // Сырой текст исключения на экран Владельцу больше не выходит: витрина
    // умела оборваться посреди JSON, и ошибка парсера печаталась как есть.
    return fail(c, 502, [{
      code: 'orders_feed_unavailable',
      message: 'Витрина .ru не ответила, и сохранённой копии нет.',
      details: { reason: e instanceof Error ? e.message : String(e) },
    }]);
  }
});

// =============================================================================
// Query params:
//   page    — 1-based page number (default 1)
//   limit   — 20 / 50 / 100 (default 50)
//   search  — free-text by name (filter[name]); if digits-only, tries phone
crm.get('/customers', async (c) => {
  if (!c.env.YANDEX_KIT_TOKEN) {
    return fail(c, 503, [{ code: 'kit_not_configured', message: 'YANDEX_KIT_TOKEN missing.' }]);
  }
  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const rawLimit = Number(c.req.query('limit') ?? 50);
  const limit = [20, 50, 100].includes(rawLimit) ? rawLimit : 50;
  const rawSearch = (c.req.query('search') ?? '').trim();
  const search = rawSearch.toLowerCase();
  const digits = search.replace(/\D/g, '');

  const TIER_RU: Record<string, string> = {
    svoy: 'Свой', tsenitel: 'Ценитель', expert: 'Эксперт', ambassador: 'Амбассадор',
  };

  try {
    const agg = (await getKitAggregate(c.env)).data;
    let list = agg.customers;
    if (search) {
      list = list.filter((cu) =>
        cu.name.toLowerCase().includes(search) ||
        (cu.email ?? '').toLowerCase().includes(search) ||
        (digits.length >= 4 && cu.phone.includes(digits))
      );
    }
    const sortKey = (c.req.query('sort') ?? 'spent').toLowerCase();
    const asc = (c.req.query('dir') ?? 'desc').toLowerCase() === 'asc';
    const mul = asc ? 1 : -1;
    let balMap: Map<string, number> | null = null;
    if (sortKey === 'balance') {
      balMap = new Map<string, number>();
      try {
        const allBal = await c.env.DB.prepare('SELECT phone, balance FROM loyalty_accounts').all<{ phone: string; balance: number }>();
        for (const r of allBal.results ?? []) balMap.set(r.phone, Number(r.balance) || 0);
      } catch { /* ignore — missing balances sort as 0 */ }
    }
    list = [...list].sort((a, b) => {
      if (sortKey === 'orders') return (a.orders_count - b.orders_count) * mul;
      // last_order — строка ISO8601, а не число. Вычитание строк давало NaN,
      // и сортировка по дате не работала вовсе (Владелец 02.09.2026).
      // Ключ 'registered' оставлен ради старых ссылок: графа всегда несла
      // дату последнего заказа, а не регистрации.
      if (sortKey === 'last_order' || sortKey === 'registered') {
        return String(a.last_order).localeCompare(String(b.last_order)) * mul;
      }
      if (sortKey === 'name') return a.name.localeCompare(b.name) * mul;
      if (sortKey === 'balance') return ((balMap!.get(a.phone) ?? 0) - (balMap!.get(b.phone) ?? 0)) * mul;
      return (a.total_spent - b.total_spent) * mul;
    });
    const totalCount = list.length;
    const pageRows = list.slice((page - 1) * limit, page * limit);

    const phones = pageRows.map((cu) => cu.phone);
    const accByPhone = new Map<string, any>();
    // Баллы, потраченные покупателем в заказах. Это не остаток счёта, но это
    // единственное, что о баллах известно по обезличенному ключу, — и прятать
    // его за прочерком нельзя (Владелец 02.09.2026: «если что-то есть —
    // показывай»). Считаем по зеркалу тем же ключом, что и строка списка.
    const usedByKey = new Map<string, number>();
    // Город покупателя. В ленте витрины его нет — приходит из связки, которую
    // набивает крон по карточке последнего заказа (Владелец 02.09.2026).
    const cityByKey = new Map<string, string>();
    if (phones.length) {
      const ph = phones.map(() => '?').join(',');
      const [accRows, usedRows] = await Promise.all([
        c.env.DB.prepare(
          `SELECT phone, balance, pending_balance, tier, lifetime_spent FROM loyalty_accounts WHERE phone IN (${ph})`
        ).bind(...phones).all<any>(),
        c.env.DB.prepare(
          `SELECT customer_key, SUM(loyalty_rub) AS used FROM crm_orders_ru
            WHERE customer_key IN (${ph}) GROUP BY customer_key`
        ).bind(...phones).all<{ customer_key: string; used: number }>()
          .catch(() => ({ results: [] as Array<{ customer_key: string; used: number }> })),
      ]);
      for (const r of accRows.results ?? []) accByPhone.set(r.phone, r);
      for (const r of usedRows.results ?? []) usedByKey.set(r.customer_key, Number(r.used) || 0);

      // Счёт по обезличенному ключу — через связку crm_loyalty_key_map, которую
      // набивает крон (Владелец разрешил обход витрины 02.09.2026). Кладём в ту
      // же карту: строка списка опознаётся ключом, и остальной код не меняется.
      // Своё try: таблицы может ещё не быть, и это не повод ронять экран.
      try {
        const mapped = await c.env.DB.prepare(
          `SELECT m.customer_key AS k, m.city, a.balance, a.pending_balance, a.tier, a.lifetime_spent
             FROM crm_loyalty_key_map m
             LEFT JOIN loyalty_accounts a ON a.id = m.account_id
            WHERE m.customer_key IN (${ph})`
        ).bind(...phones).all<any>();
        for (const r of mapped.results ?? []) {
          if (r.city) cityByKey.set(r.k, r.city);
          // Счёт кладём в ту же карту, что и прямое совпадение по телефону:
          // строка списка опознаётся ключом, остальной код не меняется.
          if (r.balance !== null && r.balance !== undefined) accByPhone.set(r.k, r);
        }
      } catch { /* связки ещё нет — покажем то, что знаем без неё */ }
    }

    const customers = pageRows.map((cu) => {
      const acc = accByPhone.get(cu.phone);
      // Счёт лояльности заведён на телефон, а обезличенная лента .ru отдаёт
      // необратимый ключ — совпасть им нечем, и графа «Level» стояла пустой у
      // всех 1482 покупателей (Владелец 02.09.2026). Уровень при этом известен:
      // по правилам клуба это функция суммы покупок (lib/loyalty.ts), а счёт —
      // лишь её хранимая копия. Поэтому без счёта считаем тем же tierFor по
      // тратам самого покупателя. Баланс баллов так не выводится: это движение
      // по счёту, вычислить его нельзя, и ставить ноль вместо «неизвестно»
      // было бы выдумкой.
      const tierInfo = acc ? tierFor(acc.lifetime_spent) : tierFor(cu.goods_spent);
      const tierKey = acc ? acc.tier : tierInfo.key;
      const depersonalized = KEY_RE.test(cu.phone);
      return {
        id: cu.phone,
        // Обезличенная строка: имя — «Заказ N», телефона и почты нет. Экран
        // покажет кнопку; настоящие данные — по /customer-key/:key под запись.
        depersonalized,
        key: depersonalized ? cu.phone : null,
        name: cu.name,
        // Город — не персональные данные (населённый пункт пункта выдачи),
        // поэтому виден без кнопки показа, как и просил Владелец.
        city: cityByKey.get(cu.phone) ?? null,
        email: cu.email,
        phone: depersonalized ? null : cu.phone,
        orders_count: cu.orders_count,
        total_spent: cu.total_spent,
        average_order: cu.sales_count ? Math.round(cu.total_spent / cu.sales_count) : 0,
        // Лента .ru даты регистрации не отдаёт: и здесь, и в created_at лежит
        // дата ПОСЛЕДНЕГО заказа. Поле названо своим именем; created_at
        // сохранён, чтобы не ломать прежних читателей ответа.
        last_order_at: cu.last_order,
        created_at: cu.last_order,
        loyalty_balance: acc ? acc.balance : null,
        loyalty_level: TIER_RU[tierKey] ?? tierKey,
        loyalty_privilege_pct: tierInfo.percent,
        // Откуда взят уровень: 'account' — из счёта в D1, 'spent' — посчитан по
        // тратам, счёта нет. Экран этим не пользуется, но по ответу видно, чему
        // верить, и подмены счёта расчётом не случится незаметно.
        loyalty_level_basis: acc ? 'account' : 'spent',
        // Баллов потрачено в заказах — 0, если покупатель баллами не платил.
        loyalty_used: usedByKey.get(cu.phone) ?? 0,
        goods_spent: cu.goods_spent,
      };
    });

    return ok(c, {
      source: 'dasexperten.ru (обезличено) + d1:loyalty',
      pagination: {
        page, limit,
        total_count: totalCount,
        total_pages: Math.max(1, Math.ceil(totalCount / limit)),
      },
      search: rawSearch,
      customers,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'kit_upstream_error', message: msg }]);
  }
});

crm.get('/timeline', async (c) => {
  if (!c.env.YANDEX_KIT_TOKEN) {
    return fail(c, 503, [{ code: 'kit_not_configured', message: 'YANDEX_KIT_TOKEN missing.' }]);
  }
  try {
    const agg = (await getKitAggregate(c.env)).data;

    // Registrations by day from the D1 loyalty ledger (registered_at, last 30d).
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setUTCDate(today.getUTCDate() - 29);
    const startEpoch = Math.floor(start.getTime() / 1000);

    const regRows = await c.env.DB.prepare(
      // Exclude the one-time RetailCRM->D1 migration backfill (source=
      // 'retailcrm_migration', all stamped 2026-06-11) — those are not real
      // daily signups and would spike the chart with ~1k on a single day.
      "SELECT registered_at FROM loyalty_accounts WHERE registered_at >= ? AND source <> 'retailcrm_migration'"
    ).bind(startEpoch).all<{ registered_at: number }>();

    const regByDay = new Map<string, number>();
    for (const r of regRows.results ?? []) {
      if (!r.registered_at) continue;
      const day = new Date(r.registered_at * 1000).toISOString().slice(0, 10);
      regByDay.set(day, (regByDay.get(day) ?? 0) + 1);
    }

    const timeline = agg.daily30.map((d) => ({
      date: d.date,
      registrations: regByDay.get(d.date) ?? 0,
      orders: d.orders,
    }));

    return ok(c, {
      source: 'dasexperten.ru (обезличено) + d1:loyalty',
      window_days: 30,
      timeline,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'kit_upstream_error', message: msg }]);
  }
});

crm.get('/funnel', async (c) => {
  if (!c.env.YANDEX_KIT_TOKEN) {
    return fail(c, 503, [{ code: 'kit_not_configured', message: 'YANDEX_KIT_TOKEN missing.' }]);
  }
  try {
    const [agg, loyaltyMembers] = await Promise.all([
      getKitAggregate(c.env),
      loyaltyMemberCount(c.env),
    ]);
    const registered = agg.data.customers_total;
    const bought = agg.data.buyers_count;
    const repeat = agg.data.repeat_buyers;
    return ok(c, {
      source: 'dasexperten.ru (обезличено) + d1:loyalty',
      stages: {
        registered,
        loyalty_members: loyaltyMembers,
        bought_at_least_once: bought,
        repeat_buyers: repeat,
      },
      conversion_to_buyer_pct: registered > 0 ? Math.round((bought / registered) * 1000) / 10 : 0,
      repeat_rate_pct: bought > 0 ? Math.round((repeat / bought) * 1000) / 10 : 0,
      welcome_burnt_estimate: Math.max(0, loyaltyMembers - bought),
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'kit_upstream_error', message: msg }]);
  }
});

crm.post('/sync-site-sales', async (c) => {
  const domain = c.env.RETAIL_CRM_DOMAIN;
  const token = c.env.RETAIL_CRM_TOKEN;
  if (!domain || !token) {
    return fail(c, 'retail_crm_not_configured', 'RETAIL_CRM_DOMAIN/TOKEN not set', 503);
  }

  let body: { from?: string; till?: string } = {};
  try { body = await c.req.json(); } catch { /* allow empty body */ }

  const today = new Date();
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const till = body.till ?? toIso(today);
  const from = body.from ?? toIso(new Date(today.getTime() - 1 * 86400_000));

  // Page through all orders in [from, till]
  type Order = {
    createdAt?: string;
    status?: string;
    site?: string;
    totalSumm?: number;
    items?: Array<{ quantity?: number }>;
  };
  type Page = {
    success: boolean;
    pagination?: { totalPageCount?: number; currentPage?: number };
    orders?: Order[];
  };

  const dayTotals = new Map<string, { rev: number; units: number; orders: number; cancelled: number }>();
  let page = 1;
  let totalPages = 1;
  let fetched = 0;

  while (page <= totalPages) {
    const params = {
      apiKey: token,
      'filter[createdAtFrom]': `${from} 00:00:00`,
      'filter[createdAtTo]':   `${till} 23:59:59`,
      'filter[sites][]':       'dasexperten',
      page,
      limit: 100,
    };
    // retailGet doesn't accept apiKey-in-params signature, so call fetch directly here
    const url = new URL(`https://${domain}.retailcrm.ru/api/v5/orders`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), { method: 'GET' });
    if (!res.ok) {
      return fail(c, 'retail_crm_http_error', `HTTP ${res.status}: ${await res.text()}`, 502);
    }
    const data = (await res.json()) as Page;
    if (!data.success) {
      return fail(c, 'retail_crm_response_error', JSON.stringify(data), 502);
    }
    totalPages = data.pagination?.totalPageCount ?? 1;

    for (const o of data.orders ?? []) {
      const day = (o.createdAt ?? '').slice(0, 10);
      if (!day) continue;
      const isCancelled = (o.status ?? '').toLowerCase() === 'cancelled';
      const bucket = dayTotals.get(day) ?? { rev: 0, units: 0, orders: 0, cancelled: 0 };
      if (isCancelled) {
        bucket.cancelled += 1;
      } else {
        bucket.rev += Number(o.totalSumm ?? 0);
        bucket.orders += 1;
        for (const it of o.items ?? []) bucket.units += Number(it.quantity ?? 0);
      }
      dayTotals.set(day, bucket);
      fetched += 1;
    }
    page += 1;
  }

  // Upsert per-day totals into marketplace_sales_daily (marketplace='site').
  // revenue_rub stored as INTEGER kopecks (× 100) to match Ozon/WB convention.
  const now = Math.floor(Date.now() / 1000);
  const days = Array.from(dayTotals.entries()).sort();
  for (const [day, totals] of days) {
    await c.env.DB.prepare(`
      INSERT INTO marketplace_sales_daily (marketplace, date, units_sold, revenue_rub, synced_at)
      VALUES ('site', ?1, ?2, ?3, ?4)
      ON CONFLICT(marketplace, date) DO UPDATE SET
        units_sold = excluded.units_sold,
        revenue_rub = excluded.revenue_rub,
        synced_at = excluded.synced_at
    `).bind(day, totals.units, Math.round(totals.rev * 100), now).run();
  }

  return ok(c, {
    range: { from, till },
    days: days.map(([day, t]) => ({
      date: day,
      orders: t.orders,
      cancelled_orders: t.cancelled,
      units: t.units,
      revenue_rub: Math.round(t.rev),
    })),
    orders_processed: fetched,
    days_written: days.length,
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/crm/backfill-site-sales
//
// One-shot historical backfill. Same logic as /sync-site-sales but default
// range is last 30 days. Pass {from,till} for custom range.
// ════════════════════════════════════════════════════════════════════════════
crm.post('/backfill-site-sales', async (c) => {
  let body: { from?: string; till?: string } = {};
  try { body = await c.req.json(); } catch { /* allow empty body */ }

  const today = new Date();
  const toIso = (d: Date) => d.toISOString().slice(0, 10);
  const till = body.till ?? toIso(today);
  const from = body.from ?? toIso(new Date(today.getTime() - 29 * 86400_000));

  // Delegate to /sync-site-sales by reposting (keeps logic in one place)
  const innerReq = new Request(`https://internal/api/crm/sync-site-sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, till }),
  });
  return c.env.SELF.fetch(innerReq);
});


/**
 * Персональные данные ОДНОГО покупателя — по кнопке, а не списком.
 *
 * Экран получает заказы обезличенными (см. fetchStorefrontOrders). Здесь витрина
 * отдаёт имя, телефон и адрес пункта выдачи ровно по одному номеру заказа,
 * и каждый показ пишется в журнал pd_access_log на стороне России: кто спросил,
 * когда, по какому заказу, с какого адреса.
 *
 * Так и должно быть: единичный доступ по надобности и постоянная копия за
 * границей — разные вещи, и журнал ровно эту разницу доказывает. Решение
 * Владельца 22.08.2026: кнопка, а не выгрузка.
 */
crm.get('/customer/:number', async (c) => {
  const number = c.req.param('number');
  if (!c.env.RU_FEED_TOKEN) {
    return c.json({ success: false, errors: [{ code: 'not_configured',
      message: 'Витрина .ru не подключена' }] }, 503);
  }
  const who = c.req.query('who') ?? 'erp';
  const res = await fetch(
    `https://dasexperten.ru/api/erp/customer.php?k=${c.env.RU_FEED_TOKEN}` +
    `&order=${encodeURIComponent(number)}&who=${encodeURIComponent(who)}`,
    { cf: { cacheTtl: 0, cacheEverything: false } },
  );
  const data = await res.json();
  return c.json({ success: res.ok, result: res.ok ? data : null,
                  errors: res.ok ? [] : [{ code: 'not_found', message: 'Заказ не найден' }] },
                res.ok ? 200 : 404);
});

/**
 * Персональные данные ОДНОГО покупателя по обезличенному ключу — экран Customers.
 * Решение Владельца 31.08.2026: кнопка, а не выгрузка. Площадка .ru сама находит
 * телефон по ключу и пишет показ в pd_access_log (order_number = key:<ключ>).
 * Уровень и баланс бонусов подтягиваются здесь по раскрытому телефону из D1 —
 * счёт лояльности ключа не знает, а телефон после показа уже на руках.
 */
crm.get('/customer-key/:key', async (c) => {
  const key = (c.req.param('key') ?? '').toLowerCase();
  if (!KEY_RE.test(key)) {
    return c.json({ success: false, errors: [{ code: 'bad_key', message: 'ключ — 12 hex-знаков' }] }, 400);
  }
  if (!c.env.RU_FEED_TOKEN) {
    return c.json({ success: false, errors: [{ code: 'not_configured',
      message: 'Витрина .ru не подключена' }] }, 503);
  }
  const who = c.req.query('who') ?? 'erp';
  const res = await fetch(
    `https://dasexperten.ru/api/erp/customer.php?k=${c.env.RU_FEED_TOKEN}` +
    `&key=${encodeURIComponent(key)}&who=${encodeURIComponent(who)}`,
    { cf: { cacheTtl: 0, cacheEverything: false } },
  );
  const data: any = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    return c.json({ success: false, result: null,
                    errors: [{ code: 'not_found', message: data?.error ?? 'Покупатель не найден' }] }, 404);
  }
  const TIER_RU: Record<string, string> = {
    svoy: 'Свой', tsenitel: 'Ценитель', expert: 'Эксперт', ambassador: 'Амбассадор',
  };
  let loyalty: { balance: number | null; level: string | null; privilege_pct: number | null } =
    { balance: null, level: null, privilege_pct: null };
  const phone = normalizePhone(data.customer?.phone);
  if (phone) {
    try {
      const acc = await c.env.DB.prepare(
        'SELECT balance, tier, lifetime_spent FROM loyalty_accounts WHERE phone = ? LIMIT 1'
      ).bind(phone).first<any>();
      if (acc) {
        const t = tierFor(acc.lifetime_spent);
        loyalty = { balance: Number(acc.balance) || 0, level: TIER_RU[acc.tier] ?? acc.tier ?? null,
                    privilege_pct: t ? t.percent : null };
      }
    } catch { /* нет счёта — нет уровня; показ имени от этого не зависит */ }
  }
  return c.json({ success: true, result: { customer: data.customer, loyalty }, errors: [] }, 200);
});

export default crm;
