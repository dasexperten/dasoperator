'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Star, Trash2, Upload, Pencil, Save as SaveIcon, X } from 'lucide-react';
import {
  getProduct, getProductStock, getProductPrices, getProductActivity,
  getProductImages, uploadProductImage, setPrimaryImage, deleteProductImage,
  getWarehouses, getManufacturers, updateProduct,
  createProductPrice, deleteProductPrice,
  type ProductFull, type ProductPriceRow, type ProductActivityRow,
  type ProductImage, type Warehouse, type ProductStockResponse,
  type Manufacturer, type UpdateProductBody,
} from '@/lib/api';

// =============================================================================
// Constants
// =============================================================================

// Reference list of all 5 price types (verified against D1 price_types table).
// Each product detail page renders one row per type; if no matching price row
// exists in /api/products/:id/prices, the row is shown muted with "— not set —".
const PRICE_TYPES_REFERENCE = [
  { id: 'purchase_cny',      code: 'PURCHASE_CNY',          currency: 'CNY', used_by_entity: 'DEC / DEI / DEASEAN',           description: 'Factory purchasing price CNY' },
  { id: 'distr_rub',   code: 'Distributor RUB', currency: 'RUB', used_by_entity: 'DEE',                 description: 'CIS distributor wholesale price in roubles' },
  { id: 'distr_usd',   code: 'Distributor USD', currency: 'USD', used_by_entity: 'DEI / DEASEAN / DEC', description: 'International distributor wholesale price in USD' },
  { id: 'export_usd',  code: 'EXPORT_USD',      currency: 'USD', used_by_entity: 'DEI',                 description: 'Generic export price USD' },
  { id: 'wb_ru',       code: 'WB_RU',           currency: 'RUB', used_by_entity: 'DEE',                 description: 'Wildberries Russia retail price' },
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

function formatPrice(sellPrice: number, currency: string): string {
  const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(currency);
  return sellPrice.toLocaleString(undefined, {
    minimumFractionDigits: isZeroDecimal ? 0 : 2,
    maximumFractionDigits: isZeroDecimal ? 0 : 2,
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

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [draft, setDraft] = useState<UpdateProductBody>({});
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([]);

  // Add-price form state
  const [addingPrice, setAddingPrice] = useState(false);
  const [priceSaving, setPriceSaving] = useState(false);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceDraft, setPriceDraft] = useState<{ price_type_id: string; sell_price: string; notes: string }>({
    price_type_id: 'distr_rub',
    sell_price: '',
    notes: '',
  });

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
        // Lazy-load manufacturers for edit dropdown (non-blocking)
        getManufacturers().then((mRes) => {
          if (mRes.success && mRes.result) setManufacturers(mRes.result.manufacturers);
        });
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

  function handleEditStart() {
    if (!product) return;
    setDraft({
      product_name: product.product_name,
      invoice_label: product.invoice_label,
      category: product.category,
      subcategory: product.subcategory ?? null,
      manufacturer_id: product.manufacturer_id,
      packaging_manufacturer_id: product.packaging_manufacturer_id ?? null,
      barcode: product.barcode ?? null,
      country_of_origin: product.country_of_origin ?? null,
      hs_code: product.hs_code ?? null,
      pieces_per_case: product.pieces_per_case ?? 1,
      ctn_qty: product.ctn_qty ?? null,
      ctn_weight_gross_kg: product.ctn_weight_gross_kg ?? null,
      ctn_dim_l_cm: product.ctn_dim_l_cm ?? null,
      ctn_dim_w_cm: product.ctn_dim_w_cm ?? null,
      ctn_dim_h_cm: product.ctn_dim_h_cm ?? null,
      unit_net_weight_g: product.unit_net_weight_g ?? null,
      weight_kg: product.weight_kg ?? null,
      volume_m3_micro: product.volume_m3_micro ?? null,
      description_ru: product.description_ru ?? null,
      description_en: product.description_en ?? null,
      description_cn: product.description_cn ?? null,
      invoice_label_ru: product.invoice_label_ru ?? null,
      invoice_label_en: product.invoice_label_en ?? null,
      invoice_label_cn: product.invoice_label_cn ?? null,
      buy_price: product.buy_price ?? null,
      buy_currency: product.buy_currency ?? null,
      buy_term: product.buy_term ?? null,
      notes: product.notes ?? null,
    });
    setEditError(null);
    setEditing(true);
  }

  function handleEditCancel() {
    setDraft({});
    setEditError(null);
    setEditing(false);
  }

  async function handleEditSave() {
    if (!product) return;
    setEditError(null);
    setSaving(true);
    try {
      const res = await updateProduct(id, draft);
      if (res.success && res.result) {
        // Re-fetch full product (response is partial — server returns row only,
        // but joined fields like manufacturer_name come from JOIN)
        const fresh = await getProduct(id);
        if (fresh.success && fresh.result) setProduct(fresh.result);
        setEditing(false);
        setDraft({});
      } else {
        setEditError(res.errors?.[0]?.message ?? 'Failed to save changes');
      }
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  }

  function handleAddPriceStart() {
    setPriceDraft({ price_type_id: 'distr_rub', sell_price: '', notes: '' });
    setPriceError(null);
    setAddingPrice(true);
  }

  function handleAddPriceCancel() {
    setAddingPrice(false);
    setPriceError(null);
  }

  async function handleAddPriceSave() {
    setPriceError(null);
    const raw = priceDraft.sell_price.replace(',', '.').trim();
    const value = parseFloat(raw);
    if (!raw || isNaN(value) || value < 0) {
      setPriceError('Enter a valid price');
      return;
    }
    setPriceSaving(true);
    try {
      const res = await createProductPrice(id, {
        price_type_id: priceDraft.price_type_id,
        sell_price: value,
        notes: priceDraft.notes.trim() || null,
      });
      if (res.success && res.result) {
        // Re-fetch all prices to refresh table
        const fresh = await getProductPrices(id);
        if (fresh.success && fresh.result) setPrices(fresh.result.prices);
        setAddingPrice(false);
      } else {
        setPriceError(res.errors?.[0]?.message ?? 'Failed to save price');
      }
    } catch (e) {
      setPriceError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setPriceSaving(false);
    }
  }

  async function handleDeletePrice(priceId: string) {
    try {
      const res = await deleteProductPrice(id, priceId);
      if (res.success) {
        const fresh = await getProductPrices(id);
        if (fresh.success && fresh.result) setPrices(fresh.result.prices);
      }
    } catch {
      // silent — user can refresh
    }
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
          {!editing ? (
            <button
              onClick={handleEditStart}
              style={{
                fontSize: '14px',
                fontWeight: 600,
                color: '#FFFFFF',
                backgroundColor: 'var(--brand-rot, #C8102E)',
                border: 'none',
                borderRadius: '6px',
                padding: '8px 16px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
              }}
            >
              <Pencil className="h-4 w-4" /> Edit
            </button>
          ) : (
            <>
              <button
                onClick={handleEditCancel}
                disabled={saving}
                style={{
                  fontSize: '14px',
                  color: '#6B6B6B',
                  backgroundColor: 'transparent',
                  border: '0.5px solid #E0DCD7',
                  borderRadius: '6px',
                  padding: '8px 14px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: 'pointer',
                }}
              >
                <X className="h-4 w-4" /> Cancel
              </button>
              <button
                onClick={handleEditSave}
                disabled={saving}
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  color: '#FFFFFF',
                  backgroundColor: 'var(--brand-rot, #C8102E)',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <SaveIcon className="h-4 w-4" />} Save
              </button>
            </>
          )}
        </div>
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
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: INK }}>
                      {onHand.toLocaleString('en-US')}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: muted ? '#6B6B6B' : INK }}>
                      {formatCases(onHand, piecesPerCase)}
                    </td>
                    <td style={{ padding: '10px 12px', fontVariantNumeric: 'tabular-nums', color: '#6B6B6B' }}>
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
          right={
            !addingPrice ? (
              <button
                onClick={handleAddPriceStart}
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  color: 'var(--brand-rot, #C8102E)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                + Add price
              </button>
            ) : null
          }
        />

        {addingPrice && (
          <div style={{
            marginBottom: '16px',
            padding: '16px',
            backgroundColor: '#FAF8F5',
            border: '0.5px solid #E0DCD7',
            borderRadius: '8px',
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr', gap: '12px', alignItems: 'end' }}>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#6B6B6B', marginBottom: '4px' }}>
                  Price type
                </div>
                <select
                  value={priceDraft.price_type_id}
                  onChange={(e) => setPriceDraft({ ...priceDraft, price_type_id: e.target.value })}
                  disabled={priceSaving}
                  style={{
                    width: '100%', padding: '8px 12px', fontSize: '14px',
                    border: '0.5px solid #C9C5BF', borderRadius: '6px',
                    backgroundColor: '#FFFFFF', color: INK,
                  }}
                >
                  {PRICE_TYPES_REFERENCE.map((pt) => (
                    <option key={pt.id} value={pt.id}>{pt.code} ({pt.currency})</option>
                  ))}
                </select>
              </div>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#6B6B6B', marginBottom: '4px' }}>
                  Price
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  value={priceDraft.sell_price}
                  onChange={(e) => setPriceDraft({ ...priceDraft, sell_price: e.target.value })}
                  disabled={priceSaving}
                  placeholder="0.00"
                  style={{
                    width: '100%', padding: '8px 12px', fontSize: '14px',
                    border: '0.5px solid #C9C5BF', borderRadius: '6px',
                    backgroundColor: '#FFFFFF', color: INK,
                    textAlign: 'right',
                  }}
                />
              </div>
              <div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#6B6B6B', marginBottom: '4px' }}>
                  Notes (optional)
                </div>
                <input
                  type="text"
                  value={priceDraft.notes}
                  onChange={(e) => setPriceDraft({ ...priceDraft, notes: e.target.value })}
                  disabled={priceSaving}
                  style={{
                    width: '100%', padding: '8px 12px', fontSize: '14px',
                    border: '0.5px solid #C9C5BF', borderRadius: '6px',
                    backgroundColor: '#FFFFFF', color: INK,
                  }}
                />
              </div>
            </div>
            {priceError && (
              <div style={{ marginTop: '10px', padding: '8px 12px', backgroundColor: '#FBE9E9', border: '0.5px solid #E5B3B3', borderRadius: '6px', color: '#A32D2D', fontSize: '14px' }}>
                {priceError}
              </div>
            )}
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button
                onClick={handleAddPriceCancel}
                disabled={priceSaving}
                style={{
                  fontSize: '14px', color: '#6B6B6B',
                  backgroundColor: 'transparent', border: '0.5px solid #E0DCD7',
                  borderRadius: '6px', padding: '8px 14px', cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleAddPriceSave}
                disabled={priceSaving}
                style={{
                  fontSize: '14px', fontWeight: 600,
                  color: '#FFFFFF', backgroundColor: 'var(--brand-rot, #C8102E)',
                  border: 'none', borderRadius: '6px', padding: '8px 16px',
                  display: 'inline-flex', alignItems: 'center', gap: '6px',
                  cursor: priceSaving ? 'not-allowed' : 'pointer',
                  opacity: priceSaving ? 0.6 : 1,
                }}
              >
                {priceSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        )}

        <table style={{ width: '100%', fontSize: '14px', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '0.5px solid #E0DCD7' }}>
              <Th>Price type</Th>
              <Th>Used by</Th>
              <Th>Currency</Th>
              <Th right>Price</Th>
              <Th>Effective</Th>
              <Th> </Th>
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
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'var(--font-accent-jakarta)', fontWeight: 700, fontSize: '18px', fontVariantNumeric: 'tabular-nums', color: muted ? '#6B6B6B' : INK }}>
                    {row ? formatPrice(row.sell_price, row.currency) : '— not set —'}
                  </td>
                  <td style={{ padding: '10px 12px', fontVariantNumeric: 'tabular-nums', color: '#6B6B6B' }}>
                    {row ? formatEffective(row.effective_from, row.effective_until) : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                    {row && (
                      <button
                        onClick={() => handleDeletePrice(row.id)}
                        title="Close this price (set effective_until = now)"
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#6B6B6B' }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* SECTION 4 — Master data + Logistics (two columns) */}
      {editError && (
        <div style={{
          marginBottom: '16px',
          padding: '12px 16px',
          backgroundColor: '#FBE9E9',
          border: '1px solid #E5B3B3',
          borderRadius: '6px',
          color: '#A32D2D',
          fontSize: '14px',
        }}>
          {editError}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
        <div style={{
          backgroundColor: '#FFFFFF',
          border: '0.5px solid #E0DCD7',
          borderRadius: '10px',
          padding: '20px 24px',
        }}>
          <SectionEyebrow label="Master data" role="master" />
          {!editing ? (
            <DefList rows={[
              { label: 'SKU', value: idUpper, mono: true },
              { label: 'Invoice label', value: product.invoice_label },
              { label: 'Category', value: product.category },
              { label: 'Barcode', value: product.barcode ?? '—', mono: true },
              { label: 'Manufacturer', value: `${product.manufacturer_name ?? '—'}${product.manufacturer_country ? ` (${product.manufacturer_country})` : ''}` },
              { label: 'Country of origin', value: product.country_of_origin ?? '—' },
              { label: 'Notes', value: product.notes ?? '—' },
            ]} />
          ) : (
            <div style={{ display: 'grid', gap: '12px' }}>
              <EditField label="SKU (read-only)">
                <input type="text" value={idUpper} disabled style={readOnlyInput} />
              </EditField>
              <EditField label="Product name">
                <input type="text" value={draft.product_name ?? ''}
                  onChange={(e) => setDraft({ ...draft, product_name: e.target.value })} style={editInput} />
              </EditField>
              <EditField label="Invoice label">
                <input type="text" value={draft.invoice_label ?? ''}
                  onChange={(e) => setDraft({ ...draft, invoice_label: e.target.value })} style={editInput} />
              </EditField>
              <EditField label="Category">
                <select value={draft.category ?? 'Other'}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value as 'Toothpaste' | 'Toothbrush' | 'Floss' | 'Other' })}
                  style={editInput}>
                  <option value="Toothpaste">Toothpaste</option>
                  <option value="Toothbrush">Toothbrush</option>
                  <option value="Floss">Floss</option>
                  <option value="Other">Other</option>
                </select>
              </EditField>
              <EditField label="Subcategory">
                <input type="text" value={draft.subcategory ?? ''}
                  onChange={(e) => setDraft({ ...draft, subcategory: e.target.value || null })}
                  placeholder="e.g. enzyme_paste, manual_toothbrush"
                  style={editInput} />
              </EditField>
              <EditField label="Manufacturer">
                <select value={draft.manufacturer_id ?? ''}
                  onChange={(e) => setDraft({ ...draft, manufacturer_id: e.target.value })}
                  style={editInput}>
                  {manufacturers.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </EditField>
              <EditField label="Packaging manufacturer (optional)">
                <select value={draft.packaging_manufacturer_id ?? ''}
                  onChange={(e) => setDraft({ ...draft, packaging_manufacturer_id: e.target.value || null })}
                  style={editInput}>
                  <option value="">— None / same as main —</option>
                  {manufacturers.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </EditField>
              <EditField label="Barcode">
                <input type="text" value={draft.barcode ?? ''}
                  onChange={(e) => setDraft({ ...draft, barcode: e.target.value || null })} style={editInput} />
              </EditField>
              <EditField label="Country of origin">
                <input type="text" value={draft.country_of_origin ?? ''}
                  onChange={(e) => setDraft({ ...draft, country_of_origin: e.target.value || null })} style={editInput} />
              </EditField>
              <EditField label="Notes">
                <textarea value={draft.notes ?? ''}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value || null })}
                  rows={2} style={{ ...editInput, resize: 'vertical' }} />
              </EditField>
            </div>
          )}
        </div>
        <div style={{
          backgroundColor: '#FFFFFF',
          border: '0.5px solid #E0DCD7',
          borderRadius: '10px',
          padding: '20px 24px',
        }}>
          <SectionEyebrow label="Logistics" role="supply" />
          {!editing ? (
            <DefList rows={[
              { label: 'HS code', value: product.hs_code ?? '—', mono: true },
              { label: 'Pieces per case', value: piecesPerCase.toLocaleString('en-US'), mono: true },
              { label: 'Carton qty', value: product.ctn_qty !== null ? `${product.ctn_qty.toLocaleString('en-US')} pcs` : '—', mono: true },
              { label: 'Carton weight', value: product.ctn_weight_gross_kg !== null ? `${product.ctn_weight_gross_kg.toLocaleString(undefined, { maximumFractionDigits: 2 })} kg gross` : '—', mono: true },
              { label: 'Carton dims', value: formatCartonDims(product.ctn_dim_l_cm, product.ctn_dim_w_cm, product.ctn_dim_h_cm), mono: true },
              { label: 'Unit weight', value: product.unit_net_weight_g !== null ? `${product.unit_net_weight_g.toLocaleString(undefined, { maximumFractionDigits: 2 })} g net` : '—', mono: true },
              { label: 'Unit volume', value: product.volume_m3_micro !== null ? `${product.volume_m3_micro.toLocaleString('en-US')} cm³` : '—', mono: true },
            ]} />
          ) : (
            <div style={{ display: 'grid', gap: '12px' }}>
              <EditField label="HS code">
                <input type="text" value={draft.hs_code ?? ''}
                  onChange={(e) => setDraft({ ...draft, hs_code: e.target.value || null })} style={editInput} />
              </EditField>
              <EditField label="Pieces per case">
                <input type="number" min={1} value={draft.pieces_per_case ?? 1}
                  onChange={(e) => setDraft({ ...draft, pieces_per_case: parseInt(e.target.value, 10) || 1 })} style={editInput} />
              </EditField>
              <EditField label="Carton qty (units)">
                <input type="number" min={0} value={draft.ctn_qty ?? ''}
                  onChange={(e) => setDraft({ ...draft, ctn_qty: e.target.value ? parseInt(e.target.value, 10) : null })} style={editInput} />
              </EditField>
              <EditField label="Carton weight gross (kg)">
                <input type="number" step="0.01" min={0} value={draft.ctn_weight_gross_kg ?? ''}
                  onChange={(e) => setDraft({ ...draft, ctn_weight_gross_kg: e.target.value ? parseFloat(e.target.value) : null })} style={editInput} />
              </EditField>
              <EditField label="Carton dims (L × W × H, cm)">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                  <input type="number" step="0.1" min={0} placeholder="L" value={draft.ctn_dim_l_cm ?? ''}
                    onChange={(e) => setDraft({ ...draft, ctn_dim_l_cm: e.target.value ? parseFloat(e.target.value) : null })} style={editInput} />
                  <input type="number" step="0.1" min={0} placeholder="W" value={draft.ctn_dim_w_cm ?? ''}
                    onChange={(e) => setDraft({ ...draft, ctn_dim_w_cm: e.target.value ? parseFloat(e.target.value) : null })} style={editInput} />
                  <input type="number" step="0.1" min={0} placeholder="H" value={draft.ctn_dim_h_cm ?? ''}
                    onChange={(e) => setDraft({ ...draft, ctn_dim_h_cm: e.target.value ? parseFloat(e.target.value) : null })} style={editInput} />
                </div>
              </EditField>
              <EditField label="Unit net weight (g)">
                <input type="number" step="0.1" min={0} value={draft.unit_net_weight_g ?? ''}
                  onChange={(e) => setDraft({ ...draft, unit_net_weight_g: e.target.value ? parseFloat(e.target.value) : null })} style={editInput} />
              </EditField>
            </div>
          )}
        </div>
      </div>

      {/* SECTION 5 — Descriptions */}
      <Card>
        <SectionEyebrow label="Descriptions" role="sales" />
        {!editing ? (
          <DefList rows={[
            { label: 'RU', value: product.description_ru ?? '—', regular: true },
            { label: 'EN', value: product.description_en ?? '—', regular: true },
            { label: 'CN', value: product.description_cn ?? '—', regular: true },
          ]} />
        ) : (
          <div style={{ display: 'grid', gap: '12px' }}>
            <EditField label="RU description">
              <textarea value={draft.description_ru ?? ''}
                onChange={(e) => setDraft({ ...draft, description_ru: e.target.value || null })}
                rows={3} style={{ ...editInput, resize: 'vertical' }} />
            </EditField>
            <EditField label="EN description">
              <textarea value={draft.description_en ?? ''}
                onChange={(e) => setDraft({ ...draft, description_en: e.target.value || null })}
                rows={3} style={{ ...editInput, resize: 'vertical' }} />
            </EditField>
            <EditField label="CN description">
              <textarea value={draft.description_cn ?? ''}
                onChange={(e) => setDraft({ ...draft, description_cn: e.target.value || null })}
                rows={3} style={{ ...editInput, resize: 'vertical' }} />
            </EditField>
          </div>
        )}
      </Card>

      {/* SECTION 5a — Invoice labels (multilingual) */}
      <Card>
        <SectionEyebrow label="Invoice labels" role="master" />
        {!editing ? (
          <DefList rows={[
            { label: 'RU', value: product.invoice_label_ru ?? '—', regular: true },
            { label: 'EN', value: product.invoice_label_en ?? '—', regular: true },
            { label: 'CN', value: product.invoice_label_cn ?? '—', regular: true },
          ]} />
        ) : (
          <div style={{ display: 'grid', gap: '12px' }}>
            <EditField label="RU invoice label">
              <input type="text" value={draft.invoice_label_ru ?? ''}
                onChange={(e) => setDraft({ ...draft, invoice_label_ru: e.target.value || null })}
                placeholder="Зубная щётка Das Experten ETALON, 1 шт."
                style={editInput} />
            </EditField>
            <EditField label="EN invoice label">
              <input type="text" value={draft.invoice_label_en ?? ''}
                onChange={(e) => setDraft({ ...draft, invoice_label_en: e.target.value || null })}
                placeholder="Toothbrush Das Experten ETALON, 1 pc."
                style={editInput} />
            </EditField>
            <EditField label="CN invoice label">
              <input type="text" value={draft.invoice_label_cn ?? ''}
                onChange={(e) => setDraft({ ...draft, invoice_label_cn: e.target.value || null })}
                placeholder="达斯专家 ETALON 牙刷, 1 支"
                style={editInput} />
            </EditField>
          </div>
        )}
      </Card>

      {/* SECTION 5b — Purchase economics */}
      <Card>
        <SectionEyebrow label="Purchase economics" role="supply" />
        {!editing ? (
          <DefList rows={[
            { label: 'Buy price', value: product.buy_price != null ? `${product.buy_price / 100} ${product.buy_currency ?? ''}` : '—' },
            { label: 'Buy term', value: product.buy_term ?? '—' },
            { label: 'Weight (kg per ctn)', value: product.weight_kg != null ? String(product.weight_kg / 1000) : '—' },
            { label: 'Volume (m³ per ctn)', value: product.volume_m3_micro != null ? String(product.volume_m3_micro / 1_000_000) : '—' },
          ]} />
        ) : (
          <div style={{ display: 'grid', gap: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 1fr', gap: '8px' }}>
              <EditField label="Buy price (×100, e.g. 250 = 2.50)">
                <input type="number" step="1" min={0}
                  value={draft.buy_price ?? ''}
                  onChange={(e) => setDraft({ ...draft, buy_price: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
                  style={editInput} />
              </EditField>
              <EditField label="Currency">
                <input type="text" maxLength={3}
                  value={draft.buy_currency ?? ''}
                  onChange={(e) => setDraft({ ...draft, buy_currency: e.target.value.toUpperCase() || null })}
                  placeholder="CNY" style={editInput} />
              </EditField>
              <EditField label="Buy term">
                <input type="text" value={draft.buy_term ?? ''}
                  onChange={(e) => setDraft({ ...draft, buy_term: e.target.value || null })}
                  placeholder="FOB Yangzhou" style={editInput} />
              </EditField>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <EditField label="Weight per carton (g, integer)">
                <input type="number" min={0}
                  value={draft.weight_kg ?? ''}
                  onChange={(e) => setDraft({ ...draft, weight_kg: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
                  style={editInput} />
              </EditField>
              <EditField label="Volume per carton (m³ × 1M)">
                <input type="number" min={0}
                  value={draft.volume_m3_micro ?? ''}
                  onChange={(e) => setDraft({ ...draft, volume_m3_micro: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
                  style={editInput} />
              </EditField>
            </div>
          </div>
        )}
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
            Stored in R2 bucket <code style={{ fontVariantNumeric: 'tabular-nums' }}>das-erp-docs-dev</code> under <code style={{ fontVariantNumeric: 'tabular-nums' }}>products/{idUpper}/</code>
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
                    <td style={{ padding: '10px 12px', fontVariantNumeric: 'tabular-nums', color: '#6B6B6B' }}>
                      {formatDate(a.performed_at)}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: '14px', color: '#6B6B6B', textTransform: 'uppercase', letterSpacing: 0 }}>
                      {a.type}
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: INK }}>
                      {a.warehouse_code ?? '—'}
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: qtyColor }}>
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
            fontVariantNumeric: r.mono ? 'tabular-nums' : 'normal',
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

// =============================================================================
// Edit-mode helpers
// =============================================================================

const editInput: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  fontSize: '14px',
  fontFamily: 'inherit',
  border: '0.5px solid #C9C5BF',
  borderRadius: '6px',
  backgroundColor: '#FFFFFF',
  color: INK,
};

const readOnlyInput: React.CSSProperties = {
  ...editInput,
  backgroundColor: '#F5F2EE',
  color: '#9C9890',
  cursor: 'not-allowed',
};

function EditField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontSize: '14px',
        fontWeight: 600,
        color: '#6B6B6B',
        marginBottom: '4px',
      }}>
        {label}
      </div>
      {children}
    </div>
  );
}
