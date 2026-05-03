'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, Users, Loader2 } from 'lucide-react';
import { getPartners, type Partner } from '@/lib/api';

type ExtendedPartner = Partner & {
  entity_abbreviation?: string | null;
  price_type_code?: string | null;
};

const STATUS_COLORS: Record<Partner['status'], string> = {
  active: 'bg-green-500/10 text-green-400',
  pending: 'bg-yellow-500/10 text-yellow-400',
  inactive: 'bg-gray-500/10 text-gray-400',
  blocked: 'bg-red-500/10 text-red-400',
};

export default function PartnersPage() {
  const [partners, setPartners] = useState<ExtendedPartner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [entityFilter, setEntityFilter] = useState<string>('all');

  useEffect(() => {
    const fetchPartners = async () => {
      setLoading(true);
      try {
        const res = await getPartners();
        if (res.success && res.result) {
          setPartners(res.result.partners);
          setError(null);
        } else {
          setError(res.errors[0]?.message ?? 'Failed to load partners');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchPartners();
  }, []);

  const entities = useMemo(() => {
    const set = new Set<string>();
    partners.forEach((p) => {
      if (p.entity_abbreviation) set.add(p.entity_abbreviation);
    });
    return Array.from(set).sort();
  }, [partners]);

  const filtered = useMemo(() => {
    return partners.filter((p) => {
      if (search) {
        const q = search.toLowerCase();
        const matchesSearch =
          p.trade_name.toLowerCase().includes(q) ||
          (p.legal_name?.toLowerCase().includes(q) ?? false) ||
          (p.country?.toLowerCase().includes(q) ?? false);
        if (!matchesSearch) return false;
      }
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (entityFilter !== 'all' && p.entity_abbreviation !== entityFilter) return false;
      return true;
    });
  }, [partners, search, statusFilter, entityFilter]);

  const activeCount = partners.filter((p) => p.status === 'active').length;
  const pendingCount = partners.filter((p) => p.status === 'pending').length;

  return (
    <div className="space-y-6 max-w-7xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="h-6 w-6" />
          Partners
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {loading
            ? 'Loading...'
            : `${partners.length} partners • ${activeCount} active${pendingCount > 0 ? ` • ${pendingCount} pending` : ''}`}
        </p>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by trade name, legal name, country..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-card border border-border rounded text-sm placeholder:text-muted-foreground focus:outline-none focus:border-accent"
          />
        </div>

        <div className="flex gap-3">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 bg-card border border-border rounded text-sm focus:outline-none focus:border-accent"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="inactive">Inactive</option>
            <option value="blocked">Blocked</option>
          </select>

          <select
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
            className="px-3 py-2 bg-card border border-border rounded text-sm focus:outline-none focus:border-accent"
          >
            <option value="all">All entities</option>
            {entities.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>

          <div className="ml-auto text-sm text-muted-foreground self-center">
            Showing {filtered.length} of {partners.length}
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
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Trade Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Country</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Currency</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Entity</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Contract</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-muted-foreground">
                    No partners match the filters
                  </td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b border-border last:border-0 hover:bg-muted/30 transition cursor-pointer"
                  >
                    <td className="px-4 py-3">
                      <Link href={`/partners/${p.id}`} className="hover:text-accent">
                        <div className="font-medium">{p.trade_name}</div>
                        {p.legal_name && (
                          <div className="text-xs text-muted-foreground">{p.legal_name}</div>
                        )}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{p.country ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                      {p.currency ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                      {p.entity_abbreviation ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs ${STATUS_COLORS[p.status]}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                      {p.contract_no ?? '—'}
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
