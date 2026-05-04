'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Plus, Search, Loader2 } from 'lucide-react';
import { getContracts, type Contract } from '@/lib/api';

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
    contracts.forEach((c) => { if (c.entity_abbreviation) set.add(c.entity_abbreviation); });
    return Array.from(set).sort();
  }, [contracts]);

  const filtered = useMemo(() => {
    return contracts.filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        const m = c.contract_no.toLowerCase().includes(q) ||
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
    <div className="space-y-8 max-w-7xl">
      <div className="flex items-start justify-between">
        <div>
          <div className="dx-eyebrow dx-eyebrow-rot mb-2">Master Data</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, letterSpacing: '-0.025em', color: 'var(--fg-1)' }}>
            Contracts
          </h1>
          <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
            {loading ? 'Loading...' : `${contracts.length} contracts · ${activeCount} active`}
          </p>
        </div>
        <Link
          href="/contracts/new"
          className="inline-flex items-center gap-2 px-4 py-2 transition-colors"
          style={{
            backgroundColor: 'var(--brand-rot)',
            color: 'var(--paper)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--fs-body-sm)',
            fontWeight: 600,
          }}
        >
          <Plus className="h-4 w-4" />
          New Contract
        </Link>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="space-y-3">
        <div className="relative max-w-xl">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--fg-muted)' }} />
          <input type="text" placeholder="Search by contract number or partner..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
        </div>
        <div className="flex gap-3">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="expired">Expired</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}
            className="px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
            <option value="all">All entities</option>
            {entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <div className="ml-auto self-center dx-mono" style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>
            {filtered.length} / {contracts.length}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>
      ) : error ? (
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>Error: {error}</div>
      ) : (
        <div className="bg-card overflow-hidden" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Contract No</Th><Th>Partner</Th><Th>Entity</Th><Th>Currency</Th><Th>Signed</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>No contracts match the filters</td></tr>
              ) : (
                filtered.map((c) => {
                  const statusStyle = STATUS_COLORS[c.status];
                  return (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-4 py-3">
                        <Link href={`/contracts/${c.id}`} className="dx-mono" style={{ fontSize: '12px', color: 'var(--fg-1)' }}>{c.contract_no}</Link>
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>{c.partner_trade_name ?? '—'}</td>
                      <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-2)' }}>{c.entity_abbreviation ?? '—'}</td>
                      <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-2)' }}>{c.currency}</td>
                      <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{formatDate(c.signed_date)}</td>
                      <td className="px-4 py-3">
                        <span className="dx-eyebrow inline-block" style={{ padding: '3px 8px', fontSize: '9px', backgroundColor: statusStyle.bg, color: statusStyle.fg, border: `1px solid ${statusStyle.border}`, borderRadius: 'var(--radius-pill)', letterSpacing: '0.15em' }}>{c.status}</span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left px-4 py-3 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>{children}</th>;
}
