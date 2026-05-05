'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, Loader2, Plus } from 'lucide-react';
import { getOperations, type Operation } from '@/lib/api';

const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  sale:     { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)' },
  purchase: { bg: 'rgba(13,25,158,0.08)',  fg: 'var(--line-innoweiss)' },
  transfer: { bg: 'var(--paper-sunk)',     fg: 'var(--fg-2)' },
};

function formatDate(unix: number): string {
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

function formatMoney(minor: number, currency: string): string {
  const factor = ['VND', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
  return (minor / factor).toLocaleString('en-US', {
    minimumFractionDigits: factor === 1 ? 0 : 2,
    maximumFractionDigits: factor === 1 ? 0 : 2,
  });
}

export default function OperationsPage() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await getOperations();
        if (res.success && res.result) {
          setOperations(res.result.operations);
          setError(null);
        } else {
          setError(res.errors?.[0]?.message ?? 'Failed to load');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, []);

  const filtered = useMemo(() => {
    return operations.filter((op) => {
      if (search) {
        const q = search.toLowerCase();
        const m = op.reference?.toLowerCase().includes(q) ||
                  op.partner_trade_name?.toLowerCase().includes(q) ||
                  op.contract_no?.toLowerCase().includes(q);
        if (!m) return false;
      }
      if (typeFilter !== 'all' && op.operation_type !== typeFilter) return false;
      if (statusFilter !== 'all' && op.status !== statusFilter) return false;
      return true;
    });
  }, [operations, search, typeFilter, statusFilter]);

  return (
    <div className="space-y-8 max-w-7xl">
      <div className="flex items-start justify-between">
        <div>
          <div className="dx-eyebrow dx-eyebrow-rot mb-2">Operations</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, letterSpacing: '-0.025em', color: 'var(--fg-1)' }}>
            All Operations
          </h1>
          <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
            {loading ? 'Loading...' : `${operations.length} across all partners · ${filtered.length} shown`}
          </p>
        </div>
        <Link
          href="/partners"
          className="inline-flex items-center gap-2 px-4 py-2"
          style={{
            backgroundColor: 'var(--brand-rot)', color: 'var(--paper)',
            borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-body-sm)', fontWeight: 600,
          }}
        >
          <Plus className="h-4 w-4" />
          Add new (select partner)
        </Link>
      </div>

      <div className="dx-ribbon-rule" />

      <div className="space-y-3">
        <div className="relative max-w-xl">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--fg-muted)' }} />
          <input type="text" placeholder="Search by reference, partner, or contract..." value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }} />
        </div>
        <div className="flex gap-3">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            className="px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }}>
            <option value="all">All types</option>
            <option value="sale">Sale</option>
            <option value="purchase">Purchase</option>
            <option value="transfer">Transfer</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }}>
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="order_fulfilment">Fulfilment</option>
            <option value="production">Production</option>
            <option value="shipped">Shipped</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </select>
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
                <Th>Reference</Th><Th>Date</Th><Th>Partner</Th><Th>Contract</Th><Th>Type</Th><Th>Total</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>No operations match the filters</td></tr>
              ) : (
                filtered.map((op) => {
                  const tc = TYPE_COLORS[op.operation_type];
                  return (
                    <tr key={op.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px' }}>
                        <Link
                          href={`/partners/${op.partner_id}/operations/${op.id}`}
                          style={{ color: 'var(--fg-1)', textDecoration: 'underline', textDecorationColor: 'var(--border-hairline)', textUnderlineOffset: '3px' }}
                        >
                          {op.reference ?? op.id}
                        </Link>
                      </td>
                      <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{formatDate(op.operation_date)}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>
                        {op.partner_trade_name ? (
                          <Link href={`/partners/${op.partner_id}`} style={{ color: 'var(--fg-1)' }}>
                            {op.partner_trade_name}
                          </Link>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-2)' }}>{op.contract_no ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className="dx-eyebrow inline-block" style={{ padding: '3px 8px', fontSize: '9px', backgroundColor: tc?.bg, color: tc?.fg, borderRadius: 'var(--radius-pill)', letterSpacing: '0.15em' }}>
                          {op.operation_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 dx-mono text-right" style={{ fontSize: '12px', color: 'var(--fg-1)' }}>{formatMoney(op.total_amount, op.currency)} {op.currency}</td>
                      <td className="px-4 py-3 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-2)', letterSpacing: '0.15em' }}>{op.status}</td>
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

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-left px-4 py-3 dx-eyebrow" style={{ fontSize: '10px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>{children}</th>;
}
