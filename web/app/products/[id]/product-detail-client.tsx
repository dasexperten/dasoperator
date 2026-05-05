'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import {
  getProductBySku, getContact, getProductStock,
  type Product, type ProductStockResponse,
} from '@/lib/api';
import { CopyableValue, SectionCard } from '@/components/ui/copyable';

interface ManufacturerDetail {
  id: string;
  name: string;
  country?: string;
  city?: string;
  address?: string;
  role?: string;
  notes?: string;
}

export default function ProductDetailClient({ sku }: { sku: string }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [manufacturer, setManufacturer] = useState<ManufacturerDetail | null>(null);
  const [stock, setStock] = useState<ProductStockResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await getProductBySku(sku);
        if (!res.success || !res.result || res.result.products.length === 0) {
          setError(`Product ${sku} not found`); setLoading(false); return;
        }
        const p = res.result.products[0]!;
        setProduct(p);
        if (p.manufacturer_id) {
          const mfrRes = await getContact(p.manufacturer_id);
          if (mfrRes.success && mfrRes.result) {
            setManufacturer(mfrRes.result.data as unknown as ManufacturerDetail);
          }
        }
        // Fetch stock breakdown
        try {
          const stockRes = await getProductStock(p.id);
          if (stockRes.success && stockRes.result) setStock(stockRes.result);
        } catch { /* silent — stock optional */ }
        setError(null);
      } catch (e) { setError(e instanceof Error ? e.message : 'Network error'); }
      finally { setLoading(false); }
    };
    fetchData();
  }, [sku]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;

  if (error || !product) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href="/products" className="text-sm inline-flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
          <ArrowLeft className="h-4 w-4" />Back to Products
        </Link>
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error ?? 'Product not found'}
        </div>
      </div>
    );
  }

  const skuShort = product.id.replace('prd_', '').toUpperCase();

  const productFields = [
    { label: 'Category', value: product.category },
    { label: 'Barcode', value: product.barcode },
    { label: 'Weight', value: product.weight_kg ? `${product.weight_kg} g` : null },
    { label: 'Volume', value: product.volume_m3_micro ? `${product.volume_m3_micro / 1000} m³ × 10⁻³` : null },
  ];

  const manufacturerFields = manufacturer ? [
    { label: 'Name', value: manufacturer.name },
    { label: 'Country', value: manufacturer.country },
    { label: 'City', value: manufacturer.city },
  ] : [];

  return (
    <div className="space-y-8 max-w-5xl">
      <Link href="/products" className="text-sm inline-flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
        <ArrowLeft className="h-4 w-4" />Back to Products
      </Link>

      <div>
        <div className="flex items-center gap-3 mb-3">
          <span className="dx-mono px-2 py-1" style={{ fontSize: '11px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--fg-2)', letterSpacing: '0.05em' }}>
            {skuShort}
          </span>
        </div>
        <h1 className="dx-product-name" style={{ fontSize: '40px', color: 'var(--fg-1)', lineHeight: 1.05 }}>
          {product.product_name}
        </h1>
        <p className="mt-3 dx-mono" style={{ fontSize: '13px', color: 'var(--fg-2)', letterSpacing: '0.02em' }}>
          {product.invoice_label}
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="grid grid-cols-2 gap-6">
        <SectionCard label="Product Details" fields={productFields}>
          <CopyableField label="Category" value={product.category} highlight={product.category === 'Toothpaste' ? 'var(--line-innoweiss)' : 'var(--brand-schwarz)'} />
          <CopyableField label="Barcode" value={product.barcode} mono />
          <CopyableField label="Weight" value={product.weight_kg ? `${product.weight_kg} g` : '—'} mono />
          <CopyableField label="Volume" value={product.volume_m3_micro ? `${product.volume_m3_micro / 1000} m³ × 10⁻³` : '—'} mono />
          {product.notes && (
            <div className="pt-3 mt-3" style={{ borderTop: '1px solid var(--border-hairline)' }}>
              <div className="dx-eyebrow mb-2" style={{ fontSize: '10px' }}>Notes</div>
              <div style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>{product.notes}</div>
            </div>
          )}
        </SectionCard>

        <SectionCard label="Manufacturer" fields={manufacturerFields}>
          {manufacturer ? (
            <>
              <div>
                <dt className="dx-eyebrow mb-1" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>Name</dt>
                <dd>
                  <CopyableValue
                    value={manufacturer.name}
                    style={{ fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: 'var(--fs-body)', color: 'var(--fg-1)' }}
                  />
                </dd>
              </div>
              {manufacturer.country && <CopyableField label="Country" value={manufacturer.country} />}
              {manufacturer.city && <CopyableField label="City" value={manufacturer.city} />}
              {manufacturer.role && (
                <div className="pt-3 mt-3" style={{ borderTop: '1px solid var(--border-hairline)' }}>
                  <div className="dx-eyebrow mb-2" style={{ fontSize: '10px' }}>Role</div>
                  <div style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>{manufacturer.role}</div>
                </div>
              )}
            </>
          ) : (
            <div style={{ color: 'var(--fg-3)' }}>Loading manufacturer...</div>
          )}
        </SectionCard>
      </div>

      {/* STOCK ACROSS WAREHOUSES */}
      {stock && (
        <StockSection stock={stock} piecesPerCase={stock.product?.pieces_per_case ?? 1} />
      )}

      <div className="p-5" style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
        <div className="dx-eyebrow mb-3" style={{ color: 'var(--fg-3)' }}>Coming in Future Phases</div>
        <ul className="space-y-1.5" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          <li>· Active prices by price_type (RUB / USD)</li>
          <li>· Recent operations history</li>
        </ul>
      </div>
    </div>
  );
}

