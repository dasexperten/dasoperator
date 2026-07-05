import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { withKvCache, cacheKey } from '../lib/kv-cache';

const metrika = new Hono<{ Bindings: Env }>();

// =============================================================================
// Yandex Metrika Stat API client
// =============================================================================
// Auth: OAuth Bearer token in Authorization header
// Base: https://api-metrika.yandex.net/stat/v1

const METRIKA_BASE = 'https://api-metrika.yandex.net/stat/v1';
const MGMT_BASE = 'https://api-metrika.yandex.net/management/v1';

// Ecommerce: purchase goal id on counter 107720199 (verified 2026-07-05).
// Used as the canonical "purchase" conversion across all audit endpoints.
const PURCHASE_GOAL_ID = '541778813';

async function metrikaGet<T = unknown>(
  token: string,
  path: string,
  params: Record<string, string | number>
): Promise<T> {
  const url = new URL(`${METRIKA_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Authorization': `OAuth ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Yandex Metrika HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function metrikaMgmt<T = unknown>(
  token: string,
  path: string,
  params: Record<string, string | number> = {}
): Promise<T> {
  const url = new URL(`${MGMT_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Authorization': `OAuth ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Yandex Metrika Mgmt HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// =============================================================================
// GET /api/metrika/stats - today's KPI + 30-day daily timeline
// =============================================================================
metrika.get('/stats', async (c) => {
  const counter = c.env.YANDEX_METRIKA_COUNTER;
  const token = c.env.YANDEX_METRIKA_TOKEN;

  if (!counter || !token) {
    return fail(c, 503, [
      {
        code: 'metrika_not_configured',
        message:
          'Yandex Metrika not configured. Set YANDEX_METRIKA_COUNTER and YANDEX_METRIKA_TOKEN.',
      },
    ]);
  }

  try {
    const payload = await withKvCache(
      c.env,
      cacheKey('metrika:stats', { counter }),
      300,
      async () => {
        // Today's totals
        const todayResp = await metrikaGet<{
          totals: number[][];
        }>(token, '/data', {
          ids: counter,
          metrics: 'ym:s:visits,ym:s:users,ym:s:bounceRate,ym:s:avgVisitDurationSeconds',
          date1: 'today',
          date2: 'today',
          accuracy: 'full',
        });

        const todayTotals = todayResp.totals?.[0] ?? [0, 0, 0, 0];

        // 30-day timeline by day (visits + users)
        const timelineResp = await metrikaGet<{
          time_intervals: string[][];
          data: Array<{ metrics: number[][] }>;
        }>(token, '/data/bytime', {
          ids: counter,
          metrics: 'ym:s:visits,ym:s:users',
          date1: '30daysAgo',
          date2: 'today',
          group: 'day',
        });

        const intervals = timelineResp.time_intervals ?? [];
        // bytime returns metrics[metric_index] = array of values per day
        const dataRow = timelineResp.data?.[0]?.metrics ?? [[], []];
        const visitsSeries = dataRow[0] ?? [];
        const usersSeries = dataRow[1] ?? [];

        const timeline = intervals.map((iv, idx) => ({
          date: iv[0]?.slice(0, 10) ?? '',
          visits: Math.round(visitsSeries[idx] ?? 0),
          users: Math.round(usersSeries[idx] ?? 0),
        }));

        return {
          source: `Yandex Metrika counter ${counter}`,
          counter_id: Number(counter),
          today: {
            // Prefer last timeline entry - Metrika's today endpoint can be sparse
            // mid-day; the bytime data is already populated even for the current day.
            visits: timeline.length ? timeline[timeline.length - 1].visits : Math.round(todayTotals[0] ?? 0),
            users: timeline.length ? timeline[timeline.length - 1].users : Math.round(todayTotals[1] ?? 0),
            bounce_rate_pct: Math.round((todayTotals[2] ?? 0) * 10) / 10,
            avg_duration_sec: Math.round(todayTotals[3] ?? 0),
          },
          timeline,
          synced_at: Math.floor(Date.now() / 1000),
        };
      }
    );
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'metrika_upstream_error', message: msg }]);
  }
});

// =============================================================================
// GET /api/metrika/sources?days=90 - traffic-source breakdown with purchases + CR
// =============================================================================
// Dimensions: ym:s:lastTrafficSource
// Metrics: ym:s:visits, ym:s:goal<PURCHASE_GOAL_ID>reaches
// Returns: rows { source, visits, purchases, cr } + totals
// KV cache: 5 min
metrika.get('/sources', async (c) => {
  const counter = c.env.YANDEX_METRIKA_COUNTER;
  const token = c.env.YANDEX_METRIKA_TOKEN;
  if (!counter || !token) {
    return fail(c, 503, [{ code: 'metrika_not_configured', message: 'Yandex Metrika not configured.' }]);
  }
  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '90', 10) || 90, 1), 365);
  const date1 = `${days}daysAgo`;

  try {
    const payload = await withKvCache(
      c.env,
      cacheKey('metrika:sources', { counter, days }),
      300,
      async () => {
        const resp = await metrikaGet<{
          totals: number[];
          data: Array<{ metrics: number[]; dimensions: Array<{ name: string }> }>;
        }>(token, '/data', {
          ids: counter,
          metrics: `ym:s:visits,ym:s:goal${PURCHASE_GOAL_ID}reaches`,
          dimensions: 'ym:s:lastTrafficSource',
          date1,
          date2: 'today',
          sort: '-ym:s:visits',
          limit: 50,
          accuracy: 'full',
        });

        const totals = resp.totals ?? [0, 0];
        const rows = (resp.data ?? []).map((r) => {
          const visits = Math.round(r.metrics[0] ?? 0);
          const purchases = Math.round(r.metrics[1] ?? 0);
          const cr = visits > 0 ? Math.round((purchases / visits) * 10000) / 100 : 0;
          return {
            source: r.dimensions[0]?.name ?? 'Unknown',
            visits,
            purchases,
            cr,
          };
        });

        return {
          source: `Yandex Metrika counter ${counter}`,
          window_days: days,
          totals: {
            visits: Math.round(totals[0] ?? 0),
            purchases: Math.round(totals[1] ?? 0),
            cr: (totals[0] ?? 0) > 0 ? Math.round(((totals[1] ?? 0) / totals[0]) * 10000) / 100 : 0,
          },
          rows,
          synced_at: Math.floor(Date.now() / 1000),
        };
      }
    );
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'metrika_upstream_error', message: msg }]);
  }
});

