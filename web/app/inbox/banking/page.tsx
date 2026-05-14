'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import AssignWizard from '@/components/banking/AssignWizard';
import {
  Loader2, RefreshCw, AlertCircle, CheckCircle2, ChevronDown,
  Link2, UserPlus, FastForward, ArrowUpRight, Wallet, Trash2, Sparkles, X,
} from 'lucide-react';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

// =============================================================================
// Types
// =============================================================================

type Bucket =
  | 'all'
  | 'partner_not_found'
  | 'partner_auto_created'
  | 'ambiguous'
  | 'auto_created_draft'
  | 'legacy_unmatched';

interface InboxItem {
  id: string;
  direction: 'incoming' | 'outgoing';
  amount: number; // minor units (kopeks)
  currency: string;
  executed_at: number;
  contragent_name: string;
  contragent_inn: string;
  payment_purpose: string;
  matched_operation_id: string | null;
  match_method: string | null;
  matched_at: number | null;
  matched_operation_ref: string | null;
  matched_operation_status: string | null;
  matched_operation_notes: string | null;
  guess_partner_id: string | null;
  guess_partner_name: string | null;
  guess_partner_kind: string | null;
  suggested_category_id: string | null;
  suggested_confidence: number | null;
  suggested_reason: string | null;
  suggested_category_label: string | null;
  suggested_category_color: string | null;
  suggested_category_always_confirm: number | null;
  suggested_category_op_type: string | null;
}

interface Suggestion {
  id: string;
  reference: string;
  total_amount: number;
  currency: string;
  operation_date: number;
  status: string;
  partner_name: string;
}

interface Counts {
  total: number;
  buckets: Record<string, number>;
}

// =============================================================================
// Bucket meta — labels + colors
// =============================================================================

const BUCKET_META: Record<Bucket, { label: string; description: string; dot: string }> = {
  all: {
    label: 'All',
    description: 'Every unresolved bank transaction',
    dot: 'var(--fg-3)',
  },
  partner_not_found: {
    label: 'No partner',
    description: 'INN not found and no service keywords. Needs manual partner assignment.',
    dot: '#E5202C',
  },
  partner_auto_created: {
    label: 'New partner — verify',
    description: 'Partner was auto-created from the payment text. Confirm name and category.',
    dot: '#A06A2C',
  },
  ambiguous: {
    label: 'Ambiguous',
    description: 'Multiple candidate operations match. Pick one.',
    dot: '#7D481C',
  },
  auto_created_draft: {
    label: 'Draft created',
    description: 'No candidate operation matched. A draft was created — confirm or merge.',
    dot: '#0D199E',
  },
  legacy_unmatched: {
    label: 'Legacy',
    description: 'Pre-cascade transactions never auto-processed.',
    dot: 'var(--fg-muted)',
  },
};

const BUCKET_ORDER: Bucket[] = [
  'all',
  'partner_not_found',
  'partner_auto_created',
  'ambiguous',
  'auto_created_draft',
  'legacy_unmatched',
];

const PARTNER_KIND_OPTIONS = [
  { value: 'service_provider', label: 'Service provider (rent, fulfilment, services)' },
  { value: '3pl', label: '3PL / warehouse / logistics provider' },
  { value: 'shipper', label: 'Shipper / freight forwarder' },
  { value: 'manufacturer', label: 'Manufacturer / goods supplier' },
  { value: 'buyer', label: 'Buyer / customer' },
  { value: 'service_provider', label: 'Other' },
];

// =============================================================================
// Formatters
// =============================================================================

