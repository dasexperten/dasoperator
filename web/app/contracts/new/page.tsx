'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import { getPartners, createContract, type Partner } from '@/lib/api';

const ENTITIES = [
  { id: 'cmp_dee', label: 'DEE — Das Experten Eurasia' },
  { id: 'cmp_dei', label: 'DEI — Das Experten International' },
  { id: 'cmp_dasean', label: 'DEASEAN — Das Experten ASEAN' },
  { id: 'cmp_dec', label: 'DEC — Das Experten China' },
];

const CURRENCIES = ['USD', 'RUB', 'EUR', 'CNY', 'VND'];

export default function NewContractPage() {
  const router = useRouter();
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loadingPartners, setLoadingPartners] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contractNo, setContractNo] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [companyId, setCompanyId] = useState('cmp_dee');
  const [currency, setCurrency] = useState('USD');
  const [signedDate, setSignedDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [incoterms, setIncoterms] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('active');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    const fetchPartners = async () => {
      const res = await getPartners();
      if (res.success && res.result) {
        setPartners(res.result.partners);
        if (res.result.partners.length > 0) {
          setPartnerId(res.result.partners[0]!.id);
        }
      }
      setLoadingPartners(false);
    };
    fetchPartners();
  }, []);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);

    const body: Parameters<typeof createContract>[0] = {
      contract_no: contractNo.trim(),
      partner_id: partnerId,
      our_company_id: companyId,
      currency,
      status,
    };

    if (signedDate) body.signed_date = Math.floor(new Date(signedDate).getTime() / 1000);
    if (expiryDate) body.expiry_date = Math.floor(new Date(expiryDate).getTime() / 1000);
    if (incoterms.trim()) body.incoterms = incoterms.trim();
    if (notes.trim()) body.notes = notes.trim();

    try {
      const res = await createContract(body);
      if (res.success && res.result) {
        // Redirect to /contracts (list page) — newly-created contracts have no
        // detail page yet because Static Export only renders pre-known IDs.
        // The new contract appears in the list immediately.
        router.push('/contracts');
      } else {
        setError(res.errors[0]?.message ?? 'Failed to create');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const valid = contractNo.trim() && partnerId && companyId && currency;

  return (
    <div className="space-y-6 max-w-3xl">
      <Link href="/contracts" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ArrowLeft className="h-4 w-4" />Back to Contracts
      </Link>

      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FileText className="h-6 w-6" />New Contract
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Each contract links one partner to one of our entities with a fixed currency.
        </p>
      </div>

      <div className="bg-card border border-border rounded-lg p-6 space-y-4">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Contract Number *</label>
          <input
            type="text"
            value={contractNo}
            onChange={(e) => setContractNo(e.target.value)}
            placeholder="e.g. DEE-TW-2026-01"
            className="w-full px-3 py-2 bg-muted border border-border rounded text-sm focus:outline-none focus:border-accent font-mono"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Our Entity *</label>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}
              className="w-full px-3 py-2 bg-muted border border-border rounded text-sm focus:outline-none focus:border-accent">
              {ENTITIES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Partner *</label>
            {loadingPartners ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">Loading...</div>
            ) : (
              <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}
                className="w-full px-3 py-2 bg-muted border border-border rounded text-sm focus:outline-none focus:border-accent">
                {partners.map((p) => <option key={p.id} value={p.id}>{p.trade_name}</option>)}
              </select>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Currency *</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-3 py-2 bg-muted border border-border rounded text-sm focus:outline-none focus:border-accent font-mono">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as 'draft' | 'active')}
              className="w-full px-3 py-2 bg-muted border border-border rounded text-sm focus:outline-none focus:border-accent">
              <option value="active">Active</option>
              <option value="draft">Draft</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-muted-foreground mb-1">Incoterms</label>
            <input type="text" value={incoterms} onChange={(e) => setIncoterms(e.target.value)}
              placeholder="FCA Saransk"
              className="w-full px-3 py-2 bg-muted border border-border rounded text-sm focus:outline-none focus:border-accent" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Signed Date</label>
            <input type="date" value={signedDate} onChange={(e) => setSignedDate(e.target.value)}
              className="w-full px-3 py-2 bg-muted border border-border rounded text-sm focus:outline-none focus:border-accent" />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Expiry Date</label>
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)}
              className="w-full px-3 py-2 bg-muted border border-border rounded text-sm focus:outline-none focus:border-accent" />
          </div>
        </div>

        <div>
          <label className="block text-xs text-muted-foreground mb-1">Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
            rows={3} placeholder="Optional notes..."
            className="w-full px-3 py-2 bg-muted border border-border rounded text-sm focus:outline-none focus:border-accent" />
        </div>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded p-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Link href="/contracts"
            className="px-4 py-2 border border-border rounded text-sm hover:bg-muted transition">
            Cancel
          </Link>
          <button onClick={handleSubmit} disabled={!valid || submitting}
            className="bg-accent text-accent-foreground px-4 py-2 rounded text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Create Contract
          </button>
        </div>
      </div>
    </div>
  );
}
