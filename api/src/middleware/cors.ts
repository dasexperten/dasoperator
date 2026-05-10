import type { MiddlewareHandler } from 'hono';

// =============================================================================
// CORS middleware
// Allows requests from dasoperator.pages.dev (production frontend) and from
// localhost during dev. Other origins get blocked.
// =============================================================================

const ALLOWED_ORIGINS = [
  'https://dasoperator.pages.dev',
  'http://localhost:3000',
  'http://localhost:8788',
];

export const corsMiddleware: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('Origin');

  // Preflight OPTIONS request
  if (c.req.method === 'OPTIONS') {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    return new Response(null, { status: 403 });
  }

  await next();

  // Add CORS headers to response if origin is allowed
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
  }
};
