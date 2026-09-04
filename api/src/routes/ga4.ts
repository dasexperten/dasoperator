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
//   GET /acquisition-detail — channel + campaign + country + landing funnel
//   GET /funnel    — page_view -> view_item -> add_to_cart -> begin_checkout -> purchase
//   GET /commerce-losses — downstream progress, failures and marketplace handoffs
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { withKvCache, cacheKey } from '../lib/kv-cache';
import { ga4Configured, ga4RunReport, ga4RunRealtimeReport, ga4Date, metricNum } from '../lib/ga4';

const ga4 = new Hono<{ Bindings: Env }>();

const round2 = (n: number) => Math.round(n * 100) / 100;

function windowDays(c: { req: { query: (k: string) => string | undefined } }, def = 30): number {
  return Math.min(Math.max(parseInt(c.req.query('days') ?? String(def), 10) || def, 1), 365);
}

// A one-day decision window is used immediately after commerce releases. Keeping
// it for an hour makes a real post-release event indistinguishable from a stale
// pre-release aggregate. Longer analytical windows remain hourly to avoid
// unnecessary GA4 quota pressure.
function decisionCacheTtl(days: number): number {
  return days === 1 ? 300 : 3600;
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
// GET /api/ga4/acquisition-detail?days=7&limit=100
// Actionable acquisition grain: one row ties the traffic source to its campaign,
// visitor country, landing page and downstream commerce steps. The separate
// /channels and /pages endpoints cannot reveal whether a high-volume landing is
// organic, paid or concentrated in a country where its checkout mode differs.
// KV cache: 1h
// =============================================================================
ga4.get('/acquisition-detail', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c, 7);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '100', 10) || 100, 1), 250);

  try {
    const payload = await withKvCache(
      c.env,
      cacheKey('ga4:acquisition-detail:v2', { days, limit }),
      decisionCacheTtl(days),
      async () => {
        const resp = await ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [
            { name: 'sessionDefaultChannelGroup' },
            { name: 'sessionCampaignName' },
            { name: 'country' },
            { name: 'landingPage' },
          ],
          metrics: [
            { name: 'sessions' },
            { name: 'engagedSessions' },
            { name: 'addToCarts' },
            { name: 'checkouts' },
            { name: 'ecommercePurchases' },
            { name: 'purchaseRevenue' },
          ],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit,
        });

        const rows = (resp.rows ?? []).map((r) => {
          const sessions = Math.round(metricNum(r, 0));
          const engagedSessions = Math.round(metricNum(r, 1));
          const purchases = Math.round(metricNum(r, 4));
          return {
            channel: r.dimensionValues?.[0]?.value || '(not set)',
            campaign: r.dimensionValues?.[1]?.value || '(not set)',
            country: r.dimensionValues?.[2]?.value || '(not set)',
            landing_page: r.dimensionValues?.[3]?.value || '(not set)',
            sessions,
            engaged_sessions: engagedSessions,
            engagement_rate_pct: sessions > 0 ? round2((engagedSessions / sessions) * 100) : 0,
            add_to_carts: Math.round(metricNum(r, 2)),
            checkouts: Math.round(metricNum(r, 3)),
            purchases,
            revenue: round2(metricNum(r, 5)),
            cr: sessions > 0 ? round2((purchases / sessions) * 100) : 0,
          };
        });

        return {
          source: sourceLabel(c.env),
          window_days: days,
          method:
            'GA4 session acquisition dimensions joined to aggregate ecommerce metrics; rows are acquisition segments, not user-level paths.',
          totals: {
            sessions: rows.reduce((a, r) => a + r.sessions, 0),
            engaged_sessions: rows.reduce((a, r) => a + r.engaged_sessions, 0),
            add_to_carts: rows.reduce((a, r) => a + r.add_to_carts, 0),
            checkouts: rows.reduce((a, r) => a + r.checkouts, 0),
            purchases: rows.reduce((a, r) => a + r.purchases, 0),
            revenue: round2(rows.reduce((a, r) => a + r.revenue, 0)),
          },
          rows,
          synced_at: Math.floor(Date.now() / 1000),
        };
      }
    );
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

