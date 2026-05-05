'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Star, Trash2, Upload } from 'lucide-react';
import {
  getProduct, getProductStock, getProductPrices, getProductActivity,
  getProductImages, uploadProductImage, setPrimaryImage, deleteProductImage,
  getWarehouses,
  type ProductFull, type ProductPriceRow, type ProductActivityRow,
  type ProductImage, type Warehouse, type ProductStockResponse,
} from '@/lib/api';

// =============================================================================
// Constants
// =============================================================================

// Reference list of all 5 price types (verified against D1 price_types table).
// Each product detail page renders one row per type; if no matching price row
// exists in /api/products/:id/prices, the row is shown muted with "— not set —".
const PRICE_TYPES_REFERENCE = [
  { id: 'pt_purchase_cny',      code: 'PURCHASE_CNY',          currency: 'CNY', used_by_entity: 'DEC / DEI / DEASEAN',           description: 'Factory purchasing price CNY' },
  { id: 'pt_distr_rub',   code: 'Distributor RUB', currency: 'RUB', used_by_entity: 'DEE',                 description: 'CIS distributor wholesale price in roubles' },
  { id: 'pt_distr_usd',   code: 'Distributor USD', currency: 'USD', used_by_entity: 'DEI / DEASEAN / DEC', description: 'International distributor wholesale price in USD' },
  { id: 'pt_export_usd',  code: 'EXPORT_USD',      currency: 'USD', used_by_entity: 'DEI',                 description: 'Generic export price USD' },
  { id: 'pt_wb_ru',       code: 'WB_RU',           currency: 'RUB', used_by_entity: 'DEE',                 description: 'Wildberries Russia retail price' },
];

const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 5 * 1024 * 1024;

// Apothecary tokens — literal hex for defensive rendering
const INK = '#1A1519';
const MUTED = '#B6B6B6';

// =============================================================================
// Helpers
// =============================================================================

function formatDate(unix: number | null | undefined): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

function formatCases(onHand: number, piecesPerCase: number): string {
  if (onHand <= 0) return '—';
  if (piecesPerCase <= 1) return `${onHand.toLocaleString('en-US')} pcs`;
  const cases = Math.floor(onHand / piecesPerCase);
  const pcs = onHand % piecesPerCase;
  if (cases === 0) return `${pcs} pcs`;
  if (pcs === 0) return `${cases} cs`;
  return `${cases} cs + ${pcs} pcs`;
}

function formatPrice(sellPriceMinor: number, currency: string): string {
  const factor = ['VND', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
  const major = sellPriceMinor / factor;
  return major.toLocaleString(undefined, {
    minimumFractionDigits: factor === 1 ? 0 : 2,
    maximumFractionDigits: factor === 1 ? 0 : 2,
  });
}

function formatEffective(from: number, until: number | null): string {
  const f = formatDate(from);
  if (until === null) return `since ${f}`;
  return `${f} → ${formatDate(until)}`;
}

function formatCartonDims(l: number | null, w: number | null, h: number | null): string {
  if (l === null || w === null || h === null) return '—';
  const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `${fmt(l)} × ${fmt(w)} × ${fmt(h)} cm`;
}

// =============================================================================
// Role tag pills
// =============================================================================

const ROLE_TAGS: Record<'supply' | 'master' | 'sales', { bg: string; fg: string; label: string }> = {
  supply: { bg: '#B5D4F4', fg: '#0C447C', label: 'supply chain' },
  master: { bg: '#C0DD97', fg: '#27500A', label: 'master' },
  sales:  { bg: '#F5C4B3', fg: '#712B13', label: 'sales' },
};

function RoleTag({ role }: { role: 'supply' | 'master' | 'sales' }) {
  const t = ROLE_TAGS[role];
  return (
    <span style={{
      display: 'inline-block',
      backgroundColor: t.bg,
      color: t.fg,
      fontSize: '14px',
      fontWeight: 500,
      padding: '2px 8px',
      borderRadius: '6px',
      marginLeft: '8px',
      verticalAlign: 'middle',
    }}>
      {t.label}
    </span>
  );
}

function SectionEyebrow({
  label, role, right,
}: {
  label: string;
  role: 'supply' | 'master' | 'sales';
  right?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
      <div style={{ fontSize: '14px', textTransform: 'uppercase', fontWeight: 500, color: '#6B6B6B', letterSpacing: 0 }}>
        {label}
        <RoleTag role={role} />
      </div>
      {right && <div style={{ fontSize: '14px', color: '#6B6B6B' }}>{right}</div>}
    </div>
  );
}

// =============================================================================
// Card primitive
// =============================================================================

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      backgroundColor: 'var(--paper, #FFFFFF)',
      border: '0.5px solid var(--border-hairline, #E0DCD7)',
      borderRadius: '10px',
      padding: '20px 24px',
      marginBottom: '16px',
      ...style,
    }}>
      {children}
    </div>
  );
}

