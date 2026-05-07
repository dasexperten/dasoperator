'use client';

export const runtime = 'edge';



import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle } from 'lucide-react';
import { getProduct, getWarehouses, createStockMovement, getProductStock, type Warehouse } from '@/lib/api';
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

const REASONS = [
  'Damaged goods',
  'Expired product',
  'Theft / loss',
  'Counting error correction',
  'Warehouse transfer error',
  'Other',
];

export default function AdjustPage({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const warehouseId = params.slug;

  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [sku, setSku] = useState(searchParams.get('sku') ?? '');
  const [productName, setProductName] = useState('');
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [productLoading, setProductLoading] = useState(false);
  const [direction, setDirection] = useState<'+' | '-'>('+');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState(REASONS[0]!);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ balance: number; delta: number } | null>(null);

  useEffect(() => {
    getWarehouses().then((res) => {
      if (res.success && res.result) {
        const wh = res.result.warehouses.find((w) => w.id === warehouseId);
        if (wh) setWarehouse(wh);
      }
    });
  }, [warehouseId]);

  useEffect(() => {
    if (!sku.trim()) { setProductName(''); setCurrentBalance(null); return; }
    const productId = `prd_${sku.toLowerCase().replace(/^prd_/, '')}`;
    const t = setTimeout(async () => {
      setProductLoading(true);
      const [pRes, sRes] = await Promise.all([
        getProduct(productId),
        getProductStock(productId),
      ]);
      setProductName(pRes.success && pRes.result ? pRes.result.product_name : '');
      if (sRes.success && sRes.result) {
        const stockRow = sRes.result.by_warehouse?.find((s: any) => s.warehouse_id === warehouseId);
        setCurrentBalance(stockRow ? stockRow.on_hand : 0);
      }
      setProductLoading(false);
    }, 400);
    return () => clearTimeout(t);
  }, [sku, warehouseId]);

  async function handleSubmit() {
    setError(null);
    const qtyNum = parseInt(qty, 10);
    if (!sku.trim()) { setError('Enter a SKU'); return; }
    if (!qtyNum || qtyNum <= 0) { setError('Quantity must be a positive number'); return; }

    const productId = `prd_${sku.toLowerCase().replace(/^prd_/, '')}`;
    const signedQty = direction === '+' ? qtyNum : -qtyNum;

    setSubmitting(true);
    try {
      const res = await createStockMovement({
        warehouse_id: warehouseId,
        product_id: productId,
        movement_type: 'adjustment',
        quantity: signedQty,
        reason: reason,
        notes: notes.trim() || null,
      });
      if (res.success && res.result) {
        setDone({ balance: res.result.balance_after, delta: signedQty });
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to record adjustment');
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
          { label: 'Adjust Stock' },
        ]} />
        <div style={{ padding: '32px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--paper)', textAlign: 'center' }}>
          <CheckCircle style={{ color: 'var(--status-success)', width: 40, height: 40, margin: '0 auto 16px' }} />
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginBottom: '8px' }}>
            Adjustment recorded
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '4px' }}>
            <strong>{done.delta > 0 ? '+' : ''}{done.delta.toLocaleString('en-US')} pcs</strong> applied to {sku.toUpperCase()} at {warehouse?.code ?? warehouseId}
          </p>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '24px' }}>
            New balance: <strong>{done.balance.toLocaleString('en-US')} pcs</strong>
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button onClick={() => { setSku(''); setQty(''); setNotes(''); setDone(null); setCurrentBalance(null); }} style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer' }}>
              Adjust another
            </button>
            <button onClick={() => router.push(`/warehouses/${warehouseId}`)} style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: '#FFFFFF', cursor: 'pointer' }}>
              Back to warehouse
            </button>
          </div>
        </div>
      </div>
    );
  }

  const preview = qty && parseInt(qty, 10) > 0
    ? (currentBalance ?? 0) + (direction === '+' ? parseInt(qty, 10) : -parseInt(qty, 10))
    : null;

  return (
    <div className="space-y-6">
      <Breadcrumb items={[
        { label: 'Warehouses', href: '/warehouses' },
        { label: warehouse?.code ?? warehouseId, href: `/warehouses/${warehouseId}` },
        { label: 'Adjust Stock' },
      ]} />

      <div>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>Stock adjustment</p>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginTop: '4px' }}>
          Adjust Stock — {warehouse?.code ?? warehouseId}
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
          Manual correction — increases or decreases on-hand by a delta
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div style={{ maxWidth: '520px', display: 'grid', gap: '20px' }}>
        <div>
          <label style={labelStyle}>SKU</label>
          <input type="text" placeholder="de201" value={sku} onChange={(e) => setSku(e.target.value)} style={inputStyle} autoFocus />
          {productLoading && <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>Looking up…</p>}
          {!productLoading && productName && (
            <p style={{ fontSize: '14px', color: 'var(--status-success)', marginTop: '4px' }}>
              {productName}
              {currentBalance !== null && <span style={{ color: 'var(--fg-3)', marginLeft: '8px' }}>— current balance: {currentBalance.toLocaleString('en-US')} pcs</span>}
            </p>
          )}
          {!productLoading && sku && !productName && <p style={{ fontSize: '14px', color: 'var(--brand-rot)', marginTop: '4px' }}>Product not found</p>}
        </div>

        <div>
          <label style={labelStyle}>Direction and quantity</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px', alignItems: 'center' }}>
            <div style={{ display: 'flex', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
              {(['+', '-'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  style={{
                    padding: '10px 20px',
                    fontSize: '18px',
                    fontWeight: 700,
                    border: 'none',
                    cursor: 'pointer',
                    backgroundColor: direction === d ? (d === '+' ? 'rgba(46,125,79,0.15)' : 'rgba(229,32,44,0.12)') : 'var(--paper-sunk)',
                    color: direction === d ? (d === '+' ? 'var(--status-success)' : 'var(--brand-rot)') : 'var(--fg-3)',
                  }}
                >
                  {d}
                </button>
              ))}
            </div>
            <input type="number" min="1" placeholder="0" value={qty} onChange={(e) => setQty(e.target.value)} style={inputStyle} />
          </div>
          {preview !== null && (
            <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '6px' }}>
              New balance will be: <strong style={{ color: preview < 0 ? 'var(--brand-rot)' : 'var(--fg-1)' }}>{preview.toLocaleString('en-US')} pcs</strong>
            </p>
          )}
        </div>

        <div>
          <label style={labelStyle}>Reason</label>
          <select value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle}>
            {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div>
          <label style={labelStyle}>Notes <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>(optional)</span></label>
          <input type="text" placeholder="Additional context" value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} />
        </div>

        {error && <p style={{ fontSize: '14px', color: 'var(--brand-rot)' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={() => router.push(`/warehouses/${warehouseId}`)} style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={submitting} style={{ padding: '10px 24px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: '#FFFFFF', cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.7 : 1, display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Apply adjustment
          </button>
        </div>
      </div>
    </div>
  );
}
