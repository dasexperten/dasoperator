'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { getPartner, createContract, type Partner, type AgreementType } from '@/lib/api';
import Breadcrumb from '@/components/layout/breadcrumb';
import { AGREEMENT_TYPE_LABELS, AGREEMENT_TYPE_ORDER, isLegalDocType } from '@/lib/agreement-types';

const ENTITIES = [
  { id: 'dee', label: 'DEE — Das Experten Eurasia' },
  { id: 'dei', label: 'DEI — Das Experten International' },
  { id: 'dasean', label: 'DEASEAN — Das Experten ASEAN' },
];

const CURRENCIES = ['USD', 'RUB', 'EUR', 'CNY', 'VND'];

export default function NewContractClient({ partnerSlug }: { partnerSlug: string }) {
  const router = useRouter();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contractNo, setContractNo] = useState('');
  const [agreementType, setAgreementType] = useState<AgreementType>('main');
  const [companyId, setCompanyId] = useState('dee');
  const [currency, setCurrency] = useState('USD');
  const [vatRate, setVatRate] = useState<0 | 5 | 20>(0);
  const [signedDate, setSignedDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [incoterms, setIncoterms] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('active');
  const [notes, setNotes] = useState('');
  // Russian currency-control field (УНК = Unique Contract Number, issued by RU bank on registration)
  // — separate from the paper contract number; shown when DEE is on either side
  // (DEE is the Russian resident; УНК is registered by VTB on the Russian leg of any
  // foreign-currency or cross-border contract, regardless of which side DEE plays)
  const [unkReference, setUnkReference] = useState('');
  const [unkValidUntil, setUnkValidUntil] = useState('');

  const isLegal = isLegalDocType(agreementType);
  const isRussianEntity = companyId === 'dee' || partner?.id === 'dee_partner';

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
      partner_id: partnerSlug,
      agreement_type: agreementType,
      our_company_id: companyId,
      currency,
      status,
      vat_rate: vatRate,
    };

    // contract_no is optional for legal docs (NDA/MOU/LOI/other) — backend
    // will auto-generate <TYPE>-<ENTITY>-<PARTNER>-<DATE> when blank.
    if (contractNo.trim()) body.contract_no = contractNo.trim();

    if (signedDate) body.signed_date = Math.floor(new Date(signedDate).getTime() / 1000);
    if (expiryDate) body.expiry_date = Math.floor(new Date(expiryDate).getTime() / 1000);
    if (incoterms.trim()) body.incoterms = incoterms.trim();
    if (notes.trim()) body.notes = notes.trim();
    // Russian currency-control fields — only submit when DEE
    if (isRussianEntity && unkReference.trim()) body.unk_reference = unkReference.trim();
    if (isRussianEntity && unkValidUntil) {
      body.unk_valid_until = Math.floor(new Date(unkValidUntil).getTime() / 1000);
    }

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

  // Legal docs may submit with blank contract_no (auto-generated server-side).
  const valid = (isLegal || contractNo.trim()) && companyId && currency;

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
          <label className="block mb-1" style={{ fontSize: '14px' }}>Type *</label>
          <select
            value={agreementType}
            onChange={(e) => setAgreementType(e.target.value as AgreementType)}
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}
          >
            {AGREEMENT_TYPE_ORDER.map((t) => (
              <option key={t} value={t}>{AGREEMENT_TYPE_LABELS[t]}</option>
            ))}
          </select>
          {isLegal && (
            <p className="mt-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
              For legal docs (NDA / MoU / LoI / Other), Contract Number can be left blank — it will be auto-generated from type, entity, partner abbreviation and date.
            </p>
          )}
        </div>

        <div>
          <label className="block mb-1" style={{ fontSize: '14px' }}>
            Contract Number {isLegal ? '' : '*'}
          </label>
          <input
            type="text" value={contractNo} onChange={(e) => setContractNo(e.target.value)}
            placeholder={isLegal ? 'Auto-generated if blank' : 'e.g. DEE-FRED-2026-01'}
            className="w-full px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

        {isRussianEntity && (
          <div
            className="p-4 space-y-3"
            style={{
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div
              style={{
                fontSize: '14px',
                fontWeight: 700,
                color: 'var(--fg-1)',
                letterSpacing: 0,
              }}
            >
              Russian currency control (УНК)
            </div>
            <p style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
              For DEE foreign-trade contracts placed on bank registration.
              Leave blank if not yet assigned.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block mb-1" style={{ fontSize: '14px' }}>УНК (Unique Contract Number — assigned by RU bank, e.g. 24080104/1927/0006/2/1)</label>
                <input
                  type="text"
                  value={unkReference}
                  onChange={(e) => setUnkReference(e.target.value)}
                  placeholder="25010001/1481/0001/2/1"
                  className="w-full px-3 py-2 text-sm focus:outline-none"
                  style={{
                    backgroundColor: 'var(--paper)',
                    border: '1px solid var(--border-hairline)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--fg-1)',
                    fontWeight: 700,
                  }}
                />
              </div>
              <div>
                <label className="block mb-1" style={{ fontSize: '14px' }}>Valid Until</label>
                <input
                  type="date"
                  value={unkValidUntil}
                  onChange={(e) => setUnkValidUntil(e.target.value)}
                  className="w-full px-3 py-2 text-sm focus:outline-none"
                  style={{
                    backgroundColor: 'var(--paper)',
                    border: '1px solid var(--border-hairline)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--fg-1)',
                    fontWeight: 700,
                  }}
                />
              </div>
            </div>
          </div>
        )}

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
