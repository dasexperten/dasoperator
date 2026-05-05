'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, Loader2 } from 'lucide-react';
import {
  getProducts, getProductsWithStock,
  type Product, type ProductWithStock,
} from '@/lib/api';

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [stockMap, setStockMap] = useState<Record<string, ProductWithStock>>({});
  const [warehouseOrder, setWarehouseOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [manufacturerFilter, setManufacturerFilter] = useState<string>('all');

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [prodRes, stockRes] = await Promise.all([
          getProducts('DE'),
          getProductsWithStock(),
        ]);
        if (prodRes.success && prodRes.result) {
          setProducts(prodRes.result.products);
          setError(null);
        } else {
          setError(prodRes.errors[0]?.message ?? 'Failed to load products');
        }
        if (stockRes.success && stockRes.result) {
          const map: Record<string, ProductWithStock> = {};
          for (const p of stockRes.result.products) {
            map[p.id] = p;
          }
          setStockMap(map);
          // Stable warehouse order from first product
          const first = stockRes.result.products[0];
          if (first) setWarehouseOrder(first.warehouses.map((w) => w.code));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, []);

  const manufacturers = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => {
      if (p.manufacturer_name) set.add(p.manufacturer_name);
    });
    return Array.from(set).sort();
  }, [products]);

  const filtered = useMemo(() => {
    return products.filter((p) => {
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
  }, [products, search, categoryFilter, manufacturerFilter]);

  const pasteCount = products.filter((p) => p.category === 'Toothpaste').length;
  const brushCount = products.filter((p) => p.category === 'Toothbrush').length;

  // Compute global max on_hand for sparkline scaling
  const maxOnHand = useMemo(() => {
    let max = 0;
    for (const ps of Object.values(stockMap)) {
      for (const w of ps.warehouses) {
        if (w.on_hand > max) max = w.on_hand;
      }
    }
    return max || 1;
  }, [stockMap]);

  return (
    <div className="space-y-8 max-w-7xl">
      <div>
        <div className="dx-eyebrow dx-eyebrow-rot mb-2">Master Data</div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-md)',
            fontWeight: 900,
            letterSpacing: '-0.025em',
            color: 'var(--fg-1)',
          }}
        >
          Products
        </h1>
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          {loading ? 'Loading...' : `${products.length} products · ${pasteCount} toothpastes · ${brushCount} brushes`}
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="space-y-3">
        <div className="relative max-w-xl">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4"
            style={{ color: 'var(--fg-muted)' }}
          />
          <input
            type="text"
            placeholder="Search by name or SKU..."
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

        <div className="flex gap-3">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 text-sm focus:outline-none"
            style={{
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--fg-1)',
            }}
          >
            <option value="all">All categories</option>
            <option value="Toothpaste">Toothpaste</option>
            <option value="Toothbrush">Toothbrush</option>
          </select>

          <select
            value={manufacturerFilter}
            onChange={(e) => setManufacturerFilter(e.target.value)}
            className="px-3 py-2 text-sm focus:outline-none"
            style={{
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

          <div
            className="ml-auto self-center dx-mono"
            style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}
          >
            {filtered.length} / {products.length}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      ) : error ? (
        <div
          className="p-4 text-sm"
          style={{
            backgroundColor: 'rgba(229,32,44,0.05)',
            border: '1px solid rgba(229,32,44,0.2)',
            color: 'var(--brand-rot)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          Error: {error}
        </div>
      ) : (
        <div
          className="bg-card overflow-hidden"
          style={{
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <ProductTh>SKU</ProductTh>
                <ProductTh>Product</ProductTh>
                <ProductTh>Total stock</ProductTh>
                <ProductTh>Category</ProductTh>
                <ProductTh>Manufacturer</ProductTh>
                <ProductTh>Weight</ProductTh>
                <ProductTh>Barcode</ProductTh>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="text-center py-12"
                    style={{ color: 'var(--fg-3)' }}
                  >
                    No products match the filters
                  </td>
                </tr>
              ) : (
                filtered.map((p) => {
                  const skuShort = p.id.replace('prd_', '').toUpperCase();
                  const stock = stockMap[p.id];
                  return (
                    <tr
                      key={p.id}
                      className="transition-colors"
                      style={{ borderBottom: '1px solid var(--border-hairline)' }}
                    >
                      <td className="px-4 py-3 dx-mono" style={{ fontWeight: 700 }}>
                        <Link href={`/products/${skuShort}`} style={{ color: 'var(--fg-1)' }}>
                          {skuShort}
                        </Link>
                      </td>
                      <td className="px-4 py-3" style={{ fontWeight: 700 }}>
                        <Link href={`/products/${skuShort}`} style={{ color: 'var(--fg-1)' }}>
                          <span className="dx-product-name">{p.product_name}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {stock ? (
                          <StockCell stock={stock} maxOnHand={maxOnHand} warehouseOrder={warehouseOrder} />
                        ) : (
                          <span className="dx-mono" style={{ color: 'var(--fg-muted)' }}>—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <CategoryBadge category={p.category} />
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>
                        {p.manufacturer_name ?? '—'}
                      </td>
                      <td className="px-4 py-3 dx-mono" style={{ color: 'var(--fg-2)' }}>
                        {p.weight_kg ? `${p.weight_kg}g` : '—'}
                      </td>
                      <td className="px-4 py-3 dx-mono" style={{ color: 'var(--fg-3)' }}>
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

function StockCell({
  stock, maxOnHand, warehouseOrder,
}: {
  stock: ProductWithStock;
  maxOnHand: number;
  warehouseOrder: string[];
}) {
  const total = stock.total_on_hand;
  const totalColor = total > 0 ? 'var(--fg-1)' : 'var(--fg-muted)';

  // Order bars by global stable order
  const byCode: Record<string, number> = {};
  for (const w of stock.warehouses) byCode[w.code] = w.on_hand;
  const bars = warehouseOrder.length > 0 ? warehouseOrder : stock.warehouses.map((w) => w.code);

  return (
    <div className="flex items-center gap-3">
      <span className="dx-mono" style={{ fontSize: '14px', fontWeight: 700, color: totalColor, minWidth: '60px', textAlign: 'right' }}>
        {total.toLocaleString('en-US')}
      </span>
      <div className="flex items-end gap-0.5" style={{ height: '20px' }}>
        {bars.map((code) => {
          const v = byCode[code] ?? 0;
          const heightPct = v === 0 ? 0 : Math.max(8, (v / maxOnHand) * 100);
          return (
            <div
              key={code}
              title={`${code}: ${v.toLocaleString('en-US')}`}
              style={{
                width: '4px',
                height: v === 0 ? '2px' : `${heightPct}%`,
                backgroundColor: v === 0 ? 'var(--fg-muted)' : 'var(--fg-1)',
                opacity: v === 0 ? 0.3 : 1,
                borderRadius: '1px',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ProductTh({ children }: { children: React.ReactNode }) {
  return (
    <th
      className="text-left px-4 py-3 dx-eyebrow"
      style={{
        fontSize: '10px',
        color: 'var(--fg-3)',
        backgroundColor: 'var(--paper-sunk)',
      }}
    >
      {children}
    </th>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const isPaste = category === 'Toothpaste';
  return (
    <span
      className="dx-eyebrow inline-block"
      style={{
        padding: '3px 8px',
        fontSize: '9px',
        backgroundColor: isPaste ? 'var(--paper-sunk)' : 'var(--bone)',
        color: isPaste ? 'var(--line-innoweiss)' : 'var(--brand-schwarz)',
        border: `1px solid ${isPaste ? 'var(--line-innoweiss)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius-pill)',
        letterSpacing: '0.15em',
      }}
    >
      {category}
    </span>
  );
}
