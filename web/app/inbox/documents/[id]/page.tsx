'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, AlertTriangle, CheckCircle2, XCircle, FileText,
  Check, X, Edit2, ChevronDown, Info, ShieldAlert, ExternalLink,
} from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';

interface FieldResolution {
  value: any;
  raw: string | null;
  confidence: number;
  source: string | null;
  alternatives: Array<{ value: any; label: string; confidence: number; why: string }>;
  needs_review: boolean;
}

interface LineItem {
  description: string;
  sku_hint: string | null;
  qty: number;
  unit_price: number;
  line_amount: number;
  hs_code: string | null;
  cartons: number | null;
  product_id: string | null;
  product_id_source: string | null;
  product_id_confidence: number;
  product_id_alternatives: Array<{ value: string; label: string; confidence: number; why: string }>;
  needs_review: boolean;
}

interface ValidationCheck {
  code: string;
  label: string;
  passed: boolean;
  severity: 'info' | 'warning' | 'error';
  details?: string;
  expected?: any;
  actual?: any;
}

interface Extraction {
  id: string;
  source: string;
  document_kind: string;
  r2_key: string | null;
  filename: string | null;
  file_mime: string | null;
  overall_confidence: number;
  status: string;
  header_fields: Record<string, FieldResolution>;
  line_items: LineItem[];
  validation: {
    checks: ValidationCheck[];
    errors_count: number;
    warnings_count: number;
    ready_for_auto_commit: boolean;
  };
  raw_extract: any;
  target_table: string;
  target_action: string;
  created_at: number;
}

