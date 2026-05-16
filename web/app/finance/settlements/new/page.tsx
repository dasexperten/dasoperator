'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, ArrowLeft, Triangle, Check, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import {
  createAgentSettlement,
  getAvailableAgentBankTxs,
  type AvailableAgentBankTx,
} from '@/lib/api';

function formatAmount(amount: number, currency: string): string {
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;
}
function formatDate(unix: number): string {
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

const COMPANIES = [
  { id: 'dee',    label: 'DEE' },
  { id: 'dei',    label: 'DEI' },
  { id: 'dasean', label: 'DASEAN' },
  { id: 'dec',    label: 'DEC' },
];

const AGENTS = [
  { id: 'bright_ideas', label: 'Bright Ideas Trading' },
  { id: 'centuno',      label: 'Centuno Co., Ltd.' },
];

export default function NewSettlementPage() {
  const router = useRouter();
  const [outbound, setOutbound] = useState<AvailableAgentBankTx[]>([]);
  const [inbound, setInbound] = useState<AvailableAgentBankTx[]>([]);
  const [loadingTxs, setLoadingTxs] = useState(true);

  const [selectedOutbound, setSelectedOutbound] = useState<AvailableAgentBankTx | null>(null);
  const [selectedInbound,  setSelectedInbound]  = useState<AvailableAgentBankTx | null>(null);

  const [outboundAgent, setOutboundAgent] = useState('bright_ideas');
  const [inboundAgent,  setInboundAgent]  = useState('centuno');
  const [outboundCompany, setOutboundCompany] = useState('dee');
  const [inboundCompany,  setInboundCompany]  = useState('dei');

  const [settlementDate, setSettlementDate] = useState(new Date().toISOString().slice(0, 10));
  const [clearanceOpRef, setClearanceOpRef] = useState('');
  const [exchangeRate, setExchangeRate] = useState('');
  const [varianceAmount, setVarianceAmount] = useState('');
  const [varianceCurrency, setVarianceCurrency] = useState('USD');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoadingTxs(true);
      try {
        const [o, i] = await Promise.all([
          getAvailableAgentBankTxs('outgoing'),
          getAvailableAgentBankTxs('incoming'),
        ]);
        if (o.success && o.result) setOutbound(o.result.transactions);
        if (i.success && i.result) setInbound(i.result.transactions);
      } finally { setLoadingTxs(false); }
    })();
  }, []);

  // When selecting an outbound tx, auto-fill company + agent (best guess)
  useEffect(() => {
    if (selectedOutbound) {
      setOutboundCompany(selectedOutbound.company_id);
      const n = (selectedOutbound.contragent_name ?? '').toUpperCase();
      if (n.includes('BRIGHT')) setOutboundAgent('bright_ideas');
      else if (n.includes('CENTUNO')) setOutboundAgent('centuno');
    }
  }, [selectedOutbound]);
  useEffect(() => {
    if (selectedInbound) {
      setInboundCompany(selectedInbound.company_id);
      const n = (selectedInbound.contragent_name ?? '').toUpperCase();
      if (n.includes('CENTUNO')) setInboundAgent('centuno');
      else if (n.includes('BRIGHT')) setInboundAgent('bright_ideas');
    }
  }, [selectedInbound]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const outAmount = selectedOutbound?.amount ?? 0;
    const inAmount  = selectedInbound?.amount  ?? 0;
    const outCcy    = selectedOutbound?.currency ?? '';
    const inCcy     = selectedInbound?.currency  ?? '';

    if (!selectedOutbound && !selectedInbound) {
      setError('Pick at least one bank transaction leg');
      return;
    }
    if ((!outAmount && selectedOutbound) || (!inAmount && selectedInbound)) {
      setError('Selected transactions must have valid amounts');
      return;
    }
    if (!outCcy && !inCcy) {
      setError('Currency required on at least one leg');
      return;
    }

    setSubmitting(true);
    try {
      const body: Parameters<typeof createAgentSettlement>[0] = {
        outbound_bank_tx_id: selectedOutbound?.id ?? null,
        inbound_bank_tx_id:  selectedInbound?.id  ?? null,
        outbound_company_id: outboundCompany,
        inbound_company_id:  inboundCompany,
        outbound_agent_partner_id: outboundAgent,
        inbound_agent_partner_id:  inboundAgent,
        outbound_amount: outAmount,
        outbound_currency: outCcy || 'CNY',
        inbound_amount: inAmount,
        inbound_currency: inCcy || 'USD',
        settlement_date: settlementDate,
        exchange_rate: exchangeRate ? parseFloat(exchangeRate) : null,
        variance_amount: varianceAmount ? parseFloat(varianceAmount) : null,
        variance_currency: varianceAmount ? varianceCurrency : null,
        clearance_operation_id: null, // user can wire later via PATCH
        notes: notes || null,
      };
      const res = await createAgentSettlement(body);
      if (res.success && res.result?.id) {
        router.push(`/finance/settlements/${res.result.id}`);
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to create');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="px-6 py-8 max-w-6xl mx-auto">
      <Link href="/finance/settlements" className="inline-flex items-center gap-2 text-sm mb-4" style={{ color: 'var(--fg-3)' }}>
        <ArrowLeft className="h-4 w-4" /> Settlements
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <Triangle className="h-7 w-7" style={{ color: 'var(--brand-schwarz)' }} />
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--fg-1)' }}>New agent settlement</h1>
          <p className="text-sm" style={{ color: 'var(--fg-3)' }}>Pick one outbound leg (own entity pays agent) and one inbound leg (paired agent pays own entity).</p>
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* Outbound picker */}
          <section style={{ background: 'var(--paper-raised)', borderRadius: '6px', padding: '20px' }}>
            <div className="flex items-center gap-2 mb-3">
              <ArrowUpRight className="h-5 w-5" style={{ color: '#A82029' }} />
              <h2 className="text-base font-bold" style={{ color: 'var(--fg-1)' }}>Outbound leg</h2>
              <span className="text-xs ml-auto" style={{ color: 'var(--fg-3)' }}>own entity → agent</span>
            </div>

            {loadingTxs ? (
              <Loader2 className="animate-spin h-5 w-5" style={{ color: 'var(--fg-3)' }} />
            ) : outbound.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--fg-3)' }}>No unsettled outgoing agent payments found.</p>
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {outbound.map((t) => {
                  const sel = selectedOutbound?.id === t.id;
                  return (
                    <button
                      type="button"
                      key={t.id}
                      onClick={() => setSelectedOutbound(sel ? null : t)}
                      className="w-full text-left p-2 rounded text-sm"
                      style={{
                        background: sel ? 'rgba(46,125,79,0.10)' : 'var(--paper-sunk)',
                        border: sel ? '1px solid #2E7D4F' : '1px solid transparent',
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold" style={{ color: 'var(--fg-1)' }}>{formatAmount(t.amount, t.currency)}</span>
                        <span className="font-bold text-xs" style={{ color: 'var(--fg-3)' }}>{formatDate(t.executed_at)}</span>
                      </div>
                      <div className="text-xs" style={{ color: 'var(--fg-3)' }}>{t.company_abbr} → {t.contragent_name}</div>
                      {sel && <Check className="inline h-3 w-3 mt-1" style={{ color: '#2E7D4F' }} />}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-3 pt-3 grid grid-cols-2 gap-2" style={{ borderTop: '1px solid var(--border-1)' }}>
              <label className="text-xs" style={{ color: 'var(--fg-3)' }}>
                From entity
                <select value={outboundCompany} onChange={(e) => setOutboundCompany(e.target.value)} className="w-full mt-1 px-2 py-1 rounded text-sm font-bold" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-1)' }}>
                  {COMPANIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
              <label className="text-xs" style={{ color: 'var(--fg-3)' }}>
                Agent partner
                <select value={outboundAgent} onChange={(e) => setOutboundAgent(e.target.value)} className="w-full mt-1 px-2 py-1 rounded text-sm font-bold" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-1)' }}>
                  {AGENTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </label>
            </div>
          </section>

          {/* Inbound picker */}
          <section style={{ background: 'var(--paper-raised)', borderRadius: '6px', padding: '20px' }}>
            <div className="flex items-center gap-2 mb-3">
              <ArrowDownLeft className="h-5 w-5" style={{ color: '#2E7D4F' }} />
              <h2 className="text-base font-bold" style={{ color: 'var(--fg-1)' }}>Inbound leg</h2>
              <span className="text-xs ml-auto" style={{ color: 'var(--fg-3)' }}>agent → own entity</span>
            </div>

            {loadingTxs ? (
              <Loader2 className="animate-spin h-5 w-5" style={{ color: 'var(--fg-3)' }} />
            ) : inbound.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--fg-3)' }}>No unsettled incoming agent receipts found.</p>
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {inbound.map((t) => {
                  const sel = selectedInbound?.id === t.id;
                  return (
                    <button
                      type="button"
                      key={t.id}
                      onClick={() => setSelectedInbound(sel ? null : t)}
                      className="w-full text-left p-2 rounded text-sm"
                      style={{
                        background: sel ? 'rgba(46,125,79,0.10)' : 'var(--paper-sunk)',
                        border: sel ? '1px solid #2E7D4F' : '1px solid transparent',
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold" style={{ color: 'var(--fg-1)' }}>{formatAmount(t.amount, t.currency)}</span>
                        <span className="font-bold text-xs" style={{ color: 'var(--fg-3)' }}>{formatDate(t.executed_at)}</span>
                      </div>
                      <div className="text-xs" style={{ color: 'var(--fg-3)' }}>{t.contragent_name} → {t.company_abbr}</div>
                      {sel && <Check className="inline h-3 w-3 mt-1" style={{ color: '#2E7D4F' }} />}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="mt-3 pt-3 grid grid-cols-2 gap-2" style={{ borderTop: '1px solid var(--border-1)' }}>
              <label className="text-xs" style={{ color: 'var(--fg-3)' }}>
                To entity
                <select value={inboundCompany} onChange={(e) => setInboundCompany(e.target.value)} className="w-full mt-1 px-2 py-1 rounded text-sm font-bold" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-1)' }}>
                  {COMPANIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
              <label className="text-xs" style={{ color: 'var(--fg-3)' }}>
                Agent partner
                <select value={inboundAgent} onChange={(e) => setInboundAgent(e.target.value)} className="w-full mt-1 px-2 py-1 rounded text-sm font-bold" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-1)' }}>
                  {AGENTS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </label>
            </div>
          </section>
        </div>

        {/* Meta fields */}
        <section style={{ background: 'var(--paper-raised)', borderRadius: '6px', padding: '20px', marginBottom: '24px' }}>
          <h2 className="text-base font-bold mb-3" style={{ color: 'var(--fg-1)' }}>Settlement details</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <label className="text-xs" style={{ color: 'var(--fg-3)' }}>
              Settlement date
              <input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} className="w-full mt-1 px-2 py-1 rounded text-sm font-bold" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-1)' }} />
            </label>
            <label className="text-xs" style={{ color: 'var(--fg-3)' }}>
              Exchange rate (CNY/USD)
              <input type="number" step="0.0001" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} placeholder="e.g. 7.20" className="w-full mt-1 px-2 py-1 rounded text-sm font-bold" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-1)' }} />
            </label>
            <label className="text-xs" style={{ color: 'var(--fg-3)' }}>
              Variance (signed)
              <div className="flex gap-1 mt-1">
                <input type="number" step="0.01" value={varianceAmount} onChange={(e) => setVarianceAmount(e.target.value)} placeholder="0.00" className="flex-1 px-2 py-1 rounded text-sm font-bold" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-1)' }} />
                <select value={varianceCurrency} onChange={(e) => setVarianceCurrency(e.target.value)} className="px-2 py-1 rounded text-sm font-bold" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-1)' }}>
                  <option>USD</option><option>CNY</option><option>EUR</option><option>RUB</option>
                </select>
              </div>
            </label>
          </div>
          <label className="block mt-3 text-xs" style={{ color: 'var(--fg-3)' }}>
            Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Reason, link to fake invoice, etc." className="w-full mt-1 px-2 py-2 rounded text-sm" style={{ background: 'var(--paper-sunk)', border: '1px solid var(--border-1)', color: 'var(--fg-1)' }} />
          </label>
        </section>

        {error && (
          <div className="mb-4 px-4 py-3 rounded text-sm" style={{ background: 'rgba(229,32,44,0.10)', color: '#A82029', fontWeight: 500 }}>
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Link href="/finance/settlements" className="px-4 py-2 rounded text-sm" style={{ background: 'var(--paper-raised)', color: 'var(--fg-2)', border: '1px solid var(--border-1)', fontWeight: 500 }}>
            Cancel
          </Link>
          <button type="submit" disabled={submitting} className="px-4 py-2 rounded text-sm font-bold inline-flex items-center gap-2" style={{ background: 'var(--brand-schwarz)', color: 'var(--paper-raised)' }}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Create settlement
          </button>
        </div>
      </form>
    </div>
  );
}
