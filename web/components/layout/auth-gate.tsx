'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getToken, getUser, type AuthUser } from '@/lib/auth';

/**
 * AuthGate — wraps the app, ensures user is authenticated before rendering
 * anything except the /login page.
 *
 * Behaviour:
 *  - On /login → render children directly (no gate)
 *  - Elsewhere → if no token, push to /login. Else render children.
 *  - Listens to 'dx-auth-change' so logout in another tab kicks user out.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  // On mount + on storage events: check token, gate or pass.
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
        router.replace('/login');
        return;
      }
      setUser(u);
      setReady(true);
    }
    check();
    window.addEventListener('dx-auth-change', check);
    window.addEventListener('storage', check); // cross-tab
    return () => {
      window.removeEventListener('dx-auth-change', check);
      window.removeEventListener('storage', check);
    };
  }, [pathname, router]);

  // On /login page: render straight away.
  if (pathname === '/login') return <>{children}</>;

  // Before the first effect runs we don't know auth state — render nothing
  // (prevents flashing protected UI to unauthenticated users).
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

  // Authenticated — render the shell + page.
  // We attach user to a data attribute on document.body so non-React code
  // (or stray components without context wiring) can read it via DOM.
  if (typeof document !== 'undefined' && user) {
    document.body.dataset.role = user.role;
    document.body.dataset.username = user.name;
  }

  return <>{children}</>;
}
