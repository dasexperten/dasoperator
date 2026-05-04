'use client';

import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export default function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1.5">
            {item.href && !isLast ? (
              <Link
                href={item.href}
                className="dx-eyebrow transition-colors"
                style={{ fontSize: '11px', color: 'var(--fg-3)', letterSpacing: '0.15em' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--brand-rot)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--fg-3)'; }}
              >
                {item.label}
              </Link>
            ) : (
              <span
                className="dx-eyebrow"
                style={{
                  fontSize: '11px',
                  color: isLast ? 'var(--fg-1)' : 'var(--fg-3)',
                  letterSpacing: '0.15em',
                }}
              >
                {item.label}
              </span>
            )}
            {!isLast && (
              <ChevronRight className="h-3 w-3" style={{ color: 'var(--fg-muted)' }} />
            )}
          </span>
        );
      })}
    </nav>
  );
}
