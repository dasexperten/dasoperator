'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Package, Loader2 } from 'lucide-react';
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
      setLoading(true);
      try {
        const res = await getProductBySku(sku);
        if (!res.success || !res.result || res.result.products.length === 0) {
          setError(`Product ${sku} not found`);
          setLoading(false);
          return;
        }
        const p = res.result.products[0]!;
        setProduct(p);

        // Fetch manufacturer details
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
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />
          Back to Products
        </Link>
        <div className="bg-card border border-red-500/30 rounded p-4 text-sm text-red-400">
          {error ?? 'Product not found'}
        </div>
      </div>
    );
  }

  const skuShort = product.id.replace('prd_', '').toUpperCase();

  return (
    <div className="space-y-6 max-w-4xl">
      <Link href="/products" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ArrowLeft className="h-4 w-4" />
        Back to Products
      </Link>

      <div>
        <div className="flex items-center gap-3 mb-1">
          <Package className="h-6 w-6 text-muted-foreground" />
          <span className="font-mono text-sm text-muted-foreground">{skuShort}</span>
        </div>
        <h1 className="text-2xl font-semibold">{product.product_name}</h1>
        <p className="text-sm text-muted-foreground mt-1">{product.invoice_label}</p>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted-foreground mb-4">Product Details</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Category</dt>
              <dd>
                <span className={`px-2 py-1 rounded text-xs ${
                  product.category === 'Toothpaste'
                    ? 'bg-blue-500/10 text-blue-400'
                    : 'bg-orange-500/10 text-orange-400'
                }`}>
                  {product.category}
                </span>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Barcode</dt>
              <dd className="font-mono text-xs">{product.barcode ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Weight</dt>
              <dd className="font-mono text-xs">{product.weight_kg ? `${product.weight_kg}g` : '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Volume</dt>
              <dd className="font-mono text-xs">
                {product.volume_m3_micro ? `${product.volume_m3_micro / 1000} m³ × 10⁻³` : '—'}
              </dd>
            </div>
            {product.notes && (
              <div className="pt-2 border-t border-border">
                <dt className="text-muted-foreground text-xs mb-1">Notes</dt>
                <dd className="text-sm">{product.notes}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted-foreground mb-4">Manufacturer</h3>
          {manufacturer ? (
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs mb-1">Name</dt>
                <dd className="font-medium">{manufacturer.name}</dd>
              </div>
              {manufacturer.country && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Country</dt>
                  <dd>{manufacturer.country}</dd>
                </div>
              )}
              {manufacturer.city && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">City</dt>
                  <dd>{manufacturer.city}</dd>
                </div>
              )}
              {manufacturer.role && (
                <div className="pt-2 border-t border-border">
                  <dt className="text-muted-foreground text-xs mb-1">Role</dt>
                  <dd className="text-sm">{manufacturer.role}</dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">Loading manufacturer...</p>
          )}
        </div>
      </div>

      <div className="bg-muted/30 border border-border rounded-lg p-4 text-xs text-muted-foreground">
        <p><strong className="text-foreground">Coming in Phase 3.0c+:</strong></p>
        <ul className="list-disc list-inside mt-2 space-y-1">
          <li>Active prices by price_type (RUB/USD)</li>
          <li>Current stock levels across warehouses</li>
          <li>Recent operations history</li>
        </ul>
      </div>
    </div>
  );
}
