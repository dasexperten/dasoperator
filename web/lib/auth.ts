// =============================================================================
// Client-side auth helpers — stores token in localStorage, exposes role map.
//
// The Worker is on a different subdomain than Pages (dasoperator-api.* vs
// dasoperator.pages.dev), so cookies can't be shared without explicit
// SameSite=None + Secure dance. Bearer token in localStorage is simpler and
// works for an internal tool used by 3 people.
//
// Mirror of api/src/lib/auth.ts ROLE_ROUTES — keep both in sync.
// =============================================================================

export type Role = 'admin' | 'manager' | 'support';
export type Access = 'full' | 'rw' | 'read' | 'none';

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  permissions: Record<string, Access>;
}

const TOKEN_KEY = 'dx_auth_token';
const USER_KEY = 'dx_auth_user';
const EXPIRES_KEY = 'dx_auth_expires';

// ---------------------------------------------------------------------------
// Local storage accessors — guarded for SSR (no `window` during build).
// ---------------------------------------------------------------------------

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  const s = safeStorage();
  if (!s) return null;
  const token = s.getItem(TOKEN_KEY);
  const expiresStr = s.getItem(EXPIRES_KEY);
  if (!token) return null;
  if (expiresStr) {
    const expires = parseInt(expiresStr, 10);
    if (Number.isFinite(expires) && expires < Date.now()) {
      clearAuth();
      return null;
    }
  }
  return token;
}

export function getUser(): AuthUser | null {
  const s = safeStorage();
  if (!s) return null;
  const raw = s.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.id === 'string' &&
      typeof parsed.name === 'string' &&
      typeof parsed.role === 'string'
    ) {
      // Permissions added in v2 — older sessions without it default to {}
      if (!parsed.permissions || typeof parsed.permissions !== 'object') {
        parsed.permissions = {};
      }
      return parsed as AuthUser;
    }
  } catch { /* ignore */ }
  return null;
}

export function setAuth(token: string, user: AuthUser, expiresAt: number): void {
  const s = safeStorage();
  if (!s) return;
  s.setItem(TOKEN_KEY, token);
  s.setItem(USER_KEY, JSON.stringify(user));
  s.setItem(EXPIRES_KEY, String(expiresAt));
  // Notify listeners (other tabs / same-tab AuthGate)
  try {
    window.dispatchEvent(new CustomEvent('dx-auth-change'));
  } catch { /* ignore */ }
}

export function clearAuth(): void {
  const s = safeStorage();
  if (!s) return;
  s.removeItem(TOKEN_KEY);
  s.removeItem(USER_KEY);
  s.removeItem(EXPIRES_KEY);
  try {
    window.dispatchEvent(new CustomEvent('dx-auth-change'));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// All known modules — canonical set, must match api/src/lib/auth.ts.
// ---------------------------------------------------------------------------

export const ALL_MODULES = [
  '/', '/partners', '/operations', '/planner', '/products', '/warehouses',
  '/marketplaces', '/reviews', '/crm', '/emailer', '/finance', '/analytics', '/settings',
] as const;

// Whether the user has any access at all to a route — drives sidebar visibility.
// Admins always pass (safety net so a corrupted/empty permissions object can
// never lock out the admin who must un-lock themselves).
export function hasModuleAccess(user: AuthUser, route: string): boolean {
  if (user.role === 'admin') return true;
  const perms = user.permissions ?? {};
  if (route === '/') return (perms['/'] ?? 'none') !== 'none';
  for (const m of ALL_MODULES) {
    if (m === '/') continue;
    if (route === m || route.startsWith(m + '/')) {
      return (perms[m] ?? 'none') !== 'none';
    }
  }
  return false;
}

// Backwards-compat shim so older imports of canAccessRoute still work.
export function canAccessRoute(_role: Role, route: string): boolean {
  const u = getUser();
  if (!u) return false;
  return hasModuleAccess(u, route);
}

// Human-friendly label for the role badge.
export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  support: 'Support',
};

// ---------------------------------------------------------------------------
// Server calls
// ---------------------------------------------------------------------------

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export async function login(pin: string): Promise<{ ok: true; user: AuthUser } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      const code = json?.errors?.[0]?.code ?? 'login_failed';
      const msg = json?.errors?.[0]?.message ?? `error ${res.status}`;
      return { ok: false, error: code === 'too_many_attempts' ? 'Too many attempts — wait 15 minutes' : msg };
    }
    setAuth(json.result.token, json.result.user, json.result.expires_at);
    return { ok: true, user: json.result.user };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? 'network error' };
  }
}

export async function logout(): Promise<void> {
  const token = getToken();
  if (token) {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore */ }
  }
  clearAuth();
}

export async function refreshMe(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      if (res.status === 401) clearAuth();
      return null;
    }
    const json = await res.json();
    return json?.result?.user ?? null;
  } catch {
    return null;
  }
}

