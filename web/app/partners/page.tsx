'use client';

export const runtime = 'edge';



import { useEffect, useState, useMemo, Fragment } from 'react';
import Link from 'next/link';
import { Search, Loader2, Plus, Mail, X, Send } from 'lucide-react';
import { getPartnersWithBalances, type Partner } from '@/lib/api';
import NetBalance from '@/components/ui/net-balance';

type ExtendedPartner = Partner & {
  entity_abbreviation?: string | null;
  price_type_code?: string | null;
  crm_status?: 'lead' | 'potential' | 'active' | 'sleeping' | null;
  email?: string | null;
};

const CRM_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  lead:      { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
  potential: { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  active:    { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  sleeping:  { bg: 'rgba(0,0,0,0.04)',      fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
};

const STATUS_COLORS: Record<Partner['status'], { bg: string; fg: string; border: string }> = {
  active:   { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  pending:  { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  inactive: { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
  blocked:  { bg: 'rgba(229,32,44,0.08)',  fg: 'var(--brand-rot)',      border: 'rgba(229,32,44,0.3)' },
};

type Kind = 'buyer' | 'manufacturer' | 'service_provider' | 'shipper' | '3pl' | 'other';

const KIND_COLORS: Record<Kind, { bg: string; fg: string }> = {
  buyer:            { bg: '#E6F1FB', fg: '#0C447C' },
  manufacturer:     { bg: '#EEEDFE', fg: '#3C3489' },
  service_provider: { bg: '#FAEEDA', fg: '#633806' },
  shipper:          { bg: '#E1F5EE', fg: '#085041' },
  '3pl':            { bg: '#FAECE7', fg: '#712B13' },
  other:            { bg: 'var(--paper-sunk)', fg: 'var(--fg-3)' },
};

const KIND_LABELS_BUTTON: Record<Kind, string> = {
  buyer:            'BUYERS',
  manufacturer:     'MANUFACTURERS',
  service_provider: 'SERVICE PROVIDERS',
  shipper:          'SHIPPERS',
  '3pl':            '3PL',
  other:            'OTHER',
};

const KIND_LABELS_BADGE: Record<Kind, string> = {
  buyer:            'BUYER',
  manufacturer:     'MANUF.',
  service_provider: 'SERVICE',
  shipper:          'SHIPPER',
  '3pl':            '3PL',
  other:            'OTHER',
};

function deriveKind(p: ExtendedPartner): Kind {
  if (p.kind) return p.kind as Kind;
  if (p.partner_type === 'buyer') return 'buyer';
  if (p.partner_type === 'shipper') return 'shipper';
  if (p.partner_type === 'supplier') return 'manufacturer';
  return 'other';
}

interface EmailEntry {
  email: string;
  label?: string;
}

// Parses partners.email which can be:
//   1. null / empty / dash         → []
//   2. plain "foo@bar.com"         → [{email:"foo@bar.com"}]
//   3. comma-separated "a@x, b@y"  → [{email:"a@x"},{email:"b@y"}]
//   4. JSON array of strings       → [{email:..}, {email:..}]
//   5. JSON array of objects with {email,label} → as-is
// Always returns an array (possibly empty). Never throws.
function parseEmails(raw: string | null | undefined): EmailEntry[] {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '—') return [];

  // Try JSON first
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((x) => {
            if (typeof x === 'string') return { email: x.trim() };
            if (x && typeof x === 'object' && typeof x.email === 'string') {
              return { email: x.email.trim(), label: x.label?.toString() };
            }
            return null;
          })
          .filter((x): x is EmailEntry => x !== null && x.email.length > 0);
      }
      if (parsed && typeof parsed === 'object' && typeof parsed.email === 'string') {
        return [{ email: parsed.email.trim(), label: parsed.label?.toString() }];
      }
    } catch {
      // fall through to plain parsing
    }
  }

  // Plain or comma-separated
  return trimmed
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.includes('@'))
    .map((email) => ({ email }));
}

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
  const [kindFilter, setKindFilter] = useState<Kind | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [entityFilter, setEntityFilter] = useState<string>('all');
  // Inline email composer — only one open at a time, keyed by partner id + email index
  const [composerKey, setComposerKey] = useState<{ partnerId: string; emailIdx: number } | null>(null);

  useEffect(() => {
    // Single combined fetch — partners list + bulk balances in one round-trip.
    // Backend returns ~6KB instead of ~42KB and saves a second CORS preflight.
    const fetchAll = async () => {
      try {
        const res = await getPartnersWithBalances();
        if (res.success && res.result) {
          setPartners(res.result.partners);
          if (res.result.balances) {
            const map: Record<string, BalanceRow> = {};
            for (const b of res.result.balances) {
              map[b.partner_id] = { usd: b.net_balance_usd, currencies: b.currencies };
            }
            setNetBalances(map);
          }
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

    fetchAll();
  }, []);

  const entities = useMemo(() => {
    const set = new Set<string>();
    partners.forEach((p) => {
      if (p.entity_abbreviation) set.add(p.entity_abbreviation);
    });
    return Array.from(set).sort();
  }, [partners]);

  const kindCounts = useMemo(() => {
    const counts: Record<Kind | 'all', number> = {
      all: partners.length,
      buyer: 0, manufacturer: 0, service_provider: 0, shipper: 0, '3pl': 0, other: 0,
    };
    partners.forEach((p) => {
      const k = deriveKind(p);
      counts[k]++;
    });
    return counts;
  }, [partners]);

  const filtered = useMemo(() => {
    return partners.filter((p) => {
      if (kindFilter !== 'all' && deriveKind(p) !== kindFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        const m = p.trade_name.toLowerCase().includes(q) ||
                  (p.legal_name?.toLowerCase().includes(q) ?? false) ||
                  (p.country?.toLowerCase().includes(q) ?? false);
        if (!m) return false;
      }
      if (statusFilter !== 'all' && (p.crm_status ?? p.status) !== statusFilter) return false;
      if (entityFilter !== 'all' && p.entity_abbreviation !== entityFilter) return false;
      return true;
    });
  }, [partners, search, kindFilter, statusFilter, entityFilter]);

  const activeCount = partners.filter((p) => p.status === 'active').length;
  const pendingCount = partners.filter((p) => p.status === 'pending').length;

  const kindButtons: Array<{ key: Kind | 'all'; label: string; count: number }> = [
    { key: 'all', label: 'ALL', count: kindCounts.all },
    { key: 'buyer', label: KIND_LABELS_BUTTON.buyer, count: kindCounts.buyer },
    { key: 'manufacturer', label: KIND_LABELS_BUTTON.manufacturer, count: kindCounts.manufacturer },
    { key: 'service_provider', label: KIND_LABELS_BUTTON.service_provider, count: kindCounts.service_provider },
    { key: 'shipper', label: KIND_LABELS_BUTTON.shipper, count: kindCounts.shipper },
    { key: '3pl', label: KIND_LABELS_BUTTON['3pl'], count: kindCounts['3pl'] },
  ];

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="dx-eyebrow-rot mb-2">Master Data</div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)' }}>
            Partners
          </h1>
          <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
            {loading ? 'Loading...' : `${partners.length} partners · ${activeCount} active${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}`}
          </p>
        </div>
        <div className="flex gap-2 mt-2">
          <button
            onClick={async () => {
              try {
                const r = await fetch('https://dasoperator-api.dasexperten.workers.dev/api/partners/recalc-status', {
                  method: 'POST',
                });
                const data = await r.json() as { success?: boolean };
                if (data.success) window.location.reload();
              } catch (e) {
                console.error('recalc failed', e);
              }
            }}
            className="inline-flex items-center gap-2 px-3 py-2"
            style={{
              backgroundColor: 'transparent',
              color: 'var(--fg-2)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--fs-body-sm)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
            title="Recompute crm_status from operations + contracts"
          >
            Recalculate statuses
          </button>
          <Link
            href="/partners/new"
            className="inline-flex items-center gap-2 px-4 py-2"
            style={{
              backgroundColor: 'var(--brand-rot)', color: 'var(--paper)',
              borderRadius: 'var(--radius-sm)', fontSize: 'var(--fs-body-sm)', fontWeight: 600,
            }}
          >
            <Plus className="h-4 w-4" /> Add new partner
          </Link>
        </div>
      </div>

      <div className="dx-ribbon-rule" />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
          gap: '10px',
        }}
      >
        {kindButtons.map((btn) => {
          const isActive = kindFilter === btn.key;
          const palette = btn.key === 'all'
            ? { bg: '#1F2937', fg: '#FFFFFF' }
            : KIND_COLORS[btn.key as Kind];
          const muted = !isActive;
          return (
            <button
              key={btn.key}
              onClick={() => setKindFilter(btn.key)}
              style={{
                padding: '14px 10px',
                background: isActive
                  ? palette.bg
                  : (btn.key === 'all' ? 'var(--paper-sunk)' : palette.bg),
                color: isActive
                  ? palette.fg
                  : (btn.key === 'all' ? 'var(--fg-2)' : palette.fg),
                opacity: muted && btn.key !== 'all' ? 0.55 : 1,
                border: `1px solid ${isActive ? (btn.key === 'all' ? '#1F2937' : palette.fg) : 'transparent'}`,
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'opacity 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.opacity = '1'; }}
              onMouseLeave={(e) => { if (!isActive && btn.key !== 'all') e.currentTarget.style.opacity = '0.55'; }}
            >
              <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: 0, marginBottom: 4, opacity: 0.75 }}>
                {btn.label}
              </div>
              <div style={{ fontSize: '22px', fontWeight: 700 }}>
                {btn.count}
              </div>
            </button>
          );
        })}
      </div>

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
            <option value="lead">Lead</option>
            <option value="potential">Potential</option>
            <option value="active">Active</option>
            <option value="sleeping">Sleeping</option>
          </select>
          <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}
            className="px-3 py-2 text-sm focus:outline-none"
            style={{ backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)' }}>
            <option value="all">All entities</option>
            {entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <div className="ml-auto self-center" style={{ fontSize: 'var(--fs-caption)', color: 'var(--fg-3)' }}>
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
                <Th>Trade Name</Th><Th>Kind</Th><Th>Country</Th><Th>Lang</Th><Th>Currency</Th><Th>Entity</Th><Th>Status</Th><Th>Email</Th><Th>Net Balance</Th><Th>Contract</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={10} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>No partners match the filters</td></tr>
              ) : (
                filtered.map((p) => {
                  const effective = p.crm_status ?? (p.status === 'pending' ? 'lead' : p.status);
                  const statusStyle = CRM_COLORS[effective] ?? STATUS_COLORS[p.status];
                  const k = deriveKind(p);
                  const kindStyle = KIND_COLORS[k];
                  return (
                    <Fragment key={p.id}>
                    <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-4 py-3">
                        <Link href={`/partners/${p.id}`} style={{ color: 'var(--fg-1)' }}>
                          <div className="dx-product-name" style={{ fontSize: 'var(--fs-body-sm)' }}>{p.trade_name}</div>
                          {p.legal_name && p.legal_name !== p.trade_name && <div className="mt-0.5" style={{ color: 'var(--fg-3)' }}>{p.legal_name}</div>}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-block" style={{ padding: '3px 10px', backgroundColor: kindStyle.bg, color: kindStyle.fg, fontSize: '11px', fontWeight: 700, letterSpacing: 0, borderRadius: 'var(--radius-pill)' }}>
                          {KIND_LABELS_BADGE[k]}
                        </span>
                      </td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>{p.country ?? '—'}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-2)', fontWeight: 700 }}>{p.partner_language ?? '—'}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-2)', fontWeight: 700 }}>{p.currency ?? '—'}</td>
                      <td className="px-4 py-3" style={{ color: 'var(--fg-2)', fontWeight: 700 }}>{p.entity_abbreviation ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className="inline-block" style={{ padding: '3px 8px', backgroundColor: statusStyle.bg, color: statusStyle.fg, border: `1px solid ${statusStyle.border}`, borderRadius: 'var(--radius-pill)' }}>
                          {effective}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {(() => {
                          const emails = parseEmails(p.email);
                          const primary = emails[0];
                          if (!primary) {
                            return <span style={{ color: 'var(--fg-muted)' }}>—</span>;
                          }
                          const isOpen = composerKey?.partnerId === p.id;
                          return (
                            <button
                              type="button"
                              onClick={() => setComposerKey(isOpen ? null : { partnerId: p.id, emailIdx: 0 })}
                              className="inline-flex items-center gap-1.5"
                              style={{
                                color: isOpen ? 'var(--brand-rot)' : 'var(--line-innoweiss, #0D199E)',
                                fontWeight: 700,
                                fontSize: 13,
                                letterSpacing: 0,
                                textAlign: 'left',
                              }}
                            >
                              <Mail size={14} />
                              <span style={{ borderBottom: '1px dotted currentColor' }}>{primary.email}</span>
                            </button>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3" style={{ fontWeight: 700 }}>
                        {netBalances[p.id] ? (
                          <NetBalance
                            usd={netBalances[p.id]!.usd}
                            currencies={netBalances[p.id]!.currencies}
                            size="compact"
                          />
                        ) : (
                          <span style={{ color: 'var(--fg-muted)' }}>—</span>
                        )}
                      </td>
                      <td className="px-4 py-3" style={{ fontWeight: 700, color: 'var(--fg-1)' }}>
                        {p.contract_no ? p.contract_no : <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>—</span>}
                      </td>
                    </tr>
                    {composerKey?.partnerId === p.id && (() => {
                      const emails = parseEmails(p.email);
                      const target = emails[0];
                      if (!target) return null;
                      return (
                        <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                          <td colSpan={10} style={{ padding: 0, background: 'var(--paper-sunk)' }}>
                            <EmailComposer
                              partnerName={p.trade_name}
                              recipientEmail={target.email}
                              onClose={() => setComposerKey(null)}
                            />
                          </td>
                        </tr>
                      );
                    })()}
                    </Fragment>
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
    <th className="text-left px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>
      {children}
    </th>
  );
}

// =============================================================================
// Inline email composer — renders inside a colspan row under the partner.
// Send goes through /api/email/send which proxies to emailer-bridge serverside.
// All email rules from Aram's preferences apply: this is a send tool, not a
// preview tool. The actual send still passes through the API which preserves
// the emailer-skill confirmation/audit flow on the backend.
// =============================================================================

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

function EmailComposer({
  partnerName, recipientEmail, onClose,
}: {
  partnerName: string;
  recipientEmail: string;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<null | { ok: boolean; message: string }>(null);

  const handleSend = async () => {
    if (!subject.trim() || !body.trim()) {
      setResult({ ok: false, message: 'Subject and body are required' });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const r = await fetch(`${API_BASE}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          recipient: recipientEmail,
          subject: subject.trim(),
          body_plain: body.trim(),
        }),
      });
      const data = await r.json();
      if (data.success) {
        setResult({ ok: true, message: `Sent to ${recipientEmail}` });
        setTimeout(onClose, 1500);
      } else {
        const errMsg = data.errors?.[0]?.message ?? 'Send failed';
        setResult({ ok: false, message: errMsg });
      }
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : 'Network error',
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>
          To: <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{partnerName}</span>
          <span style={{ marginLeft: 8, color: 'var(--fg-2)' }}>{`<${recipientEmail}>`}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{ color: 'var(--fg-3)', padding: 4 }}
          aria-label="Close composer"
        >
          <X size={16} />
        </button>
      </div>

      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        disabled={sending}
        style={{
          padding: '8px 12px',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 14,
          fontWeight: 700,
          background: 'var(--paper-base, #fff)',
          color: 'var(--fg-1)',
        }}
      />

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Message body"
        disabled={sending}
        rows={6}
        style={{
          padding: '10px 12px',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 14,
          fontWeight: 400,
          background: 'var(--paper-base, #fff)',
          color: 'var(--fg-1)',
          resize: 'vertical',
          fontFamily: 'inherit',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          onClick={handleSend}
          disabled={sending || !subject.trim() || !body.trim()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 16px',
            borderRadius: 'var(--radius-sm)',
            background: sending || !subject.trim() || !body.trim() ? 'var(--paper-sunk)' : 'var(--brand-rot, #E5202C)',
            color: sending || !subject.trim() || !body.trim() ? 'var(--fg-3)' : 'white',
            fontSize: 14,
            fontWeight: 700,
            cursor: sending || !subject.trim() || !body.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {sending ? 'Sending…' : 'Send'}
        </button>

        <button
          type="button"
          onClick={onClose}
          disabled={sending}
          style={{
            padding: '8px 14px',
            background: 'transparent',
            color: 'var(--fg-3)',
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Cancel
        </button>

        {result && (
          <span
            style={{
              fontSize: 13,
              color: result.ok ? 'var(--status-success, #2E7D4F)' : 'var(--brand-rot, #A82029)',
              fontWeight: 500,
            }}
          >
            {result.message}
          </span>
        )}
      </div>
    </div>
  );
}


