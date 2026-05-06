'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { getPartner, createContract, type Partner } from '@/lib/api';
import Breadcrumb from '@/components/layout/breadcrumb';

const ENTITIES = [
  { id: 'cmp_dee', label: 'DEE — Das Experten Eurasia' },
  { id: 'cmp_dei', label: 'DEI — Das Experten International' },
  { id: 'cmp_dasean', label: 'DEASEAN — Das Experten ASEAN' },
  { id: 'cmp_dec', label: 'DEC — Das Experten China' },
];

const CURRENCIES = ['USD', 'RUB', 'EUR', 'CNY', 'VND'];


// SPA-fallback URL resolvers — when route matches __fallback static page,
// derive the real id from window.location at runtime.
function resolve_partnerSlug(propValue: string): string {
  if (typeof window !== 'undefined') {
    const m = window.location.pathname.match(/^\/partners\/([^\/]+)/);
    if (m && m[1] && m[1] !== '__fallback') {
      return decodeURIComponent(m[1]);
    }
  }
  return propValue;
}

export default function NewContractClient({ partnerSlug: _partnerSlug }: { partnerSlug: string }) {
  const [partnerSlug, set_partnerSlug] = useState(_partnerSlug);
  useEffect(() => { set_partnerSlug(resolve_partnerSlug(_partnerSlug)); }, [_partnerSlug]);
  const router = useRouter();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contractNo, setContractNo] = useState('');
  const [companyId, setCompanyId] = useState('cmp_dee');
  const [currency, setCurrency] = useState('USD');
  const [vatRate, setVatRate] = useState<0 | 5 | 20>(0);
  const [signedDate, setSignedDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [incoterms, setIncoterms] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('active');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    const fetch = async () => {
      const res = await getPartner(partnerSlug);
      if (res.success && res.result) setPartner(res.result);
    };
    fetch();
  }, [partnerSlug]);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);

    const body: Parameters<typeof createContract>[0] = {
      contract_no: contractNo.trim(),
      partner_id: partnerSlug,
      our_company_id: companyId,
      currency,
      status,
      vat_rate: vatRate,
    };

    if (signedDate) body.signed_date = Math.floor(new Date(signedDate).getTime() / 1000);
    if (expiryDate) body.expiry_date = Math.floor(new Date(expiryDate).getTime() / 1000);
    if (incoterms.trim()) body.incoterms = incoterms.trim();
    if (notes.trim()) body.notes = notes.trim();

    try {
      const res = await createContract(body);
      if (res.success && res.result) {
        router.push(`/partners/${partnerSlug}/contracts/${res.result.id}`);
      } else {
        setError(res.errors[0]?.message ?? 'Failed to create');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const valid = contractNo.trim() && companyId && currency;

  return (
    <div className="space-y-6 max-w-3xl">
      <Breadcrumb items={[
        { label: 'Partners', href: '/partners' },
        { label: partner?.trade_name ?? partnerSlug, href: `/partners/${partnerSlug}` },
        { label: 'New Contract' },
      ]} />

      <div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-md)',
            fontWeight: 900,
            
            color: 'var(--fg-1)',
          }}
        >
          New Contract
        </h1>
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          For partner: <strong>{partner?.trade_name ?? partnerSlug}</strong>
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="bg-card p-6 space-y-4" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
        <div>
          <label className="block mb-1" style={{ fontSize: '14px' }}>Contract Number *</label>
          <input
            type="text" value={contractNo} onChange={(e) => setContractNo(e.target.value)}
            placeholder="e.g. DEE-FRED-2026-01"
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block mb-1" style={{ fontSize: '14px' }}>Our Entity *</label>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
              {ENTITIES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block mb-1" style={{ fontSize: '14px' }}>Currency *</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block mb-1" style={{ fontSize: '14px' }}>VAT Rate</label>
            <select value={vatRate} onChange={(e) => setVatRate(Number(e.target.value) as 0 | 5 | 20)}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
              <option value={0}>None</option>
              <option value={5}>5%</option>
              <option value={20}>20%</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block mb-1" style={{ fontSize: '14px' }}>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as 'draft' | 'active')}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
            </select>
          </div>
          <div>
            <label className="block mb-1" style={{ fontSize: '14px' }}>Incoterms</label>
            <input type="text" value={incoterms} onChange={(e) => setIncoterms(e.target.value)} placeholder="FCA Saransk"
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block mb-1" style={{ fontSize: '14px' }}>Signed Date</label>
            <input type="date" value={signedDate} onChange={(e) => setSignedDate(e.target.value)}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
          </div>
          <div>
            <label className="block mb-1" style={{ fontSize: '14px' }}>Expiry Date</label>
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)}
              className="w-full px-3 py-2 text-sm focus:outline-none"
              style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
          </div>
        </div>

        <div>
          <label className="block mb-1" style={{ fontSize: '14px' }}>Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Optional..."
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
        </div>

        {error && (
          <div className="p-3 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button onClick={() => router.back()}
            className="px-4 py-2 transition-colors"
            style={{ border: '1px solid var(--border-hairline)', backgroundColor: 'transparent', borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!valid || submitting}
            className="px-4 py-2 inline-flex items-center gap-2 transition-colors"
            style={{
              backgroundColor: 'var(--brand-rot)',
              color: 'var(--paper)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--fs-body-sm)',
              fontWeight: 600,
              opacity: !valid || submitting ? 0.5 : 1,
              cursor: !valid || submitting ? 'not-allowed' : 'pointer',
            }}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Create Contract
          </button>
        </div>
      </div>
    </div>
  );
}
