// =============================================================================
// /api/clarity — Microsoft Clarity behavior insight for dasexperten.com.
//
// QUOTA DISCIPLINE (HARD RULE 2): Clarity allows 10 API calls/project/day.
// The nightly cron makes exactly ONE call and pre-warms the KV key this
// endpoint reads (24h TTL). A dashboard hit only goes upstream on a cold
// cache (fresh deploy / KV eviction), so worst-case usage stays at ~2/day.
//
// Endpoint: GET /api/clarity/behavior?days=1   (days clamped 1..3 — API max)
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { fetchClarityBehavior, clarityCacheKey } from '../lib/clarity';

const clarity = new Hono<{ Bindings: Env }>();

clarity.get('/behavior', async (c) => {
  if (!c.env.CLARITY_API_TOKEN) {
    return fail(c, 503, [
      { code: 'clarity_not_configured', message: 'Clarity not configured. Set CLARITY_API_TOKEN.' },
    ]);
  }
  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '1', 10) || 1, 1), 3);

  try {
    // Read-through KV manually (not withKvCache) so the nightly cron can
    // write the very same key after its single upstream call.
    const key = clarityCacheKey(days);
    try {
      const hit = await c.env.CACHE.get(key);
      if (hit !== null) return ok(c, JSON.parse(hit));
    } catch {
      // KV read failure — fall through
    }

    const payload = await fetchClarityBehavior(c.env, days);
    try {
      await c.env.CACHE.put(key, JSON.stringify(payload), { expirationTtl: 86400 });
    } catch {
      // cache-write failure never breaks the response
    }
    return ok(c, payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return fail(c, 502, [{ code: 'clarity_upstream_error', message: msg }]);
  }
});

export default clarity;
