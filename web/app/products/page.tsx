'use client';

export const runtime = 'edge';

// build-bust: 1778137654
// build-bust: 1778137599

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, Loader2, Plus, ChevronUp, ChevronDown, RefreshCw } from 'lucide-react';
import { CopyableValue } from '@/components/ui/copyable';
import { ProductsPartnersTabs } from '@/components/products-partners/products-partners-tabs';
import {
  getProductsList, getProductsWithStock, getPricelistMap, resyncPrices,
  type ProductListItem, type ProductWithStock,
} from '@/lib/api';

const PRICE_TYPES: Array<{ id: string; label: string; currency: string }> = [
  { id: 'distr_usd',    label: 'International (USD)', currency: 'USD' },
  { id: 'distr_rub',    label: 'Russia Distr (RUB)',  currency: 'RUB' },
  { id: 'wb_ru',        label: 'Russia RSP (RUB)',    currency: 'RUB' },
  { id: 'purchase_cny', label: 'Purchasing (CNY)',    currency: 'CNY' },
  { id: 'export_usd',   label: 'Purchasing (USD)',    currency: 'USD' },
  { id: 'dasex_group',  label: 'Dasex (USD)',         currency: 'USD' },
];

type SortKey = 'sku' | 'product' | 'total' | 'price' | 'monthly' | 'coef';

function currencySymbol(c: string): string {
  switch (c) {
    case 'USD': return '$';
    case 'RUB': return '₽';
    case 'CNY': return '¥';
    case 'EUR': return '€';
    case 'GBP': return '£';
    default: return c + ' ';
  }
}

function signalLabel(s: string): { text: string; color: string } {
  switch (s) {
    case 'critical':       return { text: 'критично — заказать срочно', color: '#C4302B' };
    case 'out_of_stock':   return { text: 'out of stock', color: '#C4302B' };
    case 'severe_surplus': return { text: 'сильный затар — стоп', color: '#C4302B' };
    case 'warning':        return { text: 'на грани — следить', color: '#D4A017' };
    case 'surplus':        return { text: 'избыток — притормозить', color: '#D4A017' };
    case 'healthy':        return { text: 'здоровый', color: 'var(--fg-3)' };
    case 'dead':           return { text: 'мёртвый — продаж нет', color: 'var(--fg-muted)' };
    case 'inactive':       return { text: 'неактивный', color: 'var(--fg-muted)' };
    default:               return { text: '—', color: 'var(--fg-muted)' };
  }
}

