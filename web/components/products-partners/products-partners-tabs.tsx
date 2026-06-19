'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Package, Users } from 'lucide-react';

// =============================================================================
// Products & Partners — Tab switcher component
// Add to both /products and /partners pages.
// =============================================================================

export function ProductsPartnersTabs() {
  const pathname = usePathname();
  const router = useRouter();

  const isProducts = pathname.startsWith('/products');
  const activeTab = isProducts ? 'products' : 'partners';

  return (
    <div
      className="flex gap-1 mb-6"
      style={{
        borderBottom: '1px solid var(--border-hairline)',
        paddingBottom: '1px',
      }}
    >
      <button
        onClick={() => router.push('/products')}
        className="flex items-center gap-2 px-4 py-2 text-sm transition-colors"
        style={{
          backgroundColor: activeTab === 'products' ? 'var(--bg-accent)' : 'transparent',
          color: activeTab === 'products' ? 'var(--fg-on-brand)' : 'var(--fg-2)',
          fontWeight: activeTab === 'products' ? 500 : 400,
          borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
          borderBottom: activeTab === 'products' ? '2px solid var(--brand-rot)' : '2px solid transparent',
        }}
      >
        <Package size={16} />
        Products
      </button>
      <button
        onClick={() => router.push('/partners')}
        className="flex items-center gap-2 px-4 py-2 text-sm transition-colors"
        style={{
          backgroundColor: activeTab === 'partners' ? 'var(--bg-accent)' : 'transparent',
          color: activeTab === 'partners' ? 'var(--fg-on-brand)' : 'var(--fg-2)',
          fontWeight: activeTab === 'partners' ? 500 : 400,
          borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
          borderBottom: activeTab === 'partners' ? '2px solid var(--brand-rot)' : '2px solid transparent',
        }}
      >
        <Users size={16} />
        Partners
      </button>
    </div>
  );
}
