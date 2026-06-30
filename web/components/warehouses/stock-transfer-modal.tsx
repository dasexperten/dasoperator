'use client';

import { useEffect, useMemo, useState } from 'react';
import { X, ArrowRight, Loader2, AlertCircle, CheckCircle2, ArrowLeftRight } from 'lucide-react';
import {
  getCompanies, getStocks, transferStock,
  type Warehouse, type Company, type StockRow,
} from '@/lib/api';

interface StockTransferModalProps {
  warehouses: Warehouse[];
  onClose: () => void;
  onDone: () => void;
}

export default function StockTransferModal({ warehouses, onClose, onDone }: StockTransferModalProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [rows, setRows] = useState<StockRow[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [loadingStock, setLoadingStock] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Only companies that own 2+ warehouses can host an internal transfer
  const eligibleCompanies = useMemo(() => {
    const counts = new Map<string, number>();
    for (const w of warehouses) {
      if (w.owner_company_id) counts.set(w.owner_company_id, (counts.get(w.owner_company_id) ?? 0) + 1);
    }
    return companies.filter((c) => (counts.get(c.id) ?? 0) >= 2);
  }, [companies, warehouses]);

  const companyWarehouses = useMemo(
    () => warehouses.filter((w) => w.owner_company_id === companyId),
    [warehouses, companyId]
  );

  useEffect(() => {
    getCompanies().then((res) => {
      if (res.success && res.result) setCompanies(res.result.companies);
    });
  }, []);

  // Default to first eligible company once loaded
  useEffect(() => {
    if (!companyId && eligibleCompanies.length > 0) setCompanyId(eligibleCompanies[0].id);
  }, [eligibleCompanies, companyId]);

  // When company changes, preselect from/to
  useEffect(() => {
    if (companyWarehouses.length >= 2) {
      setFromId(companyWarehouses[0].id);
      setToId(companyWarehouses[1].id);
    } else {
      setFromId('');
      setToId('');
    }
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load source-warehouse stock whenever From changes
  useEffect(() => {
    if (!fromId) { setRows([]); return; }
    setLoadingStock(true);
    setQty({});
    getStocks({ warehouse_id: fromId }).then((res) => {
      if (res.success && res.result) {
        setRows(res.result.stocks.filter((s) => s.on_hand > 0));
      } else {
        setRows([]);
      }
    }).finally(() => setLoadingStock(false));
  }, [fromId]);

  const lines = useMemo(
    () => rows
      .map((r) => ({ product_id: r.product_id, quantity: Math.floor(qty[r.product_id] || 0) }))
      .filter((l) => l.quantity > 0),
    [rows, qty]
  );
  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);

  function setLineQty(productId: string, value: string, max: number) {
    const n = Math.max(0, Math.min(Math.floor(Number(value) || 0), max));
    setQty((prev) => ({ ...prev, [productId]: n }));
  }

  async function handleSubmit() {
    setError(null);
    if (!fromId || !toId) { setError('Pick source and destination warehouses'); return; }
    if (fromId === toId) { setError('Source and destination must differ'); return; }
    if (lines.length === 0) { setError('Enter a quantity for at least one product'); return; }

    setSubmitting(true);
    try {
      const res = await transferStock({ from_warehouse_id: fromId, to_warehouse_id: toId, lines, reason: reason || null });
      if (res.success && res.result) {
        setSuccess(`Transfer ${res.result.transfer_ref} done — ${res.result.lines.length} product(s), ${totalUnits.toLocaleString('en-US')} pcs`);
        setTimeout(() => { onDone(); }, 1400);
      } else {
        setError(res.errors?.[0]?.message || 'Transfer failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  const fieldStyle: React.CSSProperties = {
    backgroundColor: 'var(--paper-sunk)',
    border: '1px solid var(--border-hairline)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--fg-1)',
    padding: '8px 10px',
    fontSize: 'var(--fs-body-sm)',
    width: '100%',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="dx-modal-panel w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        style={{ backgroundColor: 'var(--paper-raised)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}
      >
        <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" style={{ color: 'var(--brand-blau, #185FA5)' }} />
            <h2 style={{ fontSize: 'var(--fs-body-lg)', fontWeight: 700, color: 'var(--fg-1)' }}>Stock transfer</h2>
          </div>
          <button onClick={onClose} style={{ color: 'var(--fg-muted)' }} aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {success && (
            <div className="p-3 flex items-center gap-2" style={{ backgroundColor: 'rgba(29,158,117,0.08)', border: '1px solid rgba(29,158,117,0.3)', borderRadius: 'var(--radius-sm)' }}>
              <CheckCircle2 className="h-4 w-4" style={{ color: '#0F6E56' }} />
              <span style={{ fontSize: 'var(--fs-body-sm)', color: '#0F6E56' }}>{success}</span>
            </div>
          )}
          {error && (
            <div className="p-3 flex items-center gap-2" style={{ backgroundColor: 'rgba(229,32,44,0.06)', border: '1px solid rgba(229,32,44,0.25)', borderRadius: 'var(--radius-sm)' }}>
              <AlertCircle className="h-4 w-4" style={{ color: 'var(--brand-rot, #A32D2D)' }} />
              <span style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--brand-rot, #A32D2D)' }}>{error}</span>
            </div>
          )}

          {eligibleCompanies.length === 0 ? (
            <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
              No company owns two or more warehouses, so there is nothing to transfer between.
            </p>
          ) : (
            <>
              <div>
                <label style={{ fontSize: 'var(--fs-body-xs)', color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>Company</label>
                <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} style={fieldStyle}>
                  {eligibleCompanies.map((c) => (
                    <option key={c.id} value={c.id}>{c.abbreviation || c.legal_name}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label style={{ fontSize: 'var(--fs-body-xs)', color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>From warehouse</label>
                  <select value={fromId} onChange={(e) => setFromId(e.target.value)} style={fieldStyle}>
                    {companyWarehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
                  </select>
                </div>
                <ArrowRight className="h-5 w-5 mb-2" style={{ color: 'var(--fg-muted)' }} />
                <div className="flex-1">
                  <label style={{ fontSize: 'var(--fs-body-xs)', color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>To warehouse</label>
                  <select value={toId} onChange={(e) => setToId(e.target.value)} style={fieldStyle}>
                    {companyWarehouses.filter((w) => w.id !== fromId).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label style={{ fontSize: 'var(--fs-body-xs)', color: 'var(--fg-2)', display: 'block', marginBottom: 6 }}>
                  Products to move — quantity is capped at what is on hand at the source
                </label>
                <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                  <div className="grid items-center px-3 py-2" style={{ gridTemplateColumns: '1fr 110px 130px', gap: 8, backgroundColor: 'var(--paper-sunk)', fontSize: 'var(--fs-body-xs)', color: 'var(--fg-2)' }}>
                    <span>Product</span>
                    <span style={{ textAlign: 'right' }}>Available</span>
                    <span style={{ textAlign: 'right' }}>Move qty</span>
                  </div>
                  {loadingStock ? (
                    <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>
                  ) : rows.length === 0 ? (
                    <div className="px-3 py-6 text-center" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-muted)' }}>No stock on hand at this warehouse.</div>
                  ) : (
                    <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                      {rows.map((r) => (
                        <div key={r.product_id} className="grid items-center px-3 py-2" style={{ gridTemplateColumns: '1fr 110px 130px', gap: 8, borderTop: '1px solid var(--border-hairline)', fontSize: 'var(--fs-body-sm)' }}>
                          <span style={{ color: 'var(--fg-1)' }}>{r.product_name}</span>
                          <button
                            type="button"
                            onClick={() => setLineQty(r.product_id, String(r.on_hand), r.on_hand)}
                            title="Use full available quantity"
                            style={{ textAlign: 'right', color: 'var(--fg-2)', background: 'none', border: 'none', cursor: 'pointer' }}
                          >
                            {r.on_hand.toLocaleString('en-US')}
                          </button>
                          <input
                            type="number" min={0} max={r.on_hand}
                            value={qty[r.product_id] || ''}
                            placeholder="0"
                            onChange={(e) => setLineQty(r.product_id, e.target.value, r.on_hand)}
                            style={{ ...fieldStyle, textAlign: 'right', padding: '6px 8px' }}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label style={{ fontSize: 'var(--fs-body-xs)', color: 'var(--fg-2)', display: 'block', marginBottom: 4 }}>Reason / note (optional)</label>
                <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rebalancing for Ozon FBO supply" style={fieldStyle} />
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3" style={{ borderTop: '1px solid var(--border-hairline)' }}>
          <span style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
            {lines.length > 0 ? `${lines.length} product(s) · ${totalUnits.toLocaleString('en-US')} pcs` : 'No products selected'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              style={{ padding: '8px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-hairline)', backgroundColor: 'transparent', color: 'var(--fg-1)', fontSize: 'var(--fs-body-sm)' }}
            >Cancel</button>
            <button
              onClick={handleSubmit}
              disabled={submitting || lines.length === 0 || !!success}
              style={{ padding: '8px 16px', borderRadius: 'var(--radius-sm)', border: 'none', backgroundColor: 'var(--brand-blau, #185FA5)', color: '#fff', fontSize: 'var(--fs-body-sm)', fontWeight: 600, opacity: (submitting || lines.length === 0 || !!success) ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />}
              Confirm transfer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