// =============================================================================
// GET /api/ga4/commerce-losses?days=30&limit=250
// Cart-to-payment observability. The headline funnel hides whether a checkout
// stopped before payment, hit a technical/shipping failure, or deliberately left
// for a marketplace. Keep those outcomes separate: a marketplace handoff is not
// an on-site purchase and a checkout_error is not customer reluctance.
// KV cache: 1h
// =============================================================================
const COMMERCE_LOSS_EVENTS = [
  'add_to_cart',
  'view_cart',
  'begin_checkout',
  'checkout_loaded',
  'shipping_quote_ready',
  'add_payment_info',
  'checkout_error',
  'checkout_error_required_fields',
  'checkout_error_stripe_load_failed',
  'checkout_error_quote_invalid',
  'checkout_error_quote_failed',
  'checkout_error_card_declined',
  'checkout_error_wallet_confirm_failed',
  'checkout_error_intent_failed',
  'paid_locale_landing_vn',
  'paid_locale_landing_th',
  'paid_locale_landing_tl',
  'paid_locale_landing_ms',
  'paid_locale_landing_zh',
  'pdp_value_proof_view',
  'pdp_price_view',
  'shipping_unavailable',
  'shipping_quote_request',
  'shipping_bundle_offer',
  'shipping_bundle_unavailable',
  'shipping_bundle_add',
  'marketplace_open',
  'marketplace_click',
  'purchase',
];

ga4.get('/commerce-losses', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '250', 10) || 250, 1), 250);

  try {
    const payload = await withKvCache(
      c.env,
      cacheKey('ga4:commerce-losses:v7', { days, limit }),
      decisionCacheTtl(days),
      async () => {
        const resp = await ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [
            { name: 'eventName' },
            { name: 'country' },
            { name: 'pagePath' },
            { name: 'sessionCampaignName' },
            { name: 'dateHourMinute' },
          ],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              inListFilter: { values: COMMERCE_LOSS_EVENTS },
            },
          },
          orderBys: [{ dimension: { dimensionName: 'dateHourMinute' }, desc: true }],
          limit: 10000,
        });

        const rows = (resp.rows ?? []).map((r) => ({
          event: r.dimensionValues?.[0]?.value || '(not set)',
          country: r.dimensionValues?.[1]?.value || '(not set)',
          page: r.dimensionValues?.[2]?.value || '(not set)',
          campaign: r.dimensionValues?.[3]?.value || '(not set)',
          event_minute: r.dimensionValues?.[4]?.value || '',
          count: Math.round(metricNum(r, 0)),
        }));
        const totals = Object.fromEntries(COMMERCE_LOSS_EVENTS.map((event) => [event, 0])) as Record<string, number>;
        for (const row of rows) totals[row.event] = (totals[row.event] ?? 0) + row.count;
        const market_totals = {
          vn_add_to_cart: rows
            .filter((row) => row.event === 'add_to_cart' && row.country === 'Vietnam')
            .reduce((sum, row) => sum + row.count, 0),
        };

        return {
          source: sourceLabel(c.env),
          window_days: days,
          method: 'GA4 event counts grouped by country, event page, session campaign and property-timezone minute; rows are aggregate signals, not user-level paths.',
          totals,
          market_totals,
          rows: rows.slice(0, limit),
          synced_at: Math.floor(Date.now() / 1000),
        };
      }
    );
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'ga4_upstream_error', message: msg }]);
  }
});


