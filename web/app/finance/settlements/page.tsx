'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, AlertCircle, CheckCircle2, Clock, XCircle, Triangle } from 'lucide-react';
import { getAgentSettlements, type AgentSettlement } from '@/lib/api';

const STATUS_LABELS: Record<string, { label: string; bg: string; fg: string; icon: typeof CheckCircle2 }> = {
  draft:         { label: 'Draft',         bg: 'var(--paper-sunk)',         fg: 'var(--fg-3)', icon: AlertCircle },
  pending_match: { label: 'Pending match', bg: 'rgba(125,72,28,0.10)',      fg: '#7D481C',     icon: Clock },
  settled:       { label: 'Settled',       bg: 'rgba(46,125,79,0.10)',      fg: '#2E7D4F',     icon: CheckCircle2 },
  cancelled:     { label: 'Cancelled',     bg: 'rgba(229,32,44,0.10)',      fg: '#A82029',     icon: XCircle },
};

function formatAmount(amount: number, currency: string): string {
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

export default function SettlementsListPage() {
  const [settlements, setSettlements] = useState<AgentSettlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');

  async function loadData() {
    setLoading(true);
    try {
      const filters: { status?: string } = {};
      if (statusFilter) filters.status = statusFilter;
      const res = await getAgentSettlements(filters);
      if (res.success && res.result) {
        setSettlements(res.result.settlements);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, [statusFilter]);

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Triangle className="h-7 w-7" style={{ color: 'var(--brand-schwarz)' }} />
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--fg-1)' }}>Agent settlements</h1>
            <p className="text-sm" style={{ color: 'var(--fg-3)' }}>Triangle settlements via paired agents (Bright Ideas Trading ↔ Centuno Co. Ltd)</p>
          </div>
        </div>
        <Link
          href="/finance/settlements/new"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold"
          style={{ background: 'var(--brand-schwarz)', color: 'var(--paper-raised)' }}
        >
          <Plus className="h-4 w-4" />
          New settlement
        </Link>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <span className="text-sm" style={{ color: 'var(--fg-3)' }}>Filter:</span>
        {['', 'pending_match', 'settled', 'cancelled', 'draft'].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setStatusFilter(s)}
            className="px-3 py-1.5 rounded text-sm"
            style={{
              background: statusFilter === s ? 'var(--brand-schwarz)' : 'var(--paper-raised)',
              color: statusFilter === s ? 'var(--paper-raised)' : 'var(--fg-1)',
              border: '1px solid var(--border-1)',
              fontWeight: 500,
            }}
          >
            {s ? STATUS_LABELS[s]?.label ?? s : 'All'}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-12 flex justify-center"><Loader2 className="animate-spin h-6 w-6" style={{ color: 'var(--fg-3)' }} /></div>
      ) : settlements.length === 0 ? (
        <div className="py-16 text-center" style={{ background: 'var(--paper-raised)', borderRadius: '6px' }}>
          <Triangle className="h-12 w-12 mx-auto mb-4" style={{ color: 'var(--fg-3)' }} />
          <p className="text-base mb-1" style={{ color: 'var(--fg-1)' }}>No settlements yet</p>
          <p className="text-sm mb-4" style={{ color: 'var(--fg-3)' }}>Triangle settlements link a payment to an agent on one side with a receipt from a paired agent on the other.</p>
          <Link href="/finance/settlements/new" className="inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold" style={{ background: 'var(--brand-schwarz)', color: 'var(--paper-raised)' }}>
            <Plus className="h-4 w-4" /> Create first settlement
          </Link>
        </div>
      ) : (
        <div style={{ background: 'var(--paper-raised)', borderRadius: '6px', overflow: 'hidden' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--paper-sunk)' }}>
              <tr>
                <th className="text-left px-4 py-3 font-bold" style={{ color: 'var(--fg-1)' }}>Reference</th>
                <th className="text-left px-4 py-3 font-bold" style={{ color: 'var(--fg-1)' }}>Date</th>
                <th className="text-left px-4 py-3 font-bold" style={{ color: 'var(--fg-1)' }}>Outbound leg</th>
                <th className="text-left px-4 py-3 font-bold" style={{ color: 'var(--fg-1)' }}>Inbound leg</th>
                <th className="text-left px-4 py-3 font-bold" style={{ color: 'var(--fg-1)' }}>Clearance</th>
                <th className="text-left px-4 py-3 font-bold" style={{ color: 'var(--fg-1)' }}>Variance</th>
                <th className="text-left px-4 py-3 font-bold" style={{ color: 'var(--fg-1)' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {settlements.map((s) => {
                const status = STATUS_LABELS[s.status] || STATUS_LABELS.draft!;
                const Icon = status.icon;
                return (
                  <tr key={s.id} style={{ borderTop: '1px solid var(--border-1)' }}>
                    <td className="px-4 py-3">
                      <Link href={`/finance/settlements/${s.id}`} className="font-bold" style={{ color: 'var(--brand-schwarz)' }}>
                        {s.reference}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-bold" style={{ color: 'var(--fg-1)' }}>{formatDate(s.settlement_date)}</td>
                    <td className="px-4 py-3">
                      <div className="font-bold" style={{ color: 'var(--fg-1)' }}>{formatAmount(s.outbound_amount, s.outbound_currency)}</div>
                      <div className="text-xs" style={{ color: 'var(--fg-3)' }}>{s.outbound_company} → {s.outbound_agent_name}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-bold" style={{ color: 'var(--fg-1)' }}>{formatAmount(s.inbound_amount, s.inbound_currency)}</div>
                      <div className="text-xs" style={{ color: 'var(--fg-3)' }}>{s.inbound_agent_name} → {s.inbound_company}</div>
                    </td>
                    <td className="px-4 py-3">
                      {s.clearance_op_reference ? (
                        <Link href={`/operations/${s.clearance_operation_id}`} className="font-bold text-xs" style={{ color: 'var(--brand-schwarz)' }}>
                          {s.clearance_op_reference}
                        </Link>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--fg-3)' }}>—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {s.variance_amount !== null && s.variance_amount !== undefined ? (
                        <span className="font-bold text-xs" style={{ color: Math.abs(s.variance_amount) > 100 ? '#A82029' : 'var(--fg-3)' }}>
                          {formatAmount(s.variance_amount, s.variance_currency ?? 'USD')}
                        </span>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--fg-3)' }}>—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold" style={{ background: status.bg, color: status.fg }}>
                        <Icon className="h-3 w-3" />
                        {status.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
