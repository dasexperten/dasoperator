'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Users, AlertTriangle, Loader2 } from 'lucide-react';
import { getPartner, type Partner } from '@/lib/api';

const STATUS_COLORS: Record<Partner['status'], string> = {
  active: 'bg-green-500/10 text-green-400',
  pending: 'bg-yellow-500/10 text-yellow-400',
  inactive: 'bg-gray-500/10 text-gray-400',
  blocked: 'bg-red-500/10 text-red-400',
};

const MISSING = 'MISSING';

function isMissing(value: string | null | undefined): boolean {
  return !value || value === MISSING || value.trim() === '';
}

function formatDate(unixSec?: number | null): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().split('T')[0]!;
}

interface FieldProps {
  label: string;
  value?: string | null;
  mono?: boolean;
}

function Field({ label, value, mono }: FieldProps) {
  const missing = isMissing(value);
  return (
    <div>
      <dt className="text-xs text-muted-foreground mb-1">{label}</dt>
      <dd className={`${mono ? 'font-mono text-xs' : 'text-sm'} ${missing ? 'text-yellow-500' : ''}`}>
        {missing ? '⚠ MISSING' : value}
      </dd>
    </div>
  );
}

export default function PartnerDetailClient({ slug }: { slug: string }) {
  const [partner, setPartner] = useState<Partner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPartner = async () => {
      setLoading(true);
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (error || !partner) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href="/partners" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />
          Back to Partners
        </Link>
        <div className="bg-card border border-red-500/30 rounded p-4 text-sm text-red-400">
          {error ?? 'Partner not found'}
        </div>
      </div>
    );
  }

  const isPending = partner.status === 'pending';

  return (
    <div className="space-y-6 max-w-5xl">
      <Link href="/partners" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ArrowLeft className="h-4 w-4" />
        Back to Partners
      </Link>

      <div>
        <div className="flex items-center gap-3 mb-1">
          <Users className="h-6 w-6 text-muted-foreground" />
          <span className="font-mono text-xs text-muted-foreground">{partner.id}</span>
          <span className={`px-2 py-1 rounded text-xs ${STATUS_COLORS[partner.status]}`}>
            {partner.status}
          </span>
        </div>
        <h1 className="text-2xl font-semibold">{partner.trade_name}</h1>
        {partner.legal_name && !isMissing(partner.legal_name) && (
          <p className="text-sm text-muted-foreground mt-1">{partner.legal_name}</p>
        )}
      </div>

      {isPending && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-yellow-400">Pending partner — incomplete data</p>
            <p className="text-yellow-300/80 mt-1">
              Document generation will be blocked until all required fields are filled in.
            </p>
            {partner.notes && (
              <p className="text-yellow-300/80 mt-2 text-xs">{partner.notes}</p>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-6">
        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted-foreground mb-4">General</h3>
          <dl className="space-y-3">
            <Field label="Country" value={partner.country} />
            <Field label="Type" value={partner.partner_type} />
            <Field label="Tax ID" value={partner.tax_id} mono />
            <Field label="Email" value={partner.email} mono />
          </dl>
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted-foreground mb-4">Banking</h3>
          <dl className="space-y-3">
            <Field label="IBAN" value={partner.iban} mono />
            <Field label="SWIFT/BIC" value={partner.swift_bic} mono />
            <Field label="Bank" value={partner.bank_name} />
          </dl>
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted-foreground mb-4">Commercial</h3>
          <dl className="space-y-3">
            <Field label="Linked Entity" value={partner.linked_entity_id} mono />
            <Field label="Price Type" value={partner.price_type_id} mono />
            <Field label="Currency" value={partner.currency} mono />
            <Field label="Contract" value={partner.contract_no} mono />
            <Field label="Contract Date" value={formatDate(partner.contract_date)} />
          </dl>
        </div>
      </div>

      {partner.notes && !isPending && (
        <div className="bg-muted/30 border border-border rounded-lg p-4">
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Notes</h3>
          <p className="text-sm">{partner.notes}</p>
        </div>
      )}
    </div>
  );
}