// =============================================================================
// GET /api/ga4/geo?days=7 — active users by country (choropleth + table).
// KV cache: 1h
// =============================================================================
ga4.get('/geo', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c, 7);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 250);

  try {
    const payload = await withKvCache(c.env, cacheKey('ga4:geo', { days, limit }), 3600, async () => {
      const resp = await ga4RunReport(c.env, {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'country' }, { name: 'countryId' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit,
      });

      const rows = (resp.rows ?? []).map((r) => ({
        country: r.dimensionValues?.[0]?.value || '(not set)',
        country_id: r.dimensionValues?.[1]?.value || '',
        active_users: Math.round(metricNum(r, 0)),
      }));

      // Prior period (for the delta arrows the UI shows per-row) — same shape,
      // matched by country name. Best-effort: skipped silently on failure.
      let prevByCountry = new Map<string, number>();
      try {
        const prev = await ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo` }],
          dimensions: [{ name: 'country' }],
          metrics: [{ name: 'activeUsers' }],
          limit,
        });
        for (const r of prev.rows ?? []) {
          prevByCountry.set(r.dimensionValues?.[0]?.value ?? '', Math.round(metricNum(r, 0)));
        }
      } catch (e) {
        console.error('[ga4:geo] prior-period leg failed (non-fatal):', e);
      }

      const rowsWithDelta = rows.map((r) => {
        const prev = prevByCountry.get(r.country);
        const delta_pct = prev && prev > 0 ? round2(((r.active_users - prev) / prev) * 100) : null;
        return { ...r, delta_pct };
      });

      return {
        source: sourceLabel(c.env),
        window_days: days,
        totals: { active_users: rows.reduce((a, r) => a + r.active_users, 0) },
        rows: rowsWithDelta,
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
// GET /api/ga4/languages?days=30 — active users by (UI) language.
// KV cache: 1h
// =============================================================================
ga4.get('/languages', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '15', 10) || 15, 1), 100);

  try {
    const payload = await withKvCache(c.env, cacheKey('ga4:languages', { days, limit }), 3600, async () => {
      const resp = await ga4RunReport(c.env, {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'language' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit,
      });

      const rows = (resp.rows ?? []).map((r) => ({
        language: r.dimensionValues?.[0]?.value || '(not set)',
        active_users: Math.round(metricNum(r, 0)),
      }));

      return {
        source: sourceLabel(c.env),
        window_days: days,
        totals: { active_users: rows.reduce((a, r) => a + r.active_users, 0) },
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
// GET /api/ga4/content?days=7&limit=25 — views by page title & screen name.
// KV cache: 1h
// =============================================================================
ga4.get('/content', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c, 7);
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '25', 10) || 25, 1), 250);

  try {
    const payload = await withKvCache(c.env, cacheKey('ga4:content:v4', { days, limit }), 3600, async () => {
      const [resp, commerce] = await Promise.all([ga4RunReport(c.env, {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'unifiedScreenName' }, { name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit,
      }), ga4RunReport(c.env, {
        dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'eventName' }, { name: 'unifiedScreenName' }, { name: 'pagePath' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: [
          'paid_locale_landing_vn', 'pdp_value_proof_view', 'pdp_price_view',
          'add_to_cart', 'view_cart', 'shipping_preview_ready',
          'shipping_bundle_offer', 'shipping_bundle_add', 'shipping_bundle_unavailable',
          'begin_checkout', 'checkout_loaded', 'shipping_quote_ready',
          'add_payment_info', 'purchase', 'checkout_error',
        ] } } },
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: 250,
      })]);

      const rows = (resp.rows ?? []).map((r) => ({
        title: r.dimensionValues?.[0]?.value || '(not set)',
        page: r.dimensionValues?.[1]?.value || '(not set)',
        views: Math.round(metricNum(r, 0)),
      }));
      const commerce_rows = (commerce.rows ?? []).map((r) => ({
        event: r.dimensionValues?.[0]?.value || '(not set)',
        title: r.dimensionValues?.[1]?.value || '(not set)',
        page: r.dimensionValues?.[2]?.value || '(not set)',
        count: Math.round(metricNum(r, 0)),
      }));

      return {
        source: sourceLabel(c.env),
        window_days: days,
        totals: { views: rows.reduce((a, r) => a + r.views, 0) },
        rows,
        commerce_rows,
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
// GET /api/ga4/snapshot?days=28 — ecommerce snapshot: activeUsers, addToCarts,
// checkouts (begin_checkout), ecommercePurchases — daily series, current window
// vs the immediately preceding window of equal length (for the delta chips).
// No KV cache on the "current" leg beyond the standard 1h — this backs the
// GA4-style Reports-snapshot card, refreshed hourly is plenty.
// =============================================================================
ga4.get('/snapshot', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c, 28);

  try {
    const payload = await withKvCache(c.env, cacheKey('ga4:snapshot', { days }), 3600, async () => {
      const metrics = [
        { name: 'activeUsers' },
        { name: 'addToCarts' },
        { name: 'checkouts' },
        { name: 'ecommercePurchases' },
      ];

      const [current, previous] = await Promise.all([
        ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [{ name: 'date' }],
          metrics,
          orderBys: [{ dimension: { dimensionName: 'date' } }],
          limit: 366,
        }),
        ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo` }],
          metrics,
        }),
      ]);

      const rows = (current.rows ?? []).map((r) => ({
        date: ga4Date(r.dimensionValues?.[0]?.value ?? ''),
        active_users: Math.round(metricNum(r, 0)),
        add_to_carts: Math.round(metricNum(r, 1)),
        checkouts: Math.round(metricNum(r, 2)),
        purchases: Math.round(metricNum(r, 3)),
      }));

      const sum = (k: 'active_users' | 'add_to_carts' | 'checkouts' | 'purchases') =>
        rows.reduce((a, r) => a + r[k], 0);

      const prevRow = previous.rows?.[0];
      const prevTotals = {
        active_users: Math.round(metricNum(prevRow ?? {}, 0)),
        add_to_carts: Math.round(metricNum(prevRow ?? {}, 1)),
        checkouts: Math.round(metricNum(prevRow ?? {}, 2)),
        purchases: Math.round(metricNum(prevRow ?? {}, 3)),
      };

      const totals = {
        active_users: sum('active_users'),
        add_to_carts: sum('add_to_carts'),
        checkouts: sum('checkouts'),
        purchases: sum('purchases'),
      };

      const deltaPct = (cur: number, prev: number) => (prev > 0 ? round2(((cur - prev) / prev) * 100) : null);

      return {
        source: sourceLabel(c.env),
        window_days: days,
        totals,
        previous_totals: prevTotals,
        deltas_pct: {
          active_users: deltaPct(totals.active_users, prevTotals.active_users),
          add_to_carts: deltaPct(totals.add_to_carts, prevTotals.add_to_carts),
          checkouts: deltaPct(totals.checkouts, prevTotals.checkouts),
          purchases: deltaPct(totals.purchases, prevTotals.purchases),
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
// GET /api/ga4/nav-flows?days=30 — Wix "Top navigation flows" analogue.
// GA4's Data API has no session-path dimension (that needs the BigQuery
// export), so this is the honest pairwise version:
//   entries — landingPage sessions (the "1st page" column)
//   edges   — pageReferrer -> pagePath transitions, internal referrers only
// The UI labels the method; edges are page-view transitions, not full paths.
// KV cache: 1h
// =============================================================================
ga4.get('/nav-flows', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);
  const days = windowDays(c);

  try {
    const payload = await withKvCache(c.env, cacheKey('ga4:nav-flows', { days }), 3600, async () => {
      const [entriesResp, edgesResp] = await Promise.all([
        ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [{ name: 'landingPage' }],
          metrics: [{ name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: 10,
        }),
        ga4RunReport(c.env, {
          dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
          dimensions: [{ name: 'pageReferrer' }, { name: 'pagePath' }],
          metrics: [{ name: 'screenPageViews' }],
          // Internal navigation only — referrer on our own host.
          dimensionFilter: {
            filter: {
              fieldName: 'pageReferrer',
              stringFilter: { matchType: 'CONTAINS', value: 'dasexperten.com' },
            },
          },
          orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
          limit: 250,
        }),
      ]);

      const entries = (entriesResp.rows ?? []).map((r) => ({
        page: r.dimensionValues?.[0]?.value || '(not set)',
        sessions: Math.round(metricNum(r, 0)),
      }));
      const entrySessions = entries.reduce((a, r) => a + r.sessions, 0);

      // Referrer is a full URL — reduce to a path and aggregate (from, to)
      // edges, dropping self-loops (reloads / hash navigation).
      const edgeMap = new Map<string, { from: string; to: string; views: number }>();
      for (const r of edgesResp.rows ?? []) {
        const ref = r.dimensionValues?.[0]?.value ?? '';
        const to = r.dimensionValues?.[1]?.value || '(not set)';
        let from = '(not set)';
        try {
          from = new URL(ref).pathname || '/';
        } catch {
          /* non-URL referrer value — keep (not set) */
        }
        if (from === to) continue;
        const key = `${from} ${to}`;
        const cur = edgeMap.get(key);
        const views = Math.round(metricNum(r, 0));
        if (cur) cur.views += views;
        else edgeMap.set(key, { from, to, views });
      }
      const edges = [...edgeMap.values()].sort((a, b) => b.views - a.views).slice(0, 20);
      const edgeViews = edges.reduce((a, e) => a + e.views, 0);

      return {
        source: sourceLabel(c.env),
        window_days: days,
        method:
          'GA4 pairwise transitions (pageReferrer → pagePath, internal only) — not full session paths; those require the BigQuery export.',
        totals: { entry_sessions: entrySessions, edge_views: edgeViews },
        entries,
        edges,
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
// GET /api/ga4/realtime — active users in the last 30 min, per-minute buckets
// + breakdown by country. No caching (realtime is realtime); GA4 realtime API
// quota is generous (separate from the Data API's runReport quota).
// =============================================================================
ga4.get('/realtime', async (c) => {
  if (!ga4Configured(c.env)) return notConfigured(c);

  try {
    const commerceEventNames = [
      'paid_locale_landing_vn', 'paid_locale_landing_th', 'paid_locale_landing_tl',
      'paid_locale_landing_ms', 'paid_locale_landing_zh', 'view_item', 'add_to_cart',
      'pdp_value_proof_view', 'pdp_price_view',
      'view_cart', 'shipping_preview_ready', 'shipping_bundle_offer',
      'shipping_bundle_unavailable',
      'shipping_bundle_add', 'begin_checkout', 'checkout_loaded',
      'shipping_quote_ready', 'add_payment_info', 'purchase', 'checkout_error',
    ];
    const [perMinute, byCountry, fiveMin, byAudience, byPage, byEvent] = await Promise.all([
      ga4RunRealtimeReport(c.env, {
        dimensions: [{ name: 'minutesAgo' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ dimension: { dimensionName: 'minutesAgo' } }],
        limit: 30,
      }),
      ga4RunRealtimeReport(c.env, {
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 15,
      }),
      // True distinct count for the "last 5 minutes" card — minuteRanges, not
      // a sum of per-minute buckets (those would double-count users).
      ga4RunRealtimeReport(c.env, {
        metrics: [{ name: 'activeUsers' }],
        minuteRanges: [{ startMinutesAgo: 4, endMinutesAgo: 0 }],
      }),
      ga4RunRealtimeReport(c.env, {
        dimensions: [{ name: 'audienceName' }],
        metrics: [{ name: 'activeUsers' }],
        orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
        limit: 10,
      }),
      ga4RunRealtimeReport(c.env, {
        dimensions: [{ name: 'unifiedScreenName' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10,
      }),
      ga4RunRealtimeReport(c.env, {
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: 10,
      }),
    ]);

    // minutesAgo comes back "0".."29" (0 = current minute); reverse so the
    // chart reads oldest -> newest, left to right, like the GA4 widget.
    const perMinuteRows = (perMinute.rows ?? [])
      .map((r) => ({
        minutes_ago: parseInt(r.dimensionValues?.[0]?.value ?? '0', 10),
        active_users: Math.round(metricNum(r, 0)),
      }))
      .sort((a, b) => b.minutes_ago - a.minutes_ago);

    const countryRows = (byCountry.rows ?? []).map((r) => ({
      country: r.dimensionValues?.[0]?.value || '(not set)',
      active_users: Math.round(metricNum(r, 0)),
    }));

    const dimRows = (rep: typeof byAudience, key: string) =>
      (rep.rows ?? []).map((r) => ({
        [key]: r.dimensionValues?.[0]?.value || '(not set)',
        count: Math.round(metricNum(r, 0)),
      }));

    return ok(c, {
      source: sourceLabel(c.env),
      active_users_now: countryRows.reduce((a, r) => a + r.active_users, 0),
      active_users_5min: Math.round(metricNum(fiveMin.rows?.[0] ?? {}, 0)),
      per_minute: perMinuteRows,
      by_country: countryRows,
      by_audience: dimRows(byAudience, 'audience'),
      by_page: dimRows(byPage, 'title'),
      by_event: dimRows(byEvent, 'event'),
      // NOTE for UI: GA4's realtime "by First user source" card has no
      // Realtime-API dimension — cut, never faked (audienceName is supported).
      synced_at: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'ga4_upstream_error', message: msg }]);
  }
});


export default ga4;
