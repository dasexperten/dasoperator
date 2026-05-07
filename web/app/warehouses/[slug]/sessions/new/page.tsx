'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle, ClipboardList } from 'lucide-react';
import { getWarehouses, createInventorySession, type Warehouse } from '@/lib/api';
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

const SCOPE_OPTIONS = [
  {
    value: 'full' as const,
    label: 'Full count',
    description: 'Count every SKU in the warehouse',
  },
  {
    value: 'partial' as const,
    label: 'Partial count',
    description: 'Count a selected group of SKUs',
  },
  {
    value: 'spot' as const,
    label: 'Spot check',
    description: 'Quick verification of one or a few SKUs',
  },
];

export default function StartSessionPage({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const warehouseId = params.slug;

  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);
  const [scope, setScope] = useState<'full' | 'partial' | 'spot'>('full');
  const [startedBy, setStartedBy] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reference: string; id: string } | null>(null);

  useEffect(() => {
    getWarehouses().then((res) => {
      if (res.success && res.result) {
        const wh = res.result.warehouses.find((w) => w.id === warehouseId);
        if (wh) setWarehouse(wh);
      }
    });
  }, [warehouseId]);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await createInventorySession({
        warehouse_id: warehouseId,
        scope,
        started_by: startedBy.trim() || null,
        notes: notes.trim() || null,
      });
      if (res.success && res.result) {
        setDone({ reference: res.result.reference, id: res.result.id });
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to start session');
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
          { label: 'Start Session' },
        ]} />
        <div style={{ padding: '32px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--paper)', textAlign: 'center' }}>
          <CheckCircle style={{ color: 'var(--status-success)', width: 40, height: 40, margin: '0 auto 16px' }} />
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginBottom: '8px' }}>
            Session opened
          </h2>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '4px' }}>
            Reference: <strong>{done.reference}</strong>
          </p>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '4px' }}>
            Warehouse: <strong>{warehouse?.code ?? warehouseId}</strong> · Scope: <strong>{SCOPE_OPTIONS.find(o => o.value === scope)?.label}</strong>
          </p>
          <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginBottom: '24px' }}>
            Use Recount on each SKU to enter your physical counts. The session tracks discrepancies automatically.
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <button
              onClick={() => router.push(`/warehouses/${warehouseId}/recount`)}
              style={{ padding: '10px 20px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', cursor: 'pointer' }}
            >
              Start counting
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
        { label: 'Start Session' },
      ]} />

      <div>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>Inventory session</p>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginTop: '4px' }}>
          Start Session — {warehouse?.code ?? warehouseId}
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
          Opens a formal inventory count. Use Recount for each SKU after this.
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div style={{ maxWidth: '520px', display: 'grid', gap: '20px' }}>
        <div>
          <label style={labelStyle}>Scope</label>
          <div style={{ display: 'grid', gap: '8px' }}>
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setScope(opt.value)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                  padding: '14px 16px',
                  border: `1px solid ${scope === opt.value ? 'var(--brand-rot)' : 'var(--border-hairline)'}`,
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: scope === opt.value ? 'rgba(229,32,44,0.06)' : 'var(--paper-sunk)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <div style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  border: `2px solid ${scope === opt.value ? 'var(--brand-rot)' : 'var(--border-hairline)'}`,
                  flexShrink: 0,
                  marginTop: '2px',
                  backgroundColor: scope === opt.value ? 'var(--brand-rot)' : 'transparent',
                }} />
                <div>
                  <p style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>{opt.label}</p>
                  <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: '2px 0 0' }}>{opt.description}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={labelStyle}>Started by <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>(optional)</span></label>
          <input
            type="text"
            placeholder="Name or initials"
            value={startedBy}
            onChange={(e) => setStartedBy(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={labelStyle}>Notes <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}>(optional)</span></label>
          <input
            type="text"
            placeholder="e.g. monthly recount, before shipment"
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
            <ClipboardList className="h-4 w-4" />
            Open session
          </button>
        </div>
      </div>
    </div>
  );
}
