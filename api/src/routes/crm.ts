import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const crm = new Hono<{ Bindings: Env }>();

// =============================================================================
// Retail CRM REST API v5 client
// =============================================================================
// Auth: X-API-KEY header.
// Base: https://{shop}.retailcrm.ru/api/v5
// Both env vars must be set: RETAIL_CRM_DOMAIN (e.g. "myshop") and
// RETAIL_CRM_TOKEN. If either missing, all /api/crm/* endpoints return
// a structured error so the frontend can show a "not configured" panel.

interface RetailOrder {
  id: number;
  number?: string;
  status?: string;
  totalSummary?: number;
  createdAt?: string;
  customer?: {
    firstName?: string;
    lastName?: string;
    email?: string;
  };
}

async function retailGet<T = unknown>(
  domain: string,
  token: string,
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(`https://${domain}.retailcrm.ru/api/v5${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
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

// =============================================================================
// GET /api/crm/stats — dashboard summary (customers, orders, revenue, recent)
// =============================================================================
crm.get('/stats', async (c) => {
  const domain = c.env.RETAIL_CRM_DOMAIN;
  const token = c.env.RETAIL_CRM_TOKEN;

  if (!domain || !token) {
    return fail(c, 503, [
      {
        code: 'crm_not_configured',
        message:
          'Retail CRM not configured. Set RETAIL_CRM_DOMAIN and RETAIL_CRM_TOKEN env/secret.',
      },
    ]);
  }

  try {
    // Customers count — single page, take totalCount header.
    const customersResp = await retailGet<{ pagination?: { totalCount?: number } }>(
      domain,
      token,
      '/customers',
      { 'page': 1, 'limit': 1 }
    );

    // Orders total
    const ordersTotalResp = await retailGet<{ pagination?: { totalCount?: number } }>(
      domain,
      token,
      '/orders',
      { 'page': 1, 'limit': 1 }
    );

    // Orders this month
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
      (sum, o) => sum + (typeof o.totalSummary === 'number' ? o.totalSummary : 0),
      0
    );

    // Recent orders (last 10)
    const recentResp = await retailGet<{ orders?: RetailOrder[] }>(
      domain,
      token,
      '/orders',
      { 'page': 1, 'limit': 10 }
    );

    const recentOrders = (recentResp.orders ?? []).map((o) => ({
      id: o.id,
      number: o.number ?? String(o.id),
      customer_name:
        [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') ||
        o.customer?.email ||
        '—',
      total: typeof o.totalSummary === 'number' ? o.totalSummary : 0,
      status: o.status ?? '—',
      created_at: o.createdAt ?? '—',
    }));

    return ok(c, {
      source: `${domain}.retailcrm.ru`,
      customers_total: customersResp.pagination?.totalCount ?? 0,
      orders_total: ordersTotalResp.pagination?.totalCount ?? 0,
      orders_this_month: ordersThisMonth,
      revenue_this_month_rub: revenueThisMonth,
      recent_orders: recentOrders,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'crm_upstream_error', message: msg }]);
  }
});

export default crm;
