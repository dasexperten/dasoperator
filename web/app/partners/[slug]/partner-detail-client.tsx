'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle, Loader2 } from 'lucide-react';
import { getPartner, type Partner } from '@/lib/api';

const STATUS_COLORS: Record<Partner['status'], { bg: string; fg: string; border: string }> = {
  active:   { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  pending:  { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  inactive: { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
  blocked:  { bg: 'rgba(229,32,44,0.08)',  fg: 'var(--brand-rot)',      border: 'rgba(229,32,44,0.3)' },
};

const MISSING = 'MISSING';

function isMissing(value: string | null | undefined): boolean {
  return !value || value === MISSING || value.trim() === '';
}

function formatDate(unixSec?: number | null): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().split('T')[0]!;
}

export default function PartnerDetailClient({ slug }: { slug: string }) {
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPartner = async () => {
      try {
        const res = await getPartner(slug);
        if (res.success && res.result) {
          setPartner(res.result);
          setError(null);
        } else {
          setError(res.errors?.[0]?.message ?? 'Partner not found');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchPartner();
  }, [slug]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;

  if (error || !partner) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href="/partners" className="text-sm inline-flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
          <ArrowLeft className="h-4 w-4" />Back to Partners
        </Link>
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error ?? 'Partner not found'}
        </div>
      </div>
    );
  }

  const isPending = partner.status === 'pending';
  const statusStyle = STATUS_COLORS[partner.status];

  return (
    <div className="space-y-8 max-w-5xl">
      <Link href="/partners" className="text-sm inline-flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
        <ArrowLeft className="h-4 w-4" />Back to Partners
      </Link>

      <div>
        <div className="flex items-center gap-3 mb-3">
          <span className="dx-mono" style={{ fontSize: '11px', padding: '3px 8px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--fg-2)' }}>
            {partner.id}
          </span>
          <span className="dx-eyebrow inline-block" style={{ padding: '3px 8px', fontSize: '9px', backgroundColor: statusStyle.bg, color: statusStyle.fg, border: `1px solid ${statusStyle.border}`, borderRadius: 'var(--radius-pill)' }}>
            {partner.status}
          </span>
        </div>
        <h1 className="dx-product-name" style={{ fontSize: '40px', color: 'var(--fg-1)', lineHeight: 1.05 }}>
          {partner.trade_name}
        </h1>
        {partner.legal_name && !isMissing(partner.legal_name) && (
          <p className="mt-3" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>{partner.legal_name}</p>
        )}
      </div>

      <div className="dx-ribbon-rule" />

      {isPending && (
        <div className="p-4 flex items-start gap-3" style={{ backgroundColor: 'rgba(199,122,0,0.06)', border: '1px solid rgba(199,122,0,0.25)', borderRadius: 'var(--radius-md)' }}>
          <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--status-warning)' }} />
          <div>
            <div className="dx-eyebrow mb-1" style={{ color: 'var(--status-warning)', fontSize: '10px' }}>Pending Partner — Incomplete Data</div>
            <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
              Document generation will be blocked until all required fields are filled in.
            </p>
            {partner.notes && <p className="mt-2" style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-2)' }}>{partner.notes}</p>}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-5">
        <Card label="General">
          <Field label="Country" value={partner.country} />
          <Field label="Type" value={partner.partner_type} />
          <Field label="Tax ID" value={partner.tax_id} mono />
          <Field label="Email" value={partner.email} mono />
        </Card>

        <Card label="Banking">
          <Field label="IBAN" value={partner.iban} mono />
          <Field label="SWIFT/BIC" value={partner.swift_bic} mono />
          <Field label="Bank" value={partner.bank_name} />
        </Card>

        <Card label="Commercial">
          <Field label="Linked Entity" value={partner.linked_entity_id} mono />
          <Field label="Price Type" value={partner.price_type_id} mono />
          <Field label="Currency" value={partner.currency} mono />
          <Field label="Contract" value={partner.contract_no} mono />
          <Field label="Contract Date" value={formatDate(partner.contract_date)} mono />
        </Card>
      </div>

      {partner.notes && !isPending && (
        <div className="p-4" style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <div className="dx-eyebrow mb-2" style={{ fontSize: '10px' }}>Notes</div>
          <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>{partner.notes}</p>
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
  const missing = !value || value === 'MISSING' || value.trim() === '';
  return (
    <div>
      <dt className="dx-eyebrow mb-1" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>{label}</dt>
      <dd
        className={mono ? 'dx-mono' : ''}
        style={{
          fontSize: mono ? '12px' : 'var(--fs-body-sm)',
          color: missing ? 'var(--status-warning)' : 'var(--fg-1)',
        }}
      >
        {missing ? '⚠ MISSING' : value}
      </dd>
    </div>
  );
}
