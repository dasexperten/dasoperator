'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { getContract, type Contract } from '@/lib/api';

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

export default function ContractDetailClient({ contractId }: { contractId: string }) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await getContract(contractId);
        if (res.success && res.result) { setContract(res.result); setError(null); }
        else { setError(res.errors[0]?.message ?? 'Contract not found'); }
      } catch (e) { setError(e instanceof Error ? e.message : 'Network error'); }
      finally { setLoading(false); }
    };
    fetchData();
  }, [contractId]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;

  if (error || !contract) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href="/contracts" className="text-sm inline-flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
          <ArrowLeft className="h-4 w-4" />Back to Contracts
        </Link>
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>{error ?? 'Contract not found'}</div>
      </div>
    );
  }

  const statusStyle = STATUS_COLORS[contract.status];

  return (
    <div className="space-y-8 max-w-4xl">
      <Link href="/contracts" className="text-sm inline-flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
        <ArrowLeft className="h-4 w-4" />Back to Contracts
      </Link>

      <div>
        <div className="flex items-center gap-3 mb-3">
          <span className="dx-mono" style={{ fontSize: '11px', padding: '3px 8px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--fg-2)' }}>{contract.id}</span>
          <span className="dx-eyebrow inline-block" style={{ padding: '3px 8px', fontSize: '9px', backgroundColor: statusStyle.bg, color: statusStyle.fg, border: `1px solid ${statusStyle.border}`, borderRadius: 'var(--radius-pill)' }}>{contract.status}</span>
        </div>
        <h1 className="dx-mono" style={{ fontSize: '36px', color: 'var(--fg-1)', letterSpacing: '0.02em', lineHeight: 1.1 }}>{contract.contract_no}</h1>
        <p className="mt-3" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          {contract.entity_abbreviation} ↔ {contract.partner_trade_name} <span className="dx-mono">({contract.currency})</span>
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="grid grid-cols-2 gap-5">
        <Card label="Parties">
          <Field label="Our Entity" value={contract.entity_abbreviation} mono />
          <Field label="Partner" value={contract.partner_trade_name} />
          <Field label="Currency" value={contract.currency} mono />
        </Card>
        <Card label="Dates & Terms">
          <Field label="Signed" value={formatDate(contract.signed_date)} mono />
          <Field label="Expires" value={formatDate(contract.expiry_date)} mono />
          <Field label="Incoterms" value={contract.incoterms ?? '—'} />
        </Card>
      </div>

      {contract.notes && (
        <div className="p-4" style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <div className="dx-eyebrow mb-2" style={{ fontSize: '10px' }}>Notes</div>
          <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>{contract.notes}</p>
        </div>
      )}
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="p-5 bg-card" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
      <div className="dx-eyebrow mb-4">{label}</div>
      <dl className="space-y-3">{children}</dl>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="dx-eyebrow mb-1" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>{label}</dt>
      <dd className={mono ? 'dx-mono' : ''} style={{ fontSize: mono ? '12px' : 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>{value ?? '—'}</dd>
    </div>
  );
}
