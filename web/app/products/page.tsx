'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, Loader2, Plus, ChevronUp, ChevronDown } from 'lucide-react';
import {
  getProductsList, getProductsWithStock,
  type ProductListItem, type ProductWithStock,
} from '@/lib/api';

type SortKey = 'sku' | 'product' | 'total' | 'category';
type SortDir = 'asc' | 'desc';

interface RowData extends ProductListItem {
  total_on_hand: number;
  warehouses: ProductWithStock['warehouses'];
}

export default function ProductsPage() {
  const [rows, setRows] = useState<RowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [manufacturerFilter, setManufacturerFilter] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('sku');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [listRes, stockRes] = await Promise.all([
          getProductsList(),
          getProductsWithStock(),
        ]);

        if (!listRes.success || !listRes.result) {
          setError(listRes.errors?.[0]?.message ?? 'Failed to load products');
          setLoading(false);
          return;
        }

        const stockMap: Record<string, ProductWithStock> = {};
        if (stockRes.success && stockRes.result) {
          for (const p of stockRes.result.products) stockMap[p.id] = p;
        }

        const merged: RowData[] = listRes.result.products.map((p) => {
          const s = stockMap[p.id];
          return {
            ...p,
            total_on_hand: s?.total_on_hand ?? 0,
            warehouses: s?.warehouses ?? [],
          };
        });

        setRows(merged);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, []);

  // Stable warehouse order — first 6 codes alphabetically across all rows
  const sparklineCodes = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const w of r.warehouses) set.add(w.code);
    return Array.from(set).sort().slice(0, 6);
  }, [rows]);

  const maxOnHand = useMemo(() => {
    let max = 0;
    for (const r of rows) {
      for (const w of r.warehouses) {
        if (sparklineCodes.includes(w.code) && w.on_hand > max) max = w.on_hand;
      }
    }
    return max;
  }, [rows, sparklineCodes]);

  const manufacturers = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((p) => { if (p.manufacturer_name) set.add(p.manufacturer_name); });
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((p) => {
      if (search) {
        const q = search.toLowerCase();
        const m = p.product_name.toLowerCase().includes(q) ||
                  p.id.toLowerCase().includes(q) ||
                  p.invoice_label.toLowerCase().includes(q);
        if (!m) return false;
      }
      if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
      if (manufacturerFilter !== 'all' && p.manufacturer_name !== manufacturerFilter) return false;
      return true;
    });
  }, [rows, search, categoryFilter, manufacturerFilter]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'sku':      cmp = a.id.localeCompare(b.id); break;
        case 'product':  cmp = a.product_name.localeCompare(b.product_name); break;
        case 'total':    cmp = a.total_on_hand - b.total_on_hand; break;
        case 'category': cmp = a.category.localeCompare(b.category); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [filtered, sortKey, sortDir]);

  const pasteCount = rows.filter((p) => p.category === 'Toothpaste').length;
  const brushCount = rows.filter((p) => p.category === 'Toothbrush').length;
  const otherCount = rows.length - pasteCount - brushCount;

  function clickHeader(key: SortKey, defaultDir: SortDir = 'asc') {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(defaultDir);
    }
  }

  return (
    <div className="space-y-8 max-w-7xl">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="dx-eyebrow-rot mb-2">Master Data</div>
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-md)',
            fontWeight: 900,
            
            color: 'var(--fg-1)',
          }}>
            Products
          </h1>
          <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
            {loading
              ? 'Loading...'
              : `${rows.length} products · ${pasteCount} toothpastes · ${brushCount} brushes${otherCount > 0 ? ` · ${otherCount} other` : ''}`}
          </p>
        </div>
        <Link
          href="/products/new"
          className="inline-flex items-center gap-2 px-4 py-2"
          style={{
            backgroundColor: 'var(--brand-rot)',
            color: 'var(--paper)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px',
            fontWeight: 600,
          }}
        >
          <Plus className="h-4 w-4" />
          Add product
        </Link>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="space-y-3">
        <div className="relative max-w-xl">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--fg-muted)' }} />
          <input
            type="text"
            placeholder="Search by name or SKU..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 focus:outline-none"
            style={{
              fontSize: '14px',
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--fg-1)',
            }}
          />
        </div>

        <div className="flex gap-3">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 focus:outline-none"
            style={{
              fontSize: '14px',
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--fg-1)',
            }}
          >
            <option value="all">All categories</option>
            <option value="Toothpaste">Toothpaste</option>
            <option value="Toothbrush">Toothbrush</option>
            <option value="Floss">Floss</option>
            <option value="Other">Other</option>
          </select>

          <select
            value={manufacturerFilter}
            onChange={(e) => setManufacturerFilter(e.target.value)}
            className="px-3 py-2 focus:outline-none"
            style={{
              fontSize: '14px',
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--fg-1)',
            }}
          >
            <option value="all">All manufacturers</option>
            {manufacturers.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          <div className="ml-auto self-center" style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>
            {sorted.length} / {rows.length}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      ) : error ? (
        <div className="p-4" style={{
          fontSize: '14px',
          backgroundColor: 'rgba(229,32,44,0.05)',
          border: '1px solid rgba(229,32,44,0.2)',
          color: 'var(--brand-rot)',
          borderRadius: 'var(--radius-sm)',
        }}>
          Error: {error}
        </div>
      ) : (
        <div className="bg-card overflow-hidden" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <table className="w-full" style={{ fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <ProductTh sortKey="sku"      active={sortKey} dir={sortDir} onClick={clickHeader}>SKU</ProductTh>
                <ProductTh sortKey="product"  active={sortKey} dir={sortDir} onClick={clickHeader}>Product</ProductTh>
                <ProductTh sortKey="total"    active={sortKey} dir={sortDir} onClick={clickHeader} defaultDir="desc">Total stock</ProductTh>
                <ProductTh sortKey="category" active={sortKey} dir={sortDir} onClick={clickHeader}>Category</ProductTh>
                <ProductTh>Manufacturer</ProductTh>
                <ProductTh>Weight</ProductTh>
                <ProductTh>Barcode</ProductTh>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-12" style={{ color: 'var(--fg-3)', fontSize: '14px' }}>
                    No products match the filters
                  </td>
                </tr>
              ) : (
                sorted.map((p) => {
                  const skuShort = p.id.toUpperCase();  // display-only
                  // Link uses raw lowercase p.id so route matches the
                  // exact key stored in D1 (and prerendered statically).
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-4 py-3" style={{ fontWeight: 700 }}>
                        <Link href={`/products/${p.id}`} style={{ color: 'var(--fg-1)' }}>
                          {skuShort}
                        </Link>
                      </td>
                      <td className="px-4 py-3" style={{ fontWeight: 700 }}>
                        <Link href={`/products/${p.id}`} style={{ color: 'var(--fg-1)' }}>
                          <span className="dx-product-name">{p.product_name}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <StockCell
                          total={p.total_on_hand}
                          warehouses={p.warehouses}
                          codes={sparklineCodes}
                          maxOnHand={maxOnHand}
                        />
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>
                        {p.category}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>
                        {p.manufacturer_name ?? '—'}
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--fg-2)' }}>
                        {formatWeight(p.weight_kg)}
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{ color: 'var(--fg-3)' }}>
                        {p.barcode ?? '—'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function formatWeight(weightG: number | null): string {
  if (weightG === null || weightG === undefined) return '—';
  if (weightG >= 1000) {
    const kg = weightG / 1000;
    return `${kg.toLocaleString('en-US', { maximumFractionDigits: 2 })} kg`;
  }
  return `${weightG.toLocaleString('en-US')} g`;
}

function StockCell({
  total, warehouses, codes, maxOnHand,
}: {
  total: number;
  warehouses: ProductWithStock['warehouses'];
  codes: string[];
  maxOnHand: number;
}) {
  // Use literal hex colors instead of CSS vars to avoid any variable
  // resolution issues in production bundles. These match apothecary tokens:
  //   --fg-1         = #1A1519 (brand-schwarz-ink)
  //   --fg-muted     = stone-300 (~ #B6B6B6)
  const INK = '#1A1519';
  const MUTED = '#B6B6B6';

  const totalColor = total > 0 ? INK : MUTED;

  const byCode: Record<string, number> = {};
  for (const w of warehouses) byCode[w.code] = w.on_hand;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <span
        className="tabular-nums"
        style={{
          fontSize: '14px',
          fontWeight: 700,
          color: totalColor,
          minWidth: '64px',
          textAlign: 'right',
        }}
      >
        {total.toLocaleString('en-US')}
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',  // bars grow upward from a baseline
          gap: '2px',
          height: '18px',
          minWidth: `${codes.length * 6}px`,
        }}
      >
        {codes.map((code) => {
          const v = byCode[code] ?? 0;
          // Compute bar height + color. Always render a visible bar element.
          let heightPx = 2;
          let bg = MUTED;
          let opacity = 0.5;
          if (v > 0 && maxOnHand > 0) {
            heightPx = Math.max(3, Math.round((v / maxOnHand) * 18));
            bg = INK;
            opacity = 1;
          }
          return (
            <div
              key={code}
              title={`${code}: ${v.toLocaleString('en-US')}`}
              style={{
                display: 'block',
                width: '4px',
                height: `${heightPx}px`,
                backgroundColor: bg,
                opacity,
                flexShrink: 0,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ProductTh({
  children, sortKey: key, active, dir, onClick, defaultDir = 'asc',
}: {
  children: React.ReactNode;
  sortKey?: SortKey;
  active?: SortKey;
  dir?: SortDir;
  onClick?: (key: SortKey, defaultDir?: SortDir) => void;
  defaultDir?: SortDir;
}) {
  const isActive = key && active === key;
  const sortable = !!key && !!onClick;

  return (
    <th
      className="text-left px-4 py-3"
      style={{
        fontSize: '14px',
        color: isActive ? 'var(--fg-1)' : 'var(--fg-3)',
        backgroundColor: 'var(--paper-sunk)',
        cursor: sortable ? 'pointer' : 'default',
        userSelect: sortable ? 'none' : 'auto',
      }}
      onClick={() => sortable && onClick && key && onClick(key, defaultDir)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {isActive && (dir === 'asc'
          ? <ChevronUp className="h-3 w-3" />
          : <ChevronDown className="h-3 w-3" />)}
      </span>
    </th>
  );
}
