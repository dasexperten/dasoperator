'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus } from 'lucide-react';
import {
  getOperation,
  getPartner,
  getPayments,
  updateOperationStatus,
  confirmOperationArrival,
  rejectOperationArrival,
  getDocuments,
  issueDocuments,
  getStockMovements,
  type Operation,
  type OperationLineItem,
  type Partner,
  type Payment,
  type OperationDocument,
  type StockMovement,
} from '@/lib/api';

// =============================================================================
// Payment overlay tokens (mirror of /operations top-level page)
// =============================================================================
const PAYMENT_OVERLAY: Record<string, { bg: string; fg: string; dot: string; label: string }> = {
  unpaid:  { bg: 'rgba(229,32,44,0.10)', fg: '#A82029', dot: '#E5202C', label: 'Not paid' },
  partial: { bg: 'rgba(125,72,28,0.10)', fg: '#7D481C', dot: '#A06A2C', label: 'Partially paid' },
  paid:    { bg: 'rgba(46,125,79,0.10)', fg: '#2E7D4F', dot: '#3E9E63', label: 'Fully paid' },
  neutral: { bg: 'var(--paper-sunk)',    fg: 'var(--fg-3)', dot: 'var(--fg-muted)', label: '' },
};
import { formatMoney } from '@/lib/money';
import Breadcrumb from '@/components/layout/breadcrumb';
import DocumentActionBar from '@/components/operations/document-action-bar';

// =============================================================================
// Helpers
// =============================================================================
function formatDate(unixSec?: number | null): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().split('T')[0]!;
}


