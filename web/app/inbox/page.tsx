'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, RefreshCw, Inbox, AlertCircle, CheckCircle2, XCircle, FileText } from 'lucide-react';

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
  status: string;
  matched_partner_id: string | null;
  created_operation_id: string | null;
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
            />
          ))}
        </div>
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
  item, busy, onConfirm, onReject,
}: {
  item: InboxItem;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const isResolved = ['manual_confirmed', 'auto_created', 'manual_rejected'].includes(item.status);
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

          {item.attachment_filename && (
            <div className="mt-2 flex items-center gap-2" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              <FileText className="h-3.5 w-3.5" />
              {item.attachment_filename}
            </div>
          )}

          {isResolved && item.matched_partner_id && (
            <div className="mt-2" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              {item.created_operation_id && (
                <>Created operation <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{item.created_operation_id}</span></>
              )}
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
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Yes
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
