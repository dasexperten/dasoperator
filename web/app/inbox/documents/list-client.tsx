'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, FileText, ChevronRight } from 'lucide-react';
import { listExtractions, type DocumentExtraction } from '@/lib/api';

export default function InboxListClient() {
  const [rows, setRows] = useState<DocumentExtraction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const res = await listExtractions('pending_review');
      if (res.success && res.result) setRows(res.result.extractions);
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)' }}>Document inbox</div>
      <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>Parsed documents waiting for review.</div>

      {rows.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--fg-3)', fontSize: '14px', background: 'var(--paper-sunk)', borderRadius: 'var(--radius-md)' }}>
          Nothing to review. Upload an invoice from Operations to get started.
        </div>
      ) : (
        <div style={{ background: 'var(--paper)', border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {rows.map((r) => (
            <Link key={r.id} href={`/inbox/documents/${r.id}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '14px 18px', borderBottom: '1px solid var(--line-1)', textDecoration: 'none', color: 'var(--fg-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                <FileText className="h-5 w-5" style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.filename}</div>
                  <div style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{String(r.header_fields?.doc_number?.value ?? '')} · {r.target_action} → {r.target_table}</div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4" style={{ color: 'var(--fg-3)', flexShrink: 0 }} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
