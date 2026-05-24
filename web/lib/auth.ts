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

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
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
    if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string' && typeof parsed.role === 'string') {
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
// Role → routes map. Mirrors api/src/lib/auth.ts.
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
  const allowed = ROLE_ROUTES[role] ?? [];
  if (route === '/') return allowed.includes('/');
  for (const r of allowed) {
    if (r === '/') continue;
    if (route === r || route.startsWith(r + '/')) return true;
  }
  return false;
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
