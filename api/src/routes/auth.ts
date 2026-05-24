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
  parsePermissions,
  ALL_MODULES,
  type ModuleKey,
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
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      permissions: parsePermissions(user.permissions),
    },
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
// GET /api/auth/users — list of users with permissions (admin only)
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
    .prepare(`SELECT id, name, role, active, permissions, created_at, last_login_at FROM users ORDER BY
              CASE role WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'support' THEN 3 ELSE 4 END,
              name`)
    .all<{ id: string; name: string; role: string; active: number; permissions: string; created_at: number; last_login_at: number | null }>();

  const users = (rows.results ?? []).map((u) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    active: u.active,
    permissions: parsePermissions(u.permissions),
    created_at: u.created_at,
    last_login_at: u.last_login_at,
  }));

  return ok(c, { users });
});

// ---------------------------------------------------------------------------
// PATCH /api/auth/users/:id/permissions — change one module's access level
// Body: { module: string, access: 'full' | 'rw' | 'read' | 'none' }
// Admin-only. Refuses to edit admin users (keeps admins admin).
// ---------------------------------------------------------------------------
const VALID_MODULES = new Set(ALL_MODULES);
const VALID_ACCESS = new Set(['full', 'rw', 'read', 'none']);

auth.patch('/users/:id/permissions', async (c) => {
  const token = bearer(c);
  if (!token) {
    return fail(c, 401, [{ code: 'no_token', message: 'missing bearer token' }]);
  }
  const me = await validateSession(c.env.DB, token);
  if (!me) {
    return fail(c, 401, [{ code: 'invalid_session', message: 'session not found or expired' }]);
  }
  if (me.role !== 'admin') {
    return fail(c, 403, [{ code: 'forbidden', message: 'admin role required' }]);
  }

  const targetId = c.req.param('id');
  if (!targetId) {
    return fail(c, 400, [{ code: 'bad_id', message: 'user id required' }]);
  }

  let body: { module?: unknown; access?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'bad_json', message: 'invalid JSON body' }]);
  }

  const mod = typeof body?.module === 'string' ? body.module : '';
  const access = typeof body?.access === 'string' ? body.access : '';

  if (!VALID_MODULES.has(mod as ModuleKey)) {
    return fail(c, 400, [{ code: 'bad_module', message: `unknown module: ${mod}` }]);
  }
  if (!VALID_ACCESS.has(access)) {
    return fail(c, 400, [{ code: 'bad_access', message: `access must be one of full/rw/read/none` }]);
  }

  // Fetch target user
  const target = await c.env.DB
    .prepare(`SELECT id, role, permissions FROM users WHERE id = ?1 LIMIT 1`)
    .bind(targetId)
    .first<{ id: string; role: string; permissions: string }>();

  if (!target) {
    return fail(c, 404, [{ code: 'user_not_found', message: 'user not found' }]);
  }

  // Admin users are locked — their permissions stay 'full' everywhere.
  if (target.role === 'admin') {
    return fail(c, 409, [{ code: 'admin_locked', message: 'admin users cannot be edited from the matrix' }]);
  }

  // Merge change into existing JSON
  const perms = parsePermissions(target.permissions);
  perms[mod] = access as 'full' | 'rw' | 'read' | 'none';
  const newJson = JSON.stringify(perms);

  await c.env.DB
    .prepare(`UPDATE users SET permissions = ?1 WHERE id = ?2`)
    .bind(newJson, targetId)
    .run();

  return ok(c, { id: targetId, permissions: perms });
});

export default auth;
