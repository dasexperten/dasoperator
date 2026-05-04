'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { getProductBySku, getContact, type Product } from '@/lib/api';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await getProductBySku(sku);
        if (!res.success || !res.result || res.result.products.length === 0) {
          setError(`Product ${sku} not found`);
          setLoading(false);
          return;
        }
        const p = res.result.products[0]!;
        setProduct(p);

        if (p.manufacturer_id) {
          const mfrRes = await getContact(p.manufacturer_id);
          if (mfrRes.success && mfrRes.result) {
            setManufacturer(mfrRes.result.data as unknown as ManufacturerDetail);
          }
        }
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [sku]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link
          href="/products"
          className="text-sm inline-flex items-center gap-1 transition-colors"
          style={{ color: 'var(--fg-2)' }}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Products
        </Link>
        <div
          className="p-4 text-sm"
          style={{
            backgroundColor: 'rgba(229,32,44,0.05)',
            border: '1px solid rgba(229,32,44,0.2)',
            color: 'var(--brand-rot)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {error ?? 'Product not found'}
        </div>
      </div>
    );
  }

  const skuShort = product.id.replace('prd_', '').toUpperCase();

  return (
    <div className="space-y-8 max-w-5xl">
      <Link
        href="/products"
        className="text-sm inline-flex items-center gap-1"
        style={{ color: 'var(--fg-2)' }}
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Products
      </Link>

      <div>
        <div className="flex items-center gap-3 mb-3">
          <span
            className="dx-mono px-2 py-1"
            style={{
              fontSize: '11px',
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-xs)',
              color: 'var(--fg-2)',
              letterSpacing: '0.05em',
            }}
          >
            {skuShort}
          </span>
        </div>
        <h1 className="dx-product-name" style={{ fontSize: '40px', color: 'var(--fg-1)', lineHeight: 1.05 }}>
          {product.product_name}
        </h1>
        <p
          className="mt-3 dx-mono"
          style={{ fontSize: '13px', color: 'var(--fg-2)', letterSpacing: '0.02em' }}
        >
          {product.invoice_label}
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="grid grid-cols-2 gap-6">
        <DetailCard label="Product Details">
          <DetailRow label="Category" value={
            <span style={{ color: product.category === 'Toothpaste' ? 'var(--line-innoweiss)' : 'var(--brand-schwarz)' }}>
              {product.category}
            </span>
          } />
          <DetailRow label="Barcode" value={product.barcode ?? '—'} mono />
          <DetailRow label="Weight" value={product.weight_kg ? `${product.weight_kg} g` : '—'} mono />
          <DetailRow label="Volume" value={product.volume_m3_micro ? `${product.volume_m3_micro / 1000} m³ × 10⁻³` : '—'} mono />
          {product.notes && (
            <div className="pt-3 mt-3" style={{ borderTop: '1px solid var(--border-hairline)' }}>
              <div className="dx-eyebrow mb-2" style={{ fontSize: '10px' }}>Notes</div>
              <div style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>{product.notes}</div>
            </div>
          )}
        </DetailCard>

        <DetailCard label="Manufacturer">
          {manufacturer ? (
            <>
              <DetailRow
                label="Name"
                value={<span className="dx-product-name" style={{ fontSize: 'var(--fs-body)' }}>{manufacturer.name}</span>}
              />
              {manufacturer.country && <DetailRow label="Country" value={manufacturer.country} />}
              {manufacturer.city && <DetailRow label="City" value={manufacturer.city} />}
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
        </DetailCard>
      </div>

      <div
        className="p-5"
        style={{
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <div className="dx-eyebrow mb-3" style={{ color: 'var(--fg-3)' }}>Coming in Future Phases</div>
        <ul className="space-y-1.5" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          <li>· Active prices by price_type (RUB / USD)</li>
          <li>· Current stock levels across warehouses</li>
          <li>· Recent operations history</li>
        </ul>
      </div>
    </div>
  );
}

function DetailCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="p-5 bg-card"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div className="dx-eyebrow mb-4">{label}</div>
      <dl className="space-y-3">{children}</dl>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between items-baseline gap-4">
      <dt style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-3)' }}>{label}</dt>
      <dd
        className={mono ? 'dx-mono' : ''}
        style={{
          fontSize: mono ? '12px' : 'var(--fs-body-sm)',
          color: 'var(--fg-1)',
          textAlign: 'right',
        }}
      >
        {value}
      </dd>
    </div>
  );
}
