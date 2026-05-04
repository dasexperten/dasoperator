'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import { getContract, type Contract } from '@/lib/api';

const STATUS_COLORS: Record<Contract['status'], string> = {
  active: 'bg-green-500/10 text-green-400',
  draft: 'bg-yellow-500/10 text-yellow-400',
  expired: 'bg-gray-500/10 text-gray-400',
  cancelled: 'bg-red-500/10 text-red-400',
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
        if (res.success && res.result) {
          setContract(res.result);
          setError(null);
        } else {
          setError(res.errors[0]?.message ?? 'Contract not found');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [contractId]);

  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  if (error || !contract) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href="/contracts" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />Back to Contracts
        </Link>
        <div className="bg-card border border-red-500/30 rounded p-4 text-sm text-red-400">
          {error ?? 'Contract not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <Link href="/contracts" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ArrowLeft className="h-4 w-4" />Back to Contracts
      </Link>

      <div>
        <div className="flex items-center gap-3 mb-1">
          <FileText className="h-6 w-6 text-muted-foreground" />
          <span className="font-mono text-xs text-muted-foreground">{contract.id}</span>
          <span className={`px-2 py-1 rounded text-xs ${STATUS_COLORS[contract.status]}`}>
            {contract.status}
          </span>
        </div>
        <h1 className="text-2xl font-semibold font-mono">{contract.contract_no}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {contract.entity_abbreviation} ↔ {contract.partner_trade_name} ({contract.currency})
        </p>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted-foreground mb-4">Parties</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">Our Entity</dt><dd className="font-mono">{contract.entity_abbreviation}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Partner</dt><dd>{contract.partner_trade_name}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Currency</dt><dd className="font-mono">{contract.currency}</dd></div>
          </dl>
        </div>

        <div className="bg-card border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-muted-foreground mb-4">Dates & Terms</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between"><dt className="text-muted-foreground">Signed</dt><dd className="font-mono text-xs">{formatDate(contract.signed_date)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Expires</dt><dd className="font-mono text-xs">{formatDate(contract.expiry_date)}</dd></div>
            <div className="flex justify-between"><dt className="text-muted-foreground">Incoterms</dt><dd>{contract.incoterms ?? '—'}</dd></div>
          </dl>
        </div>
      </div>

      {contract.notes && (
        <div className="bg-muted/30 border border-border rounded-lg p-4">
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Notes</h3>
          <p className="text-sm">{contract.notes}</p>
        </div>
      )}
    </div>
  );
}
