'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Loader2, Search } from 'lucide-react';
import {
  getProductsWithStock, getWarehouses,
  type ProductWithStock, type Warehouse,
} from '@/lib/api';

export default function WarehousesPage() {
  const [products, setProducts] = useState<ProductWithStock[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [stockRes, whRes] = await Promise.all([
          getProductsWithStock(),
          getWarehouses(),
        ]);
        if (stockRes.success && stockRes.result) {
          setProducts(stockRes.result.products);
        } else {
          setError(stockRes.errors[0]?.message ?? 'Failed to load stocks');
        }
        if (whRes.success && whRes.result) {
          setWarehouses(whRes.result.warehouses);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, []);

  const filtered = useMemo(() => {
    if (!search) return products;
    const q = search.toLowerCase();
    return products.filter((p) =>
      p.product_name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      p.invoice_label.toLowerCase().includes(q)
    );
  }, [products, search]);

  const totalsByWarehouse = useMemo(() => {
    const totals: Record<string, number> = {};
    let grandTotal = 0;
    for (const p of products) {
      for (const w of p.warehouses) {
        totals[w.code] = (totals[w.code] ?? 0) + w.on_hand;
        grandTotal += w.on_hand;
      }
    }
    return { totals, grandTotal };
  }, [products]);

  return (
    <div className="space-y-8 max-w-full">
      <div>
        <div className="dx-eyebrow dx-eyebrow-rot mb-2">Inventory</div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-md)',
            fontWeight: 900,
            letterSpacing: '-0.025em',
            color: 'var(--fg-1)',
          }}
        >
          Warehouses
        </h1>
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          {loading ? 'Loading...' : `${products.length} SKUs × ${warehouses.length} warehouses · ${totalsByWarehouse.grandTotal.toLocaleString('en-US')} pieces total`}
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="space-y-3">
        <div className="relative max-w-xl">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--fg-muted)' }} />
          <input
            type="text"
            placeholder="Search by SKU or product..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm focus:outline-none"
            style={{
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--fg-1)',
            }}
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      ) : error ? (
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          Error: {error}
        </div>
      ) : (
        <div className="bg-card overflow-x-auto" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr>
                <Th sticky>SKU</Th>
                <Th sticky2>Product</Th>
                {warehouses.map((w) => (
                  <Th key={w.id} center bg={TINT_BY_GROUP[groupForWarehouse(w)]}>
                    <Link href={`/warehouses/${w.id}`} style={{ color: 'inherit' }}>
                      {w.code}
                    </Link>
                  </Th>
                ))}
                <Th center accent>Total</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={warehouses.length + 3} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>
                    No products match
                  </td>
                </tr>
              ) : (
                filtered.map((p) => {
                  const skuShort = p.id.replace('prd_', '').toUpperCase();
                  // Map by warehouse_id for fast lookup
                  const byWh: Record<string, number> = {};
                  for (const w of p.warehouses) byWh[w.warehouse_id] = w.on_hand;

                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-3 py-2 dx-mono" style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: '13px' }}>
                        <Link href={`/products/${skuShort}`} style={{ color: 'inherit' }}>{skuShort}</Link>
                      </td>
                      <td className="px-3 py-2" style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: '14px', maxWidth: '280px' }}>
                        <Link href={`/products/${skuShort}`} style={{ color: 'inherit' }}>{p.product_name}</Link>
                      </td>
                      {warehouses.map((w) => {
                        const v = byWh[w.id] ?? 0;
                        return (
                          <StockCellTd
                            key={w.id}
                            value={v}
                            href={`/warehouses/${w.id}?sku=${skuShort}`}
                            tint={TINT_BY_GROUP[groupForWarehouse(w)]}
                          />
                        );
                      })}
                      <td className="px-3 py-2 dx-mono text-right" style={{
                        fontSize: '14px',
                        fontWeight: 700,
                        color: p.total_on_hand > 0 ? 'var(--fg-1)' : 'var(--fg-muted)',
                        backgroundColor: 'var(--paper-sunk)',
                      }}>
                        {p.total_on_hand.toLocaleString('en-US')}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border-hairline)' }}>
                  <td className="px-3 py-2 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>Total</td>
                  <td className="px-3 py-2" style={{ backgroundColor: 'var(--paper-sunk)' }}></td>
                  {warehouses.map((w) => (
                    <td key={w.id} className="px-3 py-2 dx-mono text-right" style={{
                      fontSize: '13px',
                      fontWeight: 700,
                      color: 'var(--fg-1)',
                      backgroundColor: TINT_BY_GROUP[groupForWarehouse(w)],
                    }}>
                      {(totalsByWarehouse.totals[w.code] ?? 0).toLocaleString('en-US')}
                    </td>
                  ))}
                  <td className="px-3 py-2 dx-mono text-right" style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: 'var(--fg-1)',
                    backgroundColor: 'var(--paper-sunk)',
                  }}>
                    {totalsByWarehouse.grandTotal.toLocaleString('en-US')}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Country grouping → soft column tint (Phase 4.4 follow-up)
