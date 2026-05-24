// =============================================================================
// Auth library — PIN verification + session lifecycle
//
// PINs stored as PBKDF2-SHA256(pin, salt, 100k iter, 32 bytes), base64 encoded.
// Sessions stored in D1 `sessions` table, token = crypto.randomUUID().
// Session lifetime: 12 hours. Cleanup of expired sessions happens lazily on
// validate() (single DELETE per call when expired session is touched).
//
// Used by: routes/auth.ts (login/logout/me) and middleware/auth.ts (token guard).
// =============================================================================

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export type Role = 'admin' | 'manager' | 'support';

export interface UserRow {
  id: string;
  name: string;
  pin_hash: string;
  pin_salt: string;
  role: Role;
  active: number;
  created_at: number;
  last_login_at: number | null;
}

export interface SessionRow {
  token: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
}

// ---------------------------------------------------------------------------
// Base64 <-> bytes helpers (Web Crypto needs ArrayBuffer/Uint8Array)
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Constant-time comparison of two base64 strings (prevents timing leak).
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// PBKDF2 hash — matches Python seed: hashlib.pbkdf2_hmac('sha256', pin, salt, 100000, 32)
// ---------------------------------------------------------------------------

async function hashPin(pin: string, saltB64: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = base64ToBytes(saltB64);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256 // 32 bytes
  );
  return bytesToBase64(new Uint8Array(bits));
}

// ---------------------------------------------------------------------------
// verifyPin — iterates active users, returns matching user or null.
// For 3 trusted internal users this is fine; rate limiting handles brute force.
// ---------------------------------------------------------------------------

export async function verifyPin(db: D1Database, pin: string): Promise<UserRow | null> {
  // Basic shape check before crypto work
  if (!/^\d{4}$/.test(pin)) return null;

  const users = await db
    .prepare(`SELECT id, name, pin_hash, pin_salt, role, active, created_at, last_login_at
              FROM users WHERE active = 1`)
    .all<UserRow>();

  for (const u of users.results ?? []) {
    const computed = await hashPin(pin, u.pin_salt);
    if (constantTimeEqual(computed, u.pin_hash)) return u;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function createSession(
  db: D1Database,
  userId: string,
  ip: string | null,
  ua: string | null
): Promise<{ token: string; expires_at: number }> {
  const token = crypto.randomUUID().replace(/-/g, '');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await db
    .prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at, ip, user_agent)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(token, userId, now, expiresAt, ip, ua)
    .run();

  // Best-effort last_login_at update
  await db
    .prepare(`UPDATE users SET last_login_at = ?1 WHERE id = ?2`)
    .bind(now, userId)
    .run();

  return { token, expires_at: expiresAt };
}

export async function validateSession(
  db: D1Database,
  token: string
): Promise<AuthUser | null> {
  if (!token || token.length < 16) return null;

  const row = await db
    .prepare(
      `SELECT s.token, s.expires_at, u.id, u.name, u.role, u.active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?1
       LIMIT 1`
    )
    .bind(token)
    .first<{ token: string; expires_at: number; id: string; name: string; role: Role; active: number }>();

  if (!row) return null;
  if (row.active !== 1) return null;

  if (row.expires_at < Date.now()) {
    // Lazy cleanup
    await db.prepare(`DELETE FROM sessions WHERE token = ?1`).bind(token).run();
    return null;
  }

  return { id: row.id, name: row.name, role: row.role };
}

export async function destroySession(db: D1Database, token: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE token = ?1`).bind(token).run();
}

// ---------------------------------------------------------------------------
// Role permission map — used by frontend (copy in web/lib/auth.ts) and any
// server-side gating we add later. Keep in sync.
// ---------------------------------------------------------------------------

export const ROLE_ROUTES: Record<Role, string[]> = {
  admin: [
    '/', '/partners', '/operations', '/planner', '/products', '/warehouses',
    '/marketplaces', '/reviews', '/crm', '/finance', '/analytics', '/settings',
  ],
  manager: [
    '/', '/partners', '/operations', '/planner', '/products', '/warehouses',
    '/marketplaces', '/reviews', '/crm', '/analytics',
  ],
  support: [
    '/', '/partners', '/products', '/warehouses', '/marketplaces', '/reviews',
  ],
};

export function canAccessRoute(role: Role, route: string): boolean {
  // Exact-match for home; prefix-match for everything else.
  const allowed = ROLE_ROUTES[role] ?? [];
  if (route === '/') return allowed.includes('/');
  for (const r of allowed) {
    if (r === '/') continue;
    if (route === r || route.startsWith(r + '/')) return true;
  }
  return false;
}
