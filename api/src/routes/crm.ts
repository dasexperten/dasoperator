import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const crm = new Hono<{ Bindings: Env }>();

interface RetailOrder {
  id: number;
  number?: string;
  status?: string;
  totalSumm?: number;
  bonusesCreditTotal?: number;
  bonusesChargeTotal?: number;
  loyaltyLevel?: { id?: number; name?: string };
  createdAt?: string;
  customer?: {
    id?: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

interface RetailLoyaltyAccount {
  id: number;
  amount?: number;
  ordersSum?: number;
  nextLevelSum?: number;
  level?: {
    id?: number;
    name?: string;
    privilegeSize?: number;
  };
  customer?: { id?: number };
}

interface RetailCustomer {
  id: number;
  externalId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phones?: Array<{ number?: string }>;
  ordersCount?: number;
  totalSumm?: number;
  averageSumm?: number;
  createdAt?: string;
  site?: string;
}

async function retailGet<T = unknown>(
  domain: string,
  token: string,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(`https://${domain}.retailcrm.ru/api/v5${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'X-API-KEY': token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Retail CRM HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

crm.get('/stats', async (c) => {
  const domain = c.env.RETAIL_CRM_DOMAIN;
  const token = c.env.RETAIL_CRM_TOKEN;
  if (!domain || !token) {
    return fail(c, 503, [{ code: 'crm_not_configured', message: 'Retail CRM not configured.' }]);
  }

  try {
    const customersResp = await retailGet<{ pagination?: { totalCount?: number } }>(
      domain, token, '/customers', { 'page': 1, 'limit': 20 }
    );
    const ordersTotalResp = await retailGet<{ pagination?: { totalCount?: number } }>(
      domain, token, '/orders', { 'page': 1, 'limit': 20 }
    );

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthStartIso = monthStart.toISOString().slice(0, 10);

    const ordersMonthResp = await retailGet<{
      pagination?: { totalCount?: number };
      orders?: RetailOrder[];
    }>(domain, token, '/orders', {
      'filter[createdAtFrom]': monthStartIso,
      'page': 1,
      'limit': 100,
    });

    const ordersThisMonth = ordersMonthResp.pagination?.totalCount ?? 0;
    const monthOrders = ordersMonthResp.orders ?? [];
    const revenueThisMonth = monthOrders.reduce(
      (sum, o) => sum + (typeof o.totalSumm === 'number' ? o.totalSumm : 0),
      0
    );

    const loyaltyResp = await retailGet<{
      pagination?: { totalCount?: number };
    }>(domain, token, '/loyalty/accounts', { 'page': 1, 'limit': 20 });

    return ok(c, {
      source: `${domain}.retailcrm.ru`,
      customers_total: customersResp.pagination?.totalCount ?? 0,
      orders_total: ordersTotalResp.pagination?.totalCount ?? 0,
      orders_this_month: ordersThisMonth,
      revenue_this_month_rub: revenueThisMonth,
      loyalty_members_total: loyaltyResp.pagination?.totalCount ?? 0,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'crm_upstream_error', message: msg }]);
  }
});

crm.get('/orders', async (c) => {
  const domain = c.env.RETAIL_CRM_DOMAIN;
  const token = c.env.RETAIL_CRM_TOKEN;
  if (!domain || !token) {
    return fail(c, 503, [{ code: 'crm_not_configured', message: 'Retail CRM not configured.' }]);
  }

  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const rawLimit = Number(c.req.query('limit') ?? 50);
  const limit = [20, 50, 100].includes(rawLimit) ? rawLimit : 50;
  const search = (c.req.query('search') ?? '').trim();

  const params: Record<string, string | number | undefined> = {
    'page': page,
    'limit': limit,
  };

  if (search) {
    if (/^\d+$/.test(search)) {
      params['filter[numbers][]'] = search;
    } else {
      params['filter[customer]'] = search;
    }
  }

  try {
    const ordersResp = await retailGet<{
      pagination?: { totalCount?: number; currentPage?: number; totalPageCount?: number };
      orders?: RetailOrder[];
    }>(domain, token, '/orders', params);

    const ordersOnPage = ordersResp.orders ?? [];

    const loyaltyResp = await retailGet<{
      loyaltyAccounts?: RetailLoyaltyAccount[];
    }>(domain, token, '/loyalty/accounts', { 'page': 1, 'limit': 100 });

    const loyaltyByCustomer = new Map<number, RetailLoyaltyAccount>();
    for (const a of loyaltyResp.loyaltyAccounts ?? []) {
      if (a.customer?.id !== undefined) {
        loyaltyByCustomer.set(a.customer.id, a);
      }
    }

    const orders = ordersOnPage.map((o) => {
      const acc = o.customer?.id !== undefined
        ? loyaltyByCustomer.get(o.customer.id)
        : undefined;
      return {
        id: o.id,
        number: o.number ?? String(o.id),
        customer_name:
          [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') ||
          o.customer?.email ||
          '—',
        total: typeof o.totalSumm === 'number' ? o.totalSumm : 0,
        status: o.status ?? '—',
        created_at: o.createdAt ?? '—',
        bonus_credited: typeof o.bonusesCreditTotal === 'number' ? o.bonusesCreditTotal : 0,
        bonus_charged: typeof o.bonusesChargeTotal === 'number' ? o.bonusesChargeTotal : 0,
        loyalty_balance: typeof acc?.amount === 'number' ? acc.amount : null,
        loyalty_level: o.loyaltyLevel?.name || acc?.level?.name || null,
        loyalty_privilege_pct: typeof acc?.level?.privilegeSize === 'number'
          ? acc.level.privilegeSize
          : null,
      };
    });

    return ok(c, {
      source: `${domain}.retailcrm.ru`,
      pagination: {
        page,
        limit,
        total_count: ordersResp.pagination?.totalCount ?? 0,
        total_pages: ordersResp.pagination?.totalPageCount ?? 1,
      },
      search,
      orders,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'crm_upstream_error', message: msg }]);
  }
});

// =============================================================================
// GET /api/crm/customers — paginated, searchable customers feed with loyalty
// =============================================================================
// Query params:
//   page    — 1-based page number (default 1)
//   limit   — 20 / 50 / 100 (default 50)
//   search  — free-text by name (filter[name]); if digits-only, tries phone
crm.get('/customers', async (c) => {
  const domain = c.env.RETAIL_CRM_DOMAIN;
  const token = c.env.RETAIL_CRM_TOKEN;
  if (!domain || !token) {
    return fail(c, 503, [{ code: 'crm_not_configured', message: 'Retail CRM not configured.' }]);
  }

  const page = Math.max(1, Number(c.req.query('page') ?? 1));
  const rawLimit = Number(c.req.query('limit') ?? 50);
  const limit = [20, 50, 100].includes(rawLimit) ? rawLimit : 50;
  const search = (c.req.query('search') ?? '').trim();

  const params: Record<string, string | number | undefined> = {
    'page': page,
    'limit': limit,
  };

  if (search) {
    if (/^[\d+\s\-()]+$/.test(search) && search.replace(/\D/g, '').length >= 4) {
      // Digits-style → search by phone
      params['filter[phone]'] = search;
    } else {
      params['filter[name]'] = search;
    }
  }

  try {
    const customersResp = await retailGet<{
      pagination?: { totalCount?: number; currentPage?: number; totalPageCount?: number };
      customers?: RetailCustomer[];
    }>(domain, token, '/customers', params);

    const customersOnPage = customersResp.customers ?? [];

    // Pull loyalty accounts to enrich balance & level per customer
    const loyaltyResp = await retailGet<{
      loyaltyAccounts?: RetailLoyaltyAccount[];
    }>(domain, token, '/loyalty/accounts', { 'page': 1, 'limit': 100 });

    const loyaltyByCustomer = new Map<number, RetailLoyaltyAccount>();
    for (const a of loyaltyResp.loyaltyAccounts ?? []) {
      if (a.customer?.id !== undefined) {
        loyaltyByCustomer.set(a.customer.id, a);
      }
    }

    const customers = customersOnPage.map((cu) => {
      const acc = loyaltyByCustomer.get(cu.id);
      const phone = cu.phones?.[0]?.number ?? null;
      return {
        id: cu.id,
        name: [cu.firstName, cu.lastName].filter(Boolean).join(' ') || cu.email || '—',
        email: cu.email ?? null,
        phone,
        orders_count: typeof cu.ordersCount === 'number' ? cu.ordersCount : 0,
        total_spent: typeof cu.totalSumm === 'number' ? cu.totalSumm : 0,
        average_order: typeof cu.averageSumm === 'number' ? cu.averageSumm : 0,
        created_at: cu.createdAt ?? '—',
        loyalty_balance: typeof acc?.amount === 'number' ? acc.amount : null,
        loyalty_level: acc?.level?.name ?? null,
        loyalty_privilege_pct: typeof acc?.level?.privilegeSize === 'number'
          ? acc.level.privilegeSize
          : null,
      };
    });

    return ok(c, {
      source: `${domain}.retailcrm.ru`,
      pagination: {
        page,
        limit,
        total_count: customersResp.pagination?.totalCount ?? 0,
        total_pages: customersResp.pagination?.totalPageCount ?? 1,
      },
      search,
      customers,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'crm_upstream_error', message: msg }]);
  }
});

// =============================================================================
// GET /api/crm/timeline — daily registrations + orders for last 30 days
// =============================================================================
// Walks Retail CRM customers + orders, groups by day. Used by the Daily
// activity chart on /crm page. Yandex Metrika visits are merged client-side.
crm.get('/timeline', async (c) => {
  const domain = c.env.RETAIL_CRM_DOMAIN;
  const token = c.env.RETAIL_CRM_TOKEN;
  if (!domain || !token) {
    return fail(c, 503, [{ code: 'crm_not_configured', message: 'Retail CRM not configured.' }]);
  }

  // Build last 30 day window — UTC days, oldest first
  const days = 30;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setUTCDate(today.getUTCDate() - (days - 1));

  const dayKeys: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate);
    d.setUTCDate(startDate.getUTCDate() + i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }

  const startIso = startDate.toISOString().slice(0, 10);
  const endIso = today.toISOString().slice(0, 10);

  // Counters: dayKey -> count
  const regsByDay = new Map<string, number>(dayKeys.map((k) => [k, 0]));
  const ordersByDay = new Map<string, number>(dayKeys.map((k) => [k, 0]));

  function bumpDay(map: Map<string, number>, isoTimestamp: string | undefined) {
    if (!isoTimestamp) return;
    const day = isoTimestamp.slice(0, 10);
    if (map.has(day)) {
      map.set(day, (map.get(day) ?? 0) + 1);
    }
  }

  try {
    // Walk all customers in window — Retail CRM uses dateFrom/dateTo for createdAt
    let page = 1;
    while (page <= 20) {
      const resp = await retailGet<{
        pagination?: { totalPageCount?: number; currentPage?: number };
        customers?: Array<{ createdAt?: string }>;
      }>(domain, token, '/customers', {
        'page': page,
        'limit': 100,
        'filter[dateFrom]': startIso,
        'filter[dateTo]': endIso,
      });
      for (const cu of resp.customers ?? []) bumpDay(regsByDay, cu.createdAt);
      const totalPages = resp.pagination?.totalPageCount ?? 1;
      if (page >= totalPages) break;
      page += 1;
    }

    // Walk all orders in window — Retail CRM uses createdAtFrom/createdAtTo
    page = 1;
    while (page <= 20) {
      const resp = await retailGet<{
        pagination?: { totalPageCount?: number; currentPage?: number };
        orders?: Array<{ createdAt?: string }>;
      }>(domain, token, '/orders', {
        'page': page,
        'limit': 100,
        'filter[createdAtFrom]': startIso,
        'filter[createdAtTo]': endIso,
      });
      for (const o of resp.orders ?? []) bumpDay(ordersByDay, o.createdAt);
      const totalPages = resp.pagination?.totalPageCount ?? 1;
      if (page >= totalPages) break;
      page += 1;
    }

    const timeline = dayKeys.map((day) => ({
      date: day,
      registrations: regsByDay.get(day) ?? 0,
      orders: ordersByDay.get(day) ?? 0,
    }));

    return ok(c, {
      source: `${domain}.retailcrm.ru`,
      window_days: days,
      timeline,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'crm_upstream_error', message: msg }]);
  }
});

export default crm;