// =============================================================================
// Group derivation by warehouse.country (no hardcoded code list — DGN/future
// warehouses fall into the right bucket automatically as long as country
// field is set in /api/warehouses).
type CountryGroup = 'russia' | 'china' | 'transit';

function groupForWarehouse(wh: { country?: string | null }): CountryGroup {
  if (wh.country === 'Russia') return 'russia';
  if (wh.country === 'China') return 'china';
  return 'transit';
}

const TINT_BY_GROUP: Record<CountryGroup, string> = {
  russia:  'rgba(252, 235, 235, 0.5)',  // warm beige-red
  china:   'rgba(230, 241, 251, 0.5)',  // cool slate-blue
  transit: 'rgba(225, 245, 238, 0.5)',  // neutral mint
};

function StockCellTd({ value, href, tint }: { value: number; href: string; tint?: string }) {
  // Cell coloring rules (Phase 4.4) — semantic warning bg overrides country tint:
  //   0       → muted text, fall through to tint
  //   1-50    → red bg + red text (tint hidden)
  //   51-200  → amber bg + amber text (tint hidden)
  //   201+    → fall through to tint
  let bg: string | undefined = tint;
  let color: string;
  if (value === 0) {
    color = 'var(--fg-muted)';
  } else if (value <= 50) {
    bg = 'rgba(229,32,44,0.08)';
    color = 'var(--brand-rot)';
  } else if (value <= 200) {
    bg = 'rgba(199,122,0,0.08)';
    color = 'var(--status-warning)';
  } else {
    color = 'var(--fg-1)';
  }

  return (
    <td className="px-3 py-2 dx-mono text-right" style={{ backgroundColor: bg, fontSize: '13px', color }}>
      <Link href={href} style={{ color: 'inherit' }}>
        {value === 0 ? '—' : value.toLocaleString('en-US')}
      </Link>
    </td>
  );
}

function Th({ children, sticky, sticky2, center, accent, bg }: {
  children: React.ReactNode;
  sticky?: boolean;
  sticky2?: boolean;
  center?: boolean;
  accent?: boolean;
  bg?: string;
}) {
  return (
    <th
      className={`px-3 py-3 dx-eyebrow ${center ? 'text-center' : 'text-left'}`}
      style={{
        fontSize: '10px',
        color: 'var(--fg-3)',
        backgroundColor: bg ?? (accent ? 'var(--paper-sunk)' : 'var(--paper-sunk)'),
        borderBottom: '1px solid var(--border-hairline)',
        position: sticky || sticky2 ? 'sticky' : undefined,
        left: sticky ? 0 : sticky2 ? '60px' : undefined,
        zIndex: sticky || sticky2 ? 1 : undefined,
      }}
    >
      {children}
    </th>
  );
}