function formatCases(onHand: number, piecesPerCase: number): string {
  if (piecesPerCase <= 1 || onHand <= 0) return '—';
  const cases = Math.floor(onHand / piecesPerCase);
  const pcs = onHand % piecesPerCase;
  if (cases === 0) return `${pcs} pcs`;
  if (pcs === 0) return `${cases} cases`;
  return `${cases} cases + ${pcs} pcs`;
}

function StockSection({ stock, piecesPerCase }: { stock: ProductStockResponse; piecesPerCase: number }) {
  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
      <div className="flex items-end justify-between mb-4">
        <div>
          <h2 style={{
            fontFamily: 'var(--font-accent-jakarta)',
            fontSize: '24px',
            fontWeight: 800,
            letterSpacing: '-0.005em',
            textTransform: 'uppercase',
            color: 'var(--fg-1)',
            lineHeight: 1,
          }}>
            Stock Across Warehouses
          </h2>
        </div>
        <div className="text-right">
          <div className="dx-eyebrow mb-1" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>Total</div>
          <div className="dx-mono" style={{ fontSize: '32px', fontWeight: 700, color: stock.total_on_hand > 0 ? 'var(--fg-1)' : 'var(--fg-muted)', lineHeight: 1 }}>
            {stock.total_on_hand.toLocaleString('en-US')}
          </div>
        </div>
      </div>

      {stock.by_warehouse.length === 0 ? (
        <div className="text-center py-8" style={{ color: 'var(--fg-3)', fontSize: '14px' }}>
          No warehouses configured
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
              <th className="text-left px-3 py-2 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>Code</th>
              <th className="text-left px-3 py-2 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>Warehouse</th>
              <th className="text-right px-3 py-2 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>On hand (pcs)</th>
              <th className="text-right px-3 py-2 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>Cases breakdown</th>
            </tr>
          </thead>
          <tbody>
            {stock.by_warehouse.map((w) => {
              const muted = w.on_hand === 0;
              return (
                <tr key={w.warehouse_id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="px-3 py-2 dx-mono" style={{ fontSize: '14px', fontWeight: 700, color: muted ? 'var(--fg-muted)' : 'var(--fg-1)' }}>
                    <Link href={`/warehouses/${w.warehouse_id}`} style={{ color: 'inherit' }}>{w.code}</Link>
                  </td>
                  <td className="px-3 py-2" style={{ fontSize: '14px', color: muted ? 'var(--fg-muted)' : 'var(--fg-2)' }}>
                    <Link href={`/warehouses/${w.warehouse_id}`} style={{ color: 'inherit' }}>{w.name}</Link>
                  </td>
                  <td className="px-3 py-2 dx-mono text-right" style={{ fontSize: '14px', fontWeight: 700, color: muted ? 'var(--fg-muted)' : 'var(--fg-1)' }}>
                    {w.on_hand.toLocaleString('en-US')}
                  </td>
                  <td className="px-3 py-2 dx-mono text-right" style={{ fontSize: '13px', color: muted ? 'var(--fg-muted)' : 'var(--fg-2)' }}>
                    {formatCases(w.on_hand, piecesPerCase)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CopyableField({ label, value, mono, highlight }: { label: string; value?: string | null; mono?: boolean; highlight?: string }) {
  const missing = !value || value === 'MISSING' || value === '—' || value.trim() === '';
  return (
    <div>
      <dt className="dx-eyebrow mb-1" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>{label}</dt>
      <dd>
        {missing ? (
          <span style={{ fontSize: mono ? '12px' : 'var(--fs-body-sm)', color: 'var(--fg-3)' }}>—</span>
        ) : (
          <CopyableValue
            value={value!}
            mono={mono}
            style={{ fontSize: mono ? '12px' : 'var(--fs-body-sm)', color: highlight ?? 'var(--fg-1)' }}
          />
        )}
      </dd>
    </div>
  );
}
