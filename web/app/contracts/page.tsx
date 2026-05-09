'use client';

export const runtime = 'edge';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { Search, Loader2, FileText, FileX } from 'lucide-react';
import { getContracts, getContractFileUrl, type Contract } from '@/lib/api';
import { isPlaceholderContractNo } from '@/components/ui/contract-ref';

// =============================================================================
// /contracts — cross-partner contract registry (Phase 7.4)
// Mirrors the look-and-feel of /operations top-level list. Shows every
// contract with quick visual cues for placeholder vs real, file uploaded
// vs missing, and lets you jump to the partner hub from any row.
// =============================================================================

const STATUS_COLORS: Record<Contract['status'], { bg: string; fg: string; border: string }> = {
  draft:     { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  active:    { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  expired:   { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
  cancelled: { bg: 'rgba(229,32,44,0.08)',  fg: 'var(--brand-rot)',      border: 'rgba(229,32,44,0.3)' },
};

type ContractRow = Contract & { partner_abbreviation?: string | null };

function formatDate(unix: number | null | undefined): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

export default function ContractsPage() {
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [entityFilter, setEntityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [fileFilter, setFileFilter] = useState<'all' | 'uploaded' | 'missing'>('all');
  const [placeholderFilter, setPlaceholderFilter] = useState<'all' | 'real' | 'placeholder'>('all');

  useEffect(() => {
    (async () => {
      try {
        const res = await getContracts();
        if (res.success && res.result) {
          setContracts(res.result.contracts);
          setError(null);
        } else {
          setError(res.errors?.[0]?.message ?? 'Failed to load');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const entities = useMemo(() => {
    const set = new Set<string>();
    for (const c of contracts) if (c.entity_abbreviation) set.add(c.entity_abbreviation);
    return Array.from(set).sort();
  }, [contracts]);

  const filtered = useMemo(() => {
    return contracts.filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        const m =
          c.contract_no?.toLowerCase().includes(q) ||
          c.partner_trade_name?.toLowerCase().includes(q) ||
          c.partner_abbreviation?.toLowerCase().includes(q) ||
          c.notes?.toLowerCase().includes(q);
        if (!m) return false;
      }
      if (entityFilter !== 'all' && c.entity_abbreviation !== entityFilter) return false;
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (fileFilter === 'uploaded' && !c.contract_file_key) return false;
      if (fileFilter === 'missing' && c.contract_file_key) return false;
      const isPh = isPlaceholderContractNo(c.contract_no);
      if (placeholderFilter === 'real' && isPh) return false;
      if (placeholderFilter === 'placeholder' && !isPh) return false;
      return true;
    });
  }, [contracts, search, entityFilter, statusFilter, fileFilter, placeholderFilter]);

  // KPI counters for hero
  const kpi = useMemo(() => {
    const total = contracts.length;
    const placeholders = contracts.filter((c) => isPlaceholderContractNo(c.contract_no)).length;
    const withFile = contracts.filter((c) => c.contract_file_key).length;
    return { total, real: total - placeholders, placeholders, withFile };
  }, [contracts]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="dx-product-name" style={{ fontSize: '40px', color: 'var(--fg-1)', lineHeight: 1.05 }}>
            Contracts
          </h1>
          <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
            All contracts across entities, with their PDF files and partner links.
          </p>
        </div>
        <div className="flex gap-6 pb-1">
          <Kpi label="Total" value={kpi.total} />
          <Kpi label="Real" value={kpi.real} accent="success" />
          <Kpi label="Placeholder" value={kpi.placeholders} accent="muted" />
          <Kpi label="With PDF" value={kpi.withFile} accent="success" />
        </div>
      </div>

      <div className="dx-ribbon-rule" />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative" style={{ minWidth: '320px', flex: 1 }}>
          <Search size={16} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--fg-3)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search contract no, partner, abbreviation, notes…"
            style={{
              width: '100%',
              fontSize: '14px',
              padding: '8px 10px 8px 34px',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper-1)',
              color: 'var(--fg-1)',
            }}
          />
        </div>
        <SelectFilter label="Entity" value={entityFilter} onChange={setEntityFilter}
          options={[['all', 'All entities'], ...entities.map((e) => [e, e] as [string, string])]} />
        <SelectFilter label="Status" value={statusFilter} onChange={setStatusFilter}
          options={[['all','All statuses'],['active','active'],['draft','draft'],['expired','expired'],['cancelled','cancelled']]} />
        <SelectFilter label="File" value={fileFilter} onChange={(v) => setFileFilter(v as typeof fileFilter)}
          options={[['all','All files'],['uploaded','PDF uploaded'],['missing','No PDF']]} />
        <SelectFilter label="Type" value={placeholderFilter} onChange={(v) => setPlaceholderFilter(v as typeof placeholderFilter)}
          options={[['all','All types'],['real','Real contract'],['placeholder','Placeholder only']]} />
      </div>

      {error && (
        <div className="p-3" style={{ fontSize: '14px', backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error}
        </div>
      )}

      {/* Result counter */}
      <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
        Showing <strong style={{ color: 'var(--fg-1)' }}>{filtered.length}</strong> of <strong style={{ color: 'var(--fg-1)' }}>{contracts.length}</strong> contracts
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="py-12 text-center" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
          No contracts match the current filters.
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <table className="w-full">
            <thead style={{ backgroundColor: 'var(--paper-sunk)' }}>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <Th>Contract No</Th>
                <Th>Entity</Th>
                <Th>Partner</Th>
                <Th>Code</Th>
                <Th>Currency</Th>
                <Th>Signed</Th>
                <Th>File</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const ss = STATUS_COLORS[c.status];
                const isPh = isPlaceholderContractNo(c.contract_no);
                return (
                  <tr
                    key={c.id}
                    style={{ borderBottom: '1px solid var(--border-hairline)' }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--paper-sunk)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/partners/${c.partner_id}/contracts/${c.id}`}
                        style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textDecoration: 'underline', textDecorationColor: 'var(--border-hairline)', textUnderlineOffset: '3px' }}
                      >
                        {isPh ? <span style={{ color: 'var(--fg-3)', fontStyle: 'italic' }}>—</span> : c.contract_no}
                      </Link>
                      {isPh && (
                        <span
                          className="inline-flex items-center gap-1.5 ml-2"
                          style={{ padding: '2px 8px', fontSize: '14px', fontWeight: 600, color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)', border: '1px dashed var(--border-hairline)', borderRadius: 'var(--radius-pill)' }}
                          title="Technical placeholder — replace when a real contract is signed"
                        >
                          <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: 'var(--fg-muted)', display: 'inline-block' }} />
                          Placeholder
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-2)' }}>
                      {c.entity_abbreviation ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      {c.partner_trade_name && c.partner_id ? (
                        <Link
                          href={`/partners/${c.partner_id}`}
                          style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textDecoration: 'none' }}
                          onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                        >
                          {c.partner_trade_name}
                        </Link>
                      ) : (
                        <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {c.partner_abbreviation ? (
                        <span style={{
                          fontSize: '14px',
                          fontWeight: 700,
                          letterSpacing: 0,
                          padding: '2px 8px',
                          backgroundColor: 'var(--paper-sunk)',
                          border: '1px solid var(--border-hairline)',
                          borderRadius: 'var(--radius-xs)',
                          color: 'var(--fg-2)',
                        }}>{c.partner_abbreviation}</span>
                      ) : (
                        <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>—</span>
                      )}
                    </td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-2)' }}>{c.currency}</td>
                    <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-3)' }}>{formatDate(c.signed_date)}</td>
                    <td className="px-4 py-3">
                      {c.contract_file_key ? (
                        <a
                          href={getContractFileUrl(c.id)}
                          target="_blank"
                          rel="noreferrer"
                          title={c.contract_file_key.split('/').pop() || 'View PDF'}
                          className="inline-flex items-center gap-1.5"
                          style={{
                            padding: '3px 8px',
                            fontSize: '14px',
                            fontWeight: 600,
                            color: 'var(--status-success)',
                            backgroundColor: 'rgba(46,125,79,0.08)',
                            border: '1px solid rgba(46,125,79,0.3)',
                            borderRadius: 'var(--radius-pill)',
                            textDecoration: 'none',
                          }}
                        >
                          <FileText size={14} /> PDF
                        </a>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1.5"
                          style={{ fontSize: '14px', color: 'var(--fg-3)' }}
                          title="No PDF uploaded yet"
                        >
                          <FileX size={14} /> —
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="inline-block"
                        style={{ padding: '4px 10px', fontSize: '14px', fontWeight: 600, backgroundColor: ss.bg, color: ss.fg, border: `1px solid ${ss.border}`, borderRadius: 'var(--radius-pill)' }}
                      >
                        {c.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Subcomponents
// =============================================================================

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left" style={{ fontSize: '14px', fontWeight: 700, letterSpacing: 0, color: 'var(--fg-3)', textTransform: 'uppercase' }}>
      {children}
    </th>
  );
}

function Kpi({ label, value, accent }: { label: string; value: number; accent?: 'success' | 'muted' }) {
  const fg = accent === 'success' ? 'var(--status-success)' :
             accent === 'muted'   ? 'var(--fg-3)' :
                                    'var(--fg-1)';
  return (
    <div className="text-right">
      <div style={{ fontSize: '28px', fontWeight: 700, lineHeight: 1, color: fg }}>{value}</div>
      <div className="mt-1" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{label}</div>
    </div>
  );
}

function SelectFilter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="flex items-center gap-2">
      <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontSize: '14px',
          fontWeight: 700,
          padding: '6px 10px',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-sm)',
          backgroundColor: 'var(--paper-1)',
          color: 'var(--fg-1)',
          cursor: 'pointer',
        }}
      >
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  );
}
