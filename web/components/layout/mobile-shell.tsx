'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Home, Users, FileText, Package, BarChart3 } from 'lucide-react';
import Sidebar from './sidebar';
import Header from './header';

/**
 * MobileShell — top-level layout orchestrator.
 *
 * Renders:
 *  - Sidebar (in-flow on md+, off-canvas drawer on mobile)
 *  - Header (with hamburger on mobile)
 *  - main content
 *  - Bottom navigation bar (mobile only, 5 most-used routes)
 *
 * Manages the open/close state of the mobile drawer and the backdrop
 * that dims content when the drawer is open.
 *
 * Auto-closes the drawer on route change so navigation feels natural
 * (tap a link → drawer slides away → you're on the new page).
 */
export default function MobileShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer whenever route changes
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Prevent body scroll while drawer is open (mobile UX)
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  return (
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
  );
}

// ----------------------------------------------------------------------------
// BottomNav — 5 most important routes for phone-on-the-go work.
// Renders fixed at the bottom of the viewport, only visible on mobile (<768px).
// ----------------------------------------------------------------------------

interface BottomNavItem {
  name: string;
  icon: typeof Home;
  href: string;
}

const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  { name: 'Home',       icon: Home,       href: '/' },
  { name: 'Partners',   icon: Users,      href: '/partners' },
  { name: 'Ops',        icon: FileText,   href: '/operations' },
  { name: 'Products',   icon: Package,    href: '/products' },
  { name: 'Analytics',  icon: BarChart3,  href: '/analytics' },
];

function BottomNav({ pathname }: { pathname: string }) {
  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  return (
    <nav className="dx-bottom-nav" aria-label="Primary mobile navigation">
      {BOTTOM_NAV_ITEMS.map((item) => {
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
