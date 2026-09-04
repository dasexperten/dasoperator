import type { MiddlewareHandler } from 'hono';

// =============================================================================
// CORS middleware
// Allows the production frontends, localhost dev, AND any Cloudflare Pages
// PREVIEW deployment of the dasoperator project (*.dasoperator.pages.dev).
// Preview branches get a fresh subdomain each deploy, so they must be matched
// by pattern — otherwise every preview is CORS-blocked and login fails.
// =============================================================================

const ALLOWED_ORIGINS = [
  'https://dasoperator.pages.dev',
  'https://erp.dasexperten.com',
  'https://bonus.dasexperten.ru',
  'https://das-bonus.pages.dev',
  'http://localhost:3000',
  'http://localhost:8788',
];

// Cloudflare Pages preview aliases: <branch>.dasoperator.pages.dev and
// <hash>.dasoperator.pages.dev. Production alias is covered by the list above.
const PREVIEW_RE = /^https:\/\/[a-z0-9][a-z0-9-]*\.dasoperator\.pages\.dev$/;

function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin) || PREVIEW_RE.test(origin);
}

export const corsMiddleware: MiddlewareHandler = async (c, next) => {
  // /geo-price is a public storefront endpoint with its own permissive CORS for
  // the dasexperten.com origins — let that route own its headers entirely.
  if (c.req.path === '/geo-price') return next();

  const origin = c.req.header('Origin');

  // Preflight OPTIONS request
  if (c.req.method === 'OPTIONS') {
    if (origin && isAllowedOrigin(origin)) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    return new Response(null, { status: 403 });
  }

  await next();

  // Add CORS headers to response if origin is allowed
  if (origin && isAllowedOrigin(origin)) {
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.set('Access-Control-Allow-Credentials', 'true');
    c.res.headers.set('Vary', 'Origin');
    // Замер по шагам виден со страницы только явно открытым: без этого
    // Server-Timing существует, но браузеру его не отдают, и «где ушло
    // время» опять становится догадкой.
    c.res.headers.set('Access-Control-Expose-Headers', 'Server-Timing, X-Mail-Body-Cache');
  }
};

