// =============================================================================
// /api/ga4 — GA4 Data API endpoints for the dasexperten.com global contour.
//
// Clone of the metrika.ts pattern: fetch -> normalize -> KV cache ->
// { window_days, totals, rows, synced_at }. Auth is the service-account JWT
// flow in lib/ga4.ts (token KV-cached 55 min).
//
// Endpoints:
//   GET /overview  — sessions, users, purchases, revenue by day (+ returning split)
//   GET /channels  — sessionDefaultChannelGroup breakdown
//   GET /pages     — landing pages
//   GET /funnel    — page_view -> view_item -> add_to_cart -> begin_checkout -> purchase
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { withKvCache, cacheKey } from '../lib/kv-cache';
import { ga4Configured, ga4RunReport, ga4Date, metricNum } from '../lib/ga4';

const ga4 = new Hono<{ Bindings: Env }>();

const round2 = (n: number) => Math.round(n * 100) / 100;

function windowDays(c: { req: { query: (k: string) => string | undefined } }, def = 30): number {
  return Math.min(Math.max(parseInt(c.req.query('days') ?? String(def), 10) || def, 1), 365);
}

function notConfigured(c: any) {
  return fail(c, 503, [
    {
      code: 'ga4_not_configured',
      message: 'GA4 not configured. Set GA4_PROPERTY_ID and GA4_SA_KEY Worker secrets.',
    },
  ]);
}

function sourceLabel(env: Env): string {
  return `GA4 property ${env.GA4_PROPERTY_ID} (dasexperten.com, global contour)`;
}

// =============================================================================
// GET /api/ga4/overview?days=30 — daily sessions/users/purchases/revenue
// + newVsReturning purchase split for the returning-customer rate.
// KV cache: 1h
// =============================================================================
ga4.get('/overview', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c);

  try {
    const payload = await withKvCache(c.env, cacheKey('ga4:overview', { days }), 3600, async () => {
      const daily = await ga4RunReport(c.env, {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'ecommercePurchases' },
          { name: 'purchaseRevenue' },
        ],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
        limit: 366,
      });

      const rows = (daily.rows ?? []).map((r) => ({
        date: ga4Date(r.dimensionValues?.[0]?.value ?? ''),
        sessions: Math.round(metricNum(r, 0)),
        users: Math.round(metricNum(r, 1)),
        purchases: Math.round(metricNum(r, 2)),
        revenue: round2(metricNum(r, 3)),
      }));

      const sum = (k: 'sessions' | 'users' | 'purchases' | 'revenue') =>
        rows.reduce((a, r) => a + r[k], 0);
      const sessions = sum('sessions');
      const purchases = sum('purchases');
      const revenue = round2(sum('revenue'));

      // Returning-customer rate, GA4 definition: purchases by returning users
      // over all purchases (newVsReturning dimension). Labelled GA4-defined in
      // the UI — this is NOT the Shopify D1-orders definition.
      let returning: { new_purchases: number; returning_purchases: number; rate_pct: number | null } = {
        new_purchases: 0,
        returning_purchases: 0,
        rate_pct: null,
      };
      try {
        const nvr = await ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [{ name: 'newVsReturning' }],
          metrics: [{ name: 'ecommercePurchases' }],
        });
        for (const r of nvr.rows ?? []) {
          const label = r.dimensionValues?.[0]?.value ?? '';
          const p = Math.round(metricNum(r, 0));
          if (label === 'returning') returning.returning_purchases += p;
          else if (label === 'new') returning.new_purchases += p;
        }
        const totalP = returning.new_purchases + returning.returning_purchases;
        returning.rate_pct = totalP > 0 ? round2((returning.returning_purchases / totalP) * 100) : null;
      } catch (e) {
        console.error('[ga4:overview] newVsReturning leg failed (non-fatal):', e);
      }

      return {
        source: sourceLabel(c.env),
        window_days: days,
        totals: {
          sessions,
          users: sum('users'),
          purchases,
          revenue,
          cr: sessions > 0 ? round2((purchases / sessions) * 100) : 0, // purchases / sessions
          aov: purchases > 0 ? round2(revenue / purchases) : 0, // revenue / purchases
        },
        returning,
        rows,
        synced_at: Math.floor(Date.now() / 1000),
      };
    });
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'ga4_upstream_error', message: msg }]);
  }
});