function getMinorFactor(currency: string): number {
  return ['VND', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
}

// Transition chains — sequential only (variant A)
const TRANSITION_CHAINS: Record<string, Record<string, string | null>> = {
  sale: {
    draft:            'issued',
    issued:           'order_fulfilment',  // "Boxing" in UI
    order_fulfilment: 'shipped',
    shipped:          null,                // final
    cancelled:        null,
  },
  purchase: {
    draft:      'issued',
    issued:     'production',
    production: 'stocked',
    stocked:    'shipped',
    shipped:    'delivered',
    delivered:  null,
    cancelled:  null,
  },
  transfer: {
    draft:     'issued',
    issued:    'shipped',
    shipped:   'delivered',
    delivered: null,
    cancelled: null,
  },
};

function getNextStatus(operationType: string, currentStatus: string): string | null {
  const chain = TRANSITION_CHAINS[operationType];
  if (!chain) return null;
  return chain[currentStatus] ?? null;
}

// =============================================================================
// Status colors (mirror partner-detail-client) — extended for full enum
// =============================================================================
const STATUS_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  draft:             { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  issued:            { bg: 'rgba(31,73,125,0.08)',  fg: 'var(--status-info)',    border: 'rgba(31,73,125,0.3)' },
  order_fulfilment:  { bg: 'rgba(31,73,125,0.08)',  fg: 'var(--status-info)',    border: 'rgba(31,73,125,0.3)' },
  production:        { bg: 'rgba(31,73,125,0.08)',  fg: 'var(--status-info)',    border: 'rgba(31,73,125,0.3)' },
  stocked:           { bg: 'rgba(31,73,125,0.08)',  fg: 'var(--status-info)',    border: 'rgba(31,73,125,0.3)' },
  shipped:           { bg: 'rgba(31,73,125,0.08)',  fg: 'var(--status-info)',    border: 'rgba(31,73,125,0.3)' },
  delivered:         { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  cancelled:         { bg: 'rgba(229,32,44,0.08)',  fg: 'var(--brand-rot)',      border: 'rgba(229,32,44,0.3)' },
};

function statusChip(status: string) {
  const colors = STATUS_COLORS[status] ?? STATUS_COLORS.draft!;
  return (
    <span
      className="inline-flex items-center px-3 py-1 text-xs"
      style={{
        backgroundColor: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.border}`,
        borderRadius: '999px',
        fontFamily: 'var(--font-sans)',
        fontWeight: 500,
        textTransform: 'capitalize',
      }}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

// =============================================================================
// Component
// =============================================================================
type Tab = 'items' | 'status' | 'documents' | 'payments' | 'movements';

// User-defined abbreviations for attachment kinds (per Aram's table)
const ATTACHMENT_KIND_LABEL: Record<string, string> = {
  act: 'Акт',
  upd: 'УПД',
  invoice: 'INV',
  invoice_in: 'INV',
  invoice_out: 'INV',
  payment: 'PMT',
  ci: 'CI',
  pl: 'PL',
  bl: 'BL',
  awb: 'AWB',
  cmr: 'CMR',
  swift: 'SWIFT',
  proforma: 'PI',
  customs_decl: 'ГТД',
  contract: 'CNTC',
  certificate: 'CERT',
  photo: 'PHOTO',
  other: 'OTHER',
};
const labelKind = (k: string) => ATTACHMENT_KIND_LABEL[k] ?? k.toUpperCase();

// =============================================================================
// ArrivalCard — Phase 3 F4 arrival confirmation flow
//
// Shown only when operation.arrival_detected_at is set (meaning the sync
// cron found a matching F4 acceptance request). Three actions:
//   - Confirm delivery to LBR     → calls /confirm-arrival
//   - Edit quantities (link to items tab — user adjusts line items manually)
//   - Not this shipment           → calls /reject-arrival
// =============================================================================
function ArrivalCard({
  operation,
  lineItems,
  onConfirmed,
  onRejected,
}: {
  operation: Operation;
  lineItems: OperationLineItem[];
  onConfirmed: () => Promise<void>;
  onRejected: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!operation.arrival_detected_at) return null;

  let receivedMap: Record<string, number> = {};
  if (operation.arrival_received_qtys) {
    try {
      receivedMap = JSON.parse(operation.arrival_received_qtys);
    } catch { /* malformed JSON — degrade gracefully */ }
  }

  const rows = lineItems.map((li) => {
    const directReceived = receivedMap[li.product_id];
    if (directReceived !== undefined) {
      return {
        sku: li.product_id,
        target_sku: li.product_id,
        product_name: li.product_name ?? li.product_id,
        expected: li.qty,
        received: directReceived,
        delta: directReceived - li.qty,
        prebundle: null as null | { ratio: number; aaSku: string },
      };
    }
    const candidateAa = `${li.product_id}aa`;
    const candidateAaaa = `${li.product_id}aaaa`;
    let aaSku: string | null = null;
    let aaReceived: number | null = null;
    let ratio = 0;
    if (receivedMap[candidateAa] !== undefined) {
      aaSku = candidateAa;
      aaReceived = receivedMap[candidateAa]!;
      ratio = 2;
    } else if (receivedMap[candidateAaaa] !== undefined) {
      aaSku = candidateAaaa;
      aaReceived = receivedMap[candidateAaaa]!;
      ratio = 4;
    }
    if (aaSku && aaReceived !== null) {
      const expectedAaUnits = Math.round(li.qty / ratio);
      return {
        sku: li.product_id,
        target_sku: aaSku,
        product_name: li.product_name ?? li.product_id,
        expected: li.qty,
        received: aaReceived,
        delta: aaReceived - expectedAaUnits,
        prebundle: { ratio, aaSku },
      };
    }
    return {
      sku: li.product_id,
      target_sku: li.product_id,
      product_name: li.product_name ?? li.product_id,
      expected: li.qty,
      received: null,
      delta: null,
      prebundle: null,
    };
  });

  const anyMismatch = rows.some((r) => r.delta !== null && r.delta !== 0 && !r.prebundle);
  const anyPrebundle = rows.some((r) => r.prebundle !== null);
  const detectedDate = new Date((operation.arrival_detected_at ?? 0) * 1000).toISOString().split('T')[0];

  async function handleConfirm() {
    setBusy('confirm');
    setErr(null);
    const res = await confirmOperationArrival(operation.id);
    setBusy(null);
    if (!res.success) {
      setErr(res.errors?.[0]?.message ?? 'Confirmation failed');
      return;
    }
    await onConfirmed();
  }

  async function handleReject() {
    if (!confirm('Reject this F4 arrival match? The card will disappear and the operation stays in shipped status.')) return;
    setBusy('reject');
    setErr(null);
    const res = await rejectOperationArrival(operation.id);
    setBusy(null);
    if (!res.success) {
      setErr(res.errors?.[0]?.message ?? 'Rejection failed');
      return;
    }
    await onRejected();
  }

  return (
    <div style={{
      background: '#E1F5EE',
      border: '1.5px solid #1D9E75',
      borderRadius: 'var(--radius-md)',
      padding: '16px 20px',
    }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
        <div style={{
          background: '#1D9E75',
          color: 'white',
          width: '32px',
          height: '32px',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          fontSize: '20px',
          fontWeight: 700,
        }}>✓</div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '15px', fontWeight: 600, color: '#04342C', marginBottom: '4px' }}>
            F4 received this shipment
          </div>
          <div style={{ fontSize: '14px', color: '#0F6E56', marginBottom: '14px' }}>
            Skladbot acceptance request{' '}
            {operation.arrival_delivery_number ? (
              <span style={{
                background: 'white',
                padding: '1px 6px',
                borderRadius: '4px',
                fontWeight: 700,
              }}>{operation.arrival_delivery_number}</span>
            ) : 'matched'}
            {' '}detected on {detectedDate}.
          </div>

          <div style={{
            background: 'white',
            borderRadius: 'var(--radius-md)',
            padding: '10px 14px',
            marginBottom: '12px',
          }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '90px 1fr 80px 24px 80px 60px',
              gap: '10px',
              alignItems: 'center',
              padding: '6px 0',
              fontSize: '12px',
              color: 'var(--fg-3)',
              fontWeight: 700,
              borderBottom: '0.5px solid var(--border-hairline)',
              marginBottom: '4px',
            }}>
              <div>SKU</div>
              <div>Product</div>
              <div style={{ textAlign: 'right' }}>Expected</div>
              <div></div>
              <div style={{ textAlign: 'right' }}>F4 received</div>
              <div style={{ textAlign: 'right' }}>Δ</div>
            </div>
            {rows.map((r) => (
              <div key={r.sku} style={{
                display: 'grid',
                gridTemplateColumns: '90px 1fr 80px 24px 80px 60px',
                gap: '10px',
                alignItems: 'center',
                padding: '6px 0',
                fontSize: '14px',
              }}>
                <div style={{ fontWeight: 700 }}>
                  {r.sku.toUpperCase()}
                  {r.prebundle && (
                    <div style={{
                      fontSize: '11px',
                      fontWeight: 500,
                      color: '#27500A',
                      marginTop: '2px',
                    }}>
                      → {r.prebundle.aaSku.toUpperCase()}
                    </div>
                  )}
                </div>
                <div style={{ color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.product_name}
                  {r.prebundle && (
                    <span style={{
                      marginLeft: '8px',
                      fontSize: '11px',
                      color: '#1D9E75',
                      background: '#E1F5EE',
                      padding: '1px 6px',
                      borderRadius: '3px',
                      fontWeight: 700,
                    }}>
                      ×{r.prebundle.ratio} pre-bundle
                    </span>
                  )}
                </div>
                <div style={{ textAlign: 'right', fontWeight: 700 }}>{r.expected.toLocaleString('en-US')}</div>
                <div style={{ textAlign: 'center', color: 'var(--fg-muted)' }}>→</div>
                <div style={{ textAlign: 'right', fontWeight: 700 }}>
                  {r.received === null ? <span style={{ color: 'var(--fg-muted)' }}>—</span> : r.received.toLocaleString('en-US')}
                </div>
                <div style={{
                  textAlign: 'right',
                  fontWeight: 700,
                  color: r.delta === null ? 'var(--fg-muted)' :
                         r.prebundle ? '#27500A' :
                         r.delta === 0 ? '#27500A' :
                         Math.abs(r.delta) <= Math.max(10, r.expected * 0.01) ? '#854F0B' :
                         '#791F1F',
                }}>
                  {r.delta === null ? '—' : r.prebundle ? '✓' : r.delta > 0 ? `+${r.delta.toLocaleString('en-US')}` : r.delta.toLocaleString('en-US')}
                </div>
              </div>
            ))}
          </div>

          {anyPrebundle && (
            <div style={{
              fontSize: '13px',
              color: '#04342C',
              marginBottom: '12px',
              padding: '6px 10px',
              background: '#E1F5EE',
              borderRadius: 'var(--radius-md)',
            }}>
              ℹ Pre-bundled at factory. Singles in our invoice will be re-labeled as 2in1 packs at delivery.
            </div>
          )}

          {anyMismatch && (
            <div style={{
              fontSize: '13px',
              color: '#854F0B',
              marginBottom: '12px',
              padding: '6px 10px',
              background: 'rgba(199,122,0,0.08)',
              borderRadius: 'var(--radius-md)',
            }}>
              ⚠ Some SKUs have variance. Confirm uses F4 numbers as final (line items will be updated to match).
            </div>
          )}

          {err && (
            <div style={{
              fontSize: '13px',
              color: '#791F1F',
              marginBottom: '12px',
              padding: '6px 10px',
              background: 'rgba(229,32,44,0.08)',
              borderRadius: 'var(--radius-md)',
            }}>{err}</div>
          )}

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={handleConfirm}
              disabled={busy !== null}
              style={{
                background: '#1D9E75',
                color: 'white',
                border: 'none',
                padding: '10px 18px',
                borderRadius: 'var(--radius-md)',
                fontSize: '14px',
                fontWeight: 700,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy === 'confirm' ? '✓ Confirming...' : '✓ Confirm delivery to LBR'}
            </button>
            <button
              onClick={handleReject}
              disabled={busy !== null}
              style={{
                background: 'transparent',
                color: 'var(--fg-3)',
                border: '0.5px solid var(--border-hairline)',
                padding: '10px 18px',
                borderRadius: 'var(--radius-md)',
                fontSize: '14px',
                fontWeight: 600,
                cursor: busy ? 'not-allowed' : 'pointer',
                opacity: busy ? 0.6 : 1,
              }}
            >
              Not this shipment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function OperationDetailClient({
  partnerSlug,
  operationId,
}: {
  partnerSlug: string;
  operationId: string;
}) {
  const [partner, setPartner] = useState<Partner | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [lineItems, setLineItems] = useState<OperationLineItem[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('items');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [documentCount, setDocumentCount] = useState(0);
  const [attachments, setAttachments] = useState<Array<{
    id: string; direction: string; kind: string;
    doc_number: string | null; doc_date: number | null;
    amount: number | null; currency: string | null;
    issuer: string | null; file_url: string | null;
    parsed_from: string | null; notes: string | null;
  }>>([]);
  /** id → code map for warehouses, used to detect factory warehouses
   * (GZH/YZH) so the Shipped button can disable itself. */
  const [warehouseCodes, setWarehouseCodes] = useState<Record<string, string>>({});

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';
        const [partnerRes, opRes, paysRes, docsRes, movRes, whRes] = await Promise.all([
          getPartner(partnerSlug),
          getOperation(operationId),
          getPayments({ operation_id: operationId }),
          getDocuments({ operation_id: operationId }),
          getStockMovements({ source: 'operation', source_ref_id: operationId }),
          fetch(`${API_BASE}/api/warehouses?compact=1`).then((r) => r.json()).catch(() => null),
        ]);

        if (whRes && whRes.success && whRes.result?.warehouses) {
          const map: Record<string, string> = {};
          for (const w of whRes.result.warehouses) {
            if (w.id && w.code) map[w.id] = w.code;
          }
          setWarehouseCodes(map);
        }

        if (partnerRes.success && partnerRes.result) setPartner(partnerRes.result);

        if (opRes.success && opRes.result) {
          setOperation(opRes.result.operation);
          setLineItems(opRes.result.line_items);
          setError(null);
        } else {
          setError(opRes.errors?.[0]?.message ?? 'Operation not found');
        }

        if (paysRes.success && paysRes.result) {
          setPayments(paysRes.result.payments);
        }

        if (docsRes.success && docsRes.result) {
          setDocumentCount(docsRes.result.count);
        }

        if (movRes.success && movRes.result) {
          setMovements(movRes.result.movements);
        }

        // Fetch operation attachments (incoming/external docs paired with payment)
        try {
          const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';
          const attRes = await fetch(`${API_BASE}/api/operations/${operationId}/attachments`);
          const attData = await attRes.json();
          if (attData.success && attData.result?.attachments) {
            setAttachments(attData.result.attachments);
          }
        } catch (e) {
          // Non-blocking — ignore if endpoint not deployed yet
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [partnerSlug, operationId]);

  const refreshOperation = async () => {
    const opRes = await getOperation(operationId);
    if (opRes.success && opRes.result) {
      setOperation(opRes.result.operation);
      setLineItems(opRes.result.line_items);
    }
  };

  const handleStatusChange = async (nextStatus: string) => {
    if (!operation) return;
    setIsUpdating(true);
    setStatusError(null);

    try {
      const res = await updateOperationStatus(operation.id, nextStatus as any);
      if (res.success) {
        // Refresh operation data
        const opRes = await getOperation(operationId);
        if (opRes.success && opRes.result) {
          setOperation(opRes.result.operation);
          setLineItems(opRes.result.line_items);
        }
      } else {
        setStatusError(res.errors?.[0]?.message ?? 'Failed to update status');
      }
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setIsUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-3)' }} />
      </div>
    );
  }

  if (error || !operation) {
    return (
      <div className="space-y-4">
        <Breadcrumb items={[
          { label: 'Partners', href: '/partners' },
          { label: partner?.trade_name ?? partnerSlug, href: `/partners/${partnerSlug}` },
          { label: operationId },
        ]} />
        <p style={{ color: 'var(--brand-rot)' }}>{error ?? 'Not found'}</p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Compute totals — Subtotal → Discount → (Net → VAT) → Total
  // line_items already have discount_pct baked into line_amount via
  // unit_price_after_disc * qty. Subtotal is sum of line_amount (post-discount).
  // We surface a simple Subtotal / Discount / Total trio when VAT = 0,
  // and add intermediate Net / VAT rows when VAT > 0.
  // ---------------------------------------------------------------------------
  const subtotal = lineItems.reduce((sum, li) => sum + li.qty * li.unit_price, 0);
  const totalAfterDiscount = lineItems.reduce((sum, li) => sum + li.line_amount, 0);
  const discount = subtotal - totalAfterDiscount;
  const discountPct = subtotal > 0 ? Math.round((discount / subtotal) * 1000) / 10 : 0;
  const vatAmount = Math.round(totalAfterDiscount * operation.vat_rate) / 100;
  const grandTotal = Math.round((totalAfterDiscount + vatAmount) * 100) / 100;
  const showVat = operation.vat_rate > 0;

  // Payments aggregation — incoming reduces outstanding, outgoing increases it.
  const paidAmount = payments.reduce(
    (sum, p) => sum + (p.direction === 'incoming' ? p.amount : -p.amount),
    0
  );
  const outstanding = Math.round((grandTotal - paidAmount) * 100) / 100;

  return (
    <div className="space-y-6">
      <Breadcrumb items={[
        { label: 'Partners', href: '/partners' },
        { label: partner?.trade_name ?? partnerSlug, href: `/partners/${partnerSlug}` },
        { label: operation.reference ?? operationId },
      ]} />

      {/* HEADER ===================================================== */}
      <div className="flex justify-between items-start flex-wrap gap-4">
        <div>
          <p style={{ fontSize: '14px' }}>
            {operation.operation_type} operation
          </p>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--fs-display-md)',
              fontWeight: 900,
              color: 'var(--fg-1)',
              marginTop: '4px',
            }}
          >
            {operation.reference ?? operationId.slice(0, 12)}
          </h1>
          <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)', marginTop: '4px' }}>
            {partner?.trade_name ?? partnerSlug}
            {operation.contract_no && !/^NO[-\s]CONTRACT/i.test(operation.contract_no) && (
              <> · Contract <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{operation.contract_no}</span></>
            )}
            {operation.gtd_number && (
              <> · ГТД <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{operation.gtd_number}</span></>
            )}
            {operation.contract_no && /^NO[-\s]CONTRACT/i.test(operation.contract_no) && (
              <>
                {' · '}
                <span
                  style={{
                    padding: '2px 8px',
                    fontSize: '12px',
                    fontWeight: 600,
                    color: 'var(--fg-3)',
                    backgroundColor: 'var(--paper-sunk)',
                    border: '1px dashed var(--border-hairline)',
                    borderRadius: 'var(--radius-pill)',
                    marginLeft: '4px',
                  }}
                  title="Technical placeholder — replace when a real contract is signed"
                >
                  Placeholder contract
                </span>
              </>
            )}
          </p>
          {/* Attached docs summary — passport line: invoice + payment + act */}
          {attachments.length > 0 && (
            <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '6px', display: 'flex', flexWrap: 'wrap', gap: '14px' }}>
              {(() => {
                const inv = attachments.find(a => a.kind === 'invoice');
                const pay = attachments.find(a => a.kind === 'payment');
                const act = attachments.find(a => a.kind === 'act' || a.kind === 'upd');
                const fmtDate = (ts: number | null) =>
                  ts ? new Date(ts * 1000).toLocaleDateString('ru-RU') : null;
                const parts: React.ReactNode[] = [];
                if (act) {
                  parts.push(
                    <span key="act">
                      <span style={{ color: 'var(--fg-3)' }}>{act.kind === 'upd' ? 'УПД' : 'Акт'} </span>
                      <span style={{ fontWeight: 700, color: 'var(--fg-2)' }}>{act.doc_number ?? '—'}</span>
                      {act.doc_date && <span style={{ color: 'var(--fg-3)' }}> от {fmtDate(act.doc_date)}</span>}
                    </span>
                  );
                }
                if (inv) {
                  parts.push(
                    <span key="inv">
                      <span style={{ color: 'var(--fg-3)' }}>Счёт </span>
                      <span style={{ fontWeight: 700, color: 'var(--fg-2)' }}>№{inv.doc_number ?? '—'}</span>
                      {inv.doc_date && <span style={{ color: 'var(--fg-3)' }}> от {fmtDate(inv.doc_date)}</span>}
                    </span>
                  );
                }
                if (pay) {
                  parts.push(
                    <span key="pay">
                      <span style={{ color: 'var(--fg-3)' }}>Платёжка </span>
                      <span style={{ fontWeight: 700, color: 'var(--fg-2)' }}>№{pay.doc_number ?? '—'}</span>
                      {pay.doc_date && <span style={{ color: 'var(--fg-3)' }}> от {fmtDate(pay.doc_date)}</span>}
                    </span>
                  );
                }
                return parts.length > 0 ? parts : null;
              })()}
            </p>
          )}
        </div>
        <div className="text-right">
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--fs-display-md)',
              fontWeight: 900,
              color: 'var(--fg-1)',
            }}
          >
            {operation.currency} {formatMoney(grandTotal, operation.currency)}
          </div>
          <div className="mt-2 flex justify-end gap-2 flex-wrap items-center">
            {statusChip(operation.status)}
            {(() => {
              const ps = operation.payment_state ?? 'neutral';
              if (ps === 'neutral') return null;
              const po = PAYMENT_OVERLAY[ps]!;
              const total = operation.total_amount || 0;
              const paid = operation.paid_amount ?? 0;
              const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
              return (
                <span
                  className="inline-flex items-center gap-2"
                  style={{
                    padding: '4px 10px',
                    backgroundColor: po.bg,
                    color: po.fg,
                    borderRadius: 'var(--radius-pill)',
                    fontSize: '14px',
                    fontWeight: 600,
                    border: `1px solid ${po.dot}33`,
                  }}
                >
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: po.dot, display: 'inline-block' }} />
                  {po.label}
                </span>
              );
            })()}
          </div>
          
          {/* Status transition buttons */}
          {statusError && (
            <p style={{ fontSize: '12px', color: 'var(--brand-rot)', marginTop: '8px' }}>
              {statusError}
            </p>
          )}
          <div className="mt-3 flex gap-2 flex-wrap justify-end">
            {(() => {
              const nextStatus = getNextStatus(operation.operation_type, operation.status);
              if (!nextStatus) return null;
              return (
                <button
                  onClick={() => handleStatusChange(nextStatus)}
                  disabled={isUpdating}
                  style={{
                    padding: '8px 14px',
                    fontSize: '14px',
                    fontWeight: 600,
                    border: '1px solid var(--border-hairline)',
                    borderRadius: 'var(--radius-md)',
                    backgroundColor: 'var(--bg-elevated)',
                    color: 'var(--fg-1)',
                    cursor: isUpdating ? 'not-allowed' : 'pointer',
                    opacity: isUpdating ? 0.5 : 1,
                    transition: 'opacity 150ms',
                  }}
                >
                  {isUpdating ? (
                    <span className="inline-flex gap-2 items-center">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Updating…
                    </span>
                  ) : (
                    `Mark as ${nextStatus.replace('_', ' ')}`
                  )}
                </button>
              );
            })()}
            {operation.status !== 'cancelled' && operation.status !== 'delivered' &&
             !(operation.operation_type === 'sale' && operation.status === 'shipped') && (
              <button
                onClick={() => handleStatusChange('cancelled')}
                disabled={isUpdating}
                style={{
                  padding: '8px 14px',
                  fontSize: '14px',
                  fontWeight: 600,
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-md)',
                  backgroundColor: 'rgba(229,32,44,0.08)',
                  color: 'var(--brand-rot)',
                  cursor: isUpdating ? 'not-allowed' : 'pointer',
                  opacity: isUpdating ? 0.5 : 1,
                  transition: 'opacity 150ms',
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="dx-ribbon-rule" />

      {/* QUICK ACTIONS ============================================ */}
      <DocumentActionBar
        operationId={operationId}
        operationStatus={operation.status}
        operationType={operation.operation_type}
        partnerCountry={partner?.country ?? null}
        ourCompanyAbbr={operation.entity_abbreviation ?? null}
        warehouseCode={
          operation.operation_type === 'purchase'
            ? (operation.warehouse_to_id ? warehouseCodes[operation.warehouse_to_id] ?? null : null)
            : (operation.warehouse_from_id ? warehouseCodes[operation.warehouse_from_id] ?? null : null)
        }
        onIssued={async () => {
          const opRes = await getOperation(operationId);
          if (opRes.success && opRes.result) {
            setOperation(opRes.result.operation);
            setLineItems(opRes.result.line_items);
          }
          const docsRes = await getDocuments({ operation_id: operationId });
          if (docsRes.success && docsRes.result) setDocumentCount(docsRes.result.count);
        }}
        onStatusChange={async () => {
          const [opRes, movesRes] = await Promise.all([
            getOperation(operationId),
            getStockMovements({ source: 'operation', source_ref_id: operationId }),
          ]);
          if (opRes.success && opRes.result) {
            setOperation(opRes.result.operation);
            setLineItems(opRes.result.line_items);
          }
          if (movesRes.success && movesRes.result) {
            setMovements(movesRes.result.movements);
          }
        }}
      />

      {/* F4 ARRIVAL CARD (Phase 3) ================================== */}
      <ArrivalCard
        operation={operation}
        lineItems={lineItems}
        onConfirmed={async () => {
          const [opRes, movesRes] = await Promise.all([
            getOperation(operationId),
            getStockMovements({ source: 'operation', source_ref_id: operationId }),
          ]);
          if (opRes.success && opRes.result) {
            setOperation(opRes.result.operation);
            setLineItems(opRes.result.line_items);
          }
          if (movesRes.success && movesRes.result) {
            setMovements(movesRes.result.movements);
          }
        }}
        onRejected={async () => {
          const opRes = await getOperation(operationId);
          if (opRes.success && opRes.result) {
            setOperation(opRes.result.operation);
          }
        }}
      />

      {/* REFERENCE STRIP ============================================ */}
      <div
        className="grid grid-cols-1 md:grid-cols-2 md:grid-cols-6 gap-4 p-4"
        style={{
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <div>
          <p style={{ fontSize: '14px' }}>Date</p>
          <p className="mt-1" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
            {formatDate(operation.operation_date)}
          </p>
        </div>
        <div>
          <p style={{ fontSize: '14px' }}>Entity</p>
          <p className="mt-1" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
            {operation.entity_abbreviation ?? '—'}
          </p>
        </div>
        <div>
          <p style={{ fontSize: '14px' }}>Warehouse</p>
          <p className="mt-1" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
            {operation.warehouse_from_id ?? '—'}
          </p>
        </div>
        <div>
          <p style={{ fontSize: '14px' }}>Currency</p>
          <p className="mt-1" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
            {operation.currency}
          </p>
        </div>
        <div>
          <p style={{ fontSize: '14px' }}>FX → USD</p>
          <p
            className="mt-1"
            style={{
              fontSize: 'var(--fs-body-sm)',
              color: operation.fx_rate_to_usd ? 'var(--fg-1)' : 'var(--fg-3)',
              fontWeight: operation.fx_rate_to_usd ? 700 : 400,
            }}
          >
            {operation.fx_rate_to_usd
              ? operation.fx_rate_to_usd.toFixed(4)
              : '—'}
          </p>
        </div>
        <div>
          <p style={{ fontSize: '14px' }}>VAT</p>
          <p
            className="mt-1"
            style={{
              fontSize: 'var(--fs-body-sm)',
              color: showVat ? 'var(--fg-1)' : 'var(--fg-3)',
            }}
          >
            {showVat ? `${operation.vat_rate}%` : 'None'}
          </p>
        </div>
      </div>

      {/* TABS ======================================================= */}
      <div
        className="flex"
        style={{ borderBottom: '1px solid var(--border-hairline)' }}
      >
        {([
          { id: 'items',     label: 'Line items', count: lineItems.length },
          { id: 'status',    label: 'Status',     count: null },
          { id: 'documents', label: 'Documents',  count: documentCount },
          { id: 'payments',  label: 'Payments',   count: payments.length },
          { id: 'movements', label: 'Stock movements', count: movements.length },
        ] as { id: Tab; label: string; count: number | null }[]).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-3 transition-colors"
              style={{
                fontSize: '18px',
                fontWeight: 700,
                color: isActive ? 'var(--fg-1)' : 'var(--fg-3)',
                borderBottom: isActive ? '2px solid var(--fg-1)' : '2px solid transparent',
                marginBottom: '-1px',
                backgroundColor: 'transparent',
                cursor: 'pointer',
              }}
            >
              {tab.label}
              {tab.count !== null && tab.count > 0 && (
                <span style={{ color: 'var(--fg-3)', marginLeft: '8px', fontSize: '16px', fontWeight: 400 }}>
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* TAB CONTENT ================================================ */}
      {activeTab === 'items' && (
        <ItemsTab
          lineItems={lineItems}
          currency={operation.currency}
          subtotal={subtotal}
          discount={discount}
          discountPct={discountPct}
          totalAfterDiscount={totalAfterDiscount}
          vatRate={operation.vat_rate}
          vatAmount={vatAmount}
          grandTotal={grandTotal}
          showVat={showVat}
          operationId={operationId}
          onLineItemUpdate={async () => {
            const opRes = await getOperation(operationId);
            if (opRes.success && opRes.result) {
              setOperation(opRes.result.operation);
              setLineItems(opRes.result.line_items);
            }
          }}
        />
      )}

      {activeTab === 'status' && (
        <StatusTab
          status={operation.status}
          operationType={operation.operation_type}
          hasDocuments={documentCount > 0}
          movements={movements}
        />
      )}

      {activeTab === 'documents' && (
        <DocumentsTab
          operationId={operationId}
          operation={operation}
          attachments={attachments}
          onOperationRefresh={refreshOperation}
        />
      )}

      {activeTab === 'payments' && (
        <PaymentsTab
          partnerSlug={partnerSlug}
          operationId={operationId}
          payments={payments}
          currency={operation.currency}
          grandTotal={grandTotal}
          paidAmount={paidAmount}
          outstanding={outstanding}
        />
      )}

      {activeTab === 'movements' && (
        <MovementsTab movements={movements} />
      )}
    </div>
  );
}

// =============================================================================
// Items tab
// =============================================================================
interface EditingCell {
  lineItemId: string;
  field: 'qty' | 'unit_price';
  value: string;
}

function ItemsTab({
  lineItems,
  currency,
  subtotal,
  discount,
  discountPct,
  totalAfterDiscount,
  vatRate,
  vatAmount,
  grandTotal,
  showVat,
  operationId,
  onLineItemUpdate,
}: {
  lineItems: OperationLineItem[];
  currency: string;
  subtotal: number;
  discount: number;
  discountPct: number;
  totalAfterDiscount: number;
  vatRate: number;
  vatAmount: number;
  grandTotal: number;
  showVat: boolean;
  operationId: string;
  onLineItemUpdate: () => Promise<void>;
}) {
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const showDiscount = discount > 0;

  const handleCellEdit = (lineItemId: string, field: 'qty' | 'unit_price', currentValue: number) => {
    setEditingCell({
      lineItemId,
      field,
      value: String(currentValue),
    });
  };

  const handleSaveCell = async () => {
    if (!editingCell) return;
    setIsSaving(true);
    try {
      const newValue = editingCell.field === 'qty' 
        ? parseInt(editingCell.value, 10)
        : parseFloat(editingCell.value);
      
      if (isNaN(newValue) || newValue < 0) {
        setEditingCell(null);
        return;
      }

      const updatePayload = editingCell.field === 'qty'
        ? { qty: newValue }
        : { unit_price: newValue };

      const response = await fetch(
        `/api/line-items/${editingCell.lineItemId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updatePayload),
        }
      );

      if (response.ok) {
        setEditingCell(null);
        await onLineItemUpdate();
      }
    } catch (e) {
      console.error('Failed to update line item:', e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveCell();
    } else if (e.key === 'Escape') {
      setEditingCell(null);
    }
  };

  return (
    <div
      className="overflow-hidden"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <table className="w-full" style={{ fontSize: 'var(--fs-body-sm)' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
            <th className="text-left px-4 py-3" style={{ fontSize: '14px' }}>SKU</th>
            <th className="text-left px-4 py-3" style={{ fontSize: '14px' }}>Product</th>
            <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Qty</th>
            <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Unit</th>
            <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {lineItems.map((li) => (
            <tr key={li.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
              <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-1)' }}>
                {li.product_id.toUpperCase()}
              </td>
              <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>
                {li.product_name ?? li.item_description ?? li.product_id}
              </td>
              <td 
                className="px-4 py-3 text-right"
                onClick={() => handleCellEdit(li.id, 'qty', li.qty)}
                style={{ 
                  color: li.qty === 0 ? 'var(--brand-rot)' : 'var(--fg-1)',
                  cursor: 'pointer',
                  backgroundColor: editingCell?.lineItemId === li.id && editingCell.field === 'qty' ? 'var(--paper-sunk)' : 'transparent',
                  borderRadius: '4px',
                  transition: 'background-color 150ms',
                }}
              >
                {editingCell?.lineItemId === li.id && editingCell.field === 'qty' ? (
                  <input
                    autoFocus
                    type="number"
                    value={editingCell.value}
                    onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                    onBlur={handleSaveCell}
                    onKeyDown={handleKeyDown}
                    disabled={isSaving}
                    style={{
                      width: '60px',
                      padding: '4px 6px',
                      fontSize: '14px',
                      border: '1px solid var(--border-hairline)',
                      borderRadius: '4px',
                      backgroundColor: 'var(--paper)',
                      color: 'var(--fg-1)',
                      fontWeight: 600,
                    }}
                  />
                ) : (
                  li.qty
                )}
              </td>
              <td 
                className="px-4 py-3 text-right"
                onClick={() => handleCellEdit(li.id, 'unit_price', li.unit_price)}
                style={{ 
                  color: 'var(--fg-1)',
                  cursor: 'pointer',
                  backgroundColor: editingCell?.lineItemId === li.id && editingCell.field === 'unit_price' ? 'var(--paper-sunk)' : 'transparent',
                  borderRadius: '4px',
                  transition: 'background-color 150ms',
                }}
              >
                {editingCell?.lineItemId === li.id && editingCell.field === 'unit_price' ? (
                  <input
                    autoFocus
                    type="number"
                    step="0.01"
                    value={editingCell.value}
                    onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                    onBlur={handleSaveCell}
                    onKeyDown={handleKeyDown}
                    disabled={isSaving}
                    style={{
                      width: '80px',
                      padding: '4px 6px',
                      fontSize: '14px',
                      border: '1px solid var(--border-hairline)',
                      borderRadius: '4px',
                      backgroundColor: 'var(--paper)',
                      color: 'var(--fg-1)',
                      fontWeight: 600,
                    }}
                  />
                ) : (
                  formatMoney(li.unit_price, currency)
                )}
              </td>
              <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 600 }}>
                {formatMoney(li.line_amount, currency)}
              </td>
            </tr>
          ))}

          {/* Subtotal */}
          <tr>
            <td colSpan={4} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '14px' }}>
              Subtotal
            </td>
            <td className="px-4 py-2 text-right" style={{ color: 'var(--fg-1)' }}>
              {formatMoney(subtotal, currency)}
            </td>
          </tr>

          {/* Discount (only if >0) */}
          {showDiscount && (
            <tr>
              <td colSpan={4} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '14px' }}>
                Discount {discountPct}%
              </td>
              <td className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)' }}>
                −{formatMoney(discount, currency)}
              </td>
            </tr>
          )}

          {/* VAT — Net + VAT lines (only if rate > 0) */}
          {showVat && (
            <>
              <tr>
                <td colSpan={4} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '14px' }}>
                  Net
                </td>
                <td className="px-4 py-2 text-right" style={{ color: 'var(--fg-1)' }}>
                  {formatMoney(totalAfterDiscount, currency)}
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '14px' }}>
                  VAT {vatRate}%
                </td>
                <td className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)' }}>
                  +{formatMoney(vatAmount, currency)}
                </td>
              </tr>
            </>
          )}

          {/* Total */}
          <tr style={{ borderTop: '1px solid var(--border-hairline)' }}>
            <td colSpan={4} className="px-4 py-3 text-right" style={{ fontSize: '14px' }}>
              Total
            </td>
            <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 700, fontSize: '15px' }}>
              {formatMoney(grandTotal, currency)} {currency}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// Status tab — read-only timeline. Past steps are filled (✓), current is
