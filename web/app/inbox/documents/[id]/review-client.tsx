'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, ArrowLeft, FileText, Check, Trash2, AlertTriangle, ChevronDown } from 'lucide-react';
import {
  getExtraction,
  patchExtractionLine,
  approveExtraction,
  rejectExtraction,
  extractionFileUrl,
  getProducts,
  type DocumentExtraction,
  type ExtractionLineItem,
} from '@/lib/api';

type ProductOpt = { id: string; product_name: string };

const HEADER_ORDER: Array<{ key: string; label: string }> = [
  { key: 'operation_type', label: 'Type' },
  { key: 'our_company_id', label: 'Our company' },
  { key: 'partner_id', label: 'Partner' },
  { key: 'manufacturer_id', label: 'Factory' },
  { key: 'currency', label: 'Currency' },
  { key: 'total_amount', label: 'Total' },
  { key: 'operation_date', label: 'Operation date' },
  { key: 'doc_number', label: 'Document №' },
  { key: 'doc_date', label: 'Document date' },
  { key: 'contract_id', label: 'Contract' },
];

function fmtHeaderValue(key: string, value: string | number | null): string {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'operation_date' && typeof value === 'number') {
    return new Date(value * 1000).toISOString().slice(0, 10);
  }
  if (key === 'total_amount' && typeof value === 'number') {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(value);
}

