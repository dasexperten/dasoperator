// =============================================================================
// /api/direct — Yandex Direct campaign stats (RU paid contour).
//
// HARD RULE 4: DIRECT_OAUTH_TOKEN is not set yet. Until it lands as a Worker
// secret this endpoint returns { configured: false } with HTTP 200 — the UI
// renders an honest "not configured" state. No fabricated data, ever.
// The leg activates the day the token is stored; no code change needed.
//
// Endpoint: GET /api/direct/campaigns?days=30
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { cacheKey } from '../lib/kv-cache';
import { directConfigured, fetchDirectCampaigns, directWindow } from '../lib/direct';

const direct = new Hono<{ Bindings: Env }>();

direct.get('/campaigns', async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '30', 10) || 30, 1), 365);

  if (!directConfigured(c.env)) {
    // Graceful, 200 — the Campaigns tab shows the honest pending state.
    return ok(c, {
      configured: false,
      source: 'Yandex Direct Reports API v5',
      reason: 'DIRECT_OAUTH_TOKEN not set. Authorize the shared OAuth app with scope direct:api and store the token as a Worker secret — the column activates the same day.',
      window_days: days,
      rows: [],
      synced_at: Math.floor(Date.now() / 1000),
    });
  }

  try {
    // Manual KV read-through: only a completed report (status ok) is cached.
    // A 201/202 "report queued" answer must NOT be cached for an hour.
    const key = cacheKey('direct:campaigns', { days });
    try {
      const hit = await c.env.CACHE.get(key);
      if (hit !== null) return ok(c, JSON.parse(hit));
    } catch {
      // fall through
    }

    const { dateFrom, dateTo } = directWindow(days);
    const report = await fetchDirectCampaigns(c.env, dateFrom, dateTo);

    if (report.status === 'pending') {
      return ok(c, {
        configured: true,
        pending: true,
        source: 'Yandex Direct Reports API v5',
        retry_in_sec: report.retry_in_sec,
        window_days: days,
        rows: [],
        synced_at: Math.floor(Date.now() / 1000),
      });
    }
    if (report.status === 'error') {
      return fail(c, 502, [{ code: 'direct_upstream_error', message: report.message }]);
    }

    const rows = report.rows;
    const totals = {
      impressions: rows.reduce((a, r) => a + r.impressions, 0),
      clicks: rows.reduce((a, r) => a + r.clicks, 0),
      cost: Math.round(rows.reduce((a, r) => a + r.cost, 0) * 100) / 100,
      conversions: rows.reduce((a, r) => a + r.conversions, 0),
    };
    const payload = {
      configured: true,
      source: 'Yandex Direct Reports API v5 (CAMPAIGN_PERFORMANCE_REPORT, VAT incl.)',
      window_days: days,
      totals,
      rows,
      synced_at: Math.floor(Date.now() / 1000),
    };
    try {
      await c.env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 3600 });
    } catch {
      // ignore
    }
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'direct_upstream_error', message: msg }]);
  }
});

export default direct;
