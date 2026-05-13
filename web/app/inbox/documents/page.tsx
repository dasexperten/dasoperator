'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Loader2, AlertTriangle, CheckCircle2, FileText, ArrowRight,
  ShieldAlert, Clock, ListChecks,
} from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';

interface Extraction {
  id: string;
  source: string;
  document_kind: string;
  filename: string | null;
  overall_confidence: number;
  status: string;
  target_table: string;
  target_action: string;
  created_at: number;
  errors_count: number | null;
  warnings_count: number | null;
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString('en-GB', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function InboxDocumentsPage() {
  const [items, setItems] = useState<Extraction[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('pending_review');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [r1, r2] = await Promise.all([
          fetch(`${API_BASE}/api/document-extractions?status=${statusFilter}`).then((r) => r.json()),
          fetch(`${API_BASE}/api/document-extractions/counts`).then((r) => r.json()),
        ]);
        if (r1.success) setItems(r1.result.extractions || []);
        else setError(r1.errors?.[0]?.message);
        if (r2.success) setCounts(r2.result.counts || {});
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    })();
  }, [statusFilter]);

  return (
    <div className="px-8 py-6 max-w-screen-2xl">
      <div className="mb-6 flex items-center gap-3">
        <ShieldAlert className="h-7 w-7" style={{ color: 'var(--brand-rot)' }} />
        <div>
          <h1 style={{
            fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '28px',
            fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase',
          }}>
            Documents · Verification Queue
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '4px' }}>
            Every parsed document waits here for review before it changes anything in the ERP.
          </p>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        {(['pending_review', 'approved', 'rejected'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            style={{
              padding: '8px 14px',
              border: `1px solid ${statusFilter === s ? 'var(--fg-1)' : 'var(--line-1)'}`,
              backgroundColor: statusFilter === s ? 'var(--fg-1)' : 'var(--paper)',
              color: statusFilter === s ? 'var(--paper)' : 'var(--fg-1)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '14px', fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {s.replace('_', ' ')}
            <span style={{ marginLeft: '8px', opacity: 0.7 }}>{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center gap-2" style={{ color: 'var(--fg-2)' }}>
          <Loader2 className="h-4 w-4 animate-spin" /> <span style={{ fontSize: '14px' }}>Loading...</span>
        </div>
      )}
      {error && <div style={{ color: 'var(--status-danger, #A82029)', fontSize: '14px' }}>{error}</div>}

      {!loading && items.length === 0 && (
        <div style={{
          padding: '32px', textAlign: 'center', fontSize: '14px', color: 'var(--fg-2)',
          border: '1px dashed var(--line-1)', borderRadius: 'var(--radius-md)',
        }}>
          {statusFilter === 'pending_review' && (
            <>No documents waiting. Upload a document from <Link href="/operations" style={{ color: 'var(--brand-rot)', textDecoration: 'underline' }}>Operations</Link> — it will land here for verification.</>
          )}
          {statusFilter === 'approved' && 'No approved documents yet.'}
          {statusFilter === 'rejected' && 'No rejected documents.'}
        </div>
      )}

      {!loading && items.length > 0 && (
        <div style={{
          border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--paper-sunk)', borderBottom: '1px solid var(--line-1)' }}>
                <th style={th}>File</th>
                <th style={{ ...th, textAlign: 'center' }}>Kind</th>
                <th style={{ ...th, textAlign: 'center' }}>Confidence</th>
                <th style={{ ...th, textAlign: 'center' }}>Checks</th>
                <th style={th}>Uploaded</th>
                <th style={{ ...th, width: '70px' }}></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const conf = Math.round(it.overall_confidence * 100);
                const errs = it.errors_count || 0;
                const warns = it.warnings_count || 0;
                return (
                  <tr key={it.id} style={{ borderBottom: '1px solid var(--line-1)' }}>
                    <td style={td}>
                      <Link href={`/inbox/documents/${it.id}`} className="flex items-center gap-2">
                        <FileText className="h-4 w-4" style={{ color: 'var(--fg-3)' }} />
                        <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>
                          {it.filename || '(no filename)'}
                        </span>
                      </Link>
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700, textTransform: 'uppercase' }}>{it.document_kind}</td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <span style={{
                        padding: '3px 8px', borderRadius: '4px', fontSize: '14px', fontWeight: 700,
                        backgroundColor: conf >= 80 ? '#3E9E6320' : conf >= 50 ? '#D4A01720' : '#A8202920',
                        color: conf >= 80 ? '#2E7D4F' : conf >= 50 ? '#7D481C' : '#A82029',
                      }}>
                        {conf}%
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      {errs > 0 && (
                        <span style={{ color: '#A82029', fontWeight: 700, marginRight: '8px' }}>
                          <AlertTriangle className="h-3 w-3 inline" /> {errs}
                        </span>
                      )}
                      {warns > 0 && (
                        <span style={{ color: '#7D481C', fontWeight: 700 }}>
                          {warns} warnings
                        </span>
                      )}
                      {errs === 0 && warns === 0 && (
                        <span style={{ color: '#2E7D4F' }}>
                          <CheckCircle2 className="h-3 w-3 inline" />
                        </span>
                      )}
                    </td>
                    <td style={{ ...td, fontSize: '14px', color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{formatDate(it.created_at)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <Link
                        href={`/inbox/documents/${it.id}`}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '4px',
                          padding: '4px 10px', backgroundColor: 'var(--fg-1)', color: 'var(--paper)',
                          borderRadius: '4px', fontSize: '14px', fontWeight: 700,
                          textDecoration: 'none',
                        }}
                      >
                        Review <ArrowRight className="h-3 w-3" />
                      </Link>
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

const th: React.CSSProperties = { textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700, fontSize: '14px' };
const td: React.CSSProperties = { padding: '12px 16px', color: 'var(--fg-1)' };
