import { Hono } from 'hono';
import type { Env } from '../types';
import { wbRequest } from '../lib/wb-gateway';
import { reconcileWbSettlementRounding } from '../lib/wb-settlement-rounding';

const route = new Hono<{ Bindings: Env }>();

route.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const secret = (c.env as Env & { ERP_RUN_SECRET?: string }).ERP_RUN_SECRET;
  const given = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '');
  let diff = 0;
  if (!secret || given.length !== secret.length) return c.json({ ok: false, error: 'unauthorized' }, 401);
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  if (diff) return c.json({ ok: false, error: 'unauthorized' }, 401);
  await next();
});

// This report neither requests a return nor changes inventory.
route.get('/goods-returns', async (c) => {
  const from = c.req.query('dateFrom') ?? '';
  const to = c.req.query('dateTo') ?? '';
  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!validDate(from) || !validDate(to) || to < from
      || (Date.parse(to) - Date.parse(from)) / 86400000 >= 31) {
    return c.json({ ok: false, error: 'dateFrom/dateTo must be valid dates spanning at most 31 inclusive days' }, 400);
  }
  const status = c.req.query('status');
  const limitText = c.req.query('limit') ?? '1000';
  const offsetText = c.req.query('offset') ?? '0';
  const limit = Number(limitText);
  const offset = Number(offsetText);
  if ((status !== undefined && status !== 'active' && status !== 'archive')
      || !/^\d+$/.test(limitText) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
      || !/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) || offset < 0) {
    return c.json({ ok: false, error: 'status must be active/archive; limit must be 1..1000; offset must be a non-negative safe integer' }, 400);
  }
  // WB retires the unpaginated endpoint on 26 October 2026.
  const paginated = c.req.query('limit') !== undefined || c.req.query('offset') !== undefined;
  const url = new URL('https://seller-analytics-api.wildberries.ru/api/analytics/v1/item-returns');
  url.searchParams.set('dateFrom', from);
  url.searchParams.set('dateTo', to);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (status) url.searchParams.set('status', status);
  try {
    const response = await wbRequest(c.env, url);
    if (!response.ok) {
      const retry = response.headers.get('Retry-After') ?? response.headers.get('X-Ratelimit-Retry');
      if (retry) c.header('Retry-After', retry);
      return c.json({ ok: false, error: 'WB return report unavailable', upstream_status: response.status }, response.status === 429 ? 429 : 502);
    }
    const body = response.status === 204 ? { count: 0, report: [] }
      : await response.json() as { count?: unknown; report?: unknown };
    if (!Array.isArray(body.report) || typeof body.count !== 'number'
        || !Number.isSafeInteger(body.count) || body.count < 0 || body.report.length > limit
        || (body.report.length > 0 && offset + body.report.length > body.count)
        || (body.report.length === 0 && offset < body.count)) {
      return c.json({ ok: false, error: 'Unexpected WB return report response' }, 502);
    }
    const hasMore = offset + body.report.length < body.count;
    // Old consumers expected a full report. Never silently give them page one.
    if (!paginated && hasMore) {
      return c.json({ ok: false, error: 'WB report requires pagination; request limit and offset explicitly',
        count: body.count, limit, offset, complete: false }, 409);
    }
    return c.json({ ok: true, date_from: from, date_to: to, status: status ?? null,
      fetched_at: new Date().toISOString(), count: body.count, limit, offset,
      has_more: hasMore, next_offset: hasMore ? offset + body.report.length : null,
      complete: offset === 0 && !hasMore, report: body.report });
  } catch {
    return c.json({ ok: false, error: 'WB return report request failed' }, 502);
  }
});

route.post('/settlements/:id/reconcile-rounding', async (c) => {
  try {
    return c.json({ ok:true, ...await reconcileWbSettlementRounding(c.env.DB,c.req.param('id')) });
  } catch (error) {
    // Deliberately no raw database error/financial record disclosure.
    return c.json({ ok:false, error:'Settlement could not be reconciled; verify source lines, payment/document links and concurrent changes' },409);
  }
});

// Separate explicit action: rounding-only callers never change fee treatment.
route.post('/settlements/:id/reconcile-rebill', async (c) => {
  try {
    return c.json({ ok:true, ...await reconcileWbSettlementRounding(c.env.DB,c.req.param('id'),'rebill') });
  } catch {
    return c.json({ ok:false, error:'Rebill correction requires audited source components, unchanged lines and no linked payments/documents' },409);
  }
});

export default route;
