import { Hono } from 'hono';
import type { BindingStatus, Env, HealthStatus } from '../types';
import { ok } from '../lib/responses';

// =============================================================================
// GET /health — deep health check
// Pings each binding (D1, R2, all 3 KV) and returns status + latency.
// =============================================================================

const health = new Hono<{ Bindings: Env }>();

async function checkBinding(check: () => Promise<unknown>): Promise<BindingStatus> {
  const start = Date.now();
  try {
    await check();
    return { status: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

health.get('/', async (c) => {
  const env = c.env;

  const [dbStatus, docsStatus, countersStatus, fxStatus, cacheStatus] = await Promise.all([
    checkBinding(() => env.DB.prepare('SELECT 1 as ping').first()),
    checkBinding(() => env.DOCS.head('__healthcheck__')),  // head on non-existent key is fine
    checkBinding(() => env.COUNTERS.get('__healthcheck__')),
    checkBinding(() => env.FX.get('__healthcheck__')),
    checkBinding(() => env.CACHE.get('__healthcheck__')),
  ]);

  const result: HealthStatus = {
    worker: 'ok',
    bindings: {
      DB: dbStatus,
      DOCS: docsStatus,
      COUNTERS: countersStatus,
      FX: fxStatus,
      CACHE: cacheStatus,
    },
    timestamp: new Date().toISOString(),
  };

  return ok(c, result);
});

export default health;
