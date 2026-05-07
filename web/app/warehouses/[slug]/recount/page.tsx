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

export default function RecountPage({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const warehouseId = params.slug;

  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [sku, setSku] = useState(searchParams.get('sku') ?? '');
  const [productName, setProductName] = useState('');
  const [systemBalance, setSystemBalance] = useState<number | null>(null);
  const [productLoading, setProductLoading] = useState(false);
  const [actualQty, setActualQty] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ delta: number; newBalance: number } | null>(null);

  useEffect(() => {
    getWarehouses().then((res) => {
      if (res.success && res.result) {
        const wh = res.result.warehouses.find((w) => w.id === warehouseId);
        if (wh) setWarehouse(wh);
      }
    });
  }, [warehouseId]);

  useEffect(() => {
    if (!sku.trim()) { setProductName(''); setSystemBalance(null); return; }
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
        setSystemBalance(stockRow ? stockRow.on_hand : 0);
      }
      setProductLoading(false);
    }, 400);
    return () => clearTimeout(t);
  }, [sku, warehouseId]);

  const actual = actualQty !== '' ? parseInt(actualQty, 10) : null;
  const delta = (actual !== null && systemBalance !== null) ? actual - systemBalance : null;

  async function handleSubmit() {
    setError(null);
    if (!sku.trim()) { setError('Enter a SKU'); return; }
    if (actualQty === '' || actual === null || isNaN(actual) || actual < 0) { setError('Enter the actual quantity you counted'); return; }
    if (delta === 0) { setError('No discrepancy — system balance matches your count'); return; }

    const productId = `prd_${sku.toLowerCase().replace(/^prd_/, '')}`;
    setSubmitting(true);
    try {
      const res = await createStockMovement({
        warehouse_id: warehouseId,
        product_id: productId,
        movement_type: 'session_correction',
        quantity: delta!,
        notes: notes.trim() || null,
      });
      if (res.success && res.result) {
        setDone({ delta: delta!, newBalance: res.result.balance_after });
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to record recount');
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
          { label: 'Recount' },
        ]} />
        <div style={{ padding: '32px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--paper)', textAlign: 'center' }}>
          <CheckCircle style={{ color: 'var(--status-success)', width: 40, height: 40, margin: '0 auto 16px' }} />
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginBottom: '8px' }}>
            Recount applied
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '4px' }}>
            Correction: <strong style={{ color: done.delta > 0 ? 'var(--status-success)' : 'var(--brand-rot)' }}>{done.delta > 0 ? '+' : ''}{done.delta.toLocaleString('en-US')} pcs</strong>
          </p>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '24px' }}>
            Verified balance: <strong>{done.newBalance.toLocaleString('en-US')} pcs</strong>
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button onClick={() => { setSku(''); setActualQty(''); setNotes(''); setDone(null); setSystemBalance(null); }} style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer' }}>
              Recount another
            </button>
            <button onClick={() => router.push(`/warehouses/${warehouseId}`)} style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: '#FFFFFF', cursor: 'pointer' }}>
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
        { label: 'Recount' },
      ]} />

      <div>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>Stock recount</p>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginTop: '4px' }}>
          Recount — {warehouse?.code ?? warehouseId}
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
          Enter what you physically counted — system calculates and applies the correction
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
              {systemBalance !== null && (
                <span style={{ color: 'var(--fg-3)', marginLeft: '8px' }}>— system says: {systemBalance.toLocaleString('en-US')} pcs</span>
              )}
            </p>
          )}
          {!productLoading && sku && !productName && <p style={{ fontSize: '14px', color: 'var(--brand-rot)', marginTop: '4px' }}>Product not found</p>}
        </div>

        <div>
          <label style={labelStyle}>Actual count (what you see on the shelf)</label>
          <input type="number" min="0" placeholder="0" value={actualQty} onChange={(e) => setActualQty(e.target.value)} style={inputStyle} />
          {delta !== null && (
            <div style={{
              marginTop: '10px',
              padding: '12px 16px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: delta === 0 ? 'var(--paper-sunk)' : delta > 0 ? 'rgba(46,125,79,0.08)' : 'rgba(229,32,44,0.08)',
              border: `1px solid ${delta === 0 ? 'var(--border-hairline)' : delta > 0 ? 'rgba(46,125,79,0.3)' : 'rgba(229,32,44,0.3)'}`,
            }}>
              <p style={{ fontSize: '14px', color: 'var(--fg-2)', margin: 0 }}>
                {delta === 0 ? (
                  <span>✓ No discrepancy</span>
                ) : (
                  <>
                    Discrepancy: <strong style={{ color: delta > 0 ? 'var(--status-success)' : 'var(--brand-rot)' }}>{delta > 0 ? '+' : ''}{delta.toLocaleString('en-US')} pcs</strong>
                    <span style={{ color: 'var(--fg-3)', marginLeft: '8px' }}>— this correction will be recorded</span>
                  </>
                )}
              </p>
            </div>
          )}
        </div>

        <div>
          <label style={labelStyle}>Notes <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>(optional)</span></label>
          <input type="text" placeholder="Who counted, when, any context" value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} />
        </div>

        {error && <p style={{ fontSize: '14px', color: 'var(--brand-rot)' }}>{error}</p>}

        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={() => router.push(`/warehouses/${warehouseId}`)} style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={submitting || delta === 0} style={{ padding: '10px 24px', fontSize: '14px', fontWeight: 600, border: 'none', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--brand-rot)', color: '#FFFFFF', cursor: (submitting || delta === 0) ? 'not-allowed' : 'pointer', opacity: (submitting || delta === 0) ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Apply recount
          </button>
        </div>
      </div>
    </div>
  );
}