export default function ExtractionReviewPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API_BASE}/api/document-extractions/${params.id}`).then((r) => r.json());
      if (r.success) setExtraction(r.result.extraction);
      else setError(r.errors?.[0]?.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  const overrideHeader = async (field: string, value: any) => {
    await fetch(`${API_BASE}/api/document-extractions/${params.id}/header`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value }),
    });
    await load();
  };

  const overrideLineItem = async (idx: number, field: string, value: any) => {
    await fetch(`${API_BASE}/api/document-extractions/${params.id}/line-item/${idx}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, value }),
    });
    await load();
  };

  const approve = async () => {
    if (!confirm('Approve and commit this document?\nLine items, header fields, and document attachment will be saved as a draft operation.')) return;
    setSubmitting(true);
    setActionMsg(null);
    try {
      const r = await fetch(`${API_BASE}/api/document-extractions/${params.id}/approve`, { method: 'POST' }).then((r) => r.json());
      if (r.success) {
        setActionMsg(`Approved → ${r.result.reference || r.result.target_id}`);
        setTimeout(() => router.push('/inbox/documents'), 1500);
      } else {
        setError(r.errors?.[0]?.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const reject = async () => {
    const reason = prompt('Reason for rejection (optional):');
    if (reason === null) return;
    setSubmitting(true);
    try {
      const r = await fetch(`${API_BASE}/api/document-extractions/${params.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }).then((r) => r.json());
      if (r.success) {
        setActionMsg('Rejected');
        setTimeout(() => router.push('/inbox/documents'), 1500);
      }
    } catch {} finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8" style={{ color: 'var(--fg-2)' }}><Loader2 className="h-4 w-4 animate-spin inline" /> Loading...</div>;
  if (error || !extraction) return <div className="p-8" style={{ color: '#A82029' }}>{error || 'Not found'}</div>;

  const isLocked = extraction.status !== 'pending_review';
  const conf = Math.round(extraction.overall_confidence * 100);
  const fileLabel = extraction.filename || '(no filename)';

  return (
    <div className="px-8 py-6 max-w-screen-xl">
      <Link href="/inbox/documents" className="inline-flex items-center gap-1 mb-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
        <ArrowLeft className="h-4 w-4" /> Verification queue
      </Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 style={{
            fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '24px',
            fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase', marginBottom: '4px',
          }}>
            {fileLabel}
          </h1>
          <div className="flex items-center gap-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            <span style={{ fontWeight: 700 }}>{extraction.document_kind}</span>
            <span>·</span>
            <span>{extraction.target_table}/{extraction.target_action}</span>
            <span>·</span>
            <span style={{
              padding: '2px 8px', borderRadius: '4px', fontSize: '14px', fontWeight: 700,
              backgroundColor: conf >= 80 ? '#3E9E6320' : conf >= 50 ? '#D4A01720' : '#A8202920',
              color: conf >= 80 ? '#2E7D4F' : conf >= 50 ? '#7D481C' : '#A82029',
            }}>
              {conf}% overall confidence
            </span>
            <span>·</span>
            <span style={{ fontWeight: 700 }}>STATUS: {extraction.status}</span>
          </div>
        </div>

        {!isLocked && (
          <div className="flex gap-2">
            <button onClick={reject} disabled={submitting} style={btnSecondary}>
              <X className="h-4 w-4" /> Reject
            </button>
            <button
              onClick={approve}
              disabled={submitting || extraction.validation.errors_count > 0}
              title={extraction.validation.errors_count > 0 ? 'Resolve errors first' : ''}
              style={{
                ...btnPrimary,
                opacity: (submitting || extraction.validation.errors_count > 0) ? 0.5 : 1,
                cursor: (submitting || extraction.validation.errors_count > 0) ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Approve & commit
            </button>
          </div>
        )}
      </div>

      {actionMsg && (
        <div style={{
          padding: '12px 16px', marginBottom: '16px',
          background: '#3E9E6315', color: '#2E7D4F',
          borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700,
        }}>
          {actionMsg}
        </div>
      )}

      {/* Validation panel */}
      <Section title="Validation checks" icon={ShieldAlert}>
        {extraction.validation.checks.map((ch, i) => (
          <CheckRow key={i} check={ch} />
        ))}
      </Section>

      {/* Header fields */}
      <Section title="Header fields" icon={Info}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--line-1)' }}>
              <th style={fieldTh}>Field</th>
              <th style={fieldTh}>Extracted</th>
              <th style={fieldTh}>From document</th>
              <th style={{ ...fieldTh, textAlign: 'center' }}>Confidence</th>
              <th style={{ ...fieldTh, textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(extraction.header_fields).map(([k, fr]) => (
              <HeaderRow
                key={k}
                field={k}
                resolution={fr}
                locked={isLocked}
                onSave={(v) => overrideHeader(k, v)}
              />
            ))}
          </tbody>
        </table>
      </Section>

      {/* Line items */}
      {extraction.line_items && extraction.line_items.length > 0 && (
        <Section title={`Line items (${extraction.line_items.length})`} icon={FileText}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line-1)' }}>
                <th style={fieldTh}>#</th>
                <th style={fieldTh}>Document description</th>
                <th style={fieldTh}>Matched SKU</th>
                <th style={{ ...fieldTh, textAlign: 'right' }}>Qty</th>
                <th style={{ ...fieldTh, textAlign: 'right' }}>Unit price</th>
                <th style={{ ...fieldTh, textAlign: 'right' }}>Line amount</th>
                <th style={{ ...fieldTh, textAlign: 'center' }}>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {extraction.line_items.map((li, i) => (
                <LineItemRow
                  key={i}
                  idx={i}
                  item={li}
                  locked={isLocked}
                  onSave={(field, value) => overrideLineItem(i, field, value)}
                />
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* File preview */}
      {extraction.r2_key && (
        <Section title="Source document" icon={FileText}>
          <a
            href={`${API_BASE}/api/attachment-files/raw?key=${encodeURIComponent(extraction.r2_key)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '8px 14px', backgroundColor: 'var(--paper-sunk)',
              borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)',
              fontSize: '14px', fontWeight: 700, textDecoration: 'none',
              border: '1px solid var(--line-1)',
            }}
          >
            <ExternalLink className="h-4 w-4" /> Open {fileLabel}
          </a>
        </Section>
      )}
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: '20px', padding: '16px',
      border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)',
      backgroundColor: 'var(--paper)',
    }}>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4" style={{ color: 'var(--fg-2)' }} />
        <h2 style={{
          fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '16px',
          fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase',
        }}>
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

