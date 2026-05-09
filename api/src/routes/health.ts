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

  const [dbStatus, docsStatus, pricelistsStatus, countersStatus, fxStatus, cacheStatus, documentsCheck] =
    await Promise.all([
      checkBinding(() => env.DB.prepare('SELECT 1 as ping').first()),
      checkBinding(() => env.DOCS.head('__healthcheck__')),
      checkBinding(() => env.PRICELISTS.head('__healthcheck__')),
      checkBinding(() => env.COUNTERS.get('__healthcheck__')),
      checkBinding(() => env.FX.get('__healthcheck__')),
      checkBinding(() => env.CACHE.get('__healthcheck__')),
      env.DB.prepare('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL')
        .first<{ n: number }>()
        .then((r) => ({ status: 'ok' as const, count: r?.n ?? 0 }))
        .catch((err) => ({
          status: 'error' as const,
          error: err instanceof Error ? err.message : String(err),
        })),
    ]);

  const result: HealthStatus & { documents_table: typeof documentsCheck } = {
    worker: 'ok',
    bindings: {
      DB: dbStatus,
      DOCS: docsStatus,
      PRICELISTS: pricelistsStatus,
      COUNTERS: countersStatus,
      FX: fxStatus,
      CACHE: cacheStatus,
    },
    documents_table: documentsCheck,
    timestamp: new Date().toISOString(),
  };

  return ok(c, result);
});

export default health;
