'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Loader2, Search, ArrowUp, ArrowDown } from 'lucide-react';
import {
  getProductsWithStock, getWarehouses, getMarketplaceStocks,
  type ProductWithStock, type Warehouse, type MarketplaceStockRow,
} from '@/lib/api';

// Sort key — special string ids for fixed columns ('sku', 'product', 'ozon',
// 'wb', 'total') or warehouse_id for per-warehouse columns.
type SortKey = string;
type SortDir = 'desc' | 'asc';
interface SortState {
  key: SortKey;
  dir: SortDir;
}

export default function WarehousesPage() {
  const [products, setProducts] = useState<ProductWithStock[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [marketplaces, setMarketplaces] = useState<Record<string, MarketplaceStockRow>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Sort: null = default order (alphabetical by SKU as the API returns).
  // Click cycles desc → asc → null.
  const [sort, setSort] = useState<SortState | null>(null);

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [stockRes, whRes, mpRes] = await Promise.all([
          getProductsWithStock(),
          getWarehouses(),
          getMarketplaceStocks(),
        ]);
        if (stockRes.success && stockRes.result) {
          setProducts(stockRes.result.products);
        } else {
          setError(stockRes.errors[0]?.message ?? 'Failed to load stocks');
        }
        if (whRes.success && whRes.result) {
          setWarehouses(whRes.result.warehouses);
        }
        if (mpRes.success && mpRes.result) {
          const byId: Record<string, MarketplaceStockRow> = {};
          for (const row of mpRes.result.stocks) byId[row.base_sku] = row;
          setMarketplaces(byId);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, []);

  // Toggle sort: same key → cycles desc → asc → null.
  // Different key → starts at desc (most useful default for stock columns).
  function handleSortClick(key: SortKey) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'desc' };
      if (prev.dir === 'desc') return { key, dir: 'asc' };
      return null; // back to default
    });
  }

  // Build numeric value extractor for current sort key.
  // Returns string for SKU/Product (text sort), number for everything else.
  const sortedProducts = useMemo(() => {
    const list = [...products];
    if (!sort) return list;

    const dir = sort.dir === 'desc' ? -1 : 1;

    list.sort((a, b) => {
      let va: number | string = 0;
      let vb: number | string = 0;

      if (sort.key === 'sku') {
        va = a.id;
        vb = b.id;
      } else if (sort.key === 'product') {
        va = a.product_name.toLowerCase();
        vb = b.product_name.toLowerCase();
      } else if (sort.key === 'total') {
        va = a.total_on_hand;
        vb = b.total_on_hand;
      } else if (sort.key === 'ozon') {
        va = marketplaces[a.id]?.ozon_units ?? 0;
        vb = marketplaces[b.id]?.ozon_units ?? 0;
      } else if (sort.key === 'wb') {
        va = marketplaces[a.id]?.wb_units ?? 0;
        vb = marketplaces[b.id]?.wb_units ?? 0;
      } else {
        // warehouse_id — find on_hand for that warehouse on each product
        const ai = a.warehouses.find((w) => w.warehouse_id === sort.key);
        const bi = b.warehouses.find((w) => w.warehouse_id === sort.key);
        va = ai?.on_hand ?? 0;
        vb = bi?.on_hand ?? 0;
      }

      if (typeof va === 'string' && typeof vb === 'string') {
        return va < vb ? dir * -1 : va > vb ? dir : 0;
      }
      return ((va as number) - (vb as number)) * dir;
    });

    return list;
  }, [products, sort, marketplaces]);

  // Apply search filter on top of sort
  const filtered = useMemo(() => {
    if (!search) return sortedProducts;
    const q = search.toLowerCase();
    return sortedProducts.filter((p) =>
      p.product_name.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      p.invoice_label.toLowerCase().includes(q)
    );
  }, [sortedProducts, search]);

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

  const marketplaceTotals = useMemo(() => {
    let ozon = 0, wb = 0;
    for (const p of products) {
      const m = marketplaces[p.id];
      if (!m) continue;
      ozon += m.ozon_units || 0;
      wb   += m.wb_units || 0;
    }
    return { ozon, wb };
  }, [products, marketplaces]);

  const sortedWarehouses = useMemo(
    () => sortWarehousesByGroup(warehouses),
    [warehouses]
  );

  return (
    <div className="space-y-8 max-w-full">
      <div>
        <div className="dx-eyebrow-rot mb-2">Inventory</div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-md)',
            fontWeight: 900,
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
                <SortableTh sticky sortKey="sku" sort={sort} onClick={handleSortClick}>SKU</SortableTh>
                <SortableTh sticky2 sortKey="product" sort={sort} onClick={handleSortClick}>Product</SortableTh>
                {sortedWarehouses.map((w) => (
                  <SortableTh
                    key={w.id}
                    center
                    bg={TINT_BY_GROUP[groupForWarehouse(w)]}
                    sortKey={w.id}
                    sort={sort}
                    onClick={handleSortClick}
                  >
                    {w.code}
                  </SortableTh>
                ))}
                <SortableTh
                  center
                  bg={MARKETPLACE_TINT.ozon}
                  sortKey="ozon"
                  sort={sort}
                  onClick={handleSortClick}
                >Ozon</SortableTh>
                <SortableTh
                  center
                  bg={MARKETPLACE_TINT.wb}
                  sortKey="wb"
                  sort={sort}
                  onClick={handleSortClick}
                >WB</SortableTh>
                <SortableTh
                  center
                  accent
                  sortKey="total"
                  sort={sort}
                  onClick={handleSortClick}
                >Total</SortableTh>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={warehouses.length + 5} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>
                    No products match
                  </td>
                </tr>
              ) : (
                filtered.map((p) => {
                  const skuShort = p.id.replace('prd_', '').toUpperCase();
                  const skuLower = p.id.replace('prd_', '').toLowerCase();
                  const byWh: Record<string, number> = {};
                  for (const w of p.warehouses) byWh[w.warehouse_id] = w.on_hand;

                  const mp = marketplaces[p.id];
                  const ozonVal = mp?.ozon_units ?? 0;
                  const wbVal   = mp?.wb_units ?? 0;

                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-3 py-2" style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: '14px' }}>
                        <Link href={`/products/${skuLower}`} style={{ color: 'inherit' }}>{skuShort}</Link>
                      </td>
                      <td className="px-3 py-2" style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: '14px', maxWidth: '280px' }}>
                        <Link href={`/products/${skuLower}`} style={{ color: 'inherit' }}>{p.product_name}</Link>
                      </td>
                      {sortedWarehouses.map((w) => {
                        const v = byWh[w.id] ?? 0;
                        return (
                          <StockCellTd
                            key={w.id}
                            value={v}
                            href={`/warehouses/${w.id}?sku=${skuLower}`}
                            tint={TINT_BY_GROUP[groupForWarehouse(w)]}
                          />
                        );
                      })}
                      <MarketplaceCellTd value={ozonVal} tint={MARKETPLACE_TINT.ozon} />
                      <MarketplaceCellTd value={wbVal}   tint={MARKETPLACE_TINT.wb} />
                      <td className="px-3 py-2 text-right" style={{
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
                  <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>Total</td>
                  <td className="px-3 py-2" style={{ backgroundColor: 'var(--paper-sunk)' }}></td>
                  {sortedWarehouses.map((w) => (
                    <td key={w.id} className="px-3 py-2 text-right" style={{
                      fontSize: '14px',
                      fontWeight: 700,
                      color: 'var(--fg-1)',
                      backgroundColor: TINT_BY_GROUP[groupForWarehouse(w)],
                    }}>
                      {(totalsByWarehouse.totals[w.code] ?? 0).toLocaleString('en-US')}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right" style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: 'var(--fg-1)',
                    backgroundColor: MARKETPLACE_TINT.ozon,
                  }}>
                    {marketplaceTotals.ozon.toLocaleString('en-US')}
                  </td>
                  <td className="px-3 py-2 text-right" style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: 'var(--fg-1)',
                    backgroundColor: MARKETPLACE_TINT.wb,
                  }}>
                    {marketplaceTotals.wb.toLocaleString('en-US')}
                  </td>
                  <td className="px-3 py-2 text-right" style={{
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
// Country grouping → soft column tint
// =============================================================================
type CountryGroup = 'russia' | 'china' | 'transit';

function groupForWarehouse(wh: { country?: string | null }): CountryGroup {
  const c = (wh.country ?? '').trim();
  if (c === 'Russia') return 'russia';
  if (c === 'China') return 'china';
  return 'transit';
}

const GROUP_PRIORITY: Record<CountryGroup, number> = {
  russia: 0,
  transit: 1,
  china: 2,
};

function sortWarehousesByGroup<T extends { country?: string | null; code: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const pa = GROUP_PRIORITY[groupForWarehouse(a)];
    const pb = GROUP_PRIORITY[groupForWarehouse(b)];
    if (pa !== pb) return pa - pb;
    return a.code.localeCompare(b.code);
  });
}

const TINT_BY_GROUP: Record<CountryGroup, string> = {
  russia:  'rgba(252, 235, 235, 0.5)',
  china:   'rgba(230, 241, 251, 0.5)',
  transit: 'rgba(225, 245, 238, 0.5)',
};

const MARKETPLACE_TINT = {
  ozon: 'rgba(0, 91, 255, 0.06)',
  wb:   'rgba(203, 17, 122, 0.06)',
};

function StockCellTd({ value, href, tint }: { value: number; href: string; tint?: string }) {
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
    <td className="px-3 py-2 text-right" style={{ backgroundColor: bg, fontSize: '14px', color }}>
      <Link href={href} style={{ color: 'inherit' }}>
        {value === 0 ? '—' : value.toLocaleString('en-US')}
      </Link>
    </td>
  );
}

function MarketplaceCellTd({ value, tint }: { value: number; tint: string }) {
  const color = value === 0 ? 'var(--fg-muted)' : 'var(--fg-1)';
  return (
    <td className="px-3 py-2 text-right" style={{ backgroundColor: tint, fontSize: '14px', color, fontWeight: value > 0 ? 600 : 400 }}>
      {value === 0 ? '—' : value.toLocaleString('en-US')}
    </td>
  );
}

// =============================================================================
// Sortable column header
// =============================================================================
function SortableTh({
  children, sortKey, sort, onClick,
  sticky, sticky2, center, accent, bg,
}: {
  children: React.ReactNode;
  sortKey: string;
  sort: SortState | null;
  onClick: (key: string) => void;
  sticky?: boolean;
  sticky2?: boolean;
  center?: boolean;
  accent?: boolean;
  bg?: string;
}) {
  const isActive = sort?.key === sortKey;
  const dir = isActive ? sort!.dir : null;

  return (
    <th
      onClick={() => onClick(sortKey)}
      className={`px-3 py-3 ${center ? 'text-center' : 'text-left'}`}
      style={{
        fontSize: '14px',
        color: isActive ? 'var(--fg-1)' : 'var(--fg-3)',
        fontWeight: isActive ? 700 : 400,
        backgroundColor: bg ?? (accent ? 'var(--paper-sunk)' : 'var(--paper-sunk)'),
        borderBottom: '1px solid var(--border-hairline)',
        position: sticky || sticky2 ? 'sticky' : undefined,
        left: sticky ? 0 : sticky2 ? '60px' : undefined,
        zIndex: sticky || sticky2 ? 1 : undefined,
        cursor: 'pointer',
        userSelect: 'none',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.color = 'var(--fg-1)';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.color = 'var(--fg-3)';
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', justifyContent: center ? 'center' : 'flex-start' }}>
        {children}
        {dir === 'desc' && <ArrowDown className="h-3 w-3" style={{ color: 'var(--brand-rot)' }} />}
        {dir === 'asc'  && <ArrowUp   className="h-3 w-3" style={{ color: 'var(--brand-rot)' }} />}
      </span>
    </th>
  );
}