export default function ReviewClient({ id }: { id: string }) {
  const [ext, setExt] = useState<DocumentExtraction | null>(null);
  const [products, setProducts] = useState<ProductOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openPicker, setOpenPicker] = useState<number | null>(null);
  const [done, setDone] = useState<{ reference?: string; target_id: string } | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [eRes, pRes] = await Promise.all([getExtraction(id), getProducts('DE')]);
      if (eRes.success && eRes.result) setExt(eRes.result.extraction);
      else setError(eRes.errors?.[0]?.message ?? 'Extraction not found');
      if (pRes.success && pRes.result) {
        setProducts(pRes.result.products.map((p) => ({ id: p.id, product_name: (p as { product_name?: string }).product_name ?? '' })));
      }
      setLoading(false);
    })();
  }, [id]);

  const lines: ExtractionLineItem[] = ext?.line_items ?? [];

  const unresolved = useMemo(
    () => lines.filter((l) => l.needs_review || !l.product_id).length,
    [lines]
  );
  const lineSum = useMemo(
    () => Math.round(lines.reduce((s, l) => s + (l.line_amount || 0), 0) * 100) / 100,
    [lines]
  );

  async function setLineProduct(idx: number, productId: string) {
    if (!ext) return;
    setOpenPicker(null);
    const res = await patchExtractionLine(id, idx, 'product_id', productId);
    if (res.success) {
      setExt((prev) => {
        if (!prev) return prev;
        const next = { ...prev, line_items: prev.line_items.map((l, i) => i === idx ? { ...l, product_id: productId, needs_review: false, product_id_source: 'operator' } : l) };
        return next;
      });
    }
  }

  async function onApprove() {
    setBusy(true); setError(null);
    const res = await approveExtraction(id);
    if (res.success && res.result) setDone({ reference: res.result.reference, target_id: res.result.target_id });
    else setError(res.errors?.[0]?.message ?? 'Approve failed');
    setBusy(false);
  }

  async function onReject() {
    setBusy(true); setError(null);
    const res = await rejectExtraction(id);
    if (res.success) window.location.href = '/inbox/documents';
    else { setError(res.errors?.[0]?.message ?? 'Reject failed'); setBusy(false); }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;
  }
  if (error && !ext) {
    return (
      <div className="max-w-3xl">
        <Link href="/inbox/documents" className="inline-flex items-center gap-1 mb-4" style={{ color: 'var(--fg-2)', fontSize: '14px', textDecoration: 'none' }}><ArrowLeft className="h-4 w-4" />Back to inbox</Link>
        <div style={{ padding: '14px', borderRadius: 'var(--radius-sm)', background: 'rgba(226,75,74,0.10)', border: '1px solid var(--brand-rot)', color: 'var(--brand-rot)', fontSize: '14px', fontWeight: 700 }}>{error}</div>
      </div>
    );
  }
  if (!ext) return null;

  if (done) {
    return (
      <div className="max-w-3xl">
        <div style={{ padding: '20px', borderRadius: 'var(--radius-md)', background: 'rgba(99,153,34,0.10)', border: '1px solid #3B6D11' }}>
          <div style={{ fontSize: '18px', fontWeight: 700, color: '#3B6D11', display: 'flex', alignItems: 'center', gap: '8px' }}><Check className="h-5 w-5" />Operation created</div>
          <div style={{ marginTop: '8px', fontSize: '14px', color: 'var(--fg-2)' }}>Reference <span style={{ fontWeight: 700 }}>{done.reference ?? done.target_id}</span></div>
          <div style={{ marginTop: '16px', display: 'flex', gap: '10px' }}>
            <Link href={`/operations/${done.target_id}`} style={{ padding: '9px 18px', borderRadius: 'var(--radius-sm)', background: 'var(--brand-rot)', color: '#fff', fontSize: '14px', fontWeight: 700, textDecoration: 'none' }}>Open operation</Link>
            <Link href="/inbox/documents" style={{ padding: '9px 18px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line-1)', color: 'var(--fg-1)', fontSize: '14px', fontWeight: 700, textDecoration: 'none' }}>Back to inbox</Link>
          </div>
        </div>
      </div>
    );
  }

  const canApprove = unresolved === 0 && !busy;
  const v = ext.validation;

  return (
    <div className="space-y-4 max-w-4xl">
      <Link href="/inbox/documents" className="inline-flex items-center gap-1" style={{ color: 'var(--fg-2)', fontSize: '14px', textDecoration: 'none' }}><ArrowLeft className="h-4 w-4" />Back to inbox</Link>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)' }}>{ext.filename}</div>
          <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '2px' }}>
            {String(ext.header_fields?.doc_number?.value ?? '')} · {ext.document_kind} · {ext.target_action} → {ext.target_table}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span style={{ fontSize: '12px', fontWeight: 700, padding: '3px 10px', borderRadius: 'var(--radius-xs)', background: 'rgba(212,160,23,0.15)', color: '#854F0B' }}>pending review</span>
          <a href={extractionFileUrl(id)} target="_blank" rel="noreferrer" style={{ fontSize: '14px', color: 'var(--brand-rot)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}><FileText className="h-4 w-4" />open PDF</a>
        </div>
      </div>

      <div style={{ background: 'var(--paper)', border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)', padding: '16px 20px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--fg-2)', marginBottom: '12px' }}>Header</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px 20px' }}>
          {HEADER_ORDER.map(({ key, label }) => {
            const fr = ext.header_fields?.[key];
            if (!fr) return null;
            const review = fr.needs_review;
            return (
              <div key={key}>
                <div style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{label}</div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: review ? 'var(--brand-rot)' : 'var(--fg-1)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {review && <AlertTriangle className="h-3.5 w-3.5" />}
                  {fmtHeaderValue(key, fr.value)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ background: 'var(--paper)', border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)', padding: '16px 20px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--fg-2)', marginBottom: '12px' }}>Line items — confirm each SKU</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', tableLayout: 'fixed' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-3)', fontSize: '12px' }}>
              <th style={{ padding: '6px', fontWeight: 700, width: '40%' }}>Description</th>
              <th style={{ padding: '6px', fontWeight: 700 }}>SKU</th>
              <th style={{ padding: '6px', fontWeight: 700, textAlign: 'right' }}>Qty</th>
              <th style={{ padding: '6px', fontWeight: 700, textAlign: 'right' }}>Price</th>
              <th style={{ padding: '6px', fontWeight: 700, textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => {
              const review = l.needs_review || !l.product_id;
              const alts = l.product_id_alternatives ?? [];
              return (
                <tr key={idx} style={{ borderTop: '1px solid var(--line-1)', background: review ? 'rgba(212,160,23,0.12)' : undefined }}>
                  <td style={{ padding: '10px 6px', color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.description}>
                    {review && <AlertTriangle className="h-3.5 w-3.5" style={{ display: 'inline', verticalAlign: '-2px', marginRight: '4px', color: '#854F0B' }} />}
                    {l.description}
                  </td>
                  <td style={{ padding: '10px 6px', position: 'relative' }}>
                    <button
                      onClick={() => setOpenPicker(openPicker === idx ? null : idx)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '14px', fontWeight: 700, padding: '3px 8px', borderRadius: 'var(--radius-xs)', cursor: 'pointer', border: review ? '1px solid #C4302B' : '1px solid var(--line-1)', background: review ? 'rgba(226,75,74,0.06)' : 'var(--paper-sunk)', color: review ? 'var(--brand-rot)' : 'var(--fg-1)' }}
                    >
                      {(l.product_id ?? 'pick SKU').toUpperCase()}<ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    {openPicker === idx && (
                      <div style={{ position: 'absolute', zIndex: 20, top: '100%', left: '6px', marginTop: '4px', width: '320px', maxHeight: '280px', overflowY: 'auto', background: 'var(--paper)', border: '1px solid var(--line-2)', borderRadius: 'var(--radius-sm)', boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}>
                        {alts.length > 0 && (
                          <div style={{ padding: '6px 10px', fontSize: '12px', color: 'var(--fg-3)', fontWeight: 700 }}>Suggested</div>
                        )}
                        {alts.map((a) => (
                          <button key={a.value} onClick={() => setLineProduct(idx, a.value)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', fontSize: '14px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--fg-1)' }}>
                            <span style={{ fontWeight: 700 }}>{a.value.toUpperCase()}</span>{a.why ? <span style={{ color: 'var(--fg-3)' }}> — {a.why}</span> : null}
                          </button>
                        ))}
                        <div style={{ padding: '6px 10px', fontSize: '12px', color: 'var(--fg-3)', fontWeight: 700, borderTop: '1px solid var(--line-1)' }}>All products</div>
                        {products.map((p) => (
                          <button key={p.id} onClick={() => setLineProduct(idx, p.id)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', fontSize: '14px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--fg-1)' }}>
                            <span style={{ fontWeight: 700 }}>{p.id.toUpperCase()}</span> <span style={{ color: 'var(--fg-3)' }}>{p.product_name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 6px', textAlign: 'right', fontWeight: 700 }}>{(l.qty ?? 0).toLocaleString('en-US')}</td>
                  <td style={{ padding: '10px 6px', textAlign: 'right', fontWeight: 700 }}>{l.unit_price}</td>
                  <td style={{ padding: '10px 6px', textAlign: 'right', fontWeight: 700 }}>{(l.line_amount ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', padding: '12px 16px', background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)' }}>
        {v && <span style={{ fontSize: '14px', fontWeight: 700, color: '#3B6D11' }}><Check className="h-4 w-4" style={{ display: 'inline', verticalAlign: '-3px', marginRight: '4px' }} />{v.passed_count} checks passed</span>}
        {unresolved > 0
          ? <span style={{ fontSize: '14px', fontWeight: 700, color: '#854F0B' }}><AlertTriangle className="h-4 w-4" style={{ display: 'inline', verticalAlign: '-3px', marginRight: '4px' }} />{unresolved} line{unresolved === 1 ? '' : 's'} need review</span>
          : <span style={{ fontSize: '14px', fontWeight: 700, color: '#3B6D11' }}>all lines confirmed</span>}
        <span style={{ fontSize: '14px', color: 'var(--fg-2)' }}>Line sum {lineSum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </div>

      {error && (
        <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-sm)', background: 'rgba(226,75,74,0.10)', border: '1px solid var(--brand-rot)', color: 'var(--brand-rot)', fontSize: '14px', fontWeight: 700 }}>{error}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
        <button onClick={onReject} disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '10px 18px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line-1)', background: 'var(--paper)', color: 'var(--fg-1)', fontSize: '14px', fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}><Trash2 className="h-4 w-4" />Reject</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {unresolved > 0 && <span style={{ fontSize: '12px', color: '#854F0B' }}>Confirm flagged SKUs to continue</span>}
          <button onClick={onApprove} disabled={!canApprove} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '11px 22px', borderRadius: 'var(--radius-sm)', border: 'none', background: canApprove ? '#C4302B' : 'var(--paper-sunk)', color: canApprove ? '#fff' : 'var(--fg-3)', fontSize: '14px', fontWeight: 700, cursor: canApprove ? 'pointer' : 'not-allowed' }}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Approve &amp; create operation
          </button>
        </div>
      </div>
    </div>
  );
}
