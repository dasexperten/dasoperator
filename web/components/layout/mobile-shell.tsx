'use client';

import { useState, useEffect, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Home, ArrowLeftRight, Warehouse, MessageSquare, Mail } from 'lucide-react';
import Sidebar from './sidebar';
import Header from './header';
import AuthGate from './auth-gate';
import { getUser, hasModuleAccess } from '@/lib/auth';

/**
 * MobileShell — top-level layout orchestrator.
 *
 * Wraps everything in AuthGate. On /login, renders only the children
 * (no sidebar/header) so the login screen is full-bleed.
 *
 * Sidebar + Header + BottomNav are filtered by role.
 */
export default function MobileShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [drawerOpen]);

  // /login renders standalone (no shell)
  if (pathname === '/login') {
    return <AuthGate>{children}</AuthGate>;
  }

  return (
    <AuthGate>
      <div className="flex h-screen">
        <Sidebar mobileOpen={drawerOpen} />
        {drawerOpen && (
          <div
            className="dx-sidebar-backdrop"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
        )}
        <div className="flex-1 flex flex-col overflow-hidden">
          <Header onHamburgerClick={() => setDrawerOpen(true)} />
          <main className="flex-1 overflow-auto">
            <div className="px-8 py-8">{children}</div>
          </main>
        </div>
        <BottomNav pathname={pathname} />
      </div>
    </AuthGate>
  );
}

// ----------------------------------------------------------------------------
// BottomNav — up to 5 most important routes for phone-on-the-go work.
// Filtered by user role.
// ----------------------------------------------------------------------------

interface BottomNavItem {
  name: string;
  icon: typeof Home;
  href: string;
}

// Candidate items, ordered by priority. We pick the first 5 the role can see.
const BOTTOM_NAV_CANDIDATES: BottomNavItem[] = [
  { name: 'Pulse',      icon: Home,           href: '/' },
  { name: 'Stock',      icon: Warehouse,      href: '/warehouses' },
  { name: 'Reviews',    icon: MessageSquare,  href: '/reviews' },
  { name: 'Emailer',    icon: Mail,           href: '/emailer' },
  { name: 'Operations', icon: ArrowLeftRight, href: '/operations' },
];

function BottomNav({ pathname }: { pathname: string }) {
  // Re-evaluate items when user changes (login/logout in another tab).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    function bump() { setTick((t) => t + 1); }
    window.addEventListener('dx-auth-change', bump);
    return () => window.removeEventListener('dx-auth-change', bump);
  }, []);

  const items = useMemo(() => {
    const u = getUser();
    if (!u) return [];
    return BOTTOM_NAV_CANDIDATES
      .filter((it) => hasModuleAccess(u, it.href))
      .slice(0, 5);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, pathname]);

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  if (items.length === 0) return null;

  return (
    <nav className="dx-bottom-nav" aria-label="Primary mobile navigation">
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActive(item.href);
        return (
          <Link
            key={item.name}
            href={item.href}
            className="dx-bottom-nav-item"
            data-active={active ? 'true' : 'false'}
          >
            <Icon className="h-5 w-5" />
            <span>{item.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}
