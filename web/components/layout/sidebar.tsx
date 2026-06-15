'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Home, Users, FileText, Package, Warehouse, ShoppingCart,
  Headphones, BarChart3, Wallet, Settings, Calculator, MessageSquare, Mail,
  LogOut,
} from 'lucide-react';
import { getUser, logout, hasModuleAccess, ROLE_LABEL, type Role, type AuthUser } from '@/lib/auth';

interface NavItem {
  name: string;
  icon: typeof Home;
  href: string;
}

const NAV_ITEMS: NavItem[] = [
  { name: 'Home',         icon: Home,          href: '/' },
  { name: 'Partners',     icon: Users,         href: '/partners' },
  { name: 'Operations',   icon: FileText,      href: '/operations' },
  { name: 'Planner',      icon: Calculator,    href: '/planner' },
  { name: 'Products',     icon: Package,       href: '/products' },
  { name: 'Warehouses',   icon: Warehouse,     href: '/warehouses' },
  { name: 'Marketplaces', icon: ShoppingCart,  href: '/marketplaces' },
  { name: 'Reviews',      icon: MessageSquare, href: '/reviews' },
  { name: 'CRM',          icon: Headphones,    href: '/crm' },
  { name: 'Emailer',      icon: Mail,          href: '/emailer' },
  { name: 'Finance',      icon: Wallet,        href: '/finance' },
  { name: 'Analytics',    icon: BarChart3,     href: '/analytics' },
  { name: 'Settings',     icon: Settings,      href: '/settings' },
];

/**
 * Sidebar — vertical navigation, filtered by current user's role.
 * Items the user cannot access are hidden entirely.
 * Footer shows user name + role + logout button.
 */
export default function Sidebar({ mobileOpen = false }: { mobileOpen?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);

  // Read user on mount + on auth-change events (login/logout in another tab).
  useEffect(() => {
    function read() {
      setUser(getUser());
    }
    read();
    window.addEventListener('dx-auth-change', read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener('dx-auth-change', read);
      window.removeEventListener('storage', read);
    };
  }, []);

  const visibleItems = useMemo(() => {
    if (!user) return [];
    return NAV_ITEMS.filter((it) => hasModuleAccess(user, it.href));
  }, [user]);

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    if (href === '/finance') return pathname.startsWith('/finance');
    return pathname.startsWith(href);
  }

  async function onLogout() {
    await logout();
    router.replace('/login');
  }

  // Initials for the avatar circle
  const initials = user
    ? user.name
        .split(/\s+/)
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
    : '';

  return (
    <aside
      className="dx-sidebar w-60 flex flex-col text-paper"
      style={{ backgroundColor: 'var(--brand-schwarz)' }}
      data-mobile-open={mobileOpen ? 'true' : 'false'}
    >
      <div className="px-5 pt-6 pb-5">
        <div
          className="dx-product-name text-paper"
          style={{ fontSize: '22px', lineHeight: 1 }}
        >
          das experten
          <sup
            style={{ fontSize: '14px', marginLeft: '2px', color: 'var(--brand-gold)' }}
          >®</sup>
        </div>
        <div
          className="mt-3"
          style={{ color: 'var(--stone-300)', fontSize: '14px' }}
        >
          innovativ und praktisch
        </div>
      </div>

      <div className="dx-ribbon-rule mx-5 mb-2" />

      <nav className="flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-0.5">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.name}
                href={item.href}
                className="flex items-center gap-3 px-3 py-2.5 transition-colors duration-fast"
                style={{
                  backgroundColor: active ? 'var(--brand-rot)' : 'transparent',
                  color: active ? 'var(--paper)' : 'var(--stone-200)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '18px',
                  fontWeight: 700,
                }}
              >
                <Icon className="h-5 w-5" />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* User block + logout */}
      {user && (
        <div className="px-5 py-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="flex items-center gap-3">
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                backgroundColor: 'var(--brand-rot)',
                color: 'var(--paper)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '14px',
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <div style={{ color: 'var(--paper)', fontSize: '15px', fontWeight: 700, lineHeight: 1.2 }}>
                {user.name}
              </div>
              <div style={{ color: 'var(--stone-400)', fontSize: '13px', marginTop: '2px' }}>
                {ROLE_LABEL[user.role as Role] ?? user.role}
              </div>
            </div>
            <button
              type="button"
              onClick={onLogout}
              title="Sign out"
              aria-label="Sign out"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--stone-300)',
                cursor: 'pointer',
                padding: '6px',
                borderRadius: 'var(--radius-sm)',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--paper)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--stone-300)'; }}
            >
              <LogOut className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

