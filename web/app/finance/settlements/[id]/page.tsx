'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Loader2, ArrowLeft, AlertCircle, CheckCircle2, Clock, XCircle,
  Triangle, Building2, ArrowUpRight, ArrowDownLeft,
} from 'lucide-react';
import { getAgentSettlement, cancelAgentSettlement, type AgentSettlementDetail } from '@/lib/api';

const STATUS_LABELS: Record<string, { label: string; bg: string; fg: string; icon: typeof CheckCircle2 }> = {
  draft:         { label: 'Draft',         bg: 'var(--paper-sunk)',    fg: 'var(--fg-3)', icon: AlertCircle },
  pending_match: { label: 'Pending match', bg: 'rgba(125,72,28,0.10)', fg: '#7D481C',     icon: Clock },
  settled:       { label: 'Settled',       bg: 'rgba(46,125,79,0.10)', fg: '#2E7D4F',     icon: CheckCircle2 },
  cancelled:     { label: 'Cancelled',     bg: 'rgba(229,32,44,0.10)', fg: '#A82029',     icon: XCircle },
};

function formatAmount(amount: number, currency: string): string {
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;
}

function formatDate(unix: number | null | undefined): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

export default function SettlementDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [settlement, setSettlement] = useState<AgentSettlementDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);

  async function loadData() {
    setLoading(true);
    try {
      const res = await getAgentSettlement(params.id);
      if (res.success && res.result) setSettlement(res.result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, [params.id]);

  async function handleCancel() {
    if (!settlement) return;
    if (!confirm(`Cancel settlement ${settlement.reference}? This cannot be undone.`)) return;
    setCancelling(true);
    try {
      await cancelAgentSettlement(settlement.id);
      await loadData();
    } finally { setCancelling(false); }
  }

  if (loading) {
    return <div className="py-16 flex justify-center"><Loader2 className="animate-spin h-6 w-6" style={{ color: 'var(--fg-3)' }} /></div>;
  }
  if (!settlement) {
    return (
      <div className="px-6 py-12 max-w-3xl mx-auto text-center">
        <p style={{ color: 'var(--fg-3)' }}>Settlement not found.</p>
        <Link href="/finance/settlements" className="inline-block mt-4 text-sm" style={{ color: 'var(--brand-schwarz)' }}>← Back to settlements</Link>
      </div>
    );
  }

  const status = STATUS_LABELS[settlement.status] || STATUS_LABELS.draft!;
  const Icon = status.icon;
  const debtor = settlement.clearance_debtor_company ?? settlement.outbound_company;
  const creditor = settlement.clearance_creditor_company ?? settlement.inbound_company;

  return (
    <div className="px-6 py-8 max-w-6xl mx-auto">
      <Link href="/finance/settlements" className="inline-flex items-center gap-2 text-sm mb-4" style={{ color: 'var(--fg-3)' }}>
        <ArrowLeft className="h-4 w-4" /> Settlements
      </Link>

      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <Triangle className="h-8 w-8" style={{ color: 'var(--brand-schwarz)' }} />
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.reference}</h1>
            <p className="text-sm mt-1" style={{ color: 'var(--fg-3)' }}>Settlement date: <strong>{formatDate(settlement.settlement_date)}</strong></p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-bold" style={{ background: status.bg, color: status.fg }}>
            <Icon className="h-4 w-4" /> {status.label}
          </span>
          {settlement.status !== 'cancelled' && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="px-3 py-1.5 rounded text-sm"
              style={{ background: 'var(--paper-raised)', color: '#A82029', border: '1px solid var(--border-1)', fontWeight: 500 }}
            >
              {cancelling ? 'Cancelling…' : 'Cancel settlement'}
            </button>
          )}
        </div>
      </div>

      {/* Triangle visualization */}
      <div style={{ background: 'var(--paper-raised)', borderRadius: '6px', padding: '24px', marginBottom: '24px' }}>
        <h2 className="text-base font-bold mb-4" style={{ color: 'var(--fg-1)' }}>Settlement triangle</h2>
        <svg viewBox="0 0 680 380" width="100%" style={{ maxHeight: '380px' }}>
          <defs>
            <marker id="arrow-detail" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </marker>
          </defs>

          {/* DEI / creditor box (top-left) */}
          <g>
            <rect x="80" y="50" width="180" height="60" rx="8" fill="rgba(46,125,79,0.10)" stroke="#2E7D4F" strokeWidth="0.5" />
            <text x="170" y="78" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="16" fontWeight="700" fill="#1F5A37">{creditor}</text>
            <text x="170" y="96" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fill="#2E7D4F">Creditor entity</text>
          </g>

          {/* DEE / debtor box (top-right) */}
          <g>
            <rect x="440" y="50" width="180" height="60" rx="8" fill="rgba(46,125,79,0.10)" stroke="#2E7D4F" strokeWidth="0.5" />
            <text x="530" y="78" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="16" fontWeight="700" fill="#1F5A37">{debtor}</text>
            <text x="530" y="96" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fill="#2E7D4F">Debtor entity</text>
          </g>

          {/* Inbound agent box (bottom-left) */}
          <g>
            <rect x="80" y="240" width="180" height="60" rx="8" fill="rgba(125,72,28,0.10)" stroke="#7D481C" strokeWidth="0.5" />
            <text x="170" y="268" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="14" fontWeight="700" fill="#52301A">{settlement.inbound_agent_name}</text>
            <text x="170" y="286" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fill="#7D481C">Paired agent</text>
          </g>

          {/* Outbound agent box (bottom-right) */}
          <g>
            <rect x="440" y="240" width="180" height="60" rx="8" fill="rgba(125,72,28,0.10)" stroke="#7D481C" strokeWidth="0.5" />
            <text x="530" y="268" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="14" fontWeight="700" fill="#52301A">{settlement.outbound_agent_name}</text>
            <text x="530" y="286" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fill="#7D481C">Paired agent</text>
          </g>

          {/* Arrow: Creditor → Debtor (goods debt) */}
          <line x1="262" y1="80" x2="436" y2="80" stroke="#1F5A37" strokeWidth="1.5" markerEnd="url(#arrow-detail)" />
          <text x="349" y="68" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fill="var(--fg-3)">Goods debt</text>
          {settlement.clearance_op_reference && (
            <text x="349" y="40" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fontWeight="700" fill="var(--fg-1)">{settlement.clearance_op_reference}</text>
          )}

          {/* Arrow: Debtor → Outbound agent (DEE pays) */}
          <line x1="530" y1="112" x2="530" y2="238" stroke="#888780" strokeWidth="1.5" markerEnd="url(#arrow-detail)" />
          <text x="544" y="170" textAnchor="start" fontFamily="Manrope, sans-serif" fontSize="12" fontWeight="700" fill="var(--fg-1)">{formatAmount(settlement.outbound_amount, settlement.outbound_currency)}</text>
          <text x="544" y="186" textAnchor="start" fontFamily="Manrope, sans-serif" fontSize="12" fill="var(--fg-3)">{formatDate(settlement.outbound_executed_at)}</text>

          {/* Arrow: Inbound agent → Creditor (Centuno pays DEI) */}
          <line x1="170" y1="238" x2="170" y2="112" stroke="#888780" strokeWidth="1.5" markerEnd="url(#arrow-detail)" />
          <text x="156" y="170" textAnchor="end" fontFamily="Manrope, sans-serif" fontSize="12" fontWeight="700" fill="var(--fg-1)">{formatAmount(settlement.inbound_amount, settlement.inbound_currency)}</text>
          <text x="156" y="186" textAnchor="end" fontFamily="Manrope, sans-serif" fontSize="12" fill="var(--fg-3)">{formatDate(settlement.inbound_executed_at)}</text>

          {/* Bottom dashed link (agent pair) */}
          <line x1="436" y1="270" x2="264" y2="270" stroke="#888780" strokeWidth="1" strokeDasharray="4 3" markerEnd="url(#arrow-detail)" markerStart="url(#arrow-detail)" />
          <text x="350" y="290" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fill="var(--fg-3)">Paired agents</text>

          {/* Center status block */}
          <text x="350" y="160" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="14" fontWeight="700" fill="var(--fg-1)">Net effect</text>
          <text x="350" y="178" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fill="var(--fg-3)">{debtor} → {creditor} debt</text>
          <text x="350" y="194" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fontWeight="700" fill={settlement.status === 'settled' ? '#2E7D4F' : '#7D481C'}>{settlement.status === 'settled' ? 'cleared' : 'pending'}</text>
          {settlement.variance_amount !== null && settlement.variance_amount !== undefined && (
            <text x="350" y="216" textAnchor="middle" fontFamily="Manrope, sans-serif" fontSize="12" fill={Math.abs(settlement.variance_amount) > 100 ? '#A82029' : 'var(--fg-3)'}>
              variance {formatAmount(settlement.variance_amount, settlement.variance_currency ?? 'USD')}
            </text>
          )}
        </svg>
      </div>

      {/* Detail cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        {/* Outbound leg */}
        <div style={{ background: 'var(--paper-raised)', borderRadius: '6px', padding: '20px' }}>
          <div className="flex items-center gap-2 mb-3">
            <ArrowUpRight className="h-5 w-5" style={{ color: '#A82029' }} />
            <h2 className="text-base font-bold" style={{ color: 'var(--fg-1)' }}>Outbound leg</h2>
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>From entity:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.outbound_company}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>To agent:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.outbound_agent_name}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Amount:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{formatAmount(settlement.outbound_amount, settlement.outbound_currency)}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Executed:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{formatDate(settlement.outbound_executed_at)}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Bank tx:</dt><dd className="font-bold text-xs" style={{ color: 'var(--fg-1)' }}>{settlement.outbound_bank_tx_id ? settlement.outbound_bank_tx_id.slice(0, 14) + '…' : <span style={{ color: '#7D481C' }}>not linked</span>}</dd></div>
          </dl>
          {settlement.outbound_purpose && (
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-1)' }}>
              <p className="text-xs" style={{ color: 'var(--fg-3)' }}>Payment purpose:</p>
              <p className="text-xs mt-1" style={{ color: 'var(--fg-1)' }}>{settlement.outbound_purpose}</p>
            </div>
          )}
        </div>

        {/* Inbound leg */}
        <div style={{ background: 'var(--paper-raised)', borderRadius: '6px', padding: '20px' }}>
          <div className="flex items-center gap-2 mb-3">
            <ArrowDownLeft className="h-5 w-5" style={{ color: '#2E7D4F' }} />
            <h2 className="text-base font-bold" style={{ color: 'var(--fg-1)' }}>Inbound leg</h2>
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>From agent:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.inbound_agent_name}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>To entity:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.inbound_company}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Amount:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{formatAmount(settlement.inbound_amount, settlement.inbound_currency)}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Executed:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{formatDate(settlement.inbound_executed_at)}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Bank tx:</dt><dd className="font-bold text-xs" style={{ color: 'var(--fg-1)' }}>{settlement.inbound_bank_tx_id ? settlement.inbound_bank_tx_id.slice(0, 14) + '…' : <span style={{ color: '#7D481C' }}>not linked</span>}</dd></div>
          </dl>
          {settlement.inbound_purpose && (
            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-1)' }}>
              <p className="text-xs" style={{ color: 'var(--fg-3)' }}>Payment purpose:</p>
              <p className="text-xs mt-1" style={{ color: 'var(--fg-1)' }}>{settlement.inbound_purpose}</p>
            </div>
          )}
        </div>
      </div>

      {/* Clearance + Variance */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div style={{ background: 'var(--paper-raised)', borderRadius: '6px', padding: '20px' }}>
          <div className="flex items-center gap-2 mb-3">
            <Building2 className="h-5 w-5" style={{ color: 'var(--fg-2)' }} />
            <h2 className="text-base font-bold" style={{ color: 'var(--fg-1)' }}>Clearance</h2>
          </div>
          {settlement.clearance_op_reference ? (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt style={{ color: 'var(--fg-3)' }}>Operation:</dt>
                <dd>
                  <Link href={`/operations/${settlement.clearance_operation_id}`} className="font-bold" style={{ color: 'var(--brand-schwarz)' }}>
                    {settlement.clearance_op_reference}
                  </Link>
                </dd>
              </div>
              <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Counterparty:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.clearance_op_partner_name ?? '—'}</dd></div>
              <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Op total:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.clearance_op_total ? formatAmount(settlement.clearance_op_total, settlement.clearance_op_currency ?? '') : '—'}</dd></div>
              <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Op status:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.clearance_op_status ?? '—'}</dd></div>
              <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Creditor:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.clearance_creditor_company ?? '—'}</dd></div>
              <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Debtor:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.clearance_debtor_company ?? '—'}</dd></div>
            </dl>
          ) : (
            <p className="text-sm" style={{ color: 'var(--fg-3)' }}>No clearance operation linked. This settlement is an advance payment with no specific invoice cleared.</p>
          )}
        </div>

        <div style={{ background: 'var(--paper-raised)', borderRadius: '6px', padding: '20px' }}>
          <div className="flex items-center gap-2 mb-3">
            <Triangle className="h-5 w-5" style={{ color: 'var(--fg-2)' }} />
            <h2 className="text-base font-bold" style={{ color: 'var(--fg-1)' }}>Reconciliation</h2>
          </div>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Exchange rate:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.exchange_rate ?? '—'}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Variance:</dt><dd className="font-bold" style={{ color: 'var(--fg-1)' }}>{settlement.variance_amount !== null && settlement.variance_amount !== undefined ? formatAmount(settlement.variance_amount, settlement.variance_currency ?? 'USD') : '—'}</dd></div>
            <div className="flex justify-between"><dt style={{ color: 'var(--fg-3)' }}>Paper invoice:</dt><dd className="font-bold text-xs" style={{ color: 'var(--fg-1)' }}>{settlement.paper_invoice_document_id ?? '—'}</dd></div>
          </dl>
        </div>
      </div>

      {settlement.notes && (
        <div style={{ background: 'var(--paper-raised)', borderRadius: '6px', padding: '20px', marginBottom: '24px' }}>
          <h2 className="text-base font-bold mb-2" style={{ color: 'var(--fg-1)' }}>Notes</h2>
          <p className="text-sm whitespace-pre-line" style={{ color: 'var(--fg-2)' }}>{settlement.notes}</p>
        </div>
      )}
    </div>
  );
}
