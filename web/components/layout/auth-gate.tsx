'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getToken, getUser, refreshMe, setAuth, clearAuth, type AuthUser } from '@/lib/auth';

/**
 * AuthGate — wraps the app, ensures user is authenticated before rendering
 * anything except the /login page.
 *
 * SSR always paints the same "Loading…" node so the tree hydrates. Children
 * (ERP pages) mount only after a client check. Rendering children on the
 * server crashed the whole ERP: localStorage-backed state did not match HTML.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

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
        if (token && !u) clearAuth();
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