// =============================================================================
// Main client component
// =============================================================================

export default function ProductDetailClient({ sku }: { sku: string }) {
  const id = sku.toLowerCase();

  const [product, setProduct] = useState<ProductFull | null>(null);
  const [stock, setStock] = useState<ProductStockResponse | null>(null);
  const [prices, setPrices] = useState<ProductPriceRow[]>([]);
  const [activity, setActivity] = useState<ProductActivityRow[]>([]);
  const [images, setImages] = useState<ProductImage[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [pRes, sRes, prRes, aRes, iRes, wRes] = await Promise.all([
          getProduct(id),
          getProductStock(id),
          getProductPrices(id),
          getProductActivity(id, 20),
          getProductImages(id),
          getWarehouses(),
        ]);
        if (!pRes.success || !pRes.result) {
          setError(pRes.errors?.[0]?.message ?? 'Product not found');
          setLoading(false);
          return;
        }
        setProduct(pRes.result);
        if (sRes.success && sRes.result) setStock(sRes.result);
        if (prRes.success && prRes.result) setPrices(prRes.result.prices);
        if (aRes.success && aRes.result) setActivity(aRes.result.activity);
        if (iRes.success && iRes.result) setImages(iRes.result.images);
        if (wRes.success && wRes.result) setWarehouses(wRes.result.warehouses);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [id]);

  async function refreshImages() {
    const r = await getProductImages(id);
    if (r.success && r.result) setImages(r.result.images);
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);

    if (!ALLOWED_MIMES.has(file.type)) {
      setUploadError(`Unsupported type ${file.type}. Use JPEG/PNG/WebP.`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadError(`File too large (${(file.size / 1024 / 1024).toFixed(2)} MB). Max 5 MB.`);
      return;
    }

    setUploading(true);
    try {
      const res = await uploadProductImage(id, file);
      if (res.success) {
        await refreshImages();
      } else {
        setUploadError(res.errors?.[0]?.message ?? 'Upload failed');
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleSetPrimary(imageId: string) {
    const res = await setPrimaryImage(id, imageId);
    if (res.success) await refreshImages();
  }

  async function handleDelete(imageId: string) {
    if (!confirm('Delete this photo?')) return;
    const res = await deleteProductImage(id, imageId);
    if (res.success) await refreshImages();
  }

  // Map last_movement per warehouse_code from activity
  const lastMovementByCode = useMemo(() => {
    const map: Record<string, number> = {};
    for (const a of activity) {
      const code = a.warehouse_code;
      if (!code) continue;
      if (!map[code] || a.performed_at > map[code]!) {
        map[code] = a.performed_at;
      }
    }
    return map;
  }, [activity]);

  // Stock map by warehouse_id from /products/:id/stock response
  const stockByWh = useMemo(() => {
    const map: Record<string, number> = {};
    if (stock) {
      for (const r of stock.by_warehouse) map[r.warehouse_id] = r.on_hand;
    }
    return map;
  }, [stock]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: MUTED }} />
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href="/products" style={{ fontSize: '14px', color: '#6B6B6B', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          <ArrowLeft className="h-4 w-4" />Back to Products
        </Link>
        <div style={{
          padding: '16px',
          fontSize: '14px',
          backgroundColor: 'rgba(229,32,44,0.05)',
          border: '1px solid rgba(229,32,44,0.2)',
          color: '#A32D2D',
          borderRadius: '8px',
        }}>
          {error ?? 'Product not found'}
        </div>
      </div>
    );
  }

  const totalOnHand = stock?.total_on_hand ?? 0;
  const warehousesWithStock = stock?.by_warehouse.filter((w) => w.on_hand > 0).length ?? 0;
  const idUpper = product.id.toUpperCase();
  const piecesPerCase = product.pieces_per_case ?? 1;

  return (
    <div style={{ maxWidth: '1280px', margin: '0 auto' }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '32px' }}>
        <div>
          <div style={{ fontSize: '14px', textTransform: 'uppercase', fontWeight: 500, color: '#6B6B6B', marginBottom: '8px' }}>
            Master Data
          </div>
          <h1 style={{ fontSize: '26px', fontWeight: 500, color: INK, margin: 0, lineHeight: 1.2 }}>
            {product.product_name}
          </h1>
          <p style={{ marginTop: '6px', fontSize: '14px', color: '#6B6B6B' }}>
            <span style={{ fontWeight: 600, color: INK }}>{idUpper}</span>
            {' · '}{product.category}
            {' · '}{product.manufacturer_name ?? '—'}
          </p>
        </div>
        <Link href="/products" style={{
          fontSize: '14px',
          color: '#6B6B6B',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '8px 12px',
        }}>
          <ArrowLeft className="h-4 w-4" />Back to products
        </Link>
      </div>

      {/* SECTION 1 — At a glance */}
      <Card>
        <SectionEyebrow label="At a glance" role="supply" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
          <Kpi
            label="Total stock"
            value={`${totalOnHand.toLocaleString('en-US')} pcs`}
            sub={`across ${warehousesWithStock} warehouse${warehousesWithStock === 1 ? '' : 's'}`}
            highlight={totalOnHand > 0}
          />
          <Kpi label="In transit" value="0 pcs" sub="no open shipments" />
          <Kpi label="Sold last 30d" value="—" sub="awaiting ops" />
          <Kpi label="Days of cover" value="—" sub="awaiting velocity" />
        </div>
      </Card>

      {/* SECTION 2 — Stock across warehouses */}
      <Card>
        <SectionEyebrow
          label="Stock across warehouses"
          role="supply"
          right={
            <span>
              <span style={{ fontWeight: 500, color: INK, fontSize: '18px' }}>
                {totalOnHand.toLocaleString('en-US')}
              </span>
              <span style={{ marginLeft: '4px' }}>pcs</span>
            </span>
          }
        />
        <table style={{ width: '100%', fontSize: '14px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '0.5px solid #E0DCD7' }}>
              <Th>Warehouse</Th>
              <Th>Country</Th>
              <Th right>On hand</Th>
              <Th right>Cases breakdown</Th>
              <Th>Last movement</Th>
            </tr>
          </thead>
          <tbody>
            {warehouses.length === 0 ? (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: '#6B6B6B' }}>No warehouses configured</td></tr>
            ) : (
              warehouses.map((w) => {
                const onHand = stockByWh[w.id] ?? 0;
                const lastMov = lastMovementByCode[w.code];
                const muted = onHand === 0;
                return (
                  <tr
                    key={w.id}
                    style={{
                      borderBottom: '0.5px solid #E0DCD7',
                      opacity: muted ? 0.55 : 1,
                      cursor: 'pointer',
                    }}
                    onClick={() => { window.location.href = `/warehouses/${w.id}`; }}
                  >
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ fontWeight: 600, color: INK }}>{w.code}</span>
                      <span style={{ marginLeft: '8px', color: '#6B6B6B' }}>{w.name}</span>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#6B6B6B' }}>{w.country ?? '—'}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontWeight: 500, color: INK }}>
                      {onHand.toLocaleString('en-US')}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'ui-monospace, monospace', color: muted ? '#6B6B6B' : INK }}>
                      {formatCases(onHand, piecesPerCase)}
                    </td>
                    <td style={{ padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: '14px', color: '#6B6B6B' }}>
                      {lastMov ? formatDate(lastMov) : '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Card>

      {/* SECTION 3 — Prices */}
      <Card>
        <SectionEyebrow
          label="Prices"
          role="sales"
          right={<span style={{ color: MUTED }}>+ Add price</span>}
        />
        <table style={{ width: '100%', fontSize: '14px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '0.5px solid #E0DCD7' }}>
              <Th>Price type</Th>
              <Th>Used by</Th>
              <Th>Currency</Th>
              <Th right>Price</Th>
              <Th>Effective</Th>
            </tr>
          </thead>
          <tbody>
            {PRICE_TYPES_REFERENCE.map((pt) => {
              const row = prices.find((p) => p.price_type_id === pt.id);
              const muted = !row;
              return (
                <tr key={pt.id} style={{ borderBottom: '0.5px solid #E0DCD7', opacity: muted ? 0.55 : 1 }}>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 600, color: INK }}>{pt.code}</div>
                    <div style={{ fontSize: '14px', color: '#6B6B6B', marginTop: '2px' }}>{pt.description}</div>
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6B6B6B' }}>{pt.used_by_entity}</td>
                  <td style={{ padding: '10px 12px', color: '#6B6B6B' }}>{pt.currency}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontWeight: 500, color: muted ? '#6B6B6B' : INK }}>
                    {row ? formatPrice(row.sell_price, row.currency) : '— not set —'}
                  </td>
                  <td style={{ padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: '14px', color: '#6B6B6B' }}>
                    {row ? formatEffective(row.effective_from, row.effective_until) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* SECTION 4 — Master data + Logistics (two columns) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        <div style={{
          backgroundColor: '#FFFFFF',
          border: '0.5px solid #E0DCD7',
          borderRadius: '10px',
          padding: '20px 24px',
        }}>
          <SectionEyebrow label="Master data" role="master" />
          <DefList rows={[
            { label: 'SKU', value: idUpper, mono: true },
            { label: 'Invoice label', value: product.invoice_label },
            { label: 'Category', value: product.category },
            { label: 'Barcode', value: product.barcode ?? '—', mono: true },
            { label: 'Manufacturer', value: `${product.manufacturer_name ?? '—'}${product.manufacturer_country ? ` (${product.manufacturer_country})` : ''}` },
            { label: 'Country of origin', value: product.country_of_origin ?? '—' },
            { label: 'Notes', value: product.notes ?? '—' },
          ]} />
        </div>
        <div style={{
          backgroundColor: '#FFFFFF',
          border: '0.5px solid #E0DCD7',
          borderRadius: '10px',
          padding: '20px 24px',
        }}>
          <SectionEyebrow label="Logistics" role="supply" />
          <DefList rows={[
            { label: 'HS code', value: product.hs_code ?? '—', mono: true },
            { label: 'Pieces per case', value: piecesPerCase.toLocaleString('en-US'), mono: true },
            { label: 'Carton qty', value: product.ctn_qty !== null ? `${product.ctn_qty.toLocaleString('en-US')} pcs` : '—', mono: true },
            { label: 'Carton weight', value: product.ctn_weight_gross_kg !== null ? `${product.ctn_weight_gross_kg.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg gross` : '—', mono: true },
            { label: 'Carton dims', value: formatCartonDims(product.ctn_dim_l_cm, product.ctn_dim_w_cm, product.ctn_dim_h_cm), mono: true },
            { label: 'Unit weight', value: product.unit_net_weight_g !== null ? `${product.unit_net_weight_g.toLocaleString(undefined, { maximumFractionDigits: 2 })} g net` : '—', mono: true },
            { label: 'Unit volume', value: product.volume_m3_micro !== null ? `${product.volume_m3_micro.toLocaleString('en-US')} cm³` : '—', mono: true },
          ]} />
        </div>
      </div>

      {/* SECTION 5 — Descriptions */}
      <Card>
        <SectionEyebrow label="Descriptions" role="sales" />
        <DefList rows={[
          { label: 'RU', value: product.description_ru ?? '—', regular: true },
          { label: 'EN', value: product.description_en ?? '—', regular: true },
          { label: 'CN', value: product.description_cn ?? '—', regular: true },
        ]} />
      </Card>

      {/* SECTION 6 — Photos */}
      <Card>
        <SectionEyebrow
          label="Photos"
          role="sales"
          right={
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                fontSize: '14px',
                fontWeight: 500,
                color: '#FFFFFF',
                backgroundColor: '#E5202C',
                border: 'none',
                borderRadius: '6px',
                cursor: uploading ? 'not-allowed' : 'pointer',
                opacity: uploading ? 0.5 : 1,
              }}
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              Upload
            </button>
          }
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={handleFileSelected}
        />
        {uploadError && (
          <div style={{
            padding: '10px 12px',
            marginBottom: '12px',
            fontSize: '14px',
            backgroundColor: 'rgba(229,32,44,0.05)',
            border: '0.5px solid rgba(229,32,44,0.2)',
            color: '#A32D2D',
            borderRadius: '6px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span>{uploadError}</span>
            <button onClick={() => setUploadError(null)} style={{ background: 'transparent', border: 'none', color: '#A32D2D', cursor: 'pointer', fontSize: '16px' }}>×</button>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px' }}>
          {images.length === 0 ? (
            <>
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  style={{
                    aspectRatio: '1 / 1',
                    backgroundColor: '#F5F2ED',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#6B6B6B',
                    fontSize: '14px',
                  }}
                >
                  no photo
                </div>
              ))}
            </>
          ) : (
            images.map((img) => (
              <PhotoTile
                key={img.id}
                img={img}
                onSetPrimary={() => handleSetPrimary(img.id)}
                onDelete={() => handleDelete(img.id)}
              />
            ))
          )}
        </div>
        {images.length === 0 && (
          <p style={{ marginTop: '12px', fontSize: '14px', color: '#6B6B6B' }}>
            Stored in R2 bucket <code style={{ fontFamily: 'ui-monospace, monospace' }}>das-erp-docs-dev</code> under <code style={{ fontFamily: 'ui-monospace, monospace' }}>products/{idUpper}/</code>
          </p>
        )}
      </Card>

      {/* SECTION 7 — Recent activity */}
      <Card>
        <SectionEyebrow label="Recent activity" role="supply" />
        {activity.length === 0 ? (
          <p style={{ color: '#6B6B6B', textAlign: 'center', padding: '24px' }}>No activity yet</p>
        ) : (
          <table style={{ width: '100%', fontSize: '14px', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '0.5px solid #E0DCD7' }}>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Where</Th>
                <Th right>Qty</Th>
                <Th>Source</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {activity.map((a) => {
                const qtyColor = a.quantity > 0 ? '#27500A' : a.quantity < 0 ? '#A32D2D' : '#6B6B6B';
                return (
                  <tr key={a.id} style={{ borderBottom: '0.5px solid #E0DCD7' }}>
                    <td style={{ padding: '10px 12px', fontFamily: 'ui-monospace, monospace', fontSize: '14px', color: '#6B6B6B' }}>
                      {formatDate(a.performed_at)}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: '14px', color: '#6B6B6B', textTransform: 'uppercase', letterSpacing: 0 }}>
                      {a.type}
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: INK }}>
                      {a.warehouse_code ?? '—'}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'ui-monospace, monospace', fontWeight: 500, color: qtyColor }}>
                      {a.quantity > 0 ? '+' : ''}{a.quantity.toLocaleString('en-US')}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: '14px', color: '#6B6B6B' }}>{a.source}</td>
                    <td style={{ padding: '10px 12px', fontSize: '14px', color: '#6B6B6B', maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {a.reason ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// =============================================================================
// Subcomponents
// =============================================================================

function Kpi({ label, value, sub, highlight = false }: {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div style={{
      backgroundColor: '#F5F2ED',
      border: 'none',
      borderRadius: '8px',
      padding: '16px',
    }}>
      <div style={{ fontSize: '14px', textTransform: 'uppercase', fontWeight: 500, color: '#6B6B6B', marginBottom: '8px' }}>
        {label}
      </div>
      <div style={{
        fontSize: '24px',
        fontWeight: 500,
        color: highlight ? INK : '#6B6B6B',
        // Inherit Manrope from page default — KPI value should match the
        // rest of the body text, not look like ledger monospace.
        lineHeight: 1.1,
      }}>
        {value}
      </div>
      <div style={{ fontSize: '14px', color: '#6B6B6B', marginTop: '6px' }}>
        {sub}
      </div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th style={{
      textAlign: right ? 'right' : 'left',
      padding: '10px 12px',
      fontSize: '14px',
      fontWeight: 500,
      textTransform: 'uppercase',
      color: '#6B6B6B',
      backgroundColor: '#FAFAFA',
      letterSpacing: 0,
    }}>
      {children}
    </th>
  );
}

function DefList({ rows }: { rows: Array<{ label: string; value: string; mono?: boolean; regular?: boolean }> }) {
  return (
    <dl style={{
      display: 'grid',
      gridTemplateColumns: '140px 1fr',
      gap: '6px 16px',
      margin: 0,
      fontSize: '14px',
    }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt style={{ color: '#6B6B6B', alignSelf: 'baseline' }}>{r.label}</dt>
          <dd style={{
            margin: 0,
            color: INK,
            fontWeight: r.regular ? 400 : 500,
            fontFamily: r.mono ? 'ui-monospace, monospace' : 'inherit',
            wordBreak: 'break-word',
          }}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function PhotoTile({ img, onSetPrimary, onDelete }: {
  img: ProductImage;
  onSetPrimary: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        aspectRatio: '1 / 1',
        backgroundColor: '#F5F2ED',
        backgroundImage: `url(${img.file_url})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      {img.is_primary && (
        <span style={{
          position: 'absolute',
          top: '6px',
          left: '6px',
          backgroundColor: '#F5C4B3',
          color: '#712B13',
          fontSize: '14px',
          fontWeight: 500,
          padding: '2px 8px',
          borderRadius: '4px',
          textTransform: 'uppercase',
          letterSpacing: 0,
        }}>
          Primary
        </span>
      )}
      {hover && (
        <div style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(26,21,25,0.55)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
        }}>
          {!img.is_primary && (
            <button
              onClick={onSetPrimary}
              title="Set as primary"
              style={iconButtonStyle}
            >
              <Star className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onDelete}
            title="Delete photo"
            style={iconButtonStyle}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

const iconButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '32px',
  height: '32px',
  backgroundColor: '#FFFFFF',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  color: INK,
};
