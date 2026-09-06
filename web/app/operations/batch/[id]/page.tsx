'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

interface BatchRecord {
  id: string;
  batch_reference: string;
  marketplace: 'OZN' | 'WB';
  batch_date: number;
  our_company_id: string;
  entity_abbreviation: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

interface ChildOperation {
  id: string;
  reference: string;
  operation_date: number;
  operation_type: string;
  warehouse_from_id: string | null;
  warehouse_to_id: string | null;
  status: string;
  delivery_status: string;
  notes: string | null;
  warehouse_from_code: string | null;
  warehouse_to_code: string | null;
}

interface BatchResponse {
  batch: BatchRecord;
  children: ChildOperation[];
  cluster_count: number;
}

function formatDate(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

const STATUS_COLOR: Record<string, { bg: string; fg: string; dot: string }> = {
  draft:     { bg: 'rgba(150,150,150,0.08)', fg: 'var(--fg-2)',         dot: '#999' },
  issued:    { bg: 'rgba(229,32,44,0.08)',   fg: 'var(--status-danger)', dot: 'var(--status-danger)' },
  shipped:   { bg: 'rgba(212,160,23,0.08)',  fg: '#9A6C00',              dot: '#D4A017' },
  delivered: { bg: 'rgba(46,125,79,0.08)',   fg: 'var(--status-success)', dot: 'var(--status-success)' },
  cancelled: { bg: 'rgba(150,150,150,0.12)', fg: 'var(--fg-3)',          dot: '#888' },
};

export default function BatchDetailPage() {
  const params = useParams();
  const batchId = params?.id as string;
  const [data, setData] = useState<BatchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!batchId) return;
    const apiBase = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';
    fetch(`${apiBase}/api/operations/batch/${batchId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setData(d.result);
        } else {
          setError(d.error || 'Failed to load batch');
        }
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [batchId]);

  if (loading) {
    return <div style={{ padding: '32px', color: 'var(--fg-3)' }}>Loading...</div>;
  }
  if (error || !data) {
    return (
      <div style={{ padding: '32px' }}>
        <Link href="/operations" style={{ color: 'var(--fg-2)' }}>
          <ArrowLeft className="h-4 w-4 inline" /> Back to Operations
        </Link>
        <div style={{ marginTop: '16px', color: 'var(--status-danger)' }}>
          Error: {error ?? 'Batch not found'}
        </div>
      </div>
    );
  }

  const { batch, children, cluster_count } = data;
  const marketplaceLabel = batch.marketplace === 'OZN' ? 'Ozon FBO' : 'Wildberries FBO';

  return (
    <div style={{ padding: '24px', maxWidth: '1100px', margin: '0 auto' }}>
      <Link
        href="/operations"
        style={{
          color: 'var(--fg-2)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '14px',
          fontWeight: 600,
          marginBottom: '16px',
        }}
      >
        <ArrowLeft className="h-4 w-4" /> Back to Operations
      </Link>

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
        <span style={{ fontSize: '14px', color: 'var(--fg-3)', fontWeight: 600 }}>
          Transfer batch
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '20px', marginBottom: '4px' }}>
        <h1 style={{ fontSize: 'clamp(20px, 5.5vw, 32px)', fontWeight: 800, color: 'var(--fg-1)', margin: 0, lineHeight: 1.1 }}>
          {batch.batch_reference}
        </h1>
        <div className="dx-num" style={{ fontSize: '18px', fontWeight: 700, color: 'var(--fg-1)' }}>
          {cluster_count} {cluster_count === 1 ? 'cluster' : 'clusters'}
        </div>
      </div>

      <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginBottom: '20px' }}>
        {marketplaceLabel} · {formatDate(batch.batch_date)} · entity {batch.entity_abbreviation || batch.our_company_id}
      </div>

      <div
        style={{
          backgroundColor: 'var(--paper)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: 'var(--paper-sunk)',
            borderBottom: '1px solid var(--border-hairline)',
            fontSize: '14px',
            fontWeight: 700,
            color: 'var(--fg-2)',
            textTransform: 'uppercase',
            letterSpacing: '0',
          }}
        >
          Clusters in this batch
        </div>
        <table style={{ width: '100%', fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--fg-3)' }}>Reference</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--fg-3)' }}>From</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--fg-3)' }}>To</th>
              <th style={{ padding: '10px 16px', textAlign: 'left', fontWeight: 600, color: 'var(--fg-3)' }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {children.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ padding: '40px', textAlign: 'center', color: 'var(--fg-3)' }}>
                  No clusters in this batch yet.
                </td>
              </tr>
            ) : (
              children.map((c) => {
                const sc = STATUS_COLOR[c.status] ?? STATUS_COLOR.draft;
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                    <td style={{ padding: '12px 16px', fontWeight: 700 }}>
                      <Link
                        href={`/operations/${c.id}`}
                        style={{
                          color: 'var(--fg-1)',
                          textDecoration: 'underline',
                          textDecorationColor: 'var(--border-hairline)',
                          textUnderlineOffset: '3px',
                        }}
                      >
                        {c.reference}
                      </Link>
                    </td>
                    <td style={{ padding: '12px 16px', color: 'var(--fg-2)' }}>
                      {c.warehouse_from_code ?? '—'}
                    </td>
                    <td style={{ padding: '12px 16px', color: 'var(--fg-2)' }}>
                      {c.warehouse_to_code ?? '—'}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '4px 10px',
                          backgroundColor: sc.bg,
                          color: sc.fg,
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '13px',
                          fontWeight: 700,
                        }}
                      >
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: sc.dot }} />
                        {c.status}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
