'use client';

export const runtime = 'edge';



import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, Loader2, Plus, X, Trash2, Factory } from 'lucide-react';
import { getOperations, deleteOperation, updateOperationStatus, type Operation } from '@/lib/api';
import { ContractRef } from '@/components/ui/contract-ref';

const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  sale:     { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)' },
  purchase: { bg: 'rgba(13,25,158,0.08)',  fg: 'var(--line-innoweiss)' },
  transfer: { bg: 'var(--paper-sunk)',     fg: 'var(--fg-2)' },
};

// Phase 4.3b — Payment overlay applied on top of status (red/brown/green at 95% tolerance)
const PAYMENT_OVERLAY: Record<string, { bg: string; fg: string; dot: string; label: string }> = {
  unpaid:  { bg: 'rgba(229,32,44,0.10)', fg: '#A82029', dot: '#E5202C', label: 'Unpaid' },
  partial: { bg: 'rgba(125,72,28,0.10)', fg: '#7D481C', dot: '#A06A2C', label: 'Partial' },
  paid:    { bg: 'rgba(46,125,79,0.10)', fg: '#2E7D4F', dot: '#3E9E63', label: 'Paid' },
  neutral: { bg: 'var(--paper-sunk)',    fg: 'var(--fg-3)', dot: 'var(--fg-muted)', label: '' },
};

