'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getContract, getPartner, type Contract, type Partner } from '@/lib/api';
import { CopyableValue, SectionCard } from '@/components/ui/copyable';
import Breadcrumb from '@/components/layout/breadcrumb';

const STATUS_COLORS: Record<Contract['status'], { bg: string; fg: string; border: string }> = {
  active:    { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  draft:     { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  expired:   { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
  cancelled: { bg: 'rgba(229,32,44,0.08)',  fg: 'var(--brand-rot)',      border: 'rgba(229,32,44,0.3)' },
};

function formatDate(unix?: number | null): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

export default function ContractDetailClient({ partnerSlug, contractId }: { partnerSlug: string; contractId: string }) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [cRes, pRes] = await Promise.all([
          getContract(contractId),
          getPartner(partnerSlug),
        ]);
        if (cRes.success && cRes.result) setContract(cRes.result);
        else setError(cRes.errors[0]?.message ?? 'Contract not found');
        if (pRes.success && pRes.result) setPartner(pRes.result);
      } catch (e) { setError(e instanceof Error ? e.message : 'Network error'); }
      finally { setLoading(false); }
    };
    fetchData();
  }, [contractId, partnerSlug]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;

  if (error || !contract) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Breadcrumb items={[
          { label: 'Partners', href: '/partners' },
          { label: partner?.trade_name ?? partnerSlug, href: `/partners/${partnerSlug}` },
          { label: 'Contract not found' },
        ]} />
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error ?? 'Contract not found'}
        </div>
      </div>
    );
  }

  const statusStyle = STATUS_COLORS[contract.status];
  const partyFields = [
    { label: 'Our Entity', value: contract.entity_abbreviation },
    { label: 'Partner', value: contract.partner_trade_name },
    { label: 'Currency', value: contract.currency },
  ];
  const termsFields = [
    { label: 'Signed', value: formatDate(contract.signed_date) },
    { label: 'Expires', value: formatDate(contract.expiry_date) },
    { label: 'Incoterms', value: contract.incoterms },
  ];

  return (
    <div className="space-y-8 max-w-4xl">
      <Breadcrumb items={[
        { label: 'Partners', href: '/partners' },
        { label: partner?.trade_name ?? partnerSlug, href: `/partners/${partnerSlug}` },
        { label: contract.contract_no },
      ]} />

      <div>
        <div className="flex items-center gap-3 mb-3">
          <span style={{ fontSize: '14px', padding: '3px 8px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--fg-2)' }}>{contract.id}</span>
          <span className="inline-block" style={{ padding: '3px 8px', fontSize: '14px', backgroundColor: statusStyle.bg, color: statusStyle.fg, border: `1px solid ${statusStyle.border}`, borderRadius: 'var(--radius-pill)' }}>{contract.status}</span>
        </div>
        <h1 style={{ fontSize: '36px', color: 'var(--fg-1)', lineHeight: 1.1 }}>{contract.contract_no}</h1>
        <p className="mt-3" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          {contract.entity_abbreviation} ↔ {contract.partner_trade_name} <span>({contract.currency})</span>
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="grid grid-cols-2 gap-5">
        <SectionCard label="Parties" fields={partyFields}>
          <CopyableField label="Our Entity" value={contract.entity_abbreviation} mono />
          <CopyableField label="Partner" value={contract.partner_trade_name} />
          <CopyableField label="Currency" value={contract.currency} mono />
        </SectionCard>
        <SectionCard label="Dates & Terms" fields={termsFields}>
          <CopyableField label="Signed" value={formatDate(contract.signed_date)} mono />
          <CopyableField label="Expires" value={formatDate(contract.expiry_date)} mono />
          <CopyableField label="Incoterms" value={contract.incoterms ?? '—'} />
        </SectionCard>
      </div>

      {contract.notes && (
        <div className="p-4" style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <div className="mb-2" style={{ fontSize: '14px' }}>Notes</div>
          <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>{contract.notes}</p>
        </div>
      )}
    </div>
  );
}

function CopyableField({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  const missing = !value || value === 'MISSING' || value === '—' || value.trim() === '';
  return (
    <div>
      <dt className="mb-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{label}</dt>
      <dd>
        {missing ? <span style={{ fontSize: mono ? '12px' : 'var(--fs-body-sm)', color: 'var(--fg-3)' }}>—</span>
                 : <CopyableValue value={value!} mono={mono} style={{ fontSize: mono ? '12px' : 'var(--fs-body-sm)', color: 'var(--fg-1)' }} />}
      </dd>
    </div>
  );
}
