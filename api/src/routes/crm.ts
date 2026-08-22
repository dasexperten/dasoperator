import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { withKvCache, cacheKey } from '../lib/kv-cache';
import { normalizePhone, tierFor } from '../lib/loyalty';

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
}

interface CustomerAgg {
  phone: string;
  name: string;
  email: string | null;
  orders_count: number;
  sales_count: number;
  total_spent: number;
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
async function fetchStorefrontOrders(env: Env): Promise<{ total: number; orders: KitOrder[] }> {
  const res = await fetch(`https://dasexperten.ru/api/erp/orders.php?k=${env.RU_FEED_TOKEN}`, {
    cf: { cacheTtl: 60, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`витрина .ru ответила ${res.status}`);
  const data = (await res.json()) as { total_count?: number; orders?: KitOrder[] };
  return { total: data.total_count ?? 0, orders: data.orders ?? [] };
}

// Прежний путь через КИТ оставлен как запасной: витрина и площадка новые,
// и если они лягут, экран должен показать хоть что-то, а не пустоту.
async function fetchAllKitOrders(env: Env): Promise<{ total: number; orders: KitOrder[] }> {
  if (env.RU_FEED_TOKEN) {
    try {
      return await fetchStorefrontOrders(env);
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
    const phone = normalizePhone(o.client?.phone);

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
        orders_count: 0, sales_count: 0, total_spent: 0, last_order: created,
      };
      cu.orders_count += 1;
      if (isSale) { cu.sales_count += 1; cu.total_spent += net; }
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

async function getKitAggregate(env: Env): Promise<KitAggregate> {
  return withKvCache(env, cacheKey('crm:kit-agg', { v: 2 }), 300, async () => {   // v2 — источник сменён на витрину .ru, старый кэш недействителен
    const { total, orders } = await fetchAllKitOrders(env);
    return buildAggregate(total, orders);
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
    const [agg, loyaltyMembers] = await Promise.all([
      getKitAggregate(c.env),
      loyaltyMemberCount(c.env),
    ]);
    return ok(c, {
      source: 'dasexperten.ru (обезличено) + d1:loyalty',
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
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'kit_upstream_error', message: msg }]);
  }
});

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
      const full = await withKvCache(
        c.env,
        'crm:orders-ru-feed-v1',
        120,
        async () => {
          const fetchKitPageFull = async (p: number) => {
            const url = new URL('https://api.kit.yandex.net/v1/orders');
            url.searchParams.set('page', String(p));
            url.searchParams.set('per_page', '100');
            const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${c.env.YANDEX_KIT_TOKEN}` } });
            if (!res.ok) throw new Error(`KIT API ${res.status}: ${(await res.text()).slice(0, 200)}`);
            return (await res.json()) as { total_count?: number; orders?: any[] };
          };
          const all: any[] = [];
          for (let p = 1; p <= 30; p++) {
            const resp = await fetchKitPageFull(p);
            const batch = resp.orders ?? [];
            all.push(...batch);
            if (batch.length < 100) break;
          }
          const accByPhone = new Map<string, any>();
          {
            const rows = await c.env.DB.prepare('SELECT phone, balance, pending_balance, tier, lifetime_spent FROM loyalty_accounts').all<any>();
            for (const r of rows.results ?? []) accByPhone.set(r.phone, r);
          }
          const accrualByOrder = new Map<string, any>();
          {
            const rows = await c.env.DB.prepare("SELECT kit_order_id, points, status FROM loyalty_transactions WHERE type = 'accrual'").all<any>();
            for (const r of rows.results ?? []) accrualByOrder.set(r.kit_order_id, r);
          }
          const mapped = all.map((o) => {
            const phone = normalizePhone(o?.client?.phone);
            const acc = phone ? accByPhone.get(phone) : undefined;
            const accrual = accrualByOrder.get(o.id);
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
              customer_name: [o.client?.first_name, o.client?.last_name].filter(Boolean).join(' ') || o.client?.email || '—',
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
          return { orders: mapped };
        },
      );
      const sorted = [...((full.orders ?? []) as any[])].sort((a, b) => {
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
        source: 'kit-full+d1',
        pagination: { page, limit, total_count: totalCount, total_pages: Math.max(1, Math.ceil(totalCount / limit)) },
        search: '',
        orders: pageRows,
        synced_at: Math.floor(Date.now() / 1000),
      }, ['Orders ranked']);
    }

    const payload = await withKvCache(
      c.env,
      cacheKey('crm:orders-kit', { page, limit, search }),
      120,
      async () => {
        // KIT: per_page до 100; search/status в API заказов не фильтруют —
        // поиск делаем сами ограниченным сканом последних страниц.
        // Витрина отдаёт весь список разом и обезличенным — постраничный обход
        // чужого API больше не нужен, отсюда и уходили 429. Страницы режем сами.
        const fetchKitPage = async (p: number, perPage: number) => {
          if (c.env.RU_FEED_TOKEN) {
            const res = await fetch(
              `https://dasexperten.ru/api/erp/orders.php?k=${c.env.RU_FEED_TOKEN}`,
              { cf: { cacheTtl: 60, cacheEverything: false } },
            );
            if (res.ok) {
              const data = (await res.json()) as { total_count?: number; orders?: any[] };
              const all = data.orders ?? [];
              const from = (p - 1) * perPage;
              return { total_count: data.total_count ?? all.length, orders: all.slice(from, from + perPage) };
            }
            console.warn('витрина .ru ответила', res.status, '— падаю обратно на КИТ');
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
          source: 'dasexperten.ru (обезличено) + d1:loyalty',
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
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'kit_upstream_error', message: msg }]);
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
    const agg = await getKitAggregate(c.env);
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
      if (sortKey === 'registered') return (a.last_order - b.last_order) * mul;
      if (sortKey === 'name') return a.name.localeCompare(b.name) * mul;
      if (sortKey === 'balance') return ((balMap!.get(a.phone) ?? 0) - (balMap!.get(b.phone) ?? 0)) * mul;
      return (a.total_spent - b.total_spent) * mul;
    });
    const totalCount = list.length;
    const pageRows = list.slice((page - 1) * limit, page * limit);

    const phones = pageRows.map((cu) => cu.phone);
    const accByPhone = new Map<string, any>();
    if (phones.length) {
      const ph = phones.map(() => '?').join(',');
      const rows = await c.env.DB.prepare(
        `SELECT phone, balance, pending_balance, tier, lifetime_spent FROM loyalty_accounts WHERE phone IN (${ph})`
      ).bind(...phones).all<any>();
      for (const r of rows.results ?? []) accByPhone.set(r.phone, r);
    }

    const customers = pageRows.map((cu) => {
      const acc = accByPhone.get(cu.phone);
      const tierInfo = acc ? tierFor(acc.lifetime_spent) : null;
      return {
        id: cu.phone,
        name: cu.name,
        email: cu.email,
        phone: cu.phone,
        orders_count: cu.orders_count,
        total_spent: cu.total_spent,
        average_order: cu.sales_count ? Math.round(cu.total_spent / cu.sales_count) : 0,
        created_at: cu.last_order,
        loyalty_balance: acc ? acc.balance : null,
        loyalty_level: acc ? (TIER_RU[acc.tier] ?? acc.tier) : null,
        loyalty_privilege_pct: tierInfo ? tierInfo.percent : null,
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
    const agg = await getKitAggregate(c.env);

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
    const registered = agg.customers_total;
    const bought = agg.buyers_count;
    const repeat = agg.repeat_buyers;
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

export default crm;
