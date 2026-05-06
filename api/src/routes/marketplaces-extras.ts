/**
 * Marketplace extras — endpoints layered on top of routes/marketplaces.ts.
 *
 * Kept in a separate file from routes/marketplaces.ts so this chat does not
 * step on edits made by the parallel chat that owns the main marketplaces
 * route. Wired into index.ts AFTER marketplacesRoutes — Hono picks the first
 * match, so paths added here must NOT collide with the main file.
 *
 * Phase 6.0b additions:
 *   GET /api/marketplaces/sync/log?limit=N
 *     Last N sync attempts (default 20) for the /marketplaces dashboard.
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';

const marketplacesExtras = new Hono<{ Bindings: Env }>();

marketplacesExtras.get('/sync/log', async (c) => {
  // Cap at 100 to keep payload small; default 20 is enough for the dashboard.
  const limitParam = c.req.query('limit');
  let limit = 20;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) limit = parsed;
  }

  const log = await c.env.DB.prepare(`
    SELECT id, marketplace, started_at, finished_at, status, rows_synced, error_message
    FROM marketplace_sync_log
    ORDER BY started_at DESC
    LIMIT ?
  `).bind(limit).all();

  return ok(c, { count: log.results.length, log: log.results });
});

export default marketplacesExtras;