function coefColor(coef: number | null): string {
  if (coef === null) return 'var(--fg-muted)';
  if (coef < 2)  return '#C4302B';
  if (coef < 3)  return '#D4A017';
  if (coef < 6)  return 'var(--fg-1)';
  if (coef < 12) return '#D4A017';
  return '#C4302B';
}
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
  const [sortKey, setSortKey] = useState<SortKey>('monthly');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [priceTypeId, setPriceTypeId] = useState<string>('distr_usd');
  const [priceMap, setPriceMap] = useState<Record<string, number>>({});
  const [priceCurrency, setPriceCurrency] = useState<string>('USD');
  const [priceLoading, setPriceLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);

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

  // Load pricelist map whenever price_type changes
  useEffect(() => {
    const loadPrices = async () => {
      setPriceLoading(true);
      try {
        const res = await getPricelistMap(priceTypeId);
        if (res.success && res.result) {
          setPriceMap(res.result.prices);
          setPriceCurrency(res.result.currency);
        } else {
          setPriceMap({});
        }
      } catch {
        setPriceMap({});
      } finally {
        setPriceLoading(false);
      }
    };
    loadPrices();
  }, [priceTypeId]);

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
        case 'price':    {
          const pa = priceMap[a.id.toUpperCase()] ?? 0;
          const pb = priceMap[b.id.toUpperCase()] ?? 0;
          cmp = pa - pb;
          break;
        }
        case 'monthly': cmp = (a.monthly_sales ?? 0) - (b.monthly_sales ?? 0); break;
        case 'coef':    {
          // null coef (no sales) sorts last
          const ca = a.coef_dee;
          const cb = b.coef_dee;
          if (ca === null && cb === null) cmp = 0;
          else if (ca === null) cmp = 1;
          else if (cb === null) cmp = -1;
          else cmp = ca - cb;
          break;
        }
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [filtered, sortKey, sortDir, priceMap]);

  useEffect(() => {
    try {
      const u = JSON.parse(window.localStorage.getItem('dx_auth_user') || '{}');
      setIsAdmin(u?.role === 'admin');
    } catch { /* ignore */ }
  }, []);

  async function handleResync() {
    if (resyncing) return;
    setResyncing(true);
    setResyncMsg(null);
    try {
      const res = await resyncPrices();
      if (res.success) {
        setResyncMsg(res.messages?.[0] ?? 'Prices resynced');
        const pm = await getPricelistMap(priceTypeId);
        if (pm.success && pm.result) {
          setPriceMap(pm.result.prices);
          setPriceCurrency(pm.result.currency);
        }
      } else {
        setResyncMsg(res.errors?.[0]?.message ?? 'Resync failed');
      }
    } catch (e) {
      setResyncMsg(e instanceof Error ? e.message : 'Network error');
    } finally {
      setResyncing(false);
    }
  }

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
      <ProductsPartnersTabs />
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
        <div className="flex items-center gap-3">
        {isAdmin && (
          <button
            type="button"
            onClick={handleResync}
            disabled={resyncing}
            className="inline-flex items-center gap-2 px-4 py-2"
            style={{
              backgroundColor: 'var(--paper-sunk)',
              color: 'var(--fg-1)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '14px',
              fontWeight: 600,
              cursor: resyncing ? 'default' : 'pointer',
            }}
            title="Пересчитать цены из прайсов pricer (R2 → D1)"
          >
            {resyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Resync prices
          </button>
        )}
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
      </div>

      {resyncMsg && (
        <div style={{ fontSize: '13px', color: 'var(--fg-2)' }}>{resyncMsg}</div>
      )}
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

        <div className="flex gap-3 items-center">
          <select
            value={priceTypeId}
            onChange={(e) => setPriceTypeId(e.target.value)}
            className="px-3 py-2 focus:outline-none"
            style={{
              fontSize: '14px',
              fontWeight: 600,
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--fg-1)',
            }}
          >
            {PRICE_TYPES.map((pt) => (
              <option key={pt.id} value={pt.id}>{pt.label}</option>
            ))}
          </select>

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

          <div className="ml-auto self-center" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
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
                <ProductTh sortKey="price"    active={sortKey} dir={sortDir} onClick={clickHeader} defaultDir="desc">Price</ProductTh>
                <ProductTh sortKey="total"    active={sortKey} dir={sortDir} onClick={clickHeader} defaultDir="desc">Total stock</ProductTh>
                <ProductTh>Barcode</ProductTh>
                <ProductTh sortKey="monthly"  active={sortKey} dir={sortDir} onClick={clickHeader} defaultDir="desc">Monthly Sales</ProductTh>
                <ProductTh sortKey="coef"     active={sortKey} dir={sortDir} onClick={clickHeader} defaultDir="asc">Coef DEE</ProductTh>
                <ProductTh>Signal</ProductTh>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-12" style={{ color: 'var(--fg-3)', fontSize: '14px' }}>
                    No products match the filters
                  </td>
                </tr>
              ) : (
                sorted.map((p) => {
                  const skuShort = p.id.toUpperCase();
                  const price = priceMap[skuShort];
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
                      <td className="px-4 py-3" style={{
                        fontFamily: 'var(--font-accent-jakarta)',
                        fontWeight: 700,
                        fontSize: '18px',
                        fontVariantNumeric: 'tabular-nums',
                        color: price !== undefined ? 'var(--fg-1)' : 'var(--fg-muted)',
                      }}>
                        {priceLoading ? '…' : price !== undefined ? `${currencySymbol(priceCurrency)}${formatPriceValue(price)}` : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <StockCell
                          total={p.total_on_hand}
                          warehouses={p.warehouses}
                          codes={sparklineCodes}
                          maxOnHand={maxOnHand}
                        />
                      </td>
                      <td className="px-2 py-3" style={{
                        color: 'var(--fg-3)',
                        whiteSpace: 'nowrap',
                        fontFamily: 'ui-monospace, SFMono-Regular, "Roboto Mono", "DejaVu Sans Mono", monospace',
                        fontStretch: 'condensed',
                        fontSize: '11px',
                        fontVariantNumeric: 'tabular-nums',
                        letterSpacing: '0',
                      }}>
                        {p.barcode ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigator.clipboard.writeText(p.barcode || '');
                              const el = e.currentTarget;
                              const prev = el.textContent;
                              el.textContent = '✓ copied';
                              setTimeout(() => { el.textContent = prev; }, 900);
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              color: 'var(--fg-3)',
                              fontFamily: 'inherit',
                              fontSize: 'inherit',
                              fontStretch: 'inherit',
                              letterSpacing: 'inherit',
                            }}
                            title="Click to copy"
                          >
                            {p.barcode}
                          </button>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontWeight: 700,
                        color: (p.monthly_sales ?? 0) > 0 ? 'var(--fg-1)' : 'var(--fg-muted)',
                      }}>
                        {(p.monthly_sales ?? 0).toLocaleString('ru-RU')}
                      </td>
                      <td className="px-4 py-3 tabular-nums" style={{
                        textAlign: 'right',
                        whiteSpace: 'nowrap',
                        fontWeight: 700,
                        color: coefColor(p.coef_dee ?? null),
                      }}>
                        {p.coef_dee === null || p.coef_dee === undefined ? '—' : p.coef_dee.toFixed(2)}
                      </td>
                      <td className="px-4 py-3" style={{
                        whiteSpace: 'nowrap',
                        color: signalLabel(p.signal ?? 'inactive').color,
                        fontSize: '13px',
                      }}>
                        {signalLabel(p.signal ?? 'inactive').text}
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

function formatPriceValue(price: number): string {
  // 0.96 → "0.96", 102 → "102.00", 1.98 → "1.98"
  // Decimals shown when meaningful (sub-100 values)
  return price.toLocaleString('en-US', {
    minimumFractionDigits: price < 10 ? 2 : 2,
    maximumFractionDigits: 2,
  });
}

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
