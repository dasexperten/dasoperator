'use client';

export const runtime = 'edge';



import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Loader2, Search, ArrowUp, ArrowDown, AlertTriangle, ArrowLeftRight, Package, SlidersHorizontal, Check, X } from 'lucide-react';
import {
  getProductsWithStock, getWarehouses, getMarketplaceStocks, getMarketplaceHealth,
  getExternalStocksByProduct,
  type ProductWithStock, type Warehouse, type MarketplaceStockRow,
  type MarketplaceHealthResponse,
  type ExternalStockByProductRow,
} from '@/lib/api';
import StockTransferModal from '@/components/warehouses/stock-transfer-modal';

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
  const [mpHealth, setMpHealth] = useState<MarketplaceHealthResponse | null>(null);
  // External stocks: keyed as `${product_id}|${warehouse_id}` for O(1) lookup in row render.
  // Source: F4 Lyubertsy WMS via Skladbot API, refreshed by /api/external-stocks/sync cron.
  const [externalStocks, setExternalStocks] = useState<Record<string, ExternalStockByProductRow>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Default sort: Total column, descending (Aram's standing instruction).
  // Click cycles desc → asc → null.
  const [sort, setSort] = useState<SortState | null>({ key: 'total', dir: 'desc' });
  const [showTransfer, setShowTransfer] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Mobile column picker: on phones the ~15-column matrix is unusable, so we
  // hide the Product name and show only SKU + a hand-picked set of warehouse
  // columns. `visibleCols` holds warehouse ids + special keys, persisted.
  const [isMobile, setIsMobile] = useState(false);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(new Set());
  const [colsInitialized, setColsInitialized] = useState(false);
  const [showColPicker, setShowColPicker] = useState(false);

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [stockRes, whRes, mpRes, mpHealthRes, extRes] = await Promise.all([
          getProductsWithStock(),
          getWarehouses(),
          getMarketplaceStocks(),
          getMarketplaceHealth(),
          getExternalStocksByProduct(),
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
        if (mpHealthRes.success && mpHealthRes.result) {
          setMpHealth(mpHealthRes.result);
        }
        if (extRes.success && extRes.result) {
          const byKey: Record<string, ExternalStockByProductRow> = {};
          for (const row of extRes.result.rows) {
            if (!row.product_id) continue;
            byKey[`${row.product_id}|${row.warehouse_id}`] = row;
          }
          setExternalStocks(byKey);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [reloadKey]);

  // Track the mobile breakpoint (drives which columns render).
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setIsMobile(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
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
        const computeTotal = (p: ProductWithStock): number => {
          const skuLower = p.id.replace('prd_', '').toLowerCase();
          let t = 0;
          for (const w of p.warehouses) {
            if (w.warehouse_id === 'lbr') {
              const ext = externalStocks[`${skuLower}|lbr`];
              t += (ext && typeof ext.amount === 'number') ? ext.amount : w.on_hand;
            } else if (w.warehouse_id === 'ozon' || w.warehouse_id === 'wb') {
              continue;
            } else {
              t += w.on_hand;
            }
          }
          t += p.on_the_way ?? 0;
          const mp = marketplaces[p.id];
          t += mp?.ozon_units ?? 0;
          t += mp?.wb_units ?? 0;
          return t;
        };
        va = computeTotal(a);
        vb = computeTotal(b);
      } else if (sort.key === 'ozon') {
        va = marketplaces[a.id]?.ozon_units ?? 0;
        vb = marketplaces[b.id]?.ozon_units ?? 0;
      } else if (sort.key === 'wb') {
        va = marketplaces[a.id]?.wb_units ?? 0;
        vb = marketplaces[b.id]?.wb_units ?? 0;
      } else if (sort.key === 'otw') {
        va = a.on_the_way ?? 0;
        vb = b.on_the_way ?? 0;
      } else {
        // warehouse_id — find on_hand for that warehouse on each product.
        // Special case: LBR is displayed with F4 external_stocks.amount when
        // available, so we sort by the same value the user sees.
        if (sort.key === 'lbr') {
          const skuLowerA = a.id.replace('prd_', '').toLowerCase();
          const skuLowerB = b.id.replace('prd_', '').toLowerCase();
          const extA = externalStocks[`${skuLowerA}|lbr`];
          const extB = externalStocks[`${skuLowerB}|lbr`];
          const onHandA = a.warehouses.find((w) => w.warehouse_id === 'lbr')?.on_hand ?? 0;
          const onHandB = b.warehouses.find((w) => w.warehouse_id === 'lbr')?.on_hand ?? 0;
          va = (extA && typeof extA.amount === 'number') ? extA.amount : onHandA;
          vb = (extB && typeof extB.amount === 'number') ? extB.amount : onHandB;
        } else {
          const ai = a.warehouses.find((w) => w.warehouse_id === sort.key);
          const bi = b.warehouses.find((w) => w.warehouse_id === sort.key);
          va = ai?.on_hand ?? 0;
          vb = bi?.on_hand ?? 0;
        }
      }

      if (typeof va === 'string' && typeof vb === 'string') {
        return va < vb ? dir * -1 : va > vb ? dir : 0;
      }
      return ((va as number) - (vb as number)) * dir;
    });

    return list;
  }, [products, sort, marketplaces, externalStocks]);

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

  // Footer column totals.
  //
  // Per-warehouse rule:
  // - LBR: prefer F4 external_stocks amount (the official Skladbot truth);
  //   fall back to our on_hand only if F4 hasn't synced this SKU.
  // - All other internal warehouses (FLP, SRN, DGN, GZH, etc.): our on_hand
  //   (no external source).
  // - OTW: our on_hand (computed from on_the_way).
  // Marketplace totals (Ozon/WB) are computed separately in marketplaceTotals.
  const totalsByWarehouse = useMemo(() => {
    const totals: Record<string, number> = {};
    let otwTotal = 0;
    for (const p of products) {
      const skuLower = p.id.replace('prd_', '').toLowerCase();
      for (const w of p.warehouses) {
        let val = w.on_hand;
        if (w.warehouse_id === 'lbr') {
          const ext = externalStocks[`${skuLower}|lbr`];
          if (ext && typeof ext.amount === 'number') val = ext.amount;
        }
        totals[w.code] = (totals[w.code] ?? 0) + val;
      }
      otwTotal += p.on_the_way ?? 0;
    }
    return { totals, otwTotal };
  }, [products, externalStocks]);

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

  // Grand total = sum of all column totals in the footer.
  // This is the single number shown in the header line ("X pieces total").
  const grandTotal = useMemo(() => {
    const whSum = Object.values(totalsByWarehouse.totals).reduce((a, b) => a + b, 0);
    return whSum + totalsByWarehouse.otwTotal + marketplaceTotals.ozon + marketplaceTotals.wb;
  }, [totalsByWarehouse, marketplaceTotals]);

  // Per-row totals computed client-side using same external-aware rule.
  // For each product, sum: LBR-from-F4 (or on_hand fallback) + other warehouses' on_hand
  // + OTW + Ozon (API) + WB (API).
  const realTotalByProduct = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of products) {
      const skuLower = p.id.replace('prd_', '').toLowerCase();
      let total = 0;
      for (const w of p.warehouses) {
        if (w.warehouse_id === 'lbr') {
          const ext = externalStocks[`${skuLower}|lbr`];
          total += (ext && typeof ext.amount === 'number') ? ext.amount : w.on_hand;
        } else if (w.warehouse_id === 'ozon' || w.warehouse_id === 'wb') {
          // Marketplace warehouses contribute via API totals below, not on_hand.
          continue;
        } else {
          total += w.on_hand;
        }
      }
      total += p.on_the_way ?? 0;
      const mp = marketplaces[p.id];
      total += mp?.ozon_units ?? 0;
      total += mp?.wb_units ?? 0;
      m[p.id] = total;
    }
    return m;
  }, [products, externalStocks, marketplaces]);

  // Filter out marketplace-hidden warehouses (ozon, wb) — these are rendered
  // separately via MarketplaceCellTd which combines API data + our internal.
  // Keeping them in the warehouses table lets transfer ops target them in
  // Phase 5, but they don't get their own matrix column.
  const sortedWarehouses = useMemo(
    () => sortWarehousesByGroup(
      warehouses.filter((w) =>
        w.external_provider !== 'ozon' &&
        w.external_provider !== 'wb' &&
        w.id !== 'otw'
      )
    ),
    [warehouses]
  );

  const SPECIAL_COLS: Array<{ key: string; label: string }> = [
    { key: 'otw', label: 'OTW (on the way)' },
    { key: 'ozon', label: 'Ozon' },
    { key: 'wb', label: 'Wildberries' },
    { key: 'total', label: 'Total' },
  ];

  // Initialise the visible-columns set once warehouses load: from localStorage,
  // or default to the first 3 warehouses (group-sorted) + Total.
  useEffect(() => {
    if (colsInitialized || sortedWarehouses.length === 0) return;
    let initial: string[] | null = null;
    try {
      const saved = localStorage.getItem('dx-wh-cols');
      if (saved) initial = JSON.parse(saved);
    } catch { /* ignore malformed */ }
    if (!initial || initial.length === 0) {
      initial = [...sortedWarehouses.slice(0, 3).map((w) => w.id), 'total'];
    }
    setVisibleCols(new Set(initial));
    setColsInitialized(true);
  }, [sortedWarehouses, colsInitialized]);

  useEffect(() => {
    if (!colsInitialized) return;
    try { localStorage.setItem('dx-wh-cols', JSON.stringify(Array.from(visibleCols))); } catch { /* ignore */ }
  }, [visibleCols, colsInitialized]);

  const toggleCol = (key: string) =>
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // On mobile: hide Product, show only the picked warehouse + special columns.
  // On desktop: everything, as before.
  const showProduct = !isMobile;
  const showCol = (key: string) => !isMobile || visibleCols.has(key);
  const visibleWarehouses = isMobile
    ? sortedWarehouses.filter((w) => visibleCols.has(w.id))
    : sortedWarehouses;
  const renderedColCount =
    (showProduct ? 2 : 1) +
    visibleWarehouses.length +
    SPECIAL_COLS.filter((c) => showCol(c.key)).length;

  return (
    <div className="space-y-8 max-w-full">
      <div className="flex items-start justify-between gap-4 dx-header-wrap">
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
            {loading ? 'Loading...' : `${products.length} SKUs × ${warehouses.length} warehouses · ${grandTotal.toLocaleString('en-US')} pieces total`}
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-2 dx-page-actions">
          <Link
            href="/operations/bundling/new"
            className="flex items-center gap-2"
            style={{
              padding: '9px 16px',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              backgroundColor: 'var(--brand-rot, #A32D2D)',
              color: '#fff',
              fontSize: 'var(--fs-body-sm)',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              textDecoration: 'none',
            }}
          >
            <Package className="h-4 w-4" />
            Bundling
          </Link>
          <button
            onClick={() => setShowTransfer(true)}
            className="flex items-center gap-2"
            style={{
              padding: '9px 16px',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              backgroundColor: 'var(--brand-blau, #185FA5)',
              color: '#fff',
              fontSize: 'var(--fs-body-sm)',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            <ArrowLeftRight className="h-4 w-4" />
            Stock transfer
          </button>
        </div>
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
        {/* Mobile-only: choose which warehouse columns to show */}
        <div className="dx-show-mobile">
          <button
            onClick={() => setShowColPicker(true)}
            className="flex items-center gap-2"
            style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-hairline)',
              background: 'var(--paper-raised)',
              color: 'var(--fg-1)',
              fontSize: '14px',
              fontWeight: 700,
            }}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Columns · {visibleCols.size}
          </button>
        </div>
      </div>

      <SyncWarningBanner health={mpHealth} />

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      ) : error ? (
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          Error: {error}
        </div>
      ) : (
        <div className="bg-card overflow-x-auto dx-table-scroll" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <table className="w-full text-sm dx-keep-table" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr>
                <SortableTh sticky sortKey="sku" sort={sort} onClick={handleSortClick}>SKU</SortableTh>
                {showProduct && <SortableTh sticky2 sortKey="product" sort={sort} onClick={handleSortClick}>Product</SortableTh>}
                {visibleWarehouses.map((w) => (
                  <SortableTh
                    key={w.id}
                    center
                    withParens={!!w.external_provider}
                    bg={TINT_BY_GROUP[groupForWarehouse(w)]}
                    sortKey={w.id}
                    sort={sort}
                    onClick={handleSortClick}
                  >
                    {w.code}
                  </SortableTh>
                ))}
                {/* OTW (On The Way) — virtual warehouse aggregating all
                    in-transit stock. Position: between Yzh (last factory)
                    and Ozon (marketplace). */}
                {showCol('otw') && <SortableTh
                  center
                  bg="rgba(250, 199, 117, 0.18)"
                  sortKey="otw"
                  sort={sort}
                  onClick={handleSortClick}
                >OTW</SortableTh>}
                {showCol('ozon') && <SortableTh
                  center
                  withParens
                  bg={MARKETPLACE_TINT.ozon}
                  sortKey="ozon"
                  sort={sort}
                  onClick={handleSortClick}
                >Ozon</SortableTh>}
                {showCol('wb') && <SortableTh
                  center
                  withParens
                  bg={MARKETPLACE_TINT.wb}
                  sortKey="wb"
                  sort={sort}
                  onClick={handleSortClick}
                >WB</SortableTh>}
                {showCol('total') && <SortableTh
                  center
                  accent
                  sortKey="total"
                  sort={sort}
                  onClick={handleSortClick}
                >Total</SortableTh>}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={renderedColCount} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>
                    No products match
                  </td>
                </tr>
              ) : (
                filtered.map((p) => {
                  const skuShort = p.id.replace('prd_', '').toUpperCase();
                  const skuLower = p.id.replace('prd_', '').toLowerCase();
                  const byWh: Record<string, number> = {};
                  const prodByWh: Record<string, number> = {};
                  for (const w of p.warehouses) {
                    byWh[w.warehouse_id] = w.on_hand;
                    prodByWh[w.warehouse_id] = w.in_production ?? 0;
                  }
                  const otwQty = p.on_the_way ?? 0;

                  const mp = marketplaces[p.id];
                  const ozonVal = mp?.ozon_units ?? 0;
                  const wbVal   = mp?.wb_units ?? 0;
                  // Our internal stock for Ozon/WB hidden warehouses — populated
                  // by transfer LBR → ozon/wb operations from Phase 5+. Until
                  // then, shows 0.
                  const ourOzonVal = byWh['ozon'] ?? 0;
                  const ourWbVal   = byWh['wb'] ?? 0;

                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-3 py-2" style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: '14px' }}>
                        <Link href={`/products/${skuLower}`} style={{ color: 'inherit' }}>{skuShort}</Link>
                      </td>
                      {showProduct && (
                        <td className="px-3 py-2 dx-sticky-2" style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: '14px', maxWidth: '280px' }}>
                          <Link href={`/products/${skuLower}`} style={{ color: 'inherit' }}>{p.product_name}</Link>
                        </td>
                      )}
                      {visibleWarehouses.map((w) => {
                        const v = byWh[w.id] ?? 0;
                        const prod = prodByWh[w.id] ?? 0;
                        const ext = externalStocks[`${skuLower}|${w.id}`];
                        return (
                          <StockCellTd
                            key={w.id}
                            value={v}
                            inProduction={prod}
                            externalAmount={ext?.amount}
                            hasParensColumn={!!w.external_provider}
                            href={`/warehouses/${w.id}?sku=${skuLower}`}
                            tint={TINT_BY_GROUP[groupForWarehouse(w)]}
                          />
                        );
                      })}
                      {showCol('otw') && <OtwCellTd value={otwQty} />}
                      {showCol('ozon') && <MarketplaceCellTd value={ozonVal} ourValue={ourOzonVal} tint={MARKETPLACE_TINT.ozon} />}
                      {showCol('wb') && <MarketplaceCellTd value={wbVal}   ourValue={ourWbVal}   tint={MARKETPLACE_TINT.wb} />}
                      {showCol('total') && (
                        <td className="px-3 py-2 text-right" style={{
                          fontSize: '14px',
                          fontWeight: 700,
                          color: (realTotalByProduct[p.id] ?? 0) > 0 ? 'var(--fg-1)' : 'var(--fg-muted)',
                          backgroundColor: 'var(--paper-sunk)',
                        }}>
                          {(realTotalByProduct[p.id] ?? 0).toLocaleString('en-US')}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border-hairline)' }}>
                  <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>Total</td>
                  {showProduct && <td className="px-3 py-2 dx-sticky-2" style={{ backgroundColor: 'var(--paper-sunk)' }}></td>}
                  {visibleWarehouses.map((w) => {
                    const tot = totalsByWarehouse.totals[w.code] ?? 0;
                    const cellBg = TINT_BY_GROUP[groupForWarehouse(w)];
                    if (w.external_provider) {
                      return (
                        <td key={w.id} className="px-3 py-2" style={{
                          fontSize: '14px',
                          fontWeight: 700,
                          color: 'var(--fg-1)',
                          backgroundColor: cellBg,
                        }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px', columnGap: '4px', alignItems: 'baseline' }}>
                            <span style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                              {tot.toLocaleString('en-US')}
                            </span>
                            <span />
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td key={w.id} className="px-3 py-2 text-right" style={{
                        fontSize: '14px',
                        fontWeight: 700,
                        color: 'var(--fg-1)',
                        backgroundColor: cellBg,
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                      }}>
                        {tot.toLocaleString('en-US')}
                      </td>
                    );
                  })}
                  {/* OTW total */}
                  {showCol('otw') && <td className="px-3 py-2 text-right" style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: totalsByWarehouse.otwTotal > 0 ? '#854F0B' : 'var(--fg-1)',
                    backgroundColor: 'rgba(250, 199, 117, 0.28)',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {totalsByWarehouse.otwTotal.toLocaleString('en-US')}
                  </td>}
                  {showCol('ozon') && <td className="px-3 py-2" style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: 'var(--fg-1)',
                    backgroundColor: MARKETPLACE_TINT.ozon,
                  }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px', columnGap: '4px', alignItems: 'baseline' }}>
                      <span style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {marketplaceTotals.ozon.toLocaleString('en-US')}
                      </span>
                      <span />
                    </div>
                  </td>}
                  {showCol('wb') && <td className="px-3 py-2" style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: 'var(--fg-1)',
                    backgroundColor: MARKETPLACE_TINT.wb,
                  }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px', columnGap: '4px', alignItems: 'baseline' }}>
                      <span style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {marketplaceTotals.wb.toLocaleString('en-US')}
                      </span>
                      <span />
                    </div>
                  </td>}
                  {showCol('total') && <td className="px-3 py-2 text-right" style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: 'var(--fg-1)',
                    backgroundColor: 'var(--paper-sunk)',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {grandTotal.toLocaleString('en-US')}
                  </td>}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {showColPicker && (
        <div
          onClick={() => setShowColPicker(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,15,15,0.5)', zIndex: 80, display: 'flex', alignItems: 'flex-end' }}
        >
          <div
            className="dx-modal-panel"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--paper)', width: '100%',
              borderRadius: '14px 14px 0 0', padding: '16px',
              maxHeight: '80vh', overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <h2 style={{ fontSize: 16, fontWeight: 800, color: 'var(--fg-1)' }}>Columns to show</h2>
              <button onClick={() => setShowColPicker(false)} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--fg-3)', padding: 4 }}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--fg-3)', marginBottom: 8 }}>SKU is always shown. Pick the warehouses to display alongside it.</p>
            {sortedWarehouses.map((w) => {
              const on = visibleCols.has(w.id);
              return (
                <button key={w.id} onClick={() => toggleCol(w.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 4px', borderBottom: '1px solid var(--border-hairline)', background: 'transparent', textAlign: 'left', cursor: 'pointer' }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg-1)' }}>
                    {w.code}
                    <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--fg-3)' }}>{w.country ?? ''}</span>
                  </span>
                  {on ? <Check className="h-5 w-5" style={{ color: 'var(--brand-rot)' }} /> : <span style={{ width: 20, display: 'inline-block' }} />}
                </button>
              );
            })}
            {SPECIAL_COLS.map((c) => {
              const on = visibleCols.has(c.key);
              return (
                <button key={c.key} onClick={() => toggleCol(c.key)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 4px', borderBottom: '1px solid var(--border-hairline)', background: 'transparent', textAlign: 'left', cursor: 'pointer' }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--fg-1)' }}>{c.label}</span>
                  {on ? <Check className="h-5 w-5" style={{ color: 'var(--brand-rot)' }} /> : <span style={{ width: 20, display: 'inline-block' }} />}
                </button>
              );
            })}
            <button onClick={() => setShowColPicker(false)} style={{ marginTop: 16, width: '100%', padding: '12px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'var(--brand-rot)', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>Done</button>
          </div>
        </div>
      )}
      {showTransfer && (
        <StockTransferModal
          warehouses={warehouses}
          onClose={() => setShowTransfer(false)}
          onDone={() => { setShowTransfer(false); setReloadKey((k) => k + 1); }}
        />
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

function StockCellTd({ value, inProduction = 0, externalAmount, hasParensColumn = false, href, tint }: { value: number; inProduction?: number; externalAmount?: number; hasParensColumn?: boolean; href: string; tint?: string }) {
  const hasExternal = typeof externalAmount === 'number';

  // ────────────────────────────────────────────────────────────────────────
  // Display invariant: warehouses backed by an external API (LBR via F4,
  // ozon via Ozon Seller, wb via WB Statistics) show **API number primary**
  // and **our internal value in parens**. Source of truth = the API.
  //
  // Other warehouses (FLP, SRN, OTW, factory, bonded) show only `value`.
  // ────────────────────────────────────────────────────────────────────────
  const primary = hasExternal ? externalAmount! : value;   // big number
  const secondary = hasExternal ? value : undefined;        // in parens

  // Background tint based on primary qty (low-stock red/amber signal)
  let bg: string | undefined = tint;
  let color: string;
  if (primary === 0 && inProduction === 0) {
    color = 'var(--fg-muted)';
  } else if (primary > 0 && primary <= 50) {
    bg = 'rgba(229,32,44,0.08)';
    color = 'var(--brand-rot)';
  } else if (primary > 0 && primary <= 200) {
    bg = 'rgba(199,122,0,0.08)';
    color = 'var(--status-warning)';
  } else {
    color = 'var(--fg-1)';
  }

  const showPrimary = primary > 0;
  const showProd = inProduction !== 0;
  const isPendingOut = inProduction < 0;
  const pendingColor = isPendingOut ? 'var(--brand-rot)' : '#3B6D11';
  const pendingSign = isPendingOut ? '−' : '+';
  const pendingAbs = Math.abs(inProduction);

  // Parens color = drift signal. Compare api vs our: small=grey, 1-5%=amber,
  // >5%=red. When primary is 0 but secondary>0 (we still hold stock that
  // API says is gone) — amber to surface the reconciliation gap.
  let parensColor = 'var(--fg-3)';
  if (hasExternal && showPrimary && secondary !== undefined) {
    const diff = Math.abs(primary - secondary);
    const pct = primary > 0 ? diff / primary : 0;
    if (pct > 0.05) parensColor = 'var(--brand-rot)';
    else if (pct > 0.01) parensColor = '#854F0B';
  } else if (hasExternal && !showPrimary && (secondary ?? 0) > 0) {
    parensColor = '#854F0B';
  }

  if (!hasParensColumn) {
    // No-API warehouse (FLP, SRN, SWH, DGN, GZH, YZH) — no parens ever,
    // so keep the column compact with plain right-aligned content.
    return (
      <td className="px-3 py-2 text-right" style={{ backgroundColor: bg, fontSize: '14px', color, fontVariantNumeric: 'tabular-nums' }}>
        <Link href={href} style={{ color: 'inherit', whiteSpace: 'nowrap' }}>
          {!showPrimary && !showProd && '—'}
          {showPrimary && <span>{primary.toLocaleString('en-US')}</span>}
          {showProd && (
            <span style={{ color: pendingColor, fontWeight: 600, marginLeft: showPrimary ? '4px' : 0 }}>
              {pendingSign}{pendingAbs.toLocaleString('en-US')}
            </span>
          )}
        </Link>
      </td>
    );
  }

  return (
    <td className="px-3 py-2" style={{ backgroundColor: bg, fontSize: '14px', color }}>
      <Link
        href={href}
        style={{
          color: 'inherit',
          display: 'grid',
          gridTemplateColumns: '1fr 56px',
          columnGap: '4px',
          alignItems: 'baseline',
        }}
      >
        <span style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {!showPrimary && !showProd && !hasExternal && '—'}
          {showPrimary && <span>{primary.toLocaleString('en-US')}</span>}
          {!showPrimary && hasExternal && <span style={{ color: 'var(--fg-muted)' }}>0</span>}
          {showProd && (
            <span style={{ color: pendingColor, fontWeight: 600, marginLeft: showPrimary ? '4px' : 0 }}>
              {pendingSign}{pendingAbs.toLocaleString('en-US')}
            </span>
          )}
        </span>
        <span style={{ textAlign: 'left', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {hasExternal && secondary !== undefined && (
            <span style={{ color: parensColor, fontWeight: 400, fontSize: '12px' }}>
              ({secondary.toLocaleString('en-US')})
            </span>
          )}
        </span>
      </Link>
    </td>
  );
}

// OTW (On The Way) — virtual warehouse cell, always light yellow
function OtwCellTd({ value }: { value: number }) {
  const color = value === 0 ? 'var(--fg-muted)' : '#854F0B';
  return (
    <td className="px-3 py-2 text-right" style={{
      backgroundColor: 'rgba(250, 199, 117, 0.18)',
      fontSize: '14px',
      color,
      fontWeight: value > 0 ? 600 : 400,
      fontVariantNumeric: 'tabular-nums',
    }}>
      {value === 0 ? '—' : value.toLocaleString('en-US')}
    </td>
  );
}

function MarketplaceCellTd({ value, ourValue = 0, tint }: { value: number; ourValue?: number; tint: string }) {
  // API number primary (Ozon/WB FBO from /marketplace/stocks endpoint).
  // ourValue in parens = our internal stock at the hidden 'ozon' / 'wb'
  // warehouse — built up from transfer LBR → external operations starting
  // in Phase 5. Until then ourValue = 0.
  const color = value === 0 ? 'var(--fg-muted)' : 'var(--fg-1)';

  // Parens color = drift signal. Compare api vs our.
  let parensColor = 'var(--fg-3)';
  if (value > 0) {
    const diff = Math.abs(value - ourValue);
    const pct = diff / value;
    if (pct > 0.05) parensColor = 'var(--brand-rot)';      // >5% off — red
    else if (pct > 0.01) parensColor = '#854F0B';          // 1-5% off — amber
  } else if (ourValue > 0) {
    // API says nothing, but we have transfers recorded — surface this
    parensColor = '#854F0B';
  }

  return (
    <td className="px-3 py-2" style={{ backgroundColor: tint, fontSize: '14px', color, fontWeight: value > 0 ? 600 : 400 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 56px',
          columnGap: '4px',
          alignItems: 'baseline',
        }}
      >
        <span style={{ textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {value === 0 && ourValue === 0
            ? '—'
            : value > 0
              ? value.toLocaleString('en-US')
              : <span style={{ color: 'var(--fg-muted)' }}>0</span>}
        </span>
        <span style={{ textAlign: 'left', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {!(value === 0 && ourValue === 0) && (
            <span style={{ color: parensColor, fontWeight: 400, fontSize: '12px' }}>
              ({ourValue.toLocaleString('en-US')})
            </span>
          )}
        </span>
      </div>
    </td>
  );
}

// =============================================================================
// Sortable column header
// =============================================================================
function SortableTh({
  children, sortKey, sort, onClick,
  sticky, sticky2, center, accent, bg, withParens,
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
  withParens?: boolean;
}) {
  const isActive = sort?.key === sortKey;
  const dir = isActive ? sort!.dir : null;

  // When withParens=true, the column's cells use a two-slot grid
  // (1fr main number | 56px parens). The header mimics the same grid
  // so that the label + sort arrow line up with the main numbers below,
  // not with the right edge of the cell (which is the parens slot).
  const labelBlock = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', justifyContent: center ? 'flex-end' : 'flex-start' }}>
      {children}
      {dir === 'desc' && <ArrowDown className="h-3 w-3" style={{ color: 'var(--brand-rot)' }} />}
      {dir === 'asc'  && <ArrowUp   className="h-3 w-3" style={{ color: 'var(--brand-rot)' }} />}
      {!isActive && <ArrowDown className="h-3 w-3" style={{ color: 'var(--fg-3)', opacity: 0.35 }} />}
    </span>
  );

  return (
    <th
      onClick={() => onClick(sortKey)}
      className={`px-3 py-3 ${withParens ? '' : center ? 'text-right' : 'text-left'}`}
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
      {withParens ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 56px',
            columnGap: '4px',
            alignItems: 'baseline',
          }}
        >
          <span style={{ textAlign: 'right' }}>{labelBlock}</span>
          <span />
        </div>
      ) : labelBlock}
    </th>
  );
}

// =============================================================================
// Marketplace sync warning banner (Phase 6.0b)
// =============================================================================
// Renders a red strip if the last sync attempt for either marketplace failed.
// Hidden when both syncs are OK or running.

function SyncWarningBanner({ health }: { health: MarketplaceHealthResponse | null }) {
  if (!health) return null;

  const failed: string[] = [];
  for (const [key, name] of [['ozon', 'Ozon'], ['wb', 'Wildberries']] as const) {
    const entry = health[key];
    if (!entry) continue;
    if (entry.status === 'error') failed.push(name);
  }
  if (failed.length === 0) return null;

  const failedAt = Math.max(
    health.ozon?.status === 'error' ? (health.ozon.started_at ?? 0) : 0,
    health.wb?.status === 'error' ? (health.wb.started_at ?? 0) : 0,
  );

  return (
    <div
      className="flex items-start gap-3 p-3"
      style={{
        backgroundColor: 'rgba(229,32,44,0.06)',
        border: '1px solid rgba(229,32,44,0.25)',
        borderRadius: 'var(--radius-sm)',
        fontSize: '14px',
        color: 'var(--fg-1)',
      }}
    >
      <AlertTriangle className="h-5 w-5 mt-0.5 flex-shrink-0" style={{ color: 'var(--brand-rot)' }} />
      <div>
        <div style={{ color: 'var(--brand-rot)', fontWeight: 700 }}>
          Marketplace sync failed: {failed.join(', ')}
        </div>
        <div className="mt-1" style={{ color: 'var(--fg-2)' }}>
          Last attempt at {formatBannerTimestamp(failedAt)} did not complete. Stock columns below show data from the previous successful sync. <a href="/marketplaces" style={{ color: 'var(--brand-rot)', textDecoration: 'underline' }}>View sync log</a>
        </div>
      </div>
    </div>
  );
}

function formatBannerTimestamp(unix: number): string {
  if (!unix) return 'unknown time';
  const d = new Date(unix * 1000);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

