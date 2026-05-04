'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Home, Package, Users, FileSignature, FileText,
  Truck, Boxes, BarChart3
} from 'lucide-react';

interface NavItem {
  name: string;
  icon: typeof Home;
  href: string;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: 'Overview',
    items: [{ name: 'Home', icon: Home, href: '/' }],
  },
  {
    label: 'Master Data',
    items: [
      { name: 'Products', icon: Package, href: '/products' },
      { name: 'Partners', icon: Users, href: '/partners' },
      { name: 'Contracts', icon: FileSignature, href: '/contracts' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { name: 'Operations', icon: FileText, href: '/operations' },
      { name: 'Documents', icon: FileText, href: '/documents' },
      { name: 'Inventory', icon: Boxes, href: '/inventory' },
      { name: 'Shipments', icon: Truck, href: '/shipments' },
    ],
  },
  {
    label: 'Insights',
    items: [{ name: 'Analytics', icon: BarChart3, href: '/analytics' }],
  },
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
      {/* Wordmark only — без logo-mark icon */}
      <div className="px-5 pt-6 pb-5">
        <div
          className="dx-product-name text-paper"
          style={{ fontSize: '22px', lineHeight: 1, letterSpacing: '-0.005em' }}
        >
          das experten
          <sup
            className="dx-mono"
            style={{ fontSize: '10px', marginLeft: '2px', color: 'var(--brand-gold)' }}
          >®</sup>
        </div>
        <div
          className="dx-eyebrow mt-3"
          style={{ color: 'var(--stone-300)', fontSize: '10px', letterSpacing: '0.2em' }}
        >
          innovativ und praktisch
        </div>
      </div>

      <div className="dx-ribbon-rule mx-5 mb-2" />

      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
        {SECTIONS.map((section) => (
          <div key={section.label}>
            <div
              className="dx-eyebrow px-3 mb-2"
              style={{ color: 'var(--stone-300)', fontSize: '10px' }}
            >
              {section.label}
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    className="flex items-center gap-3 px-3 py-2 text-sm transition-colors duration-fast"
                    style={{
                      backgroundColor: active ? 'var(--brand-rot)' : 'transparent',
                      color: active ? 'var(--paper)' : 'var(--stone-200)',
                      borderRadius: 'var(--radius-sm)',
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
                    <Icon className="h-4 w-4" />
                    <span>{item.name}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-5 py-4" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="dx-ribbon-rule mb-3" />
        <div className="flex items-center justify-between">
          <div className="dx-eyebrow" style={{ color: 'var(--stone-400)', fontSize: '9px' }}>
            Das Operator
          </div>
          <div className="dx-mono" style={{ color: 'var(--stone-400)', fontSize: '10px', letterSpacing: '0.05em' }}>
            v0.8
          </div>
        </div>
      </div>
    </aside>
  );
}
