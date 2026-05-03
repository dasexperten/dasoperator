import type { MiddlewareHandler } from 'hono';

// Simple request logger — logs method, path, status, latency.
// In Phase 2.x will pipe to Cloudflare Logpush or R2 audit log.
export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  const { method, path } = c.req;

  await next();

  const duration = Date.now() - start;
  console.log(`[REQ] ${method} ${path} -> ${c.res.status} (${duration}ms)`);
};
