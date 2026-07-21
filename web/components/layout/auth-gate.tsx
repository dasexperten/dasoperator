'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getToken, getUser, refreshMe, setAuth, type AuthUser } from '@/lib/auth';

/**
 * AuthGate — wraps the app, ensures user is authenticated before rendering
 * anything except the /login page.
 *
 * Behaviour:
 *  - On /login → render children directly (no gate)
 *  - Elsewhere → if no token, push to /login. Else render children.
 *  - On mount also calls /api/auth/me silently to keep permissions fresh
 *    after server-side changes (self-heals stale localStorage).
 *  - Listens to 'dx-auth-change' so logout in another tab kicks user out.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    function check() {
      const token = getToken();
      const u = getUser();
      if (pathname === '/login') {
        setUser(null);
        setReady(true);
        return;
      }
      if (!token || !u) {
        // Preserve deep link so Android mail PWA returns to /mail after PIN
        const next = pathname && pathname !== '/'
          ? `?next=${encodeURIComponent(pathname)}`
          : '';
        router.replace(`/login${next}`);
        return;
      }
      setUser(u);
      setReady(true);
    }
    check();
    window.addEventListener('dx-auth-change', check);
    window.addEventListener('storage', check);
    return () => {
      window.removeEventListener('dx-auth-change', check);
      window.removeEventListener('storage', check);
    };
  }, [pathname, router]);

  // Background self-heal: pull a fresh user from the server on each mount,
  // merge new permissions into localStorage. Quietly noops if logged out.
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

  if (!ready) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: 'var(--brand-schwarz)',
          color: 'var(--paper)',
          fontSize: '14px',
        }}
      >
        Loading…
      </div>
    );
  }

  if (typeof document !== 'undefined' && user) {
    document.body.dataset.role = user.role;
    document.body.dataset.username = user.name;
  }

  return <>{children}</>;
}
