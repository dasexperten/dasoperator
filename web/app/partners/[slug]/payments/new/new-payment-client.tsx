'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import {
  getPartner, getPartnerContracts, getOperations,
  createPayment,
  type Partner, type Contract, type Operation
} from '@/lib/api';
import { formatMoney } from '@/lib/money';
import Breadcrumb from '@/components/layout/breadcrumb';

const CURRENCIES = ['USD', 'RUB', 'EUR', 'CNY', 'VND'];


export default function NewPaymentClient({ partnerSlug }: { partnerSlug: string }) {
  const router = useRouter();

  // Reference data
  const [partner, setPartner] = useState<Partner | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loadingRef, setLoadingRef] = useState(true);
  const [loadingOps, setLoadingOps] = useState(false);

  // Form state
  const [contractId, setContractId] = useState<string>('');
  const [operationId, setOperationId] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [useDifferentCurrency, setUseDifferentCurrency] = useState(false);
  const [currency, setCurrency] = useState<string>('USD');
  const [paymentDate, setPaymentDate] = useState<string>(new Date().toISOString().split('T')[0]!);
  const [type, setType] = useState<'advance' | 'final' | 'partial' | 'refund'>('partial');
  const [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming');
  const [notes, setNotes] = useState<string>('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load partner + contracts on mount
  useEffect(() => {
    const fetch = async () => {
      try {
        const [pRes, cRes] = await Promise.all([
          getPartner(partnerSlug),
          getPartnerContracts(partnerSlug),
        ]);
        if (pRes.success && pRes.result) setPartner(pRes.result);
        if (cRes.success && cRes.result) {
          setContracts(cRes.result.contracts.filter((c) => c.status === 'active'));
        }
      } finally {
        setLoadingRef(false);
      }
    };
    fetch();
  }, [partnerSlug]);

  // Load operations when contract chosen
  useEffect(() => {
    if (!contractId) {
      setOperations([]);
      setOperationId('');
      return;
    }
    const fetchOps = async () => {
      setLoadingOps(true);
      try {
        const res = await getOperations({ contract_id: contractId, compact: true });
        if (res.success && res.result) {
          setOperations(res.result.operations);
        }
      } finally {
        setLoadingOps(false);
      }
    };
    fetchOps();
  }, [contractId]);

  const selectedContract = useMemo(
    () => contracts.find((c) => c.id === contractId),
    [contracts, contractId]
  );

  // Auto-set currency to contract currency when contract selected
  useEffect(() => {
    if (selectedContract && !useDifferentCurrency) {
      setCurrency(selectedContract.currency);
    }
  }, [selectedContract, useDifferentCurrency]);

  const effectiveCurrency = useDifferentCurrency ? currency : (selectedContract?.currency ?? 'USD');

  async function handleSubmit() {
    setError(null);

    if (!contractId) { setError('Contract required'); return; }
    if (!amount || parseFloat(amount) <= 0) { setError('Amount must be positive'); return; }

    setSubmitting(true);

    const body = {
      partner_id: partnerSlug,
      contract_id: contractId,
      operation_id: operationId || undefined,
      amount: parseFloat(amount),
      currency: effectiveCurrency,
      payment_date: Math.floor(new Date(paymentDate).getTime() / 1000),
      type,
      direction,
      notes: notes.trim() || undefined,
    };

    try {
      const res = await createPayment(body);
      if (res.success) {
        router.push(`/partners/${partnerSlug}`);
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to create payment');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = contractId && amount && parseFloat(amount) > 0;

  if (loadingRef) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Breadcrumb items={[
        { label: 'Partners', href: '/partners' },
        { label: partner?.trade_name ?? partnerSlug, href: `/partners/${partnerSlug}` },
        { label: 'New Payment' },
      ]} />

      <div>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'var(--fs-display-md)',
          fontWeight: 900,
          
          color: 'var(--fg-1)',
        }}>
          New Payment
        </h1>
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          For partner: <strong>{partner?.trade_name ?? partnerSlug}</strong>
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      {/* Section 1: Contract */}
      <Section label="Contract">
        <div>
          <Label>Select contract *</Label>
          {contracts.length === 0 ? (
            <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--status-warning)' }}>
              No active contracts for this partner. Create a contract first.
            </p>
          ) : (
            <select value={contractId} onChange={(e) => setContractId(e.target.value)}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
              <option value="">— Choose contract —</option>
              {contracts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.contract_no} ({c.entity_abbreviation} · {c.currency})
                </option>
              ))}
            </select>
          )}
        </div>
      </Section>

      {/* Section 2: Operation (optional) */}
      <Section label="Operation (optional)" disabled={!contractId}>
        <div>
          <Label>Link to operation</Label>
          {loadingOps ? (
            <div className="text-sm flex items-center gap-2" style={{ color: 'var(--fg-3)' }}>
              <Loader2 className="h-4 w-4 animate-spin" /> Loading operations...
            </div>
          ) : operations.length === 0 && contractId ? (
            <p style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>
              No operations under this contract. Leaving empty creates an advance payment.
            </p>
          ) : (
            <select value={operationId} onChange={(e) => setOperationId(e.target.value)} disabled={!contractId}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
              <option value="">— None (advance payment) —</option>
              {operations.map((op) => (
                <option key={op.id} value={op.id}>
                  {op.reference ?? op.id} — {op.operation_type} — {formatMoney(op.total_amount, op.currency)} {op.currency}
                </option>
              ))}
            </select>
          )}
          <p className="mt-2" style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>
            Empty = advance payment (не привязан к operation)
          </p>
        </div>
      </Section>

      {/* Section 3: Payment Details */}
      <Section label="Payment Details" disabled={!contractId}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>Amount *</Label>
            <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} disabled={!contractId} placeholder="0.00"
              className="w-full px-3 py-2 text-sm focus:outline-none text-right"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
          </div>
          <div>
            <Label>Currency</Label>
            <div className="flex items-center gap-2">
              <select value={effectiveCurrency} onChange={(e) => setCurrency(e.target.value)} disabled={!contractId || !useDifferentCurrency}
                className="flex-1 px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: 'var(--paper-sunk)',
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--fg-1)',
                  opacity: !useDifferentCurrency ? 0.7 : 1,
                }}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 mt-2" style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-2)' }}>
              <input type="checkbox" checked={useDifferentCurrency} onChange={(e) => setUseDifferentCurrency(e.target.checked)} disabled={!contractId} />
              Use different currency than contract
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>
            <Label>Payment Date *</Label>
            <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} disabled={!contractId}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
          </div>
          <div>
            <Label>Direction *</Label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as 'incoming' | 'outgoing')} disabled={!contractId}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
              <option value="incoming">Incoming (partner paid us)</option>
              <option value="outgoing">Outgoing (we paid partner)</option>
            </select>
          </div>
        </div>

        <div className="mt-4">
          <Label>Type</Label>
          <select value={type} onChange={(e) => setType(e.target.value as 'advance' | 'final' | 'partial' | 'refund')} disabled={!contractId}
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
            <option value="advance">Advance — prepayment before operation</option>
            <option value="partial">Partial — partial payment of operation</option>
            <option value="final">Final — closing payment of operation</option>
            <option value="refund">Refund — money returned</option>
          </select>
        </div>

        <div className="mt-4">
          <Label>Notes</Label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!contractId} rows={2} placeholder="Optional"
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
        </div>
      </Section>

      {error && (
        <div className="p-3 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button onClick={() => router.back()}
          className="px-4 py-2"
          style={{ border: '1px solid var(--border-hairline)', backgroundColor: 'transparent', borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
          Cancel
        </button>
        <button onClick={handleSubmit} disabled={!canSubmit || submitting}
          className="px-4 py-2 inline-flex items-center gap-2"
          style={{
            backgroundColor: 'var(--brand-rot)', color: 'var(--paper)',
            borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-body-sm)', fontWeight: 600,
            opacity: (!canSubmit || submitting) ? 0.5 : 1,
            cursor: (!canSubmit || submitting) ? 'not-allowed' : 'pointer',
          }}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Record Payment
        </button>
      </div>
    </div>
  );
}

function Section({ label, children, disabled = false }: { label: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', opacity: disabled ? 0.5 : 1 }}>
      <h2 style={{
        fontFamily: 'var(--font-accent-jakarta)',
        fontSize: '24px',
        fontWeight: 800,
        
        textTransform: 'uppercase',
        color: 'var(--fg-1)',
        lineHeight: 1,
        marginBottom: '20px',
      }}>
        {label}
      </h2>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block mb-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
      {children}
    </label>
  );
}