// highlighted, future steps are dimmed. All write actions live in the header
// "Mark as ..." button. The timeline is purely visual history.
// =============================================================================

// Display order of all statuses per operation_type (terminal cancelled is shown
// only when the op is actually cancelled).
const STATUS_TIMELINE: Record<string, string[]> = {
  sale:     ['draft', 'issued', 'order_fulfilment', 'shipped'],
  purchase: ['draft', 'issued', 'production', 'stocked', 'shipped', 'delivered'],
  transfer: ['draft', 'issued', 'shipped', 'delivered'],
};

const STATUS_VERBS: Record<string, string> = {
  draft:            'Created',
  issued:           'Issued',
  order_fulfilment: 'Boxing',
  production:       'In production',
  stocked:          'Stocked',
  shipped:          'Shipped',
  delivered:        'Delivered',
  cancelled:        'Cancelled',
};

function StatusTab({
  status,
  operationType,
  hasDocuments,
  movements,
}: {
  status: string;
  operationType: string;
  hasDocuments: boolean;
  movements: StockMovement[];
}) {
  const cancelled = status === 'cancelled';
  const baseTimeline = STATUS_TIMELINE[operationType] ?? STATUS_TIMELINE.purchase!;
  const currentIdx = baseTimeline.indexOf(status);

  // For cancelled operations — infer the last reached step from side-effects.
  // No history table exists; we use stock movements + documents as evidence.
  //
  //   purchase: shipment(out) at shipped, receipt(in) at delivered
  //   sale:     shipment(out) at shipped
  //   transfer: shipment(out) at shipped, receipt(in) at delivered
  //   any:      documents exist at issued
  //
  // We pick the furthest step whose evidence is present.
  let cancelledLastReachedIdx = -1;
  if (cancelled) {
    const hasReceipt = movements.some((m) => m.movement_type === 'receipt' || m.movement_type === 'transfer_in');
    const hasShipment = movements.some((m) => m.movement_type === 'shipment' || m.movement_type === 'transfer_out');
    if (hasReceipt) cancelledLastReachedIdx = baseTimeline.indexOf('delivered');
    else if (hasShipment) cancelledLastReachedIdx = baseTimeline.indexOf('shipped');
    else if (hasDocuments) cancelledLastReachedIdx = baseTimeline.indexOf('issued');
    else cancelledLastReachedIdx = baseTimeline.indexOf('draft');
  }

  // Build full visual timeline: base steps + cancelled marker (if applicable)
  const steps = cancelled ? [...baseTimeline, 'cancelled'] : baseTimeline;

  return (
    <div
      className="p-6"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <p
        className="mb-6"
        style={{ fontSize: '14px', color: 'var(--fg-3)' }}
      >
        Lifecycle for {operationType} operation. Use{' '}
        <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>Mark as …</span>{' '}
        button in the header to advance status.
      </p>

      <ol className="space-y-3" style={{ position: 'relative' }}>
        {steps.map((step, idx) => {
          let state: 'past' | 'current' | 'future' | 'cancel-marker' | 'cancel-here';
          if (step === 'cancelled') {
            state = 'cancel-marker';
          } else if (cancelled) {
            // Op is cancelled — render base steps relative to the inferred
            // last-reached index instead of currentIdx (-1 anyway).
            if (idx < cancelledLastReachedIdx) state = 'past';
            else if (idx === cancelledLastReachedIdx) state = 'cancel-here';
            else state = 'future';
          } else if (idx < currentIdx) {
            state = 'past';
          } else if (idx === currentIdx) {
            state = 'current';
          } else {
            state = 'future';
          }

          const visual = (() => {
            switch (state) {
              case 'past':
                return {
                  dot: 'var(--status-success)',
                  fg: 'var(--fg-1)',
                  weight: 600,
                  prefix: '✓',
                  filled: true,
                };
              case 'current':
                return {
                  dot: 'var(--status-info)',
                  fg: 'var(--fg-1)',
                  weight: 700,
                  prefix: '●',
                  filled: true,
                };
              case 'cancel-here':
                // The step at which cancellation happened — past tense, but
                // marked red so the eye lands here.
                return {
                  dot: 'var(--brand-rot)',
                  fg: 'var(--brand-rot)',
                  weight: 700,
                  prefix: '✓',
                  filled: true,
                };
              case 'future':
                return {
                  dot: 'var(--border-hairline)',
                  fg: 'var(--fg-3)',
                  weight: 400,
                  prefix: '○',
                  filled: false,
                };
              case 'cancel-marker':
                return {
                  dot: 'var(--brand-rot)',
                  fg: 'var(--brand-rot)',
                  weight: 700,
                  prefix: '✕',
                  filled: true,
                };
            }
          })();

          return (
            <li
              key={step}
              className="flex items-center gap-3"
              style={{ fontSize: 'var(--fs-body-sm)' }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '24px',
                  height: '24px',
                  borderRadius: '50%',
                  backgroundColor: visual.filled ? visual.dot : 'transparent',
                  border: visual.filled ? 'none' : '1px solid var(--border-hairline)',
                  color: 'var(--paper)',
                  fontSize: '13px',
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {visual.filled ? visual.prefix : ''}
              </span>
              <span
                style={{
                  color: visual.fg,
                  fontWeight: visual.weight,
                  textTransform: 'capitalize',
                }}
              >
                {STATUS_VERBS[step] ?? step.replace(/_/g, ' ')}
              </span>
              {state === 'current' && (
                <span
                  className="ml-auto"
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--status-info)',
                    padding: '2px 10px',
                    backgroundColor: 'rgba(31,73,125,0.08)',
                    border: '1px solid rgba(31,73,125,0.3)',
                    borderRadius: 'var(--radius-pill)',
                  }}
                >
                  Current
                </span>
              )}
              {state === 'cancel-here' && (
                <span
                  className="ml-auto"
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--brand-rot)',
                    padding: '2px 10px',
                    backgroundColor: 'rgba(229,32,44,0.08)',
                    border: '1px solid rgba(229,32,44,0.3)',
                    borderRadius: 'var(--radius-pill)',
                  }}
                >
                  Cancelled here
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// =============================================================================
// Documents tab — live data from GET /api/documents?operation_id=...
// =============================================================================
function DocumentsTab({ operationId, operation, attachments, onOperationRefresh }: {
  operationId: string;
  operation: Operation;
  attachments: Array<{
    id: string; direction: string; kind: string;
    doc_number: string | null; doc_date: number | null;
    amount: number | null; currency: string | null;
    issuer: string | null; file_url: string | null;
    parsed_from: string | null; notes: string | null;
  }>;
  onOperationRefresh: () => Promise<void>;
}) {
  const [docs, setDocs] = useState<OperationDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueSuccess, setIssueSuccess] = useState<string | null>(null);

  const fetchDocs = async () => {
    const res = await getDocuments({ operation_id: operationId });
    if (res.success && res.result) setDocs(res.result.documents);
    setLoading(false);
  };

  useEffect(() => { fetchDocs(); }, [operationId]);

  const handleIssue = async () => {
    setIssueError(null);
    setIssueSuccess(null);
    setIssuing(true);
    try {
      const res = await issueDocuments(operationId);
      if (res.success && res.result) {
        const { issued, skipped } = res.result;
        setIssueSuccess(
          issued.length > 0
            ? `Issued: ${issued.join(', ')}${skipped.length > 0 ? ` · Already existed: ${skipped.join(', ')}` : ''}`
            : `Already up to date — ${skipped.join(', ')}`
        );
        await fetchDocs();
      } else {
        setIssueError(res.errors?.[0]?.message ?? 'Failed to issue documents');
      }
    } catch (e) {
      setIssueError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setIssuing(false);
    }
  };

  const DOC_TYPE_LABELS: Record<string, string> = {
    CI: 'Commercial Invoice',
    PL: 'Packing List',
    'IS-V1': 'Issuance Statement',
    'IS-V2': 'Issuance Statement v2',
    IS: 'Issuance Statement',
    UPD: 'UPD',
    TN: 'TN',
    GTD: 'GTD',
    RFQ: 'RFQ',
    ACT: 'ACT',
    contract: 'Contract',
    annex: 'Annex',
    addendum: 'Addendum',
    other: 'Other',
  };

  const STATUS_STYLE: Record<string, { fg: string; bg: string }> = {
    issued:   { fg: 'var(--status-success)', bg: 'rgba(46,125,79,0.08)' },
    draft:    { fg: 'var(--status-warning)', bg: 'rgba(199,122,0,0.08)' },
    voided:   { fg: 'var(--fg-3)',           bg: 'var(--paper-sunk)' },
  };

  const isPurchase = operation.operation_type === 'purchase';
  const isGoodsPurchase = isPurchase && operation.operation_track !== 'service';

  return (
    <>
    {isPurchase && (
      <GtdSection
        operationId={operationId}
        currentNumber={operation.gtd_number ?? null}
        isMandatory={isGoodsPurchase}
        onUpdated={onOperationRefresh}
      />
    )}
    <div
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {/* header */}
      <div
        className="flex justify-between items-center px-4 py-3"
        style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}
      >
        <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)', margin: 0 }}>
          {loading ? 'Documents' : `Documents${docs.length > 0 ? ` (${docs.length})` : ''}`}
        </p>
        <button
          onClick={handleIssue}
          disabled={issuing}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 14px',
            fontSize: '14px',
            fontWeight: 600,
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: 'var(--paper)',
            color: 'var(--fg-1)',
            cursor: issuing ? 'not-allowed' : 'pointer',
            opacity: issuing ? 0.6 : 1,
          }}
        >
          {issuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Issue documents
        </button>
      </div>

      {/* feedback */}
      {issueSuccess && (
        <div style={{ padding: '10px 16px', backgroundColor: 'rgba(46,125,79,0.08)', borderBottom: '1px solid var(--border-hairline)' }}>
          <p style={{ fontSize: '14px', color: 'var(--status-success)', margin: 0 }}>{issueSuccess}</p>
        </div>
      )}
      {issueError && (
        <div style={{ padding: '10px 16px', backgroundColor: 'rgba(229,32,44,0.08)', borderBottom: '1px solid var(--border-hairline)' }}>
          <p style={{ fontSize: '14px', color: 'var(--brand-rot)', margin: 0 }}>{issueError}</p>
        </div>
      )}

      {/* body */}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--fg-3)' }} />
        </div>
      ) : docs.length === 0 ? (
        <div style={{ padding: '32px 16px', textAlign: 'center' }}>
          <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: '0 0 4px' }}>No documents yet</p>
          <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: 0 }}>Click Issue documents to generate CI and PL for this operation</p>
        </div>
      ) : (
        <table className="w-full" style={{ fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Document</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Type</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Date</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Status</th>
              <th className="text-right px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>PDF</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => {
              const statusStyle = STATUS_STYLE[doc.status] ?? STATUS_STYLE.draft!;
              const typeLabel = DOC_TYPE_LABELS[doc.document_type] ?? doc.document_type;
              const date = doc.document_date
                ? new Date(doc.document_date * 1000).toISOString().split('T')[0]
                : '—';
              return (
                <tr key={doc.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="px-4 py-3" style={{ fontWeight: 700, color: 'var(--fg-1)' }}>
                    {doc.document_number}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>
                    {typeLabel}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-3)' }}>
                    {date}
                  </td>
                  <td className="px-4 py-3">
                    <span style={{
                      display: 'inline-block',
                      padding: '2px 10px',
                      borderRadius: '999px',
                      fontSize: '14px',
                      fontWeight: 500,
                      color: statusStyle.fg,
                      backgroundColor: statusStyle.bg,
                    }}>
                      {doc.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {doc.pdf_r2_url ? (
                      <a
                        href={`${process.env.NEXT_PUBLIC_API_URL ?? 'https://dasoperator-api.dasexperten.workers.dev'}/api/documents/${doc.id}/download`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: '14px', fontWeight: 600, color: 'var(--brand-rot)', textDecoration: 'none' }}
                      >
                        Download
                      </a>
                    ) : (
                      <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
    {/* === ATTACHED DOCUMENTS — unified incoming + outgoing list === */}
    <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginTop: '16px' }}>
      <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
        <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)', margin: 0 }}>
          Attached documents{attachments.length > 0 ? ` (${attachments.length})` : ''}
        </p>
      </div>
      {attachments.length === 0 ? (
        <div style={{ padding: '24px 16px', textAlign: 'center' }}>
          <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: 0 }}>No external documents attached yet</p>
        </div>
      ) : (
        <table className="w-full" style={{ fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Direction</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Kind</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Number</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Date</th>
              <th className="text-right px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Amount</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Issuer</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Source</th>
            </tr>
          </thead>
          <tbody>
            {attachments.map((att) => {
              const date = att.doc_date ? new Date(att.doc_date * 1000).toLocaleDateString('ru-RU') : '—';
              const dirColor = att.direction === 'outgoing' ? 'var(--brand-rot)' : 'var(--status-success)';
              const dirBg = att.direction === 'outgoing' ? 'rgba(229,32,44,0.08)' : 'rgba(46,125,79,0.08)';
              return (
                <tr key={att.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="px-4 py-3">
                    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: '999px', fontSize: '14px', fontWeight: 500, color: dirColor, backgroundColor: dirBg }}>
                      {att.direction === 'outgoing' ? 'Outgoing' : 'Incoming'}
                    </span>
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-2)', fontWeight: 600 }}>{labelKind(att.kind)}</td>
                  <td className="px-4 py-3" style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{att.doc_number ?? '—'}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-3)' }}>{date}</td>
                  <td className="px-4 py-3 text-right" style={{ fontWeight: 700, color: 'var(--fg-1)' }}>
                    {att.amount != null ? `${formatMoney(att.amount, att.currency || 'RUB')} ${att.currency || ''}` : '—'}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-3)', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={att.issuer || ''}>
                    {att.issuer || '—'}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-3)', fontSize: '14px' }}>{att.parsed_from || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
    </>
  );
}

// =============================================================================
// GTD section — editable customs declaration number + PDF upload/download
// Used inside DocumentsTab for purchase operations.
// =============================================================================
function GtdSection({
  operationId,
  currentNumber,
  isMandatory,
  onUpdated,
}: {
  operationId: string;
  currentNumber: string | null;
  isMandatory: boolean;
  onUpdated: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentNumber ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Keep draft in sync if parent refreshes with new number
  useEffect(() => {
    if (!editing) setDraft(currentNumber ?? '');
  }, [currentNumber, editing]);

  const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';

  const handleSave = async () => {
    setError(null);
    setInfo(null);
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/operations/${operationId}/gtd`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gtd_number: draft.trim() }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.errors?.[0]?.message ?? 'Failed to save GTD number');
      } else {
        setEditing(false);
        setInfo('GTD number saved.');
        await onUpdated();
        setTimeout(() => setInfo(null), 3000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleUploadClick = () => fileInputRef.current?.click();

  const handleFileSelected = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setError('Only PDF files are accepted.');
      ev.target.value = '';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File must be under 10 MB.');
      ev.target.value = '';
      return;
    }

    const numberToUse = (draft.trim() || currentNumber || '').trim();
    if (!numberToUse) {
      setError('Enter a GTD number first before uploading the PDF.');
      ev.target.value = '';
      return;
    }

    setError(null);
    setInfo(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('gtd_number', numberToUse);

      const res = await fetch(`${API_BASE}/api/operations/${operationId}/gtd/upload`, {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.errors?.[0]?.message ?? 'Upload failed');
      } else {
        setInfo(
          data.result?.replaced
            ? `Replaced existing GTD PDF (${formatBytes(data.result.file_size)}).`
            : `Uploaded GTD PDF (${formatBytes(data.result.file_size)}).`
        );
        await onUpdated();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setUploading(false);
      ev.target.value = '';
    }
  };

  const downloadUrl = currentNumber
    ? `${API_BASE}/api/operations/${operationId}/gtd/download`
    : null;

  return (
    <div
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        marginBottom: '16px',
        overflow: 'hidden',
      }}
    >
      <div
        className="flex justify-between items-center px-4 py-3"
        style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}
      >
        <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)', margin: 0 }}>
          ГТД — Customs Declaration
          {isMandatory && (
            <span style={{ marginLeft: '8px', fontSize: '12px', fontWeight: 500, color: 'var(--brand-rot)' }}>
              * required
            </span>
          )}
        </p>
        {!editing && (
          <button
            onClick={() => { setEditing(true); setError(null); setInfo(null); }}
            style={{
              padding: '4px 10px',
              fontSize: '13px',
              fontWeight: 500,
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)',
              color: 'var(--fg-2)',
              cursor: 'pointer',
            }}
          >
            {currentNumber ? 'Edit' : 'Add'}
          </button>
        )}
      </div>

      <div className="px-4 py-3" style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        {editing ? (
          <>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. 10228010/130526/5149029"
              autoFocus
              style={{
                flex: '1 1 280px',
                padding: '8px 12px',
                fontSize: '14px',
                fontWeight: 700,
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--paper-sunk)',
                color: 'var(--fg-1)',
              }}
            />
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 600,
                border: '1px solid var(--brand-rot)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--brand-rot)',
                color: 'white',
                cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => { setEditing(false); setDraft(currentNumber ?? ''); setError(null); }}
              disabled={saving}
              style={{
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 500,
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--paper)',
                color: 'var(--fg-2)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', flex: '1 1 auto' }}>
              {currentNumber ?? <span style={{ color: 'var(--fg-3)', fontWeight: 500, fontStyle: 'italic' }}>Not set</span>}
            </span>
            {downloadUrl && (
              <a
                href={downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: '6px 14px',
                  fontSize: '13px',
                  fontWeight: 500,
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'var(--paper)',
                  color: 'var(--fg-1)',
                  textDecoration: 'none',
                }}
              >
                View PDF
              </a>
            )}
            <button
              onClick={handleUploadClick}
              disabled={uploading}
              style={{
                padding: '6px 14px',
                fontSize: '13px',
                fontWeight: 500,
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--paper)',
                color: 'var(--fg-1)',
                cursor: uploading ? 'not-allowed' : 'pointer',
                opacity: uploading ? 0.6 : 1,
              }}
            >
              {uploading ? 'Uploading…' : currentNumber ? 'Replace PDF' : 'Upload PDF'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={handleFileSelected}
              style={{ display: 'none' }}
            />
          </>
        )}
      </div>

      {(error || info) && (
        <div className="px-4 py-2" style={{
          borderTop: '1px solid var(--border-hairline)',
          backgroundColor: error ? 'rgba(229,32,44,0.06)' : 'rgba(46,125,79,0.06)',
        }}>
          <p style={{
            fontSize: '13px',
            color: error ? 'var(--brand-rot)' : 'var(--status-success)',
            margin: 0,
          }}>
            {error || info}
          </p>
        </div>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// =============================================================================
// Payments tab
// =============================================================================
function PaymentsTab({
  partnerSlug,
  operationId,
  payments,
  currency,
  grandTotal,
  paidAmount,
  outstanding,
}: {
  partnerSlug: string;
  operationId: string;
  payments: Payment[];
  currency: string;
  grandTotal: number;
  paidAmount: number;
  outstanding: number;
}) {
  return (
    <div className="space-y-4">
      <div
        className="overflow-hidden"
        style={{
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <div
          className="px-4 py-3 flex justify-between items-center"
          style={{
            backgroundColor: 'var(--paper-sunk)',
            borderBottom: '1px solid var(--border-hairline)',
          }}
        >
          <p style={{ color: 'var(--fg-2)', fontSize: 'var(--fs-body-sm)' }}>
            {payments.length} {payments.length === 1 ? 'payment' : 'payments'} recorded
          </p>
          <Link
            href={`/partners/${partnerSlug}/payments/new?operation_id=${operationId}`}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm transition-colors"
            style={{
              backgroundColor: 'var(--brand-rot)',
              color: 'var(--paper)',
              borderRadius: 'var(--radius-sm)',
              fontWeight: 600,
            }}
          >
            <Plus className="h-4 w-4" />
            Record payment
          </Link>
        </div>

        {payments.length === 0 ? (
          <p className="px-4 py-8 text-center" style={{ color: 'var(--fg-3)', fontSize: 'var(--fs-body-sm)' }}>
            No payments yet.
          </p>
        ) : (
          <table className="w-full" style={{ fontSize: 'var(--fs-body-sm)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <th className="text-left px-4 py-2" style={{ fontSize: '14px' }}>Date</th>
                <th className="text-left px-4 py-2" style={{ fontSize: '14px' }}>Type</th>
                <th className="text-left px-4 py-2" style={{ fontSize: '14px' }}>Direction</th>
                <th className="text-right px-4 py-2" style={{ fontSize: '14px' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>
                    {formatDate(p.payment_date)}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-1)', fontSize: '14px' }}>
                    {p.type}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-2)', fontSize: '14px' }}>
                    {p.direction}
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 600 }}>
                    {formatMoney(p.amount, p.currency)} {p.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Summary strip */}
      <div
        className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4"
        style={{
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <div>
          <p style={{ fontSize: '14px' }}>Operation</p>
          <p className="mt-1" style={{ fontSize: 'var(--fs-body-md)', color: 'var(--fg-1)', fontWeight: 600 }}>
            {formatMoney(grandTotal, currency)}
          </p>
        </div>
        <div>
          <p style={{ fontSize: '14px' }}>Paid</p>
          <p className="mt-1" style={{ fontSize: 'var(--fs-body-md)', color: 'var(--status-success)', fontWeight: 600 }}>
            {formatMoney(paidAmount, currency)}
          </p>
        </div>
        <div>
          <p style={{ fontSize: '14px' }}>Outstanding</p>
          <p
            className="mt-1"
            style={{
              fontSize: 'var(--fs-body-md)',
              color: outstanding > 0 ? 'var(--brand-rot)' : 'var(--fg-3)',
              fontWeight: 600,
            }}
          >
            {formatMoney(outstanding, currency)}
          </p>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Stock Movements tab — read-only journal of warehouse movements driven by
// this operation's status transitions. Source = 'operation', source_ref_id = id.
// =============================================================================
function MovementsTab({ movements }: { movements: StockMovement[] }) {
  if (movements.length === 0) {
    return (
      <div
        className="overflow-hidden"
        style={{
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        <p
          className="px-4 py-12 text-center"
          style={{ color: 'var(--fg-3)', fontSize: 'var(--fs-body-sm)' }}
        >
          No stock movements recorded for this operation yet.
        </p>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div
        className="px-4 py-3"
        style={{
          backgroundColor: 'var(--paper-sunk)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <p style={{ color: 'var(--fg-2)', fontSize: 'var(--fs-body-sm)' }}>
          {movements.length}{' '}
          {movements.length === 1 ? 'movement' : 'movements'} recorded
        </p>
      </div>
      <table className="w-full" style={{ fontSize: 'var(--fs-body-sm)' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <th className="text-left px-4 py-2" style={{ fontSize: '14px' }}>Date</th>
            <th className="text-left px-4 py-2" style={{ fontSize: '14px' }}>Warehouse</th>
            <th className="text-left px-4 py-2" style={{ fontSize: '14px' }}>Product</th>
            <th className="text-left px-4 py-2" style={{ fontSize: '14px' }}>Type</th>
            <th className="text-right px-4 py-2" style={{ fontSize: '14px' }}>Quantity</th>
            <th className="text-right px-4 py-2" style={{ fontSize: '14px' }}>Balance after</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => {
            const isNegative = m.quantity < 0;
            return (
              <tr key={m.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>
                  {formatDate(m.performed_at)}
                </td>
                <td className="px-4 py-3" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
                  {m.code}
                </td>
                <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>
                  <span style={{ fontWeight: 700 }}>{m.product_id.toUpperCase()}</span>
                  <span style={{ color: 'var(--fg-3)', marginLeft: '8px' }}>
                    {m.product_name}
                  </span>
                </td>
                <td className="px-4 py-3" style={{ color: 'var(--fg-2)' }}>
                  {m.movement_type.replace(/_/g, ' ')}
                </td>
                <td
                  className="px-4 py-3 text-right"
                  style={{
                    color: isNegative ? 'var(--brand-rot)' : 'var(--status-success)',
                    fontWeight: 700,
                  }}
                >
                  {m.quantity > 0 ? '+' : ''}{m.quantity}
                </td>
                <td
                  className="px-4 py-3 text-right"
                  style={{ color: 'var(--fg-1)', fontWeight: 700 }}
                >
                  {m.balance_after}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
