'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { FileText, Plus, Search, Loader2 } from 'lucide-react';
import { getContracts, type Contract } from '@/lib/api';

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

export default function ContractsPage() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [entityFilter, setEntityFilter] = useState<string>('all');

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await getContracts();
        if (res.success && res.result) {
          setContracts(res.result.contracts);
          setError(null);
        } else {
          setError(res.errors[0]?.message ?? 'Failed to load contracts');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const entities = useMemo(() => {
    const set = new Set<string>();
    contracts.forEach((c) => {
      if (c.entity_abbreviation) set.add(c.entity_abbreviation);
    });
    return Array.from(set).sort();
  }, [contracts]);

  const filtered = useMemo(() => {
    return contracts.filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        const m =
          c.contract_no.toLowerCase().includes(q) ||
          (c.partner_trade_name?.toLowerCase().includes(q) ?? false);
        if (!m) return false;
      }
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (entityFilter !== 'all' && c.entity_abbreviation !== entityFilter) return false;
      return true;
    });
  }, [contracts, search, statusFilter, entityFilter]);

  const activeCount = contracts.filter((c) => c.status === 'active').length;

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FileText className="h-6 w-6" />
            Contracts
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {loading ? 'Loading...' : `${contracts.length} contracts • ${activeCount} active`}
          </p>
        </div>
        <Link
          href="/contracts/new"
          className="bg-accent text-accent-foreground px-4 py-2 rounded text-sm flex items-center gap-2 hover:opacity-90 transition"
        >
          <Plus className="h-4 w-4" />
          New Contract
        </Link>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by contract number or partner..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-card border border-border rounded text-sm placeholder:text-muted-foreground focus:outline-none focus:border-accent"
          />
        </div>

        <div className="flex gap-3">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 bg-card border border-border rounded text-sm focus:outline-none focus:border-accent">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}
            className="px-3 py-2 bg-card border border-border rounded text-sm focus:outline-none focus:border-accent">
            <option value="all">All entities</option>
            {entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <div className="ml-auto text-sm text-muted-foreground self-center">
            Showing {filtered.length} of {contracts.length}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 text-muted-foreground animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-card border border-red-500/30 rounded p-4 text-sm text-red-400">
          Error: {error}
        </div>
      ) : (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contract No</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Partner</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Entity</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Currency</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Signed</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    No contracts match the filters
                  </td>
                </tr>
              ) : (
                filtered.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition cursor-pointer">
                    <td className="px-4 py-3">
                      <Link href={`/contracts/${c.id}`} className="hover:text-accent font-mono">
                        {c.contract_no}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{c.partner_trade_name ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                      {c.entity_abbreviation ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{c.currency}</td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{formatDate(c.signed_date)}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${STATUS_COLORS[c.status]}`}>
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
