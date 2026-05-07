'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, FileText, Package, FileCheck, Truck, Files } from 'lucide-react';
import { issueDocuments } from '@/lib/api';

interface DocumentActionBarProps {
  operationId: string;
  operationStatus: string;
  onIssued: () => Promise<void> | void;
}

type DocType = 'CI' | 'PL' | 'IS-V1' | 'IS-V2';
type ButtonId = 'CI' | 'PL' | 'IS' | 'FREIGHT' | 'ALL';

export default function DocumentActionBar({
  operationId,
  operationStatus,
  onIssued,
}: DocumentActionBarProps) {
  const [busy, setBusy] = useState<ButtonId | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const canIssue = operationStatus !== 'cancelled';

  const handleIssue = async (id: ButtonId, types?: DocType[]) => {
    if (!canIssue) {
      setFeedback({ type: 'error', text: `Cannot issue documents — operation status is ${operationStatus}` });
      return;
    }
    setBusy(id);
    setFeedback(null);
    try {
      // Try IS-V1 first; if backend says not in plan, retry with IS-V2
      let res = await issueDocuments(operationId, types);
      if (!res.success && types?.includes('IS-V1') && res.errors?.[0]?.code === 'no_matching_documents') {
        res = await issueDocuments(operationId, types.map((t) => (t === 'IS-V1' ? 'IS-V2' : t)) as DocType[]);
      }
      if (res.success && res.result) {
        const issued = (res.result as any).documents?.map((d: any) => d.reference).join(', ') ?? 'documents';
        setFeedback({ type: 'success', text: `Issued: ${issued}` });
        await onIssued();
      } else {
        setFeedback({ type: 'error', text: res.errors?.[0]?.message ?? 'Failed to issue' });
      }
    } catch (e) {
      setFeedback({ type: 'error', text: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 14px',
    fontSize: '14px',
    fontWeight: 600,
    border: '1px solid var(--border-hairline)',
    borderRadius: 'var(--radius-sm)',
    backgroundColor: active ? 'var(--paper)' : 'var(--paper-sunk)',
    color: active ? 'var(--fg-1)' : 'var(--fg-3)',
    cursor: !canIssue || busy ? 'not-allowed' : 'pointer',
    opacity: !canIssue || busy ? 0.5 : 1,
    transition: 'all 150ms',
  });

  return (
    <div className="space-y-3">
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={() => handleIssue('CI', ['CI'])}
          disabled={!canIssue || !!busy}
          style={buttonStyle(canIssue)}
          title="Generate Commercial Invoice"
        >
          {busy === 'CI' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          CI
        </button>
        <button
          onClick={() => handleIssue('PL', ['PL'])}
          disabled={!canIssue || !!busy}
          style={buttonStyle(canIssue)}
          title="Generate Packing List"
        >
          {busy === 'PL' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
          PL
        </button>
        <button
          onClick={() => handleIssue('IS', ['IS-V1'])}
          disabled={!canIssue || !!busy}
          style={buttonStyle(canIssue)}
          title="Generate Issuance Statement"
        >
          {busy === 'IS' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck className="h-4 w-4" />}
          IS
        </button>
        <Link
          href={`/operations/${operationId}/freight-rfq`}
          style={{
            ...buttonStyle(true),
            cursor: 'pointer',
            opacity: 1,
            textDecoration: 'none',
            backgroundColor: 'var(--paper)',
            color: 'var(--fg-1)',
          }}
          title="Send freight forwarding request to a shipper"
        >
          <Truck className="h-4 w-4" />
          Заявка логисту
        </Link>
        <button
          onClick={() => handleIssue('ALL')}
          disabled={!canIssue || !!busy}
          style={{
            ...buttonStyle(canIssue),
            backgroundColor: canIssue ? 'var(--brand-rot)' : 'var(--paper-sunk)',
            color: canIssue ? '#FFFFFF' : 'var(--fg-3)',
            border: 'none',
          }}
          title="Generate all documents (CI + PL + IS)"
        >
          {busy === 'ALL' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Files className="h-4 w-4" />}
          Все документы
        </button>
      </div>
      {feedback && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: feedback.type === 'success' ? 'rgba(46,125,79,0.08)' : 'rgba(229,32,44,0.08)',
            border: `1px solid ${feedback.type === 'success' ? 'rgba(46,125,79,0.3)' : 'rgba(229,32,44,0.3)'}`,
          }}
        >
          <p style={{
            fontSize: '14px',
            margin: 0,
            color: feedback.type === 'success' ? 'var(--status-success)' : 'var(--brand-rot)',
            fontWeight: 500,
          }}>
            {feedback.text}
          </p>
        </div>
      )}
      {!canIssue && (
        <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: 0 }}>
          Operation is cancelled — documents cannot be issued.
        </p>
      )}
    </div>
  );
}