// Phase 5.x — Status display labels (DB enum → human-readable)
const STATUS_LABELS: Record<string, string> = {
  draft:            'Draft',
  issued:           'Issued',
  order_fulfilment: 'Boxing',
  production:       'In Production',
  stocked:          'Stocked',
  shipped:          'Shipped',
  delivered:        'Delivered',
  cancelled:        'Cancelled',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

function formatMoney(amount: number, currency: string): string {
  const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(currency);
  const fractionDigits = isZeroDecimal ? 0 : 2;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export default function OperationsPage() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [paymentFilter, setPaymentFilter] = useState<string>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState<boolean>(false);

  async function handleCancel(op: Operation) {
    const label = op.reference ?? op.id;
    if (!confirm(`Cancel operation ${label}?\n\nThis will move it to status 'cancelled'. If stock has already moved, a return movement will be written. This action cannot be undone.`)) return;
    setBusyId(op.id);
    setActionMsg(null);
    try {
      const res = await updateOperationStatus(op.id, 'cancelled');
      if (res.success) {
        setOperations((prev) => prev.map((o) => o.id === op.id ? { ...o, status: 'cancelled', payment_state: 'neutral' } : o));
        setActionMsg(`${label} cancelled`);
      } else {
        setActionMsg(`Failed to cancel ${label}: ${res.errors?.[0]?.message ?? 'unknown error'}`);
      }
    } catch (e) {
      setActionMsg(`Network error cancelling ${label}`);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(op: Operation) {
    const label = op.reference ?? op.id;
    if (!confirm(`Permanently DELETE draft operation ${label}?\n\nThis removes it entirely. Only possible for drafts with no documents, payments, or stock movements. This cannot be undone.`)) return;
    setBusyId(op.id);
    setActionMsg(null);
    try {
      const res = await deleteOperation(op.id);
      if (res.success) {
        setOperations((prev) => prev.filter((o) => o.id !== op.id));
        setActionMsg(`${label} deleted`);
      } else {
        setActionMsg(`Failed to delete ${label}: ${res.errors?.[0]?.message ?? 'unknown error'}`);
      }
    } catch (e) {
      setActionMsg(`Network error deleting ${label}`);
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    const fetchOps = async () => {
      setLoading(true);
      try {
        const res = await getOperations({ include_cancelled: showCancelled, compact: true });
        if (res.success && res.result) {
          setOperations(res.result.operations);
          setError(null);
        } else {
          setError(res.errors?.[0]?.message ?? 'Failed to load');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchOps();
  }, [showCancelled]);

  const filtered = useMemo(() => {
    return operations.filter((op) => {
      if (search) {
        const q = search.toLowerCase();
        const m = op.reference?.toLowerCase().includes(q) ||
                  op.partner_trade_name?.toLowerCase().includes(q) ||
                  op.manufacturer_name?.toLowerCase().includes(q) ||
                  op.contract_no?.toLowerCase().includes(q);
        if (!m) return false;
      }
      if (typeFilter !== 'all' && op.operation_type !== typeFilter) return false;
      if (statusFilter !== 'all' && op.status !== statusFilter) return false;
      if (paymentFilter !== 'all' && (op.payment_state ?? 'neutral') !== paymentFilter) return false;
      return true;
    });
  }, [operations, search, typeFilter, statusFilter, paymentFilter]);

  return (
    <div className="space-y-8 max-w-7xl">
      <div className="flex items-start justify-between">
        <div>
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: '14px', fontWeight: 500, color: 'var(--fg-3)', marginBottom: '8px' }}>
            Operations
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)' }}>
            All Operations
          </h1>
          <p className="mt-2" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            {loading ? 'Loading...' : `${operations.length} across all partners · ${filtered.length} shown`}
          </p>
        </div>
        <Link
          href="/operations/new"
          className="inline-flex items-center gap-2 px-4 py-2"
          style={{
            backgroundColor: 'var(--brand-rot)', color: 'var(--paper)',
            borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 600,
          }}
        >
          <Plus className="h-4 w-4" />
          Add new
        </Link>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="space-y-3">
        <div className="relative max-w-xl">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--fg-muted)' }} />
          <input type="text" placeholder="Search by reference, partner, or contract..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2"
            style={{ fontSize: '14px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
        </div>
        <div className="flex gap-3 flex-wrap">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            className="px-3 py-2"
            style={{ fontSize: '14px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }}>
            <option value="all">All types</option>
            <option value="sale">Sale</option>
            <option value="purchase">Purchase</option>
            <option value="transfer">Transfer</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2"
            style={{ fontSize: '14px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }}>
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="issued">Issued</option>
            <option value="order_fulfilment">Boxing</option>
            <option value="production">In Production</option>
            <option value="stocked">Stocked</option>
            <option value="shipped">Shipped</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)}
            className="px-3 py-2"
            style={{ fontSize: '14px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }}>
            <option value="all">All payments</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
            <option value="neutral">No overlay</option>
          </select>
          <label className="inline-flex items-center gap-2" style={{
            fontSize: '14px', color: 'var(--fg-2)', padding: '6px 10px',
            border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
            backgroundColor: 'var(--paper-sunk)', cursor: 'pointer',
          }}>
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            Show cancelled
          </label>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>
      ) : error ? (
        <div className="p-4" style={{ fontSize: '14px', backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>Error: {error}</div>
      ) : (
        <>
          {actionMsg && (
            <div className="px-4 py-3 mb-3" style={{
              fontSize: '14px',
              color: 'var(--fg-1)',
              backgroundColor: 'rgba(46,125,79,0.08)',
              border: '1px solid rgba(46,125,79,0.2)',
              borderRadius: 'var(--radius-sm)',
            }}>
              {actionMsg}
            </div>
          )}
        <div className="bg-card overflow-hidden" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <table className="w-full" style={{ fontSize: '14px', fontFamily: 'var(--font-sans)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Reference</Th><Th>Date</Th><Th>Partner</Th><Th>Contract</Th><Th>Type</Th><Th align="right">Total</Th><Th>Status</Th><Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>No operations match the filters</td></tr>
              ) : (
                filtered.map((op) => {
                  const tc = TYPE_COLORS[op.operation_type];
                  const ps = op.payment_state ?? 'neutral';
                  const po = PAYMENT_OVERLAY[ps]!;
                  const total = op.total_amount || 0;
                  const paid = op.paid_amount ?? 0;
                  const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
                  return (
                    <tr key={op.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-4 py-3" style={{ fontWeight: 700, color: 'var(--fg-1)' }}>
                        <Link
                          href={`/operations/${op.id}`}
                          style={{ color: 'var(--fg-1)', textDecoration: 'underline', textDecorationColor: 'var(--border-hairline)', textUnderlineOffset: '3px' }}
                        >
                          {op.reference ?? op.id}
                        </Link>
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-3)' }}>{formatDate(op.operation_date)}</td>
                      {/* v2 manufacturer fallback — deployed 2026-05-11 */}
                      <td className="px-4 py-3" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
                        {op.partner_trade_name ? (
                          <Link href={`/partners/${op.partner_id}`} style={{ color: 'var(--fg-1)' }}>
                            {op.partner_trade_name}
                          </Link>
                        ) : op.manufacturer_name ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', color: 'var(--fg-1)', fontWeight: 700 }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: 'var(--radius-pill)', backgroundColor: 'rgba(229,32,44,0.10)', color: 'var(--brand-rot)', fontSize: '12px', fontWeight: 700 }}>
                              <Factory style={{ width: 12, height: 12 }} />
                              Factory
                            </span>
                            <span>{op.manufacturer_name}</span>
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>
                        <ContractRef contractNo={op.contract_no} />
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block" style={{ fontSize: '14px', fontWeight: 500, padding: '3px 10px', backgroundColor: tc?.bg, color: tc?.fg, borderRadius: 'var(--radius-pill)' }}>
                          {op.operation_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>{formatMoney(op.total_amount, op.currency)} {op.currency}</td>
                      <td className="px-4 py-3">
                        <div className="inline-flex items-center gap-2" style={{
                          padding: '4px 10px',
                          backgroundColor: po.bg,
                          color: po.fg,
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '14px',
                          fontWeight: 500,
                        }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: po.dot, display: 'inline-block' }} />
                          <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{statusLabel(op.status)}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-2">
                          {op.status === 'draft' && (
                            <button
                              onClick={() => handleDelete(op)}
                              disabled={busyId === op.id}
                              title="Delete (draft only — permanent)"
                              style={{
                                fontSize: '14px', fontWeight: 600,
                                padding: '4px 10px',
                                border: '1px solid rgba(229,32,44,0.3)',
                                borderRadius: 'var(--radius-sm)',
                                color: '#A82029',
                                backgroundColor: busyId === op.id ? 'var(--paper-sunk)' : 'transparent',
                                cursor: busyId === op.id ? 'wait' : 'pointer',
                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Delete
                            </button>
                          )}
                          {op.status !== 'draft' && op.status !== 'cancelled' && op.status !== 'delivered' && (
                            <button
                              onClick={() => handleCancel(op)}
                              disabled={busyId === op.id}
                              title="Cancel operation (reverses stock if shipped)"
                              style={{
                                fontSize: '14px', fontWeight: 600,
                                padding: '4px 10px',
                                border: '1px solid var(--border-hairline)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--fg-2)',
                                backgroundColor: busyId === op.id ? 'var(--paper-sunk)' : 'transparent',
                                cursor: busyId === op.id ? 'wait' : 'pointer',
                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                              Cancel
                            </button>
                          )}
                          {(op.status === 'cancelled' || op.status === 'delivered') && (
                            <span style={{ fontSize: '14px', color: 'var(--fg-muted)' }}>—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        </>
      )}

      <div className="flex items-center gap-6 flex-wrap" style={{ fontSize: '14px', color: 'var(--fg-3)', paddingTop: '8px' }}>
        <span style={{ fontWeight: 500, color: 'var(--fg-2)' }}>Payment:</span>
        <LegendDot color={PAYMENT_OVERLAY.unpaid!.dot} label="Not paid" />
        <LegendDot color={PAYMENT_OVERLAY.partial!.dot} label="Partially paid" />
        <LegendDot color={PAYMENT_OVERLAY.paid!.dot} label="Fully paid" />
      </div>
    </div>
  );
}

function Th({ children, align = 'left' }: { children?: React.ReactNode; align?: 'left' | 'right' }) {
  return <th className={`px-4 py-3 text-${align}`} style={{ fontSize: '14px', fontWeight: 500, color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)', textTransform: 'none', letterSpacing: 0 }}>{children}</th>;
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: color, display: 'inline-block' }} />
      {label}
    </span>
  );
}
