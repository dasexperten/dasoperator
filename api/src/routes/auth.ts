// =============================================================================
// Auth routes — public login, authenticated me/logout
//
//   POST /api/auth/login   { pin }                       → { token, user }
//   GET  /api/auth/me      Authorization: Bearer <token> → { user }
//   POST /api/auth/logout  Authorization: Bearer <token> → { ok }
//
// Rate limiting: brute-force prevention via KV `auth_fail:<ip>` counter.
// 5 failed attempts in 15min → 15min lockout per IP.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import {
  verifyPin,
  createSession,
  validateSession,
  destroySession,
} from '../lib/auth';

const auth = new Hono<{ Bindings: Env }>();

const MAX_FAILS = 5;
const FAIL_WINDOW_SEC = 15 * 60; // 15 minutes

function clientIp(c: import('hono').Context): string {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0].trim() ??
    'unknown'
  );
}

function bearer(c: import('hono').Context): string | null {
  const h = c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
auth.post('/login', async (c) => {
  let body: { pin?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'bad_json', message: 'invalid JSON body' }]);
  }

  const pin = typeof body?.pin === 'string' ? body.pin.trim() : '';
  if (!/^\d{4}$/.test(pin)) {
    return fail(c, 400, [{ code: 'bad_pin', message: 'pin must be 4 digits' }]);
  }

  const ip = clientIp(c);
  const failKey = `auth_fail:${ip}`;

  // Rate-limit check
  const failsStr = await c.env.CACHE.get(failKey);
  const fails = failsStr ? parseInt(failsStr, 10) : 0;
  if (fails >= MAX_FAILS) {
    return fail(c, 429, [
      { code: 'too_many_attempts', message: 'too many failed attempts, try again later' },
    ]);
  }

  const user = await verifyPin(c.env.DB, pin);
  if (!user) {
    // Increment fail counter with sliding window
    await c.env.CACHE.put(failKey, String(fails + 1), { expirationTtl: FAIL_WINDOW_SEC });
    return fail(c, 401, [{ code: 'invalid_pin', message: 'incorrect pin' }]);
  }

  // Success — clear fail counter, create session
  await c.env.CACHE.delete(failKey);
  const ua = c.req.header('User-Agent') ?? null;
  const { token, expires_at } = await createSession(c.env.DB, user.id, ip, ua);

  return ok(c, {
    token,
    expires_at,
    user: { id: user.id, name: user.name, role: user.role },
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
auth.get('/me', async (c) => {
  const token = bearer(c);
  if (!token) {
    return fail(c, 401, [{ code: 'no_token', message: 'missing bearer token' }]);
  }
  const user = await validateSession(c.env.DB, token);
  if (!user) {
    return fail(c, 401, [{ code: 'invalid_session', message: 'session not found or expired' }]);
  }
  return ok(c, { user });
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
auth.post('/logout', async (c) => {
  const token = bearer(c);
  if (token) {
    await destroySession(c.env.DB, token);
  }
  return ok(c, { ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/auth/users — list of users (admin only)
// ---------------------------------------------------------------------------
auth.get('/users', async (c) => {
  const token = bearer(c);
  if (!token) {
    return fail(c, 401, [{ code: 'no_token', message: 'missing bearer token' }]);
  }
  const user = await validateSession(c.env.DB, token);
  if (!user) {
    return fail(c, 401, [{ code: 'invalid_session', message: 'session not found or expired' }]);
  }
  if (user.role !== 'admin') {
    return fail(c, 403, [{ code: 'forbidden', message: 'admin role required' }]);
  }

  const rows = await c.env.DB
    .prepare(`SELECT id, name, role, active, created_at, last_login_at FROM users ORDER BY
              CASE role WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'support' THEN 3 ELSE 4 END,
              name`)
    .all<{ id: string; name: string; role: string; active: number; created_at: number; last_login_at: number | null }>();

  return ok(c, { users: rows.results ?? [] });
});

export default auth;
