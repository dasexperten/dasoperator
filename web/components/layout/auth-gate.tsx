'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { getToken, getUser, refreshMe, setAuth, clearAuth, type AuthUser } from '@/lib/auth';

/**
 * AuthGate — wraps the app, ensures user is authenticated before staying
 * on anything except /login.
 *
 * Session lives in localStorage. useSyncExternalStore reads it on the first
 * client render — no "Loading…" gate. Parking the tree on Loading until
 * useEffect ran is what made /emailer look dead after hydrate.
 */
function subscribeAuth(cb: () => void) {
  window.addEventListener('dx-auth-change', cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener('dx-auth-change', cb);
    window.removeEventListener('storage', cb);
  };
}

function getAuthSnapshot(): AuthUser | null {
  return getToken() && getUser() ? getUser() : null;
}

function getServerAuthSnapshot(): AuthUser | null {
  return null;
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const user = useSyncExternalStore(subscribeAuth, getAuthSnapshot, getServerAuthSnapshot);

  useEffect(() => {
    if (pathname === '/login') return;
    const token = getToken();
    const u = getUser();
    if (!token || !u) {
      if (token && !u) clearAuth();
      const next = pathname && pathname !== '/'
        ? `?next=${encodeURIComponent(pathname)}`
        : '';
      window.location.replace(`/login${next}`);
    }
  }, [pathname]);

  useEffect(() => {
    if (pathname === '/login') return;
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    refreshMe().then((fresh) => {
      if (cancelled || !fresh) return;
      const expiresStr = window.localStorage.getItem('dx_auth_expires');
      const expires = expiresStr ? parseInt(expiresStr, 10) : Date.now() + 12 * 60 * 60 * 1000;
      setAuth(token, fresh, expires);
    });
    return () => { cancelled = true; };
  }, [pathname]);

  if (pathname === '/login') return <>{children}</>;

  if (typeof document !== 'undefined' && user) {
    document.body.dataset.role = user.role;
    document.body.dataset.username = user.name;
  }

  return <>{children}</>;
}
