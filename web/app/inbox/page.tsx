'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, RefreshCw, Inbox, AlertCircle, CheckCircle2, XCircle, FileText, Link2, Search, X } from 'lucide-react';

interface InboxItem {
  id: string;
  email_from: string;
  email_subject: string | null;
  email_received_at: number;
  email_snippet: string | null;
  attachment_filename: string | null;
  attachment_r2_key: string | null;
  classification: string;
  classification_confidence: number | null;
  extracted_vendor_name: string | null;
  extracted_vendor_inn: string | null;
  extracted_invoice_no: string | null;
  extracted_invoice_date: string | null;
  extracted_period: string | null;
  extracted_currency: string | null;
  extracted_amount: number | null;
  extracted_vendor_email: string | null;
  extracted_vendor_country: string | null;
  extracted_vendor_address: string | null;
  extracted_bank_name: string | null;
  extracted_bank_account: string | null;
  extracted_iban: string | null;
  extracted_swift: string | null;
  extracted_service_category: string | null;
  extracted_buyer_entity: string | null;
  status: string;
  matched_partner_id: string | null;
  created_operation_id: string | null;
  /** Operation reference for created_operation_id (joined by GET /api/inbox). */
  created_operation_reference?: string | null;
  /** Auto-matcher suggestion: target operation if confidence < auto threshold. */
  suggested_operation_id: string | null;
  suggested_operation_reference?: string | null;
  suggested_match_confidence: number | null;
  suggested_match_reason: string | null;
  notes: string | null;
  line_items: Array<{ description: string; line_total: number }> | null;
}

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

type FilterMode = 'open' | 'resolved' | 'all';

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('open');
  const [actionId, setActionId] = useState<string | null>(null);
  // Attach-to-existing-operation modal target. When non-null, modal is open.
  const [attachItem, setAttachItem] = useState<InboxItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/inbox?status=${filter}&limit=100`);
      const data = await res.json();
      if (data.success && data.result) {
        setItems(data.result.items);
      } else {
        setError(data.errors?.[0]?.message ?? 'Failed to load');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function handleConfirm(item: InboxItem) {
    setActionId(item.id);
    try {
      const res = await fetch(`${API_BASE}/api/inbox/${item.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!data.success) {
        alert(`Failed: ${data.errors?.[0]?.message ?? 'Unknown'}`);
      } else {
        await load();
      }
    } finally {
      setActionId(null);
    }
  }

  async function handleReject(item: InboxItem) {
    if (!confirm(`Reject "${item.extracted_vendor_name ?? item.email_from}"? This won't create any partner or operation.`)) return;
    setActionId(item.id);
    try {
      const res = await fetch(`${API_BASE}/api/inbox/${item.id}/reject`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!data.success) {
        alert(`Failed: ${data.errors?.[0]?.message ?? 'Unknown'}`);
      } else {
        await load();
      }
    } finally {
      setActionId(null);
    }
  }

  async function handleAttach(item: InboxItem, operationId: string, opReference: string | null) {
    setActionId(item.id);
    try {
      const res = await fetch(`${API_BASE}/api/inbox/${item.id}/attach-to-operation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation_id: operationId }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(`Failed to attach: ${data.errors?.[0]?.message ?? 'Unknown'}`);
      } else {
        setAttachItem(null);
        await load();
        // Soft confirmation in console — main feedback is the list refresh.
        console.log(`Attached to ${opReference ?? operationId} as ${data.result?.kind}`);
      }
    } catch (e) {
      alert(`Network error: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="space-y-6 max-w-full">
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Inbox className="h-7 w-7" style={{ color: 'var(--brand-rot)' }} />
            <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--fg-1)' }}>Inbox</h1>
          </div>
          <p style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 4 }}>
            Invoices auto-detected in dasexperten@gmail.com — confirm or reject each one
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2"
          style={{
            fontSize: 14, fontWeight: 700, color: 'var(--fg-1)',
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="flex items-center gap-1" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
        <FilterButton active={filter === 'open'} onClick={() => setFilter('open')} label="Open" />
        <FilterButton active={filter === 'resolved'} onClick={() => setFilter('resolved')} label="Resolved" />
        <FilterButton active={filter === 'all'} onClick={() => setFilter('all')} label="All" />
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4" style={{
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-sm)',
        }}>
          <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--brand-rot)' }} />
          <div style={{ fontSize: 14, color: 'var(--fg-1)' }}>{error}</div>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
          No invoices in this view.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <InvoiceCard
              key={item.id}
              item={item}
              busy={actionId === item.id}
              onConfirm={() => handleConfirm(item)}
              onReject={() => handleReject(item)}
              onAttach={() => setAttachItem(item)}
              onAttachToSuggested={() => {
                if (item.suggested_operation_id) {
                  handleAttach(item, item.suggested_operation_id, item.suggested_operation_reference ?? null);
                }
              }}
            />
          ))}
        </div>
      )}

      {attachItem && (
        <AttachModal
          item={attachItem}
          busy={actionId === attachItem.id}
          onClose={() => setAttachItem(null)}
          onAttach={(opId, opRef) => handleAttach(attachItem, opId, opRef)}
        />
      )}
    </div>
  );
}

function FilterButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="px-5 py-3"
      style={{
        fontSize: 14,
        fontWeight: 700,
        color: active ? 'var(--brand-rot)' : 'var(--fg-3)',
        backgroundColor: 'transparent',
        borderBottom: active ? '2px solid var(--brand-rot)' : '2px solid transparent',
        marginBottom: '-1px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function InvoiceCard({
  item, busy, onConfirm, onReject, onAttach, onAttachToSuggested,
}: {
  item: InboxItem;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onAttach: () => void;
  /** One-click: attach to the auto-suggested operation. Bypasses the search modal. */
  onAttachToSuggested: () => void;
}) {
  const isResolved = ['manual_confirmed', 'auto_created', 'auto_attached', 'manual_rejected'].includes(item.status);
  const date = new Date(item.email_received_at * 1000).toLocaleDateString('ru-RU');
  const amountStr = item.extracted_amount !== null
    ? `${item.extracted_amount.toLocaleString('ru-RU')} ${item.extracted_currency ?? ''}`
    : '—';

  const classColor = {
    service: '#1D9E75',
    purchase: '#7F77DD',
    sale_payment: '#D9A300',
    not_invoice: '#888',
    error: '#C72127',
    pending: '#888',
    unclear: '#D9A300',
  }[item.classification] ?? '#888';

  const statusColor = {
    auto_created: '#1D9E75',
    auto_attached: '#1D9E75',
    manual_confirmed: '#1D9E75',
    manual_rejected: '#888',
    needs_partner_link: '#D9A300',
    needs_review: '#D9A300',
    queued: '#888',
    processed: '#888',
    error: '#C72127',
  }[item.status] ?? '#888';

  return (
    <div style={{
      backgroundColor: 'var(--paper)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-sm)',
      padding: '16px 20px',
    }}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span style={{
              fontSize: 14, fontWeight: 700, padding: '2px 8px',
              backgroundColor: classColor + '22', color: classColor,
              borderRadius: 'var(--radius-sm)',
            }}>
              {item.classification}
            </span>
            <span style={{
              fontSize: 14, fontWeight: 700, padding: '2px 8px',
              backgroundColor: statusColor + '22', color: statusColor,
              borderRadius: 'var(--radius-sm)',
            }}>
              {item.status.replace(/_/g, ' ')}
            </span>
            {item.classification_confidence !== null && (
              <span style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                {Math.round(item.classification_confidence * 100)}% confident
              </span>
            )}
          </div>

          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-1)', marginBottom: 4 }}>
            {item.extracted_vendor_name ?? item.email_from}
          </div>

          <div style={{ fontSize: 14, color: 'var(--fg-3)', marginBottom: 8 }}>
            {item.email_subject}
          </div>

          <div className="flex items-center gap-4" style={{ fontSize: 14 }}>
            <span style={{ color: 'var(--fg-3)' }}>
              Amount <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{amountStr}</span>
            </span>
            {item.extracted_invoice_no && (
              <span style={{ color: 'var(--fg-3)' }}>
                Invoice # <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.extracted_invoice_no}</span>
              </span>
            )}
            {item.extracted_period && (
              <span style={{ color: 'var(--fg-3)' }}>
                Period <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.extracted_period}</span>
              </span>
            )}
            <span style={{ color: 'var(--fg-3)' }}>
              Received <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{date}</span>
            </span>
          </div>

          {item.line_items && item.line_items.length > 0 && (
            <div className="mt-3 pl-3" style={{ borderLeft: '2px solid var(--border-hairline)', fontSize: 14 }}>
              {item.line_items.map((li, idx) => (
                <div key={idx} style={{ color: 'var(--fg-3)' }}>
                  • {li.description} <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{li.line_total.toLocaleString('ru-RU')} {item.extracted_currency}</span>
                </div>
              ))}
            </div>
          )}

          {/* Vendor details — what will be saved if Yes is clicked */}
          {(item.extracted_service_category || item.extracted_bank_name || item.extracted_vendor_country || item.extracted_buyer_entity) && (
            <div className="mt-3 pt-3 grid grid-cols-2 gap-x-6 gap-y-1" style={{ borderTop: '1px dashed var(--border-hairline)', fontSize: 14 }}>
              {item.extracted_service_category && (
                <div style={{ color: 'var(--fg-3)' }}>
                  Service category <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.extracted_service_category}</span>
                </div>
              )}
              {item.extracted_buyer_entity && (
                <div style={{ color: 'var(--fg-3)' }}>
                  Buyer entity <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.extracted_buyer_entity}</span>
                </div>
              )}
              {item.extracted_vendor_country && (
                <div style={{ color: 'var(--fg-3)' }}>
                  Vendor country <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.extracted_vendor_country}</span>
                </div>
              )}
              {item.extracted_vendor_email && (
                <div style={{ color: 'var(--fg-3)' }}>
                  Email <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.extracted_vendor_email}</span>
                </div>
              )}
              {item.extracted_bank_name && (
                <div style={{ color: 'var(--fg-3)' }}>
                  Bank <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.extracted_bank_name}</span>
                </div>
              )}
              {item.extracted_iban && (
                <div style={{ color: 'var(--fg-3)' }}>
                  IBAN <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.extracted_iban}</span>
                </div>
              )}
              {item.extracted_swift && (
                <div style={{ color: 'var(--fg-3)' }}>
                  SWIFT <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.extracted_swift}</span>
                </div>
              )}
            </div>
          )}

          {item.attachment_filename && (
            <div className="mt-2 flex items-center gap-2" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              <FileText className="h-3.5 w-3.5" />
              {item.attachment_filename}
            </div>
          )}

          {isResolved && item.created_operation_id && (
            <div className="mt-2 flex items-center gap-2" style={{ fontSize: 14 }}>
              <span style={{ color: 'var(--fg-3)' }}>
                {item.status === 'auto_attached' ? 'Auto-attached to' : 'Created operation'}
              </span>
              <a
                href={`/operations/${item.created_operation_id}`}
                style={{ fontWeight: 700, color: 'var(--brand-rot)', textDecoration: 'none' }}
              >
                {item.created_operation_reference ?? item.created_operation_id.slice(0, 12)}
              </a>
            </div>
          )}

          {/* Suggested-match banner: shown only when row is still open AND
              the auto-matcher found a candidate it wasn't confident enough
              to auto-attach. Provides a 1-click attach without opening
              the modal. */}
          {!isResolved && item.suggested_operation_id && item.suggested_match_confidence !== null && (
            <div className="mt-3 flex items-center justify-between gap-3 px-3 py-2" style={{
              backgroundColor: 'rgba(217,163,0,0.08)',
              border: '1px solid rgba(217,163,0,0.3)',
              borderRadius: 'var(--radius-sm)',
            }}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2" style={{ fontSize: 14 }}>
                  <span style={{ fontWeight: 700, color: '#9B7300' }}>
                    Suggested match · {Math.round(item.suggested_match_confidence * 100)}%
                  </span>
                  <span style={{ color: 'var(--fg-2)' }}>
                    {item.suggested_operation_reference ?? item.suggested_operation_id.slice(0, 12)}
                  </span>
                </div>
                {item.suggested_match_reason && (
                  <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 2 }}>
                    {item.suggested_match_reason}
                  </div>
                )}
              </div>
              <button
                onClick={onAttachToSuggested}
                disabled={busy}
                className="flex items-center gap-2 px-3 py-1.5"
                style={{
                  fontSize: 14, fontWeight: 700, color: 'white',
                  backgroundColor: '#9B7300',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  cursor: busy ? 'wait' : 'pointer',
                  flexShrink: 0,
                }}
                title={`Attach to ${item.suggested_operation_reference ?? 'this operation'} in one click`}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                Attach
              </button>
            </div>
          )}
        </div>

        {!isResolved && (
          <div className="flex flex-col gap-2 flex-shrink-0">
            <button
              onClick={onConfirm}
              disabled={busy}
              className="flex items-center justify-center gap-2 px-4 py-2"
              style={{
                fontSize: 14, fontWeight: 700, color: 'white',
                backgroundColor: '#1D9E75',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: busy ? 'wait' : 'pointer',
                minWidth: 100,
              }}
              title="Create a new operation and partner from this invoice"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Yes
            </button>
            <button
              onClick={onAttach}
              disabled={busy}
              className="flex items-center justify-center gap-2 px-4 py-2"
              style={{
                fontSize: 14, fontWeight: 700, color: 'var(--fg-1)',
                backgroundColor: 'var(--paper)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                cursor: busy ? 'wait' : 'pointer',
                minWidth: 100,
              }}
              title="Attach this PDF to an existing operation instead of creating a new one"
            >
              <Link2 className="h-4 w-4" />
              Attach
            </button>
            <button
              onClick={onReject}
              disabled={busy}
              className="flex items-center justify-center gap-2 px-4 py-2"
              style={{
                fontSize: 14, fontWeight: 700, color: 'var(--fg-1)',
                backgroundColor: 'var(--paper-sunk)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                cursor: busy ? 'wait' : 'pointer',
                minWidth: 100,
              }}
              title="Mark as not relevant — no operation, no partner"
            >
              <XCircle className="h-4 w-4" />
              No
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// AttachModal — search and pick an existing operation to attach the PDF to.
// Debounced search via GET /api/operations?q=...&compact=1&limit=20.
// =============================================================================
interface OpResult {
  id: string;
  reference: string | null;
  partner_trade_name: string | null;
  operation_type: string;
  operation_date: number;
  currency: string;
  total_amount: number;
  status: string;
}

function AttachModal({
  item, busy, onClose, onAttach,
}: {
  item: InboxItem;
  busy: boolean;
  onClose: () => void;
  onAttach: (operationId: string, opReference: string | null) => void;
}) {
  // Seed the search with the invoice number (most informative starting point).
  const initialQ = item.extracted_invoice_no ?? '';
  const [q, setQ] = useState(initialQ);
  const [results, setResults] = useState<OpResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<OpResult | null>(null);

  // Debounced search effect.
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const url = `${API_BASE}/api/operations?q=${encodeURIComponent(trimmed)}&compact=1&limit=20`;
        const r = await fetch(url);
        const data = await r.json();
        if (data.success && data.result) {
          setResults(data.result.operations as OpResult[]);
        } else {
          setSearchError(data.errors?.[0]?.message ?? 'Search failed');
        }
      } catch (e) {
        setSearchError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setSearching(false);
      }
    }, 250); // debounce
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.45)',
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--paper)',
          borderRadius: 'var(--radius-md)',
          width: '100%',
          maxWidth: '720px',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--fg-1)' }}>Attach to existing operation</div>
            <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 2 }}>
              {item.attachment_filename ?? '(no filename)'}
              {item.extracted_amount !== null && (
                <> · {item.extracted_amount.toLocaleString('ru-RU')} {item.extracted_currency ?? ''}</>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              width: '32px', height: '32px',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              backgroundColor: 'transparent',
              border: 'none',
              color: 'var(--fg-3)',
              cursor: 'pointer',
            }}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search input */}
        <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <div className="flex items-center gap-2 px-3 py-2" style={{
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
          }}>
            <Search className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
            <input
              autoFocus
              type="text"
              value={q}
              onChange={(e) => { setQ(e.target.value); setSelected(null); }}
              placeholder="Search by reference, partner name, or notes…"
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                fontSize: 14, color: 'var(--fg-1)',
              }}
            />
            {searching && <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--fg-3)' }} />}
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 py-3" style={{ minHeight: '200px' }}>
          {searchError && (
            <div style={{ color: 'var(--brand-rot)', fontSize: 14 }}>{searchError}</div>
          )}
          {!searchError && q.trim().length < 2 && (
            <div style={{ fontSize: 14, color: 'var(--fg-3)', textAlign: 'center', padding: '40px 0' }}>
              Type at least 2 characters to search.
            </div>
          )}
          {!searchError && q.trim().length >= 2 && !searching && results.length === 0 && (
            <div style={{ fontSize: 14, color: 'var(--fg-3)', textAlign: 'center', padding: '40px 0' }}>
              No operations match. Try a different keyword.
            </div>
          )}
          {results.length > 0 && (
            <div className="space-y-1">
              {results.map((op) => {
                const isSel = selected?.id === op.id;
                const opDate = new Date(op.operation_date * 1000).toLocaleDateString('ru-RU');
                return (
                  <button
                    key={op.id}
                    onClick={() => setSelected(op)}
                    className="w-full text-left px-3 py-2 flex items-center justify-between gap-3"
                    style={{
                      backgroundColor: isSel ? 'rgba(229,32,44,0.06)' : 'var(--paper)',
                      border: `1px solid ${isSel ? 'var(--brand-rot)' : 'var(--border-hairline)'}`,
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                    }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: 14 }}>
                          {op.reference ?? op.id.slice(0, 12)}
                        </span>
                        <span style={{
                          fontSize: 14,
                          color: 'var(--fg-3)',
                          padding: '1px 8px',
                          backgroundColor: 'var(--paper-sunk)',
                          borderRadius: '999px',
                        }}>
                          {op.operation_type}
                        </span>
                        <span style={{ fontSize: 14, color: 'var(--fg-3)' }}>{op.status}</span>
                      </div>
                      <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 2 }}>
                        {op.partner_trade_name ?? '—'} · {opDate}
                      </div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-1)', whiteSpace: 'nowrap' }}>
                      {op.total_amount.toLocaleString('ru-RU')} {op.currency}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--border-hairline)' }}>
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2"
            style={{
              fontSize: 14, fontWeight: 600, color: 'var(--fg-2)',
              backgroundColor: 'transparent',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => selected && onAttach(selected.id, selected.reference)}
            disabled={!selected || busy}
            className="flex items-center gap-2 px-4 py-2"
            style={{
              fontSize: 14, fontWeight: 700, color: 'white',
              backgroundColor: selected ? 'var(--brand-rot)' : 'var(--paper-sunk)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: selected && !busy ? 'pointer' : 'not-allowed',
              opacity: selected ? 1 : 0.5,
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            {selected ? `Attach to ${selected.reference ?? selected.id.slice(0, 12)}` : 'Select an operation'}
          </button>
        </div>
      </div>
    </div>
  );
}
