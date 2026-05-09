'use client';

export const runtime = 'edge';



import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle } from 'lucide-react';
import { getProduct, getWarehouses, createStockMovement, type Warehouse } from '@/lib/api';
import Breadcrumb from '@/components/layout/breadcrumb';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: '14px',
  fontWeight: 700,
  backgroundColor: 'var(--paper-sunk)',
  border: '1px solid var(--border-hairline)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--fg-1)',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '14px',
  fontWeight: 600,
  color: 'var(--fg-2)',
  marginBottom: '6px',
};

export default function ReceiptPage({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const warehouseId = params.slug;

  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [sku, setSku] = useState(searchParams.get('sku') ?? '');
  const [productName, setProductName] = useState('');
  const [productLoading, setProductLoading] = useState(false);
  const [qty, setQty] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reference: string; balance: number } | null>(null);

  useEffect(() => {
    getWarehouses().then((res) => {
      if (res.success && res.result) {
        const wh = res.result.warehouses.find((w) => w.id === warehouseId);
        if (wh) setWarehouse(wh);
      }
    });
  }, [warehouseId]);

  useEffect(() => {
    if (!sku.trim()) { setProductName(''); return; }
    const t = setTimeout(async () => {
      setProductLoading(true);
      const res = await getProduct(`prd_${sku.toLowerCase().replace(/^prd_/, '')}`);
      setProductName(res.success && res.result ? res.result.product_name : '');
      setProductLoading(false);
    }, 400);
    return () => clearTimeout(t);
  }, [sku]);

  async function handleSubmit() {
    setError(null);
    const qtyNum = parseInt(qty, 10);
    if (!sku.trim()) { setError('Enter a SKU'); return; }
    if (!qtyNum || qtyNum <= 0) { setError('Quantity must be a positive number'); return; }

    const productId = `prd_${sku.toLowerCase().replace(/^prd_/, '')}`;
    setSubmitting(true);
    try {
      const res = await createStockMovement({
        warehouse_id: warehouseId,
        product_id: productId,
        movement_type: 'receipt',
        quantity: qtyNum,
        notes: notes.trim() || null,
      });
      if (res.success && res.result) {
        setDone({ reference: productId.toUpperCase(), balance: res.result.balance_after });
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to record receipt');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-6">
        <Breadcrumb items={[
          { label: 'Warehouses', href: '/warehouses' },
          { label: warehouse?.code ?? warehouseId, href: `/warehouses/${warehouseId}` },
          { label: 'Receipt' },
        ]} />
        <div style={{
          padding: '32px',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper)',
          textAlign: 'center',
        }}>
          <CheckCircle style={{ color: 'var(--status-success)', width: 40, height: 40, margin: '0 auto 16px' }} />
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginBottom: '8px' }}>
            Receipt recorded
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '4px' }}>
            <strong>{parseInt(qty, 10).toLocaleString('en-US')} pcs</strong> of <strong>{done.reference}</strong> added to {warehouse?.code ?? warehouseId}
          </p>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '24px' }}>
            New balance: <strong>{done.balance.toLocaleString('en-US')} pcs</strong>
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button
              onClick={() => { setSku(''); setQty(''); setNotes(''); setDone(null); }}
              style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer' }}
            >
              Add another
            </button>
            <button
              onClick={() => router.push(`/warehouses/${warehouseId}`)}
              style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: '#FFFFFF', cursor: 'pointer' }}
            >
              Back to warehouse
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumb items={[
        { label: 'Warehouses', href: '/warehouses' },
        { label: warehouse?.code ?? warehouseId, href: `/warehouses/${warehouseId}` },
        { label: 'Receipt' },
      ]} />

      <div>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>Stock receipt</p>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginTop: '4px' }}>
          Record Receipt — {warehouse?.code ?? warehouseId}
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
          Goods arriving at this warehouse — increases on-hand stock
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div style={{ maxWidth: '520px', display: 'grid', gap: '20px' }}>
        <div>
          <label style={labelStyle}>SKU</label>
          <input
            type="text"
            placeholder="de201"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            style={inputStyle}
            autoFocus
          />
          {productLoading && <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>Looking up…</p>}
          {!productLoading && productName && <p style={{ fontSize: '14px', color: 'var(--status-success)', marginTop: '4px' }}>{productName}</p>}
          {!productLoading && sku && !productName && <p style={{ fontSize: '14px', color: 'var(--brand-rot)', marginTop: '4px' }}>Product not found</p>}
        </div>

        <div>
          <label style={labelStyle}>Quantity (pcs)</label>
          <input
            type="number"
            min="1"
            placeholder="0"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle}>Notes <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>(optional)</span></label>
          <input
            type="text"
            placeholder="e.g. from DEI-012, batch 2026-05"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={inputStyle}
          />
        </div>

        {error && <p style={{ fontSize: '14px', color: 'var(--brand-rot)' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={() => router.push(`/warehouses/${warehouseId}`)}
            style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ padding: '10px 24px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: '#FFFFFF', cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '8px' }}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Record receipt
          </button>
        </div>
      </div>
    </div>
  );
}
