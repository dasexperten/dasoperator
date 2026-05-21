'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Home, Users, FileText, Package, Warehouse, ShoppingCart,
  Headphones, BarChart3, Wallet, Settings, Calculator, MessageSquare,
  ChevronDown, ChevronRight,
} from 'lucide-react';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

interface NavItem {
  name: string;
  icon: typeof Home;
  href: string;
}

interface NavGroup {
  name: string;
  icon: typeof Home;
  href: string;            // root URL (clicking the group label navigates here)
  children: SubItem[];
  badgeKey?: 'bank_inbox'; // optional dynamic badge
}

interface SubItem {
  name: string;
  href: string;
  badgeKey?: 'bank_inbox';
}

const NAV_ITEMS_BEFORE_FINANCE: NavItem[] = [
  { name: 'Home',         icon: Home,         href: '/' },
  { name: 'Partners',     icon: Users,        href: '/partners' },
  { name: 'Operations',   icon: FileText,     href: '/operations' },
  { name: 'Planner',      icon: Calculator,   href: '/planner' },
  { name: 'Products',     icon: Package,      href: '/products' },
  { name: 'Warehouses',   icon: Warehouse,    href: '/warehouses' },
  { name: 'Marketplaces', icon: ShoppingCart, href: '/marketplaces' },
  { name: 'Reviews',      icon: MessageSquare,href: '/reviews' },
  { name: 'CRM',          icon: Headphones,   href: '/crm' },
];

const FINANCE_GROUP: NavGroup = {
  name: 'Finance',
  icon: Wallet,
  href: '/finance',
  badgeKey: 'bank_inbox',
  children: [
    { name: 'Overview',       href: '/finance' },
    { name: 'Bank accounts',  href: '/finance/accounts' },
    { name: 'Bank Inbox',     href: '/inbox/banking', badgeKey: 'bank_inbox' },
    { name: 'Settlements',    href: '/finance/settlements' },
  ],
};

const NAV_ITEMS_AFTER_FINANCE: NavItem[] = [
  { name: 'Analytics',    icon: BarChart3,    href: '/analytics' },
  { name: 'Settings',     icon: Settings,     href: '/settings' },
];

/**
 * Sidebar — vertical navigation.
 *
 * On desktop (md+): visible in-flow as a 240px-wide left column.
 * On mobile (<768px): hidden off-canvas via CSS transform; slides in when
 *   data-mobile-open="true" is set on the root <aside>.
 */
export default function Sidebar({ mobileOpen = false }: { mobileOpen?: boolean }) {
  const pathname = usePathname();

  // Finance group expands automatically when pathname matches any of its
  // children. Otherwise persisted state from localStorage decides.
  const isInFinanceGroup =
    pathname.startsWith('/finance') || pathname.startsWith('/inbox/banking');

  const [financeOpen, setFinanceOpen] = useState<boolean>(false);

  useEffect(() => {
    // First render after hydration: auto-open if user is on a Finance route,
    // else restore stored preference.
    if (isInFinanceGroup) {
      setFinanceOpen(true);
      return;
    }
    try {
      const stored = localStorage.getItem('dx-sidebar-finance-open');
      if (stored !== null) setFinanceOpen(stored === 'true');
    } catch {}
  }, [isInFinanceGroup]);

  function toggleFinance() {
    setFinanceOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem('dx-sidebar-finance-open', String(next)); } catch {}
      return next;
    });
  }

  // Fetch Bank Inbox badge count
  const [bankInboxCount, setBankInboxCount] = useState<number>(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${API_BASE}/api/inbox/banking/counts`);
        const json = await res.json();
        if (cancelled) return;
        const total = json?.result?.total ?? 0;
        setBankInboxCount(Number(total) || 0);
      } catch {
        if (!cancelled) setBankInboxCount(0);
      }
    }
    load();
    const t = setInterval(load, 60_000); // refresh every minute
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    if (href === '/finance') return pathname === '/finance';
    return pathname.startsWith(href);
  }

  function renderItem(item: NavItem) {
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
  }

  function badgeFor(key: SubItem['badgeKey']): number {
    if (key === 'bank_inbox') return bankInboxCount;
    return 0;
  }

  function renderGroup(group: NavGroup) {
    const Icon = group.icon;
    const groupActive = isInFinanceGroup;
    const badge = group.badgeKey ? badgeFor(group.badgeKey) : 0;

    return (
      <div key={group.name}>
        {/* Group header — clicking the row toggles. Clicking just the label
            text could navigate, but we keep it simple: whole row toggles, and
            sub-item Overview takes the user to the root. */}
        <button
          type="button"
          onClick={toggleFinance}
          className="flex items-center gap-3 px-3 py-2.5 w-full transition-colors duration-fast"
          style={{
            backgroundColor: 'transparent',
            color: groupActive ? 'var(--paper)' : 'var(--stone-200)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '18px',
            fontWeight: 700,
            textAlign: 'left',
          }}
        >
          <Icon className="h-5 w-5" />
          <span className="flex-1">{group.name}</span>
          {!financeOpen && badge > 0 && (
            <span
              style={{
                fontSize: '12px',
                fontWeight: 500,
                padding: '2px 8px',
                borderRadius: '999px',
                background: 'var(--brand-gold)',
                color: 'var(--brand-schwarz)',
              }}
            >
              {badge}
            </span>
          )}
          {financeOpen
            ? <ChevronDown className="h-4 w-4" style={{ opacity: 0.6 }} />
            : <ChevronRight className="h-4 w-4" style={{ opacity: 0.6 }} />
          }
        </button>

        {financeOpen && (
          <div
            className="ml-3 pl-2 mt-1 mb-1 space-y-0.5"
            style={{ borderLeft: '1px solid rgba(255,255,255,0.10)' }}
          >
            {group.children.map((sub) => {
              const subActive = isActive(sub.href);
              const subBadge = sub.badgeKey ? badgeFor(sub.badgeKey) : 0;
              return (
                <Link
                  key={sub.name}
                  href={sub.href}
                  className="flex items-center gap-2 px-3 py-2 transition-colors duration-fast"
                  style={{
                    backgroundColor: subActive ? 'var(--brand-rot)' : 'transparent',
                    color: subActive ? 'var(--paper)' : 'var(--stone-300)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '15px',
                    fontWeight: 700,
                  }}
                >
                  <span className="flex-1">{sub.name}</span>
                  {subBadge > 0 && (
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 500,
                        padding: '1px 7px',
                        borderRadius: '999px',
                        background: subActive ? 'rgba(255,255,255,0.25)' : 'var(--brand-gold)',
                        color: subActive ? 'var(--paper)' : 'var(--brand-schwarz)',
                      }}
                    >
                      {subBadge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    );
  }

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
          {NAV_ITEMS_BEFORE_FINANCE.map(renderItem)}
          {renderGroup(FINANCE_GROUP)}
          {NAV_ITEMS_AFTER_FINANCE.map(renderItem)}
        </div>
      </nav>

      <div className="px-5 py-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="dx-ribbon-rule mb-3" />
        <div className="flex items-center justify-between">
          <div style={{ color: 'var(--stone-400)', fontSize: '14px' }}>
            Das Operator
          </div>
          <div style={{ color: 'var(--stone-400)', fontSize: '14px' }}>
            v1.3
          </div>
        </div>
      </div>
    </aside>
  );
}
