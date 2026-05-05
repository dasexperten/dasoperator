'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, Loader2 } from 'lucide-react';
import { getPartners, getAllNetBalances, type Partner } from '@/lib/api';
import NetBalance from '@/components/ui/net-balance';

type ExtendedPartner = Partner & {
  entity_abbreviation?: string | null;
  price_type_code?: string | null;
};

const STATUS_COLORS: Record<Partner['status'], { bg: string; fg: string; border: string }> = {
  active:   { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  pending:  { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  inactive: { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
  blocked:  { bg: 'rgba(229,32,44,0.08)',  fg: 'var(--brand-rot)',      border: 'rgba(229,32,44,0.3)' },
};

interface BalanceRow {
  usd: number;
  currencies: Record<string, number>;
}

export default function PartnersPage() {
  const [partners, setPartners] = useState<ExtendedPartner[]>([]);
  const [netBalances, setNetBalances] = useState<Record<string, BalanceRow>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [entityFilter, setEntityFilter] = useState<string>('all');

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [partnersRes, balRes] = await Promise.all([
          getPartners(),
          getAllNetBalances(),
        ]);
        if (partnersRes.success && partnersRes.result) {
          setPartners(partnersRes.result.partners);
          setError(null);
        } else {
          setError(partnersRes.errors[0]?.message ?? 'Failed to load partners');
        }
        if (balRes.success && balRes.result) {
          const map: Record<string, BalanceRow> = {};
          for (const b of balRes.result.balances) {
            map[b.partner_id] = { usd: b.net_balance_usd_cents, currencies: b.currencies };
          }
          setNetBalances(map);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
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
        const m = p.trade_name.toLowerCase().includes(q) ||
                  (p.legal_name?.toLowerCase().includes(q) ?? false) ||
                  (p.country?.toLowerCase().includes(q) ?? false);
        if (!m) return false;
      }
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (entityFilter !== 'all' && p.entity_abbreviation !== entityFilter) return false;
      return true;
    });
  }, [partners, search, statusFilter, entityFilter]);

  const activeCount = partners.filter((p) => p.status === 'active').length;
  const pendingCount = partners.filter((p) => p.status === 'pending').length;

  return (
    <div className="space-y-8 max-w-7xl">
      <div>
        <div className="dx-eyebrow dx-eyebrow-rot mb-2">Master Data</div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, letterSpacing: '-0.025em', color: 'var(--fg-1)' }}>
          Partners
        </h1>
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          {loading ? 'Loading...' : `${partners.length} partners · ${activeCount} active${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}`}
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="space-y-3">
        <div className="relative max-w-xl">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--fg-muted)' }} />
          <input
            type="text"
            placeholder="Search by trade name, legal name, country..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}
          />
        </div>

        <div className="flex gap-3">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="inactive">Inactive</option>
            <option value="blocked">Blocked</option>
          </select>
          <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}
            className="px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
            <option value="all">All entities</option>
            {entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <div className="ml-auto self-center dx-mono" style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>
            {filtered.length} / {partners.length}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>
      ) : error ? (
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          Error: {error}
        </div>
      ) : (
        <div className="bg-card overflow-hidden" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Trade Name</Th><Th>Country</Th><Th>Currency</Th><Th>Entity</Th><Th>Status</Th><Th>Net Balance</Th><Th>Contract</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>No partners match the filters</td></tr>
              ) : (
                filtered.map((p) => {
                  const statusStyle = STATUS_COLORS[p.status];
                  return (
                    <tr key={p.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-4 py-3">
                        <Link href={`/partners/${p.id}`} style={{ color: 'var(--fg-1)' }}>
                          <div className="dx-product-name" style={{ fontSize: 'var(--fs-body-sm)' }}>{p.trade_name}</div>
                          {p.legal_name && <div className="text-xs mt-0.5" style={{ color: 'var(--fg-3)' }}>{p.legal_name}</div>}
                        </Link>
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>{p.country ?? '—'}</td>
                      <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-2)' }}>{p.currency ?? '—'}</td>
                      <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-2)' }}>{p.entity_abbreviation ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className="dx-eyebrow inline-block" style={{ padding: '3px 8px', fontSize: '9px', backgroundColor: statusStyle.bg, color: statusStyle.fg, border: `1px solid ${statusStyle.border}`, borderRadius: 'var(--radius-pill)', letterSpacing: '0.15em' }}>
                          {p.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {netBalances[p.id] ? (
                          <NetBalance
                            usdCents={netBalances[p.id]!.usd}
                            currencies={netBalances[p.id]!.currencies}
                            size="compact"
                          />
                        ) : (
                          <span className="dx-mono" style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{p.contract_no ?? '—'}</td>
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
  return (
    <th className="text-left px-4 py-3 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>
      {children}
    </th>
  );
}
