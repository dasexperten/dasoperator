'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, Package, Loader2 } from 'lucide-react';
import { getProducts, type Product } from '@/lib/api';

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [manufacturerFilter, setManufacturerFilter] = useState<string>('all');

  useEffect(() => {
    const fetchProducts = async () => {
      setLoading(true);
      try {
        const res = await getProducts('DE');
        if (res.success && res.result) {
          setProducts(res.result.products);
          setError(null);
        } else {
          setError(res.errors[0]?.message ?? 'Failed to load products');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchProducts();
  }, []);

  // Unique manufacturers for filter dropdown
  const manufacturers = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => {
      if (p.manufacturer_name) set.add(p.manufacturer_name);
    });
    return Array.from(set).sort();
  }, [products]);

  // Filtered products
  const filtered = useMemo(() => {
    return products.filter((p) => {
      if (search) {
        const q = search.toLowerCase();
        const matchesSearch =
          p.product_name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          p.invoice_label.toLowerCase().includes(q);
        if (!matchesSearch) return false;
      }
      if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
      if (manufacturerFilter !== 'all' && p.manufacturer_name !== manufacturerFilter) return false;
      return true;
    });
  }, [products, search, categoryFilter, manufacturerFilter]);

  // Stats
  const pasteCount = products.filter((p) => p.category === 'Toothpaste').length;
  const brushCount = products.filter((p) => p.category === 'Toothbrush').length;

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Package className="h-6 w-6" />
          Products
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {loading
            ? 'Loading...'
            : `${products.length} products • ${pasteCount} toothpastes • ${brushCount} brushes`}
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search products by name or SKU..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-card border border-border rounded text-sm placeholder:text-muted-foreground focus:outline-none focus:border-accent"
          />
        </div>

        <div className="flex gap-3">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 bg-card border border-border rounded text-sm focus:outline-none focus:border-accent"
          >
            <option value="all">All categories</option>
            <option value="Toothpaste">Toothpaste</option>
            <option value="Toothbrush">Toothbrush</option>
          </select>

          <select
            value={manufacturerFilter}
            onChange={(e) => setManufacturerFilter(e.target.value)}
            className="px-3 py-2 bg-card border border-border rounded text-sm focus:outline-none focus:border-accent"
          >
            <option value="all">All manufacturers</option>
            {manufacturers.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <div className="ml-auto text-sm text-muted-foreground self-center">
            Showing {filtered.length} of {products.length}
          </div>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-card border border-red-500/30 rounded p-4 text-sm text-red-400">
          Error: {error}
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">SKU</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Product</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Category</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Manufacturer</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Weight</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Barcode</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    No products match the filters
                  </td>
                </tr>
              ) : (
                filtered.map((p) => {
                  const skuShort = p.id.replace('prd_', '').toUpperCase();
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-border last:border-0 hover:bg-muted/30 transition cursor-pointer"
                    >
                      <td className="px-4 py-3 font-mono text-xs">
                        <Link href={`/products/${skuShort}`} className="hover:text-accent">
                          {skuShort}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <Link href={`/products/${skuShort}`} className="hover:text-accent">
                          {p.product_name}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded text-xs ${
                          p.category === 'Toothpaste'
                            ? 'bg-blue-500/10 text-blue-400'
                            : 'bg-orange-500/10 text-orange-400'
                        }`}>
                          {p.category}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {p.manufacturer_name ?? '—'}
                        {p.manufacturer_country && (
                          <span className="text-xs ml-1 opacity-60">({p.manufacturer_country})</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                        {p.weight_kg ? `${p.weight_kg}g` : '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
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
