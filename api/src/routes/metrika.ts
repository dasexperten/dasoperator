import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const metrika = new Hono<{ Bindings: Env }>();

// =============================================================================
// Yandex Metrika Stat API client
// =============================================================================
// Auth: OAuth Bearer token in Authorization header
// Base: https://api-metrika.yandex.net/stat/v1

const METRIKA_BASE = 'https://api-metrika.yandex.net/stat/v1';

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

// =============================================================================
// GET /api/metrika/stats — today's KPI + 30-day daily timeline
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

    return ok(c, {
      source: `Yandex Metrika counter ${counter}`,
      counter_id: Number(counter),
      today: {
        // Prefer last timeline entry — Metrika's today endpoint can be sparse
        // mid-day; the bytime data is already populated even for the current day.
        visits: timeline.length ? timeline[timeline.length - 1].visits : Math.round(todayTotals[0] ?? 0),
        users: timeline.length ? timeline[timeline.length - 1].users : Math.round(todayTotals[1] ?? 0),
        bounce_rate_pct: Math.round((todayTotals[2] ?? 0) * 10) / 10,
        avg_duration_sec: Math.round(todayTotals[3] ?? 0),
      },
      timeline,
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'metrika_upstream_error', message: msg }]);
  }
});

export default metrika;
