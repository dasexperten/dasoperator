'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Users, FileText, Package, Warehouse, ShoppingCart, BarChart3 } from 'lucide-react';

interface NavItem {
  name: string;
  icon: typeof Home;
  href: string;
}

const NAV_ITEMS: NavItem[] = [
  { name: 'Home',         icon: Home,         href: '/' },
  { name: 'Partners',     icon: Users,        href: '/partners' },
  { name: 'Operations',   icon: FileText,     href: '/operations' },
  { name: 'Products',     icon: Package,      href: '/products' },
  { name: 'Warehouses',   icon: Warehouse,    href: '/warehouses' },
  { name: 'Marketplaces', icon: ShoppingCart, href: '/marketplaces' },
  { name: 'Analytics',    icon: BarChart3,    href: '/analytics' },
];

export default function Sidebar() {
  const pathname = usePathname();

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  }

  return (
    <aside
      className="w-60 flex flex-col text-paper"
      style={{ backgroundColor: 'var(--brand-schwarz)' }}
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
          {NAV_ITEMS.map((item) => {
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
                onMouseEnter={(e) => {
                  if (!active) {
                    e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)';
                    e.currentTarget.style.color = 'var(--paper)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!active) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--stone-200)';
                  }
                }}
              >
                <Icon className="h-5 w-5" />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="px-5 py-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="dx-ribbon-rule mb-3" />
        <div className="flex items-center justify-between">
          <div style={{ color: 'var(--stone-400)', fontSize: '14px' }}>
            Das Operator
          </div>
          <div style={{ color: 'var(--stone-400)', fontSize: '14px' }}>
            v1.1
          </div>
        </div>
      </div>
    </aside>
  );
}
