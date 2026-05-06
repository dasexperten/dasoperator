'use client';

import { ShoppingCart } from 'lucide-react';

export default function MarketplacesPage() {
  return (
    <div className="space-y-8 max-w-full">
      <div>
        <div className="dx-eyebrow-rot mb-2">Sales channels</div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-md)',
            fontWeight: 900,
            color: 'var(--fg-1)',
          }}
        >
          Marketplaces
        </h1>
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          Wildberries and Ozon stocks, sales, and analytics.
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div
        className="flex flex-col items-center justify-center text-center py-20"
        style={{
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <ShoppingCart className="h-10 w-10 mb-4" style={{ color: 'var(--fg-muted)' }} />
        <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--fg-1)' }}>
          Coming soon
        </div>
        <p
          className="mt-2 max-w-md"
          style={{ fontSize: '14px', color: 'var(--fg-2)' }}
        >
          Marketplace stocks are already visible in the rightmost columns of the
          Warehouses page. Sales charts, top SKUs, and per-warehouse breakdowns
          will land here.
        </p>
      </div>
    </div>
  );
}