// =============================================================================
// GET /api/ga4/channels?days=30 — sessionDefaultChannelGroup breakdown
// KV cache: 1h
// =============================================================================
ga4.get('/channels', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c);

  try {
    const payload = await withKvCache(c.env, cacheKey('ga4:channels', { days }), 3600, async () => {
      const resp = await ga4RunReport(c.env, {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'ecommercePurchases' },
          { name: 'purchaseRevenue' },
        ],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 50,
      });

      const rows = (resp.rows ?? []).map((r) => {
        const sessions = Math.round(metricNum(r, 0));
        const purchases = Math.round(metricNum(r, 2));
        return {
          channel: r.dimensionValues?.[0]?.value ?? 'Unknown',
          sessions,
          users: Math.round(metricNum(r, 1)),
          purchases,
          revenue: round2(metricNum(r, 3)),
          cr: sessions > 0 ? round2((purchases / sessions) * 100) : 0,
        };
      });

      const tSessions = rows.reduce((a, r) => a + r.sessions, 0);
      const tPurchases = rows.reduce((a, r) => a + r.purchases, 0);

      return {
        source: sourceLabel(c.env),
        window_days: days,
        totals: {
          sessions: tSessions,
          users: rows.reduce((a, r) => a + r.users, 0),
          purchases: tPurchases,
          revenue: round2(rows.reduce((a, r) => a + r.revenue, 0)),
          cr: tSessions > 0 ? round2((tPurchases / tSessions) * 100) : 0,
        },
        rows,
        synced_at: Math.floor(Date.now() / 1000),
      };
    });
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'ga4_upstream_error', message: msg }]);
  }
});

// =============================================================================
// GET /api/ga4/pages?days=30&limit=50 — landing pages
// KV cache: 1h
// =============================================================================
ga4.get('/pages', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 250);

  try {
    const payload = await withKvCache(c.env, cacheKey('ga4:pages', { days, limit }), 3600, async () => {
      const resp = await ga4RunReport(c.env, {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'landingPage' }],
        metrics: [{ name: 'sessions' }, { name: 'ecommercePurchases' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit,
      });

      const rows = (resp.rows ?? []).map((r) => {
        const sessions = Math.round(metricNum(r, 0));
        const purchases = Math.round(metricNum(r, 1));
        return {
          page: r.dimensionValues?.[0]?.value || '(not set)',
          sessions,
          purchases,
          cr: sessions > 0 ? round2((purchases / sessions) * 100) : 0,
        };
      });

      return {
        source: sourceLabel(c.env),
        window_days: days,
        totals: {
          sessions: rows.reduce((a, r) => a + r.sessions, 0),
          purchases: rows.reduce((a, r) => a + r.purchases, 0),
        },
        rows,
        synced_at: Math.floor(Date.now() / 1000),
      };
    });
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'ga4_upstream_error', message: msg }]);
  }
});

// =============================================================================
// GET /api/ga4/funnel?days=30 — e-commerce funnel event counts.
// Steps: sessions (base) -> view_item -> add_to_cart -> begin_checkout -> purchase.
// Step rates are computed vs the previous step; overall rate vs sessions.
// KV cache: 1h
// =============================================================================
const FUNNEL_EVENTS = ['page_view', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'];

ga4.get('/funnel', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c);

  try {
    const payload = await withKvCache(c.env, cacheKey('ga4:funnel', { days }), 3600, async () => {
      const [sessionsResp, eventsResp] = await Promise.all([
        ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          metrics: [{ name: 'sessions' }],
        }),
        ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              inListFilter: { values: FUNNEL_EVENTS },
            },
          },
        }),
      ]);

      const sessions = Math.round(metricNum(sessionsResp.rows?.[0] ?? {}, 0));
      const counts = new Map<string, number>();
      for (const r of eventsResp.rows ?? []) {
        counts.set(r.dimensionValues?.[0]?.value ?? '', Math.round(metricNum(r, 0)));
      }

      // Funnel per brief 4.3: session -> view_item -> add_to_cart ->
      // begin_checkout -> purchase (page_view kept as reference row).
      const stepNames = ['sessions', 'view_item', 'add_to_cart', 'begin_checkout', 'purchase'];
      const stepCounts = [
        sessions,
        counts.get('view_item') ?? 0,
        counts.get('add_to_cart') ?? 0,
        counts.get('begin_checkout') ?? 0,
        counts.get('purchase') ?? 0,
      ];
      const rows = stepNames.map((step, i) => {
        const count = stepCounts[i] ?? 0;
        const prev = i === 0 ? null : stepCounts[i - 1] ?? 0;
        return {
          step,
          count,
          rate_vs_prev_pct: prev && prev > 0 ? round2((count / prev) * 100) : null,
          rate_vs_sessions_pct: sessions > 0 ? round2((count / sessions) * 100) : null,
        };
      });

      return {
        source: sourceLabel(c.env),
        window_days: days,
        // NOTE for UI: step units differ — sessions vs event counts. A session
        // can fire an event multiple times; rates are indicative, labelled.
        totals: {
          sessions,
          page_view_events: counts.get('page_view') ?? 0,
          purchases: counts.get('purchase') ?? 0,
          overall_cr: sessions > 0 ? round2(((counts.get('purchase') ?? 0) / sessions) * 100) : 0,
        },
        rows,
        synced_at: Math.floor(Date.now() / 1000),
      };
    });
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'ga4_upstream_error', message: msg }]);
  }
});

export default ga4;
