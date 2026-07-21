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
const LS_EMAILER_NAV = 'dx_emailer_erp_nav_collapsed_v1';

export default function MobileShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Desktop ERP left nav collapse — used on /emailer for more reading space.
  const [emailerNavCollapsed, setEmailerNavCollapsed] = useState(false);
  const pathname = usePathname();
  const isEmailer = pathname === '/emailer' || pathname.startsWith('/emailer/');

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      setEmailerNavCollapsed(window.localStorage.getItem(LS_EMAILER_NAV) === '1');
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [drawerOpen]);

  const toggleEmailerNav = () => {
    setEmailerNavCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(LS_EMAILER_NAV, next ? '1' : '0');
      } catch { /* ignore */ }
      return next;
    });
  };

  // Only collapse the ERP sidebar while on emailer (desktop). Other routes stay full nav.
  const desktopNavCollapsed = isEmailer && emailerNavCollapsed;

  const isMailApp = pathname === '/mail' || pathname.startsWith('/mail/');

  // /login and standalone Android mail app — no ERP chrome
  if (pathname === '/login' || isMailApp) {
    return <AuthGate>{children}</AuthGate>;
  }

  return (
    <AuthGate>
      <div
        className="flex h-screen"
        data-emailer-nav-collapsed={desktopNavCollapsed ? 'true' : 'false'}
      >
        <Sidebar mobileOpen={drawerOpen} desktopCollapsed={desktopNavCollapsed} />
        {drawerOpen && (
          <div
            className="dx-sidebar-backdrop"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
        )}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <Header
            onHamburgerClick={() => setDrawerOpen(true)}
            showEmailerNavToggle={isEmailer}
            emailerNavCollapsed={emailerNavCollapsed}
            onEmailerNavToggle={toggleEmailerNav}
          />
          {/* Tricolor ribbon — mobile das-dashboard chrome (hidden on desktop via CSS) */}
          <div className="dx-mobile-tricolor" aria-hidden="true" />
          <main className="flex-1 overflow-auto dx-main">
            <div className="px-8 py-8 dx-main-inner">{children}</div>
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