function formatMoney(minor: number, currency: string): string {
  const major = minor / 100;
  return `${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatMoneyMajor(major: number, currency: string): string {
  return `${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatDate(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function cleanContragent(name: string): string {
  if (!name) return '—';
  return name
    .replace(/^ОБЩЕСТВО\s+С\s+ОГРАНИЧЕННОЙ\s+ОТВЕТСТВЕННОСТЬЮ\s*/i, 'ООО ')
    .replace(/^ИНДИВИДУАЛЬНЫЙ\s+ПРЕДПРИНИМАТЕЛЬ\s*/i, 'ИП ')
    .replace(/"/g, '')
    .trim();
}

// =============================================================================
// Page
// =============================================================================

export default function InboxBankingPage() {
  const [bucket, setBucket] = useState<Bucket>('all');
  const [items, setItems] = useState<InboxItem[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadCounts = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/inbox/banking/counts`);
      const data = await r.json();
      if (data.success && data.result) setCounts(data.result);
    } catch (e) {
      // ignore — counts are optional UI sugar
    }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/inbox/banking?filter=${bucket}&limit=100`);
      const data = await r.json();
      if (data.success && data.result) {
        setItems(data.result.items || []);
      } else {
        setError(data.errors?.[0]?.message || 'Failed to load');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [bucket]);

  useEffect(() => { loadCounts(); }, [loadCounts]);
  useEffect(() => { loadItems(); }, [loadItems]);

  const refresh = useCallback(() => {
    loadCounts();
    loadItems();
    setExpandedId(null);
  }, [loadCounts, loadItems]);

  return (
    <div className="px-6 py-6 max-w-[1400px] mx-auto" style={{ fontSize: 14, letterSpacing: 0 }}>
      <Header counts={counts} loading={loading} onRefresh={refresh} />

      <Tabs current={bucket} counts={counts} onChange={(b) => { setBucket(b); setExpandedId(null); }} />

      <div className="text-[13px]" style={{ color: 'var(--fg-3)', marginBottom: 16 }}>
        {BUCKET_META[bucket].description}
      </div>

      {error && (
        <div
          className="flex items-center gap-2 px-4 py-3 mb-4 rounded"
          style={{ background: 'rgba(229,32,44,0.08)', color: '#A82029' }}
        >
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center gap-2 py-8" style={{ color: 'var(--fg-3)' }}>
          <Loader2 size={16} className="animate-spin" />
          Loading…
        </div>
      ) : items.length === 0 ? (
        <EmptyState bucket={bucket} />
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <InboxRow
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
              onResolved={refresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Header
// =============================================================================

function Header({
  counts, loading, onRefresh,
}: {
  counts: Counts | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div>
        <h1 className="font-bold" style={{ fontSize: 20, letterSpacing: 0, color: 'var(--fg-1)' }}>
          Banking Inbox
        </h1>
        <div className="text-[13px]" style={{ color: 'var(--fg-3)', marginTop: 2 }}>
          {counts !== null && (
            <>
              <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{counts.total}</span>
              <span> unresolved bank transactions</span>
            </>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="flex items-center gap-2 px-3 py-1.5 rounded"
        style={{
          background: 'var(--paper-sunk)',
          color: 'var(--fg-2)',
          fontSize: 13,
          fontWeight: 500,
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        Refresh
      </button>
    </div>
  );
}

// =============================================================================
// Tabs
// =============================================================================

function Tabs({
  current, counts, onChange,
}: {
  current: Bucket;
  counts: Counts | null;
  onChange: (b: Bucket) => void;
}) {
  return (
    <div
      className="flex gap-1 mb-3 border-b"
      style={{ borderColor: 'var(--paper-divider, rgba(0,0,0,0.08))' }}
    >
      {BUCKET_ORDER.map((b) => {
        const cnt = counts?.buckets[b];
        const isCurrent = current === b;
        return (
          <button
            key={b}
            type="button"
            onClick={() => onChange(b)}
            className="flex items-center gap-2 px-3 py-2"
            style={{
              fontSize: 14,
              fontWeight: isCurrent ? 700 : 500,
              color: isCurrent ? 'var(--fg-1)' : 'var(--fg-3)',
              borderBottom: isCurrent ? `2px solid ${BUCKET_META[b].dot}` : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            <span
              style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                background: BUCKET_META[b].dot, opacity: isCurrent ? 1 : 0.5,
              }}
            />
            {BUCKET_META[b].label}
            {cnt !== undefined && cnt > 0 && (
              <span
                style={{
                  fontSize: 12, fontWeight: 600,
                  padding: '1px 6px', borderRadius: 8,
                  background: isCurrent ? BUCKET_META[b].dot : 'var(--paper-sunk)',
                  color: isCurrent ? 'white' : 'var(--fg-3)',
                  minWidth: 20, textAlign: 'center',
                }}
              >
                {cnt}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// Empty state
// =============================================================================

function EmptyState({ bucket }: { bucket: Bucket }) {
  return (
    <div
      className="flex flex-col items-center justify-center py-16"
      style={{ color: 'var(--fg-3)' }}
    >
      <CheckCircle2 size={32} style={{ color: '#3E9E63', marginBottom: 8 }} />
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-1)' }}>
        {bucket === 'all' ? 'Inbox is clear' : `No items in ${BUCKET_META[bucket].label}`}
      </div>
      <div style={{ fontSize: 13, marginTop: 4 }}>
        New bank transactions arrive here when auto-match cannot resolve them.
      </div>
    </div>
  );
}

// =============================================================================
// Inbox Row — collapsed line + expandable resolution panel
// =============================================================================

function InboxRow({
  item, expanded, onToggle, onResolved,
}: {
  item: InboxItem;
  expanded: boolean;
  onToggle: () => void;
  onResolved: () => void;
}) {
  const dirColor = item.direction === 'incoming' ? '#3E9E63' : '#A82029';
  const dirLabel = item.direction === 'incoming' ? 'IN' : 'OUT';

  return (
    <div
      className="rounded"
      style={{
        background: 'var(--paper-base, #fff)',
        border: `1px solid var(--paper-divider, rgba(0,0,0,0.08))`,
      }}
    >
      {/* Collapsed line */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        <span
          style={{
            fontSize: 11, fontWeight: 700, letterSpacing: 0,
            padding: '2px 6px', borderRadius: 4,
            background: `${dirColor}14`, color: dirColor,
            minWidth: 30, textAlign: 'center',
          }}
        >
          {dirLabel}
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-1)', minWidth: 160 }}>
          {formatMoney(item.amount, item.currency)}
        </span>
        <span style={{ fontSize: 13, color: 'var(--fg-2)', flex: 1, minWidth: 0 }}>
          <span className="truncate inline-block max-w-full" style={{ verticalAlign: 'bottom' }}>
            {cleanContragent(item.contragent_name)}
          </span>
        </span>
        {item.suggested_category_id && item.suggested_category_label && (
          <span
            title={item.suggested_reason || ''}
            style={{
              fontSize: 12, fontWeight: 700,
              padding: '3px 8px', borderRadius: 4,
              background: `${item.suggested_category_color || '#5B4A2F'}1A`,
              color: item.suggested_category_color || '#5B4A2F',
              whiteSpace: 'nowrap',
              border: `1px solid ${item.suggested_category_color || '#5B4A2F'}33`,
            }}
          >
            {item.suggested_category_label}
            {item.suggested_confidence != null && (
              <span style={{ opacity: 0.7, marginLeft: 4 }}>
                {Math.round(item.suggested_confidence * 100)}%
              </span>
            )}
          </span>
        )}
        <span style={{ fontSize: 12, color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>
          {formatDate(item.executed_at)}
        </span>
        <ChevronDown
          size={16}
          style={{
            color: 'var(--fg-3)',
            transform: expanded ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        />
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div
          style={{
            borderTop: '1px solid var(--paper-divider, rgba(0,0,0,0.08))',
            padding: 16,
            background: 'var(--paper-sunk)',
          }}
        >
          <Details item={item} />
          <AssignWizard item={{
            id: item.id,
            direction: item.direction,
            amount: item.amount,
            currency: item.currency,
            executed_at: item.executed_at,
            contragent_name: item.contragent_name,
            contragent_inn: item.contragent_inn,
            payment_purpose: item.payment_purpose,
          }} onResolved={onResolved} />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Details — payment context for the operator to decide
// =============================================================================

function Details({ item }: { item: InboxItem }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 8, fontSize: 13, marginBottom: 16 }}>
      <span style={{ color: 'var(--fg-3)' }}>Counterparty</span>
      <span style={{ color: 'var(--fg-2)' }}>
        <span style={{ fontWeight: 700 }}>{cleanContragent(item.contragent_name)}</span>
        {item.contragent_inn && (
          <span style={{ color: 'var(--fg-3)', marginLeft: 8 }}>
            ИНН {item.contragent_inn}
          </span>
        )}
      </span>

      <span style={{ color: 'var(--fg-3)' }}>Payment purpose</span>
      <span style={{ color: 'var(--fg-2)', lineHeight: 1.4 }}>{item.payment_purpose || '—'}</span>

      {item.matched_operation_ref && (
        <>
          <span style={{ color: 'var(--fg-3)' }}>Currently attached to</span>
          <span>
            <Link
              href={`/operations/${item.matched_operation_id}`}
              style={{ fontWeight: 700, color: 'var(--line-innoweiss, #0D199E)' }}
            >
              {item.matched_operation_ref}
            </Link>
            <span style={{ color: 'var(--fg-3)', marginLeft: 8 }}>
              {item.matched_operation_status}
            </span>
          </span>
        </>
      )}

      {item.guess_partner_id && !item.matched_operation_ref && (
        <>
          <span style={{ color: 'var(--fg-3)' }}>Partner suggestion</span>
          <span>
            <span style={{ fontWeight: 700 }}>{item.guess_partner_name}</span>
            <span style={{ color: 'var(--fg-3)', marginLeft: 8, fontSize: 12 }}>
              {item.guess_partner_kind}
            </span>
          </span>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Resolution Actions — buttons + form panels
// =============================================================================

type ActionMode = null | 'attach' | 'assign' | 'promote' | 'skip';

function ResolutionActions({
  item, onResolved,
}: {
  item: InboxItem;
  onResolved: () => void;
}) {
  const [mode, setMode] = useState<ActionMode>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ruleDialogOpId, setRuleDialogOpId] = useState<string | null>(null);

  const doSimple = useCallback(async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await fetch(`${API_BASE}/api/inbox/banking/${item.id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (data.success) {
        onResolved();
      } else {
        setActionError(data.errors?.[0]?.message || 'Action failed');
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [item.id, onResolved]);

  return (
    <div>
      {actionError && (
        <div
          className="flex items-center gap-2 px-3 py-2 mb-3 rounded"
          style={{ background: 'rgba(229,32,44,0.08)', color: '#A82029', fontSize: 13 }}
        >
          <AlertCircle size={14} /> {actionError}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        <ActionButton
          icon={<Link2 size={14} />}
          label="Attach to operation"
          active={mode === 'attach'}
          onClick={() => setMode(mode === 'attach' ? null : 'attach')}
        />
        <ActionButton
          icon={<UserPlus size={14} />}
          label="Assign / create partner"
          active={mode === 'assign'}
          onClick={() => setMode(mode === 'assign' ? null : 'assign')}
        />
        {item.matched_operation_id && (
          <ActionButton
            icon={<CheckCircle2 size={14} />}
            label="Confirm draft"
            active={false}
            disabled={busy}
            onClick={() => doSimple('promote-draft', { confirm: true })}
          />
        )}
        <ActionButton
          icon={<Trash2 size={14} />}
          label="Dismiss"
          active={false}
          disabled={busy}
          onClick={() => {
            if (confirm('Dismiss this transaction from the inbox? It stays in bank history.')) {
              doSimple('skip', { reason: 'dismissed' });
            }
          }}
        />
      </div>

      {mode === 'attach' && (
        <AttachPanel
          item={item}
          busy={busy}
          setBusy={setBusy}
          setActionError={setActionError}
          onResolved={(opId) => {
            if (opId) setRuleDialogOpId(opId);
            else onResolved();
          }}
        />
      )}

      {mode === 'assign' && (
        <AssignPartnerPanel
          item={item}
          busy={busy}
          setBusy={setBusy}
          setActionError={setActionError}
          onResolved={onResolved}
        />
      )}
    
      {ruleDialogOpId && (
        <RuleSuggestionDialog
          txId={item.id}
          operationId={ruleDialogOpId}
          onClose={() => { setRuleDialogOpId(null); onResolved(); }}
          onConfirm={() => { setRuleDialogOpId(null); onResolved(); }}
        />
      )}

      </div>
  );
}

function ActionButton({
  icon, label, active, onClick, disabled,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2 px-3 py-1.5 rounded"
      style={{
        fontSize: 13,
        fontWeight: active ? 700 : 500,
        background: active ? 'var(--fg-1)' : 'var(--paper-base, #fff)',
        color: active ? 'white' : 'var(--fg-2)',
        border: `1px solid ${active ? 'var(--fg-1)' : 'var(--paper-divider, rgba(0,0,0,0.12))'}`,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// =============================================================================
// Attach panel — load suggestions, let user pick one
// =============================================================================

function AttachPanel({
  item, busy, setBusy, setActionError, onResolved,
}: {
  item: InboxItem;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setActionError: (s: string | null) => void;
  onResolved: (operationId?: string) => void;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loadingSugg, setLoadingSugg] = useState(true);

  useEffect(() => {
    (async () => {
      setLoadingSugg(true);
      try {
        const r = await fetch(`${API_BASE}/api/inbox/banking/${item.id}/suggestions`);
        const data = await r.json();
        if (data.success && data.result) {
          setSuggestions(data.result.candidates || []);
        }
      } catch (e) {
        setSuggestions([]);
      } finally {
        setLoadingSugg(false);
      }
    })();
  }, [item.id]);

  const attach = useCallback(async (operationId: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await fetch(`${API_BASE}/api/inbox/banking/${item.id}/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation_id: operationId }),
      });
      const data = await r.json();
      if (data.success) onResolved(operationId);
      else setActionError(data.errors?.[0]?.message || 'Attach failed');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [item.id, onResolved, setBusy, setActionError]);

  return (
    <div
      style={{
        background: 'var(--paper-base, #fff)',
        border: '1px solid var(--paper-divider, rgba(0,0,0,0.08))',
        borderRadius: 4, padding: 12, marginTop: 4,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
        Candidate operations (±90 days, ±5% amount)
      </div>
      {loadingSugg ? (
        <div className="flex items-center gap-2" style={{ color: 'var(--fg-3)', fontSize: 13 }}>
          <Loader2 size={14} className="animate-spin" /> Loading suggestions…
        </div>
      ) : !suggestions || suggestions.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>
          No matching operations found. Use Assign partner to create a new operation.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => attach(s.id)}
              style={{
                display: 'grid',
                gridTemplateColumns: '110px 1fr 130px 100px 24px',
                gap: 12, alignItems: 'center',
                padding: '8px 10px', borderRadius: 4,
                background: 'var(--paper-sunk)',
                border: '1px solid transparent',
                fontSize: 13, textAlign: 'left',
                cursor: busy ? 'default' : 'pointer',
              }}
            >
              <span style={{ fontWeight: 700, color: 'var(--line-innoweiss, #0D199E)' }}>
                {s.reference}
              </span>
              <span style={{ color: 'var(--fg-2)' }}>{s.partner_name}</span>
              <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>
                {formatMoneyMajor(s.total_amount, s.currency)}
              </span>
              <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>
                {formatDate(s.operation_date)}
              </span>
              <ArrowUpRight size={14} style={{ color: 'var(--fg-3)' }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Assign Partner panel — pick existing or create new
// =============================================================================

function AssignPartnerPanel({
  item, busy, setBusy, setActionError, onResolved,
}: {
  item: InboxItem;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setActionError: (s: string | null) => void;
  onResolved: () => void;
}) {
  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ id: string; trade_name: string; kind: string; tax_id: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [newName, setNewName] = useState(cleanContragent(item.contragent_name));
  const [newKind, setNewKind] = useState('service_provider');
  const [newInn, setNewInn] = useState(item.contragent_inn || '');

  const runSearch = useCallback(async (q: string) => {
    if (!q || q.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      // Reuse existing partners search endpoint if available; fall back to listing
      const r = await fetch(`${API_BASE}/api/partners?search=${encodeURIComponent(q)}&limit=8`);
      const data = await r.json();
      if (data.success && data.result) {
        const items = Array.isArray(data.result) ? data.result : (data.result.items || []);
        setSearchResults(items.map((p: { id: string; trade_name: string; kind?: string; tax_id?: string }) => ({
          id: p.id, trade_name: p.trade_name, kind: p.kind || '', tax_id: p.tax_id || '',
        })));
      }
    } catch (e) {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => runSearch(search), 250);
    return () => clearTimeout(t);
  }, [search, runSearch]);

  const assignExisting = useCallback(async (partnerId: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await fetch(`${API_BASE}/api/inbox/banking/${item.id}/assign-partner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partner_id: partnerId }),
      });
      const data = await r.json();
      if (data.success) onResolved();
      else setActionError(data.errors?.[0]?.message || 'Assign failed');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [item.id, onResolved, setBusy, setActionError]);

  const createNew = useCallback(async () => {
    if (!newName.trim()) {
      setActionError('Trade name required');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const r = await fetch(`${API_BASE}/api/inbox/banking/${item.id}/assign-partner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trade_name: newName.trim(),
          kind: newKind,
          tax_id: newInn.trim() || undefined,
        }),
      });
      const data = await r.json();
      if (data.success) onResolved();
      else setActionError(data.errors?.[0]?.message || 'Create failed');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [item.id, newName, newKind, newInn, onResolved, setBusy, setActionError]);

  return (
    <div
      style={{
        background: 'var(--paper-base, #fff)',
        border: '1px solid var(--paper-divider, rgba(0,0,0,0.08))',
        borderRadius: 4, padding: 12, marginTop: 4,
      }}
    >
      <div className="flex gap-1 mb-3" style={{ borderBottom: '1px solid var(--paper-divider, rgba(0,0,0,0.08))' }}>
        {(['existing', 'new'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              padding: '6px 12px', fontSize: 13,
              fontWeight: tab === t ? 700 : 500,
              color: tab === t ? 'var(--fg-1)' : 'var(--fg-3)',
              borderBottom: tab === t ? '2px solid var(--fg-1)' : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {t === 'existing' ? 'Pick existing partner' : 'Create new partner'}
          </button>
        ))}
      </div>

      {tab === 'existing' ? (
        <div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type partner name…"
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 4,
              border: '1px solid var(--paper-divider, rgba(0,0,0,0.15))',
              fontSize: 14, fontWeight: 700,
              marginBottom: 8,
            }}
          />
          {searching && (
            <div className="flex items-center gap-2" style={{ color: 'var(--fg-3)', fontSize: 13 }}>
              <Loader2 size={14} className="animate-spin" /> Searching…
            </div>
          )}
          {!searching && searchResults.length === 0 && search.length >= 2 && (
            <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>
              No matches. Switch to <span style={{ fontWeight: 700 }}>Create new partner</span>.
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {searchResults.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                onClick={() => assignExisting(p.id)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 10px', borderRadius: 4,
                  background: 'var(--paper-sunk)',
                  fontSize: 13, textAlign: 'left', cursor: busy ? 'default' : 'pointer',
                }}
              >
                <span>
                  <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{p.trade_name}</span>
                  <span style={{ color: 'var(--fg-3)', marginLeft: 8 }}>{p.kind}</span>
                </span>
                {p.tax_id && (
                  <span style={{ color: 'var(--fg-3)', fontSize: 12 }}>ИНН {p.tax_id}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Field label="Trade name">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Category">
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              style={inputStyle}
            >
              {PARTNER_KIND_OPTIONS.map((opt, i) => (
                <option key={`${opt.value}-${i}`} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </Field>
          <Field label="ИНН (optional)">
            <input
              type="text"
              value={newInn}
              onChange={(e) => setNewInn(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <button
            type="button"
            disabled={busy}
            onClick={createNew}
            style={{
              padding: '8px 14px', borderRadius: 4,
              background: 'var(--fg-1)', color: 'white',
              fontSize: 13, fontWeight: 700,
              opacity: busy ? 0.6 : 1, alignSelf: 'flex-start',
            }}
          >
            {busy ? 'Creating…' : 'Create partner and close operation'}
          </button>
          <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>
            For service categories (service_provider, 3pl, shipper) the operation is auto-closed as recognised expense.
            For goods categories a draft operation is created for later review.
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <span style={{ color: 'var(--fg-3)' }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 4,
  border: '1px solid var(--paper-divider, rgba(0,0,0,0.15))',
  fontSize: 14,
  fontWeight: 700,
  background: 'var(--paper-base, #fff)',
  color: 'var(--fg-1)',
};


// =============================================================================
// Rule Suggestion Dialog — shown after attach/assign succeeds
// =============================================================================
function RuleSuggestionDialog({
  txId, operationId, onClose, onConfirm,
}: {
  txId: string; operationId: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [suggestion, setSuggestion] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/bank-match-rules/suggest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tx_id: txId, operation_id: operationId }),
        });
        const data = await r.json();
        if (data.success && data.result?.suggestion) {
          setSuggestion(data.result.suggestion);
          setPattern(data.result.suggestion.purpose_pattern || '');
        }
      } catch {} finally {
        setLoading(false);
      }
    })();
  }, [txId, operationId]);

  const createRule = async () => {
    if (!suggestion) return;
    setCreating(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/bank-match-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partner_id: suggestion.partner_id,
          contragent_inn: suggestion.contragent_inn,
          purpose_pattern: pattern || null,
          direction: suggestion.direction,
          default_operation_type: suggestion.default_operation_type,
          default_our_company_id: suggestion.default_our_company_id,
          created_from_tx_id: txId,
        }),
      });
      const data = await r.json();
      if (data.success) {
        onConfirm();
      } else {
        setError(data.errors?.[0]?.message || 'Failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  if (loading) return null;
  if (!suggestion) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(15,15,15,0.50)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 60, padding: '24px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--paper)', borderRadius: 'var(--radius-md)',
          padding: '24px', width: '560px', maxWidth: '95vw',
          border: '1px solid var(--line-1)',
        }}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles size={18} style={{ color: 'var(--brand-rot)' }} />
            <h2 style={{
              fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '18px',
              fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase',
            }}>
              Save as rule?
            </h2>
          </div>
          <button onClick={onClose} style={{ color: 'var(--fg-3)' }}><X size={18} /></button>
        </div>

        <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '16px' }}>
          Next time a similar transaction arrives, ERP will auto-attach it to a matching operation without asking.
        </p>

        <div style={{ marginBottom: '12px' }}>
          <label style={{ fontSize: '14px', color: 'var(--fg-2)', fontWeight: 700, display: 'block', marginBottom: '4px' }}>
            Purpose pattern (substring match)
          </label>
          <input
            type="text"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="e.g. Accounting Services"
            style={{
              width: '100%', padding: '8px 12px', fontSize: '14px', fontWeight: 700,
              border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)', color: 'var(--fg-1)',
            }}
          />
          <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
            Leave empty if INN alone is enough (any payment from this INN → same operation type).
          </div>
        </div>

        <div style={{
          padding: '12px', background: 'var(--paper-sunk)',
          borderRadius: 'var(--radius-sm)', fontSize: '14px',
          color: 'var(--fg-2)', marginBottom: '16px',
        }}>
          <div style={{ marginBottom: '4px' }}>
            <span style={{ color: 'var(--fg-3)' }}>INN:</span>{' '}
            <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{suggestion.contragent_inn || '(none)'}</span>
          </div>
          <div style={{ marginBottom: '4px' }}>
            <span style={{ color: 'var(--fg-3)' }}>Direction:</span>{' '}
            <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{suggestion.direction}</span>
          </div>
          <div style={{ marginBottom: '4px' }}>
            <span style={{ color: 'var(--fg-3)' }}>Operation type:</span>{' '}
            <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{suggestion.default_operation_type}</span>
          </div>
          {suggestion.rationale && (
            <div style={{ marginTop: '8px', fontSize: '14px', color: 'var(--fg-3)', fontStyle: 'italic' }}>
              {suggestion.rationale}
            </div>
          )}
        </div>

        {error && (
          <div style={{
            marginBottom: '12px', padding: '12px',
            background: 'rgba(229,32,44,0.08)', color: '#A82029',
            borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700,
          }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} style={{
            padding: '8px 16px', border: '1px solid var(--line-1)',
            borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper)',
            color: 'var(--fg-1)', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
          }}>
            Not now
          </button>
          <button
            onClick={createRule}
            disabled={creating}
            style={{
              padding: '8px 16px', borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--fg-1)', color: 'var(--paper)',
              fontSize: '14px', fontWeight: 700,
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              cursor: creating ? 'wait' : 'pointer',
              opacity: creating ? 0.6 : 1,
            }}
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            Create rule
          </button>
        </div>
      </div>
    </div>
  );
}