function CheckRow({ check }: { check: ValidationCheck }) {
  const c = check.passed
    ? { icon: CheckCircle2, color: '#2E7D4F', bg: '#3E9E6310' }
    : check.severity === 'error'
      ? { icon: XCircle, color: '#A82029', bg: '#A8202910' }
      : { icon: AlertTriangle, color: '#7D481C', bg: '#D4A01710' };
  return (
    <div style={{
      padding: '8px 12px', marginBottom: '6px', backgroundColor: c.bg,
      borderRadius: '4px', display: 'flex', alignItems: 'flex-start', gap: '8px',
    }}>
      <c.icon className="h-4 w-4 mt-0.5" style={{ color: c.color, flexShrink: 0 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
          {check.label}
        </div>
        {check.details && (
          <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '2px' }}>
            {check.details}
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderRow({ field, resolution, locked, onSave }: {
  field: string;
  resolution: FieldResolution;
  locked: boolean;
  onSave: (v: any) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState<string>(String(resolution.value ?? ''));

  const conf = Math.round(resolution.confidence * 100);
  return (
    <tr style={{ borderBottom: '1px solid var(--line-1)', backgroundColor: resolution.needs_review ? '#D4A01708' : undefined }}>
      <td style={fieldTd}>
        <span style={{ fontWeight: 700, fontFamily: 'Manrope, monospace', color: 'var(--fg-3)' }}>{field}</span>
      </td>
      <td style={fieldTd}>
        {editing ? (
          <input
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => { onSave(editValue); setEditing(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { onSave(editValue); setEditing(false); } if (e.key === 'Escape') setEditing(false); }}
            autoFocus
            style={{ width: '100%', padding: '4px 8px', border: '1px solid var(--fg-1)', borderRadius: '4px', fontSize: '14px', fontWeight: 700 }}
          />
        ) : (
          <span style={{ fontWeight: 700, color: resolution.value ? 'var(--fg-1)' : 'var(--fg-3)' }}>
            {resolution.value ?? '(empty)'}
          </span>
        )}
      </td>
      <td style={fieldTd}>
        <span style={{ color: 'var(--fg-3)', fontSize: '14px' }}>
          {resolution.raw || '—'}
        </span>
      </td>
      <td style={{ ...fieldTd, textAlign: 'center' }}>
        <span style={{
          padding: '2px 6px', borderRadius: '3px', fontSize: '14px', fontWeight: 700,
          backgroundColor: conf >= 80 ? '#3E9E6315' : conf >= 50 ? '#D4A01715' : '#A8202915',
          color: conf >= 80 ? '#2E7D4F' : conf >= 50 ? '#7D481C' : '#A82029',
        }}>
          {conf}%
        </span>
      </td>
      <td style={{ ...fieldTd, textAlign: 'right' }}>
        {!locked && !editing && (
          <button onClick={() => { setEditValue(String(resolution.value ?? '')); setEditing(true); }} style={iconBtn}>
            <Edit2 className="h-3 w-3" />
          </button>
        )}
      </td>
    </tr>
  );
}

function LineItemRow({ idx, item, locked, onSave }: {
  idx: number;
  item: LineItem;
  locked: boolean;
  onSave: (field: string, value: any) => void;
}) {
  const [showAlts, setShowAlts] = useState(false);
  const conf = Math.round(item.product_id_confidence * 100);

  return (
    <>
      <tr style={{ borderBottom: '1px solid var(--line-1)', backgroundColor: item.needs_review ? '#D4A01708' : undefined }}>
        <td style={{ ...fieldTd, textAlign: 'center', fontWeight: 700, color: 'var(--fg-3)' }}>{idx + 1}</td>
        <td style={fieldTd}>
          <span style={{ fontSize: '14px', color: 'var(--fg-1)' }}>{item.description}</span>
        </td>
        <td style={fieldTd}>
          <div className="flex items-center gap-2">
            <span style={{ fontWeight: 700, fontFamily: 'Manrope, monospace', color: item.product_id ? 'var(--fg-1)' : '#A82029' }}>
              {item.product_id || '(no match)'}
            </span>
            {item.product_id_alternatives && item.product_id_alternatives.length > 0 && !locked && (
              <button
                onClick={() => setShowAlts(!showAlts)}
                style={{ ...iconBtn, fontSize: '14px' }}
                title="Show alternatives"
              >
                <ChevronDown className="h-3 w-3" style={{ transform: showAlts ? 'rotate(180deg)' : '' }} />
              </button>
            )}
          </div>
        </td>
        <td style={{ ...fieldTd, textAlign: 'right', fontWeight: 700 }}>{item.qty.toLocaleString()}</td>
        <td style={{ ...fieldTd, textAlign: 'right', fontWeight: 700 }}>{item.unit_price?.toFixed(2)}</td>
        <td style={{ ...fieldTd, textAlign: 'right', fontWeight: 700 }}>{item.line_amount?.toFixed(2)}</td>
        <td style={{ ...fieldTd, textAlign: 'center' }}>
          <span style={{
            padding: '2px 6px', borderRadius: '3px', fontSize: '14px', fontWeight: 700,
            backgroundColor: conf >= 80 ? '#3E9E6315' : conf >= 50 ? '#D4A01715' : '#A8202915',
            color: conf >= 80 ? '#2E7D4F' : conf >= 50 ? '#7D481C' : '#A82029',
          }}>
            {conf}%
          </span>
        </td>
      </tr>
      {showAlts && (
        <tr style={{ backgroundColor: 'var(--paper-sunk)' }}>
          <td colSpan={7} style={{ padding: '8px 16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-2)', marginBottom: '6px' }}>
              Alternative matches:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {item.product_id_alternatives.map((alt) => (
                <button
                  key={alt.value}
                  onClick={() => { onSave('product_id', alt.value); setShowAlts(false); }}
                  style={{
                    textAlign: 'left', padding: '6px 10px',
                    backgroundColor: 'var(--paper)', border: '1px solid var(--line-1)',
                    borderRadius: '4px', cursor: 'pointer', fontSize: '14px',
                  }}
                >
                  <span style={{ fontWeight: 700, fontFamily: 'Manrope, monospace', color: 'var(--fg-1)' }}>
                    {alt.value}
                  </span>
                  <span style={{ marginLeft: '8px', color: 'var(--fg-2)' }}>{alt.label}</span>
                  <span style={{ marginLeft: '8px', color: 'var(--fg-3)', fontSize: '14px' }}>
                    {Math.round(alt.confidence * 100)}% · {alt.why}
                  </span>
                </button>
              ))}
              <button
                onClick={() => { const v = prompt('Enter product SKU (e.g. de205aa):', item.product_id || ''); if (v) onSave('product_id', v); setShowAlts(false); }}
                style={{ textAlign: 'left', padding: '6px 10px', backgroundColor: 'var(--paper)', border: '1px dashed var(--line-1)', borderRadius: '4px', cursor: 'pointer', fontSize: '14px', color: 'var(--fg-2)' }}
              >
                Enter manually...
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const fieldTh: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', color: 'var(--fg-2)', fontWeight: 700, fontSize: '14px' };
const fieldTd: React.CSSProperties = { padding: '8px 12px', color: 'var(--fg-1)', fontSize: '14px' };
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-2)', padding: '4px' };
const btnPrimary: React.CSSProperties = {
  padding: '10px 18px', borderRadius: 'var(--radius-sm)',
  backgroundColor: 'var(--brand-rot, #C4302B)', color: 'var(--paper)',
  fontSize: '14px', fontWeight: 700,
  display: 'inline-flex', alignItems: 'center', gap: '8px', border: 'none',
};
const btnSecondary: React.CSSProperties = {
  padding: '10px 18px', borderRadius: 'var(--radius-sm)',
  backgroundColor: 'var(--paper)', color: 'var(--fg-1)',
  fontSize: '14px', fontWeight: 700, border: '1px solid var(--line-1)',
  display: 'inline-flex', alignItems: 'center', gap: '8px',
};