// =============================================================================
// GET /api/metrika/phrases?days=90&limit=200 - top organic search phrases
// =============================================================================
// Dimensions: ym:s:searchPhrase
// Metrics: ym:s:visits
// KV cache: 15 min
metrika.get('/phrases', async (c) => {
  const counter = c.env.YANDEX_METRIKA_COUNTER;
  const token = c.env.YANDEX_METRIKA_TOKEN;
  if (!counter || !token) {
    return fail(c, 503, [{ code: 'metrika_not_configured', message: 'Yandex Metrika not configured.' }]);
  }
  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '90', 10) || 90, 1), 365);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '200', 10) || 200, 1), 1000);
  const date1 = `${days}daysAgo`;

  try {
    const payload = await withKvCache(
      c.env,
      cacheKey('metrika:phrases', { counter, days, limit }),
      900,
      async () => {
        const resp = await metrikaGet<{
          totals: number[];
          data: Array<{ metrics: number[]; dimensions: Array<{ name: string }> }>;
        }>(token, '/data', {
          ids: counter,
          metrics: 'ym:s:visits',
          dimensions: 'ym:s:searchPhrase',
          date1,
          date2: 'today',
          sort: '-ym:s:visits',
          limit,
          accuracy: 'full',
        });

        const total = Math.round(resp.totals?.[0] ?? 0);
        const rows = (resp.data ?? []).map((r) => ({
          phrase: r.dimensions[0]?.name ?? '',
          visits: Math.round(r.metrics[0] ?? 0),
        }));

        return {
          source: `Yandex Metrika counter ${counter}`,
          window_days: days,
          total_visits_with_phrase: total,
          rows,
          synced_at: Math.floor(Date.now() / 1000),
        };
      }
    );
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'metrika_upstream_error', message: msg }]);
  }
});

// =============================================================================
// GET /api/metrika/goals - list goals on the counter (id -> name)
// =============================================================================
// KV cache: 24h (goals rarely change)
metrika.get('/goals', async (c) => {
  const counter = c.env.YANDEX_METRIKA_COUNTER;
  const token = c.env.YANDEX_METRIKA_TOKEN;
  if (!counter || !token) {
    return fail(c, 503, [{ code: 'metrika_not_configured', message: 'Yandex Metrika not configured.' }]);
  }

  try {
    const payload = await withKvCache(
      c.env,
      cacheKey('metrika:goals', { counter }),
      86400,
      async () => {
        const resp = await metrikaMgmt<{ goals: Array<{ id: number; name: string; type: string }> }>(
          token,
          `/counter/${counter}/goals`
        );
        const goals = (resp.goals ?? []).map((g) => ({
          id: g.id,
          name: g.name,
          type: g.type,
        }));
        return {
          counter_id: Number(counter),
          goals,
          synced_at: Math.floor(Date.now() / 1000),
        };
      }
    );
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'metrika_upstream_error', message: msg }]);
  }
});

export default metrika;
