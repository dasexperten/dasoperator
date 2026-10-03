import { Hono } from 'hono';
import type { Env } from '../types';
import { wbRequest } from '../lib/wb-gateway';

const route = new Hono<{ Bindings: Env }>();

// Return identifiers and collection locations are available only to ERP operators.
// This is a read-only report: it neither requests a return nor changes inventory.
route.get('/goods-returns', async (c) => {
  c.header('Cache-Control', 'no-store');
  const secret = (c.env as Env & { ERP_RUN_SECRET?: string }).ERP_RUN_SECRET;
  const given = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '');
  let diff = 0;
  if (!secret || given.length !== secret.length) return c.json({ ok: false, error: 'unauthorized' }, 401);
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  if (diff) return c.json({ ok: false, error: 'unauthorized' }, 401);

  const from = c.req.query('dateFrom') ?? '';
  const to = c.req.query('dateTo') ?? '';
  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!validDate(from) || !validDate(to) || to < from
      || (Date.parse(to) - Date.parse(from)) / 86400000 >= 31) {
    return c.json({ ok: false, error: 'dateFrom/dateTo must be valid dates spanning at most 31 inclusive days' }, 400);
  }
  const url = new URL('https://seller-analytics-api.wildberries.ru/api/v1/analytics/goods-return');
  url.searchParams.set('dateFrom', from);
  url.searchParams.set('dateTo', to);
  try {
    const response = await wbRequest(c.env, url);
    if (!response.ok) {
      const retry = response.headers.get('Retry-After') ?? response.headers.get('X-Ratelimit-Retry');
      if (retry) c.header('Retry-After', retry);
      return c.json({ ok: false, error: 'WB return report unavailable', upstream_status: response.status }, response.status === 429 ? 429 : 502);
    }
    const body = await response.json() as { report?: unknown };
    if (!Array.isArray(body.report)) return c.json({ ok: false, error: 'Unexpected WB return report response' }, 502);
    return c.json({ ok: true, date_from: from, date_to: to, fetched_at: new Date().toISOString(), report: body.report });
  } catch {
    return c.json({ ok: false, error: 'WB return report request failed' }, 502);
  }
});

export default route;
