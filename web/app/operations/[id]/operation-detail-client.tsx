'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, Trash2, Check, X, AlertTriangle } from 'lucide-react';
import {
  getOperation,
  getPartner,
  getPayments,
  getStockMovements,
  updateOperationStatus,
  getDocuments,
  issueDocuments,
  getProductsList,
  updateLineItem,
  addLineItem,
  deleteLineItem,
  deleteDocument,
  deleteAttachment,
  type Operation,
  type OperationLineItem,
  type Partner,
  type Payment,
  type StockMovement,
  type OperationDocument,
  type ProductListItem,
} from '@/lib/api';
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
type Tab = 'items' | 'status' | 'stock' | 'documents' | 'payments';

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

export default function OperationDetailClient({
  operationId,
}: {
  operationId: string;
}) {
  const [partner, setPartner] = useState<Partner | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [lineItems, setLineItems] = useState<OperationLineItem[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [documents, setDocuments] = useState<OperationDocument[]>([]);
  const [attachments, setAttachments] = useState<Array<{
    id: string; direction: string; kind: string;
    doc_number: string | null; doc_date: number | null;
    amount: number | null; currency: string | null;
    issuer: string | null; file_url: string | null;
    parsed_from: string | null; notes: string | null;
  }>>([]);
  const [activeTab, setActiveTab] = useState<Tab>('items');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reusable refetch — called after a successful manual attach
  const refetchAttachments = async () => {
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';
      const attRes = await fetch(`${API_BASE}/api/operations/${operationId}/attachments`);
      const attData = await attRes.json();
      if (attData.success && attData.result?.attachments) {
        setAttachments(attData.result.attachments);
      }
    } catch {
      // non-blocking
    }
  };

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [opRes, paysRes, movesRes, docsRes] = await Promise.all([
          getOperation(operationId),
          getPayments({ operation_id: operationId }),
          getStockMovements({ source_ref_id: operationId, source: 'operation' }),
          getDocuments({ operation_id: operationId }),
        ]);

        if (opRes.success && opRes.result) {
          setOperation(opRes.result.operation);
          setLineItems(opRes.result.line_items);
          setError(null);

          // Load partner record only if this operation is tied to a partner.
          // Purchases from manufacturers have partner_id = null and rely on
          // operation.manufacturer_name (joined server-side) for the header.
          const partnerId = opRes.result.operation.partner_id;
          if (partnerId) {
            const partnerRes = await getPartner(partnerId);
            if (partnerRes.success && partnerRes.result) setPartner(partnerRes.result);
          }
        } else {
          setError(opRes.errors?.[0]?.message ?? 'Operation not found');
        }

        if (paysRes.success && paysRes.result) {
          setPayments(paysRes.result.payments);
        }

        if (movesRes.success && movesRes.result) {
          setStockMovements(movesRes.result.movements);
        }

        if (docsRes.success && docsRes.result) {
          setDocuments(docsRes.result.documents);
        }

        // Fetch operation attachments (incoming/external docs)
        try {
          const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';
          const attRes = await fetch(`${API_BASE}/api/operations/${operationId}/attachments`);
          const attData = await attRes.json();
          if (attData.success && attData.result?.attachments) {
            setAttachments(attData.result.attachments);
          }
        } catch (e) {
          // Non-blocking — attachments table may not exist on older deployments
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [operationId]);

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
          { label: 'Operations', href: '/operations' },
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

  // Counterparty display: partner if operation has partner_id, else manufacturer
  // (purchase from factory). One of these is always present from the API JOIN.
  const counterpartyName =
    operation.partner_trade_name ??
    partner?.trade_name ??
    operation.manufacturer_name ??
    operation.partner_id ??
    operation.manufacturer_id ??
    '—';
  const counterpartyHref = operation.partner_id
    ? `/partners/${operation.partner_id}`
    : null;

  return (
    <div className="space-y-6">
      <Breadcrumb items={[
        { label: 'Operations', href: '/operations' },
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
            {counterpartyHref ? (
              <Link
                href={counterpartyHref}
                style={{ color: 'var(--fg-2)', textDecoration: 'underline' }}
              >
                {counterpartyName}
              </Link>
            ) : (
              counterpartyName
            )}
            {operation.contract_no && !/^NO[-\s]CONTRACT/i.test(operation.contract_no) && (
              <> · Contract <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{operation.contract_no}</span></>
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
          {/* Attached docs summary — invoice + payment refs as a passport line */}
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
          <div className="mt-2">{statusChip(operation.status)}</div>
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
        onIssued={async () => {
          const opRes = await getOperation(operationId);
          if (opRes.success && opRes.result) {
            setOperation(opRes.result.operation);
            setLineItems(opRes.result.line_items);
          }
        }}
      />

      {/* REFERENCE STRIP ============================================ */}
      <div
        className="grid grid-cols-2 md:grid-cols-5 gap-4 p-4"
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
          { id: 'items',     label: 'Line items',      count: lineItems.length },
          { id: 'status',    label: 'Status',          count: null },
          { id: 'stock',     label: 'Stock movements', count: stockMovements.length },
          { id: 'documents', label: 'Documents',       count: documents.length },
          { id: 'payments',  label: 'Payments',        count: payments.length },
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
          operationId={operationId}
          operationStatus={operation.status}
          lineItems={lineItems}
          onLineItemsChange={async () => {
            const opRes = await getOperation(operationId);
            if (opRes.success && opRes.result) {
              setLineItems(opRes.result.line_items);
              setOperation(opRes.result.operation);
              // Refresh documents to reflect cancelled status
              const docsRes = await getDocuments({ operation_id: operationId });
              if (docsRes.success && docsRes.result) {
                setDocuments(docsRes.result.documents);
              }
            }
          }}
          currency={operation.currency}
          subtotal={subtotal}
          discount={discount}
          discountPct={discountPct}
          totalAfterDiscount={totalAfterDiscount}
          vatRate={operation.vat_rate}
          vatAmount={vatAmount}
          grandTotal={grandTotal}
          showVat={showVat}
        />
      )}

      {activeTab === 'status' && (
        <StatusTab
          status={operation.status}
          operationType={operation.operation_type}
          operationId={operationId}
          onStatusChange={async (newStatus) => {
            const res = await updateOperationStatus(operationId, newStatus);
            if (res.success && res.result) {
              setOperation({
                ...operation,
                status: res.result.status,
                updated_at: res.result.updated_at,
              });
            } else {
              throw new Error(res.errors?.[0]?.message ?? 'Update failed');
            }
          }}
        />
      )}

      {activeTab === 'stock' && (
        <StockMovementsTab movements={stockMovements} />
      )}

      {activeTab === 'documents' && (
        <DocumentsTab
          operationId={operationId}
          initialDocs={documents}
          onChange={(next) => setDocuments(next)}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
        />
      )}

      {activeTab === 'payments' && (
        <PaymentsTab
          partnerId={operation.partner_id}
          operationId={operationId}
          payments={payments}
          currency={operation.currency}
          grandTotal={grandTotal}
          paidAmount={paidAmount}
          outstanding={outstanding}
        />
      )}
    </div>
  );
}

// =============================================================================
// Items tab — Phase 4.5: editable composition
// =============================================================================
function ItemsTab({
  operationId,
  operationStatus,
  lineItems,
  onLineItemsChange,
  currency,
  subtotal,
  discount,
  discountPct,
  totalAfterDiscount,
  vatRate,
  vatAmount,
  grandTotal,
  showVat,
}: {
  operationId: string;
  operationStatus: string;
  lineItems: OperationLineItem[];
  onLineItemsChange: () => Promise<void>;
  currency: string;
  subtotal: number;
  discount: number;
  discountPct: number;
  totalAfterDiscount: number;
  vatRate: number;
  vatAmount: number;
  grandTotal: number;
  showVat: boolean;
}) {
  const showDiscount = discount > 0;
  const locked = operationStatus === 'cancelled' || operationStatus === 'delivered';
  const issuedOrLater = operationStatus !== 'draft' && !locked;

  const [editMode, setEditMode] = useState(false);
  const [editing, setEditing] = useState<{ id: string; qty: number; unit_price: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [showAddRow, setShowAddRow] = useState(false);
  const [newRow, setNewRow] = useState<{ product_id: string; qty: string; unit_price: string }>({ product_id: '', qty: '', unit_price: '' });

  useEffect(() => {
    if (editMode && products.length === 0) {
      getProductsList().then((res) => {
        if (res.success && res.result) setProducts(res.result.products);
      });
    }
  }, [editMode, products.length]);

  function confirmIfIssued(actionLabel: string): boolean {
    if (!issuedOrLater) return true;
    return confirm(`${actionLabel}\n\nThis operation has documents already issued.\nThe existing documents will be marked as CANCELLED (kept for audit trail, shown in red).\nYou will need to click "Issue documents" again to generate fresh ones.\n\nProceed?`);
  }

  async function handleSaveEdit(li: OperationLineItem) {
    if (!editing || editing.id !== li.id) return;
    if (!confirmIfIssued(`Update ${li.product_id.toUpperCase()}: qty ${li.qty} → ${editing.qty}, price ${li.unit_price} → ${editing.unit_price}`)) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const res = await updateLineItem(li.id, { qty: editing.qty, unit_price: editing.unit_price });
      if (res.success) {
        setActionMsg(res.result?.docs_cancelled ? 'Updated · documents marked cancelled' : 'Updated');
        setEditing(null);
        await onLineItemsChange();
      } else {
        setActionMsg(`Error: ${res.errors?.[0]?.message ?? 'unknown'}`);
      }
    } catch (e) {
      setActionMsg('Network error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(li: OperationLineItem) {
    if (lineItems.length <= 1) {
      alert('Cannot delete the last line item. Cancel the operation instead.');
      return;
    }
    if (!confirm(`Remove ${li.product_id.toUpperCase()} (qty ${li.qty}) from this operation?`)) return;
    if (!confirmIfIssued(`Removing ${li.product_id.toUpperCase()}`)) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const res = await deleteLineItem(li.id);
      if (res.success) {
        setActionMsg(res.result?.docs_cancelled ? 'Line item removed · documents marked cancelled' : 'Line item removed');
        await onLineItemsChange();
      } else {
        setActionMsg(`Error: ${res.errors?.[0]?.message ?? 'unknown'}`);
      }
    } catch (e) {
      setActionMsg('Network error');
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    if (!newRow.product_id || !newRow.qty || !newRow.unit_price) {
      alert('Fill all three: product, qty, unit price');
      return;
    }
    const qty = parseFloat(newRow.qty);
    const price = parseFloat(newRow.unit_price);
    if (qty <= 0 || price < 0) {
      alert('Qty must be > 0 and price >= 0');
      return;
    }
    const productLabel = products.find(p => p.id === newRow.product_id)?.product_name ?? newRow.product_id;
    if (!confirmIfIssued(`Adding ${productLabel}: qty ${qty}, price ${price}`)) return;
    setBusy(true);
    setActionMsg(null);
    try {
      const res = await addLineItem(operationId, {
        product_id: newRow.product_id,
        qty,
        unit_price: price,
      });
      if (res.success) {
        setActionMsg(res.result?.docs_cancelled ? 'Line item added · documents marked cancelled' : 'Line item added');
        setNewRow({ product_id: '', qty: '', unit_price: '' });
        setShowAddRow(false);
        await onLineItemsChange();
      } else {
        setActionMsg(`Error: ${res.errors?.[0]?.message ?? 'unknown'}`);
      }
    } catch (e) {
      setActionMsg('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="overflow-hidden"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      {!locked && (
        <div className="px-4 py-3 flex items-center justify-between" style={{
          borderBottom: '1px solid var(--border-hairline)',
          backgroundColor: 'var(--paper-sunk)',
        }}>
          <div className="flex items-center gap-3">
            <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)', margin: 0 }}>
              Composition
            </p>
            {issuedOrLater && editMode && (
              <span className="inline-flex items-center gap-1.5" style={{ fontSize: '14px', color: 'var(--brand-rot)', backgroundColor: 'rgba(229,32,44,0.06)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
                <AlertTriangle className="h-3.5 w-3.5" />
                Edits will cancel existing documents
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {editMode && !showAddRow && (
              <button
                onClick={() => setShowAddRow(true)}
                disabled={busy}
                style={{ padding: '6px 12px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-1)', backgroundColor: 'var(--paper)', cursor: busy ? 'wait' : 'pointer', fontSize: '14px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <Plus className="h-3.5 w-3.5" /> Add line
              </button>
            )}
            <button
              onClick={() => { setEditMode(!editMode); setEditing(null); setShowAddRow(false); }}
              disabled={busy}
              style={{ padding: '6px 12px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: editMode ? 'var(--paper)' : 'var(--fg-1)', backgroundColor: editMode ? 'var(--brand-rot)' : 'var(--paper)', cursor: busy ? 'wait' : 'pointer', fontSize: '14px', fontWeight: 600 }}
            >
              {editMode ? 'Done editing' : 'Edit composition'}
            </button>
          </div>
        </div>
      )}
      {actionMsg && (
        <div className="px-4 py-2" style={{
          fontSize: '14px',
          color: actionMsg.startsWith('Error') || actionMsg.startsWith('Network') ? 'var(--brand-rot)' : 'var(--fg-1)',
          backgroundColor: actionMsg.startsWith('Error') || actionMsg.startsWith('Network') ? 'rgba(229,32,44,0.06)' : 'rgba(46,125,79,0.06)',
          borderBottom: '1px solid var(--border-hairline)',
        }}>
          {actionMsg}
        </div>
      )}
      <table className="w-full" style={{ fontSize: 'var(--fs-body-sm)' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
            <th className="text-left px-4 py-3" style={{ fontSize: '14px' }}>SKU</th>
            <th className="text-left px-4 py-3" style={{ fontSize: '14px' }}>Product</th>
            <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Qty</th>
            <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Unit</th>
            <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Total</th>
            {editMode && <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Edit</th>}
          </tr>
        </thead>
        <tbody>
          {lineItems.map((li) => {
            const isEditingRow = editMode && editing?.id === li.id;
            return (
            <tr key={li.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
              <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-1)', fontWeight: 700 }}>
                {li.product_id.toUpperCase()}
              </td>
              <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>
                {li.product_name ?? li.item_description ?? li.product_id}
              </td>
              <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
                {isEditingRow ? (
                  <input
                    type="number"
                    value={editing!.qty}
                    onChange={(e) => setEditing({ ...editing!, qty: parseFloat(e.target.value) || 0 })}
                    style={{ width: '80px', padding: '4px 6px', textAlign: 'right', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 }}
                  />
                ) : li.qty}
              </td>
              <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
                {isEditingRow ? (
                  <input
                    type="number"
                    step="0.001"
                    value={editing!.unit_price}
                    onChange={(e) => setEditing({ ...editing!, unit_price: parseFloat(e.target.value) || 0 })}
                    style={{ width: '100px', padding: '4px 6px', textAlign: 'right', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 }}
                  />
                ) : formatMoney(li.unit_price, currency)}
              </td>
              <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
                {formatMoney(isEditingRow ? editing!.qty * editing!.unit_price : li.line_amount, currency)}
              </td>
              {editMode && (
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    {isEditingRow ? (
                      <>
                        <button
                          onClick={() => handleSaveEdit(li)}
                          disabled={busy}
                          title="Save"
                          style={{ padding: '4px 8px', border: '1px solid rgba(46,125,79,0.3)', borderRadius: 'var(--radius-sm)', color: 'var(--status-success)', backgroundColor: 'transparent', cursor: busy ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '14px', fontWeight: 600 }}
                        >
                          <Check className="h-3.5 w-3.5" /> Save
                        </button>
                        <button
                          onClick={() => setEditing(null)}
                          disabled={busy}
                          title="Cancel edit"
                          style={{ padding: '4px 8px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-3)', backgroundColor: 'transparent', cursor: busy ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '14px' }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => setEditing({ id: li.id, qty: li.qty, unit_price: li.unit_price })}
                          disabled={busy}
                          title="Edit qty/price"
                          style={{ padding: '4px 8px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-2)', backgroundColor: 'transparent', cursor: busy ? 'wait' : 'pointer', fontSize: '14px', fontWeight: 600 }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(li)}
                          disabled={busy || lineItems.length <= 1}
                          title={lineItems.length <= 1 ? 'Last line — cancel operation instead' : 'Remove this line'}
                          style={{ padding: '4px 8px', border: '1px solid rgba(229,32,44,0.3)', borderRadius: 'var(--radius-sm)', color: '#A82029', backgroundColor: 'transparent', cursor: (busy || lineItems.length <= 1) ? 'not-allowed' : 'pointer', opacity: lineItems.length <= 1 ? 0.4 : 1, display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '14px', fontWeight: 600 }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              )}
            </tr>
            );
          })}
          {editMode && showAddRow && (
            <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'rgba(46,125,79,0.04)' }}>
              <td className="px-4 py-3" colSpan={2}>
                <select
                  value={newRow.product_id}
                  onChange={(e) => setNewRow({ ...newRow, product_id: e.target.value })}
                  style={{ width: '100%', padding: '4px 8px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', fontSize: '14px', backgroundColor: 'var(--paper)' }}
                >
                  <option value="">Select product...</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.id.toUpperCase()} — {p.product_name}</option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-3 text-right">
                <input
                  type="number"
                  placeholder="qty"
                  value={newRow.qty}
                  onChange={(e) => setNewRow({ ...newRow, qty: e.target.value })}
                  style={{ width: '80px', padding: '4px 6px', textAlign: 'right', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 }}
                />
              </td>
              <td className="px-4 py-3 text-right">
                <input
                  type="number"
                  step="0.001"
                  placeholder="price"
                  value={newRow.unit_price}
                  onChange={(e) => setNewRow({ ...newRow, unit_price: e.target.value })}
                  style={{ width: '100px', padding: '4px 6px', textAlign: 'right', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 }}
                />
              </td>
              <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-3)', fontSize: '14px' }}>
                {newRow.qty && newRow.unit_price ? formatMoney(parseFloat(newRow.qty) * parseFloat(newRow.unit_price), currency) : '—'}
              </td>
              <td className="px-4 py-3 text-right">
                <div className="inline-flex items-center gap-2">
                  <button
                    onClick={handleAdd}
                    disabled={busy}
                    style={{ padding: '4px 10px', border: '1px solid rgba(46,125,79,0.3)', borderRadius: 'var(--radius-sm)', color: 'var(--status-success)', backgroundColor: 'transparent', cursor: busy ? 'wait' : 'pointer', fontSize: '14px', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  >
                    <Check className="h-3.5 w-3.5" /> Add
                  </button>
                  <button
                    onClick={() => { setShowAddRow(false); setNewRow({ product_id: '', qty: '', unit_price: '' }); }}
                    disabled={busy}
                    style={{ padding: '4px 8px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', color: 'var(--fg-3)', backgroundColor: 'transparent', cursor: busy ? 'wait' : 'pointer', fontSize: '14px' }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          )}

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
// Status tab
// =============================================================================
// Full list of all possible status targets — UI filters per operation_type below.
const STATUS_TARGETS = [
  { id: 'production', label: 'Mark Production' },
  { id: 'shipped',    label: 'Mark Shipped'    },
  { id: 'delivered',  label: 'Mark Delivered'  },
  { id: 'cancelled',  label: 'Cancel'          },
] as const;

type StatusTarget = typeof STATUS_TARGETS[number]['id'];

// Operation-type-aware lifecycle map (mirror of backend ALLOWED_TRANSITIONS).
// `null` means terminal (no further targets).
const LIFECYCLE_NEXT: Record<string, Record<string, StatusTarget[]>> = {
  sale: {
    draft:            ['shipped', 'cancelled'],
    issued:           ['shipped', 'cancelled'],
    order_fulfilment: ['shipped', 'cancelled'],
    shipped:          ['delivered', 'cancelled'],
    delivered:        [],
    cancelled:        [],
  },
  purchase: {
    draft:      ['production', 'cancelled'],
    issued:     ['production', 'cancelled'],
    production: ['shipped', 'cancelled'],
    shipped:    ['delivered', 'cancelled'],  // delivered здесь = manual fallback
    delivered:  [],
    cancelled:  [],
    stocked:    ['shipped', 'cancelled'],    // legacy
  },
  transfer: {
    draft:     ['shipped', 'cancelled'],
    issued:    ['shipped', 'cancelled'],
    shipped:   ['delivered', 'cancelled'],
    delivered: [],
    cancelled: [],
  },
};

function StatusTab({
  status,
  operationType,
  operationId,
  onStatusChange,
}: {
  status: string;
  operationType: string;
  operationId: string;
  onStatusChange: (newStatus: StatusTarget) => Promise<void>;
}) {
  const [pending, setPending] = useState<StatusTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async (target: StatusTarget) => {
    const verb = target === 'cancelled' ? 'cancel' : `mark as ${target}`;
    if (!confirm(`Confirm: ${verb} this operation?`)) return;
    setError(null);
    setPending(target);
    try {
      await onStatusChange(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setPending(null);
    }
  };

  // Filter to only the targets allowed from current status, per op type.
  const allowedNext = LIFECYCLE_NEXT[operationType]?.[status] ?? [];
  const visibleTargets = STATUS_TARGETS.filter((t) => allowedNext.includes(t.id));

  // Once cancelled, no further moves available
  const terminal = status === 'cancelled';

  return (
    <div
      className="p-6 space-y-6"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div className="flex items-center gap-3">
        <span>Current</span>
        {statusChip(status)}
      </div>

      <div>
        <p className="mb-3">Move to</p>
        <div className="flex flex-wrap gap-2">
          {visibleTargets.length === 0 ? (
            <span style={{ color: 'var(--fg-3)', fontSize: '14px' }}>No further transitions available — operation is complete.</span>
          ) : visibleTargets.map((target) => {
            const isPending = pending === target.id;
            const isCurrent = status === target.id;
            const disabled = terminal || isCurrent || pending !== null;
            return (
              <button
                key={target.id}
                onClick={() => handleClick(target.id)}
                disabled={disabled}
                className="px-4 py-2 transition-colors inline-flex items-center gap-2"
                style={{
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: target.id === 'cancelled' ? 'transparent' : 'var(--paper-sunk)',
                  color: target.id === 'cancelled' ? 'var(--brand-rot)' : 'var(--fg-1)',
                  opacity: disabled ? 0.4 : 1,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                }}
                title={isCurrent ? 'Already in this status' : terminal ? 'Operation is cancelled' : ''}
              >
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {target.label}
              </button>
            );
          })}
        </div>

        {terminal && (
          <p className="mt-3" style={{ color: 'var(--fg-3)' }}>
            This operation is cancelled — status cannot change further.
          </p>
        )}

        {error && (
          <p className="mt-3" style={{ color: 'var(--brand-rot)' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Documents tab — live data from GET /api/documents?operation_id=...
// =============================================================================
function DocumentsTab({
  operationId,
  initialDocs,
  onChange,
  attachments,
  onAttachmentsChange,
}: {
  operationId: string;
  initialDocs: OperationDocument[];
  onChange: (docs: OperationDocument[]) => void;
  attachments: Array<{
    id: string; direction: string; kind: string;
    doc_number: string | null; doc_date: number | null;
    amount: number | null; currency: string | null;
    issuer: string | null; file_url: string | null;
    parsed_from: string | null; notes: string | null;
  }>;
  onAttachmentsChange: (next: any[]) => void;
}) {
  const [docs, setDocs] = useState<OperationDocument[]>(initialDocs);
  const [loading, setLoading] = useState(initialDocs.length === 0);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueSuccess, setIssueSuccess] = useState<string | null>(null);
  // Manual attach modal
  const [attachModalOpen, setAttachModalOpen] = useState(false);

  // Refetch attachments from API after a successful manual attach
  const refetchAttachments = async () => {
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';
      const r = await fetch(`${API_BASE}/api/operations/${operationId}/attachments`);
      const data = await r.json();
      if (data.success && data.result?.attachments) {
        onAttachmentsChange(data.result.attachments);
      }
    } catch {
      // non-blocking
    }
  };

  const fetchDocs = async () => {
    const res = await getDocuments({ operation_id: operationId });
    if (res.success && res.result) {
      setDocs(res.result.documents);
      onChange(res.result.documents);
    }
    setLoading(false);
  };

  // Re-fetch only if no initial data (parent fetched all in parallel)
  useEffect(() => {
    if (initialDocs.length === 0) fetchDocs();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operationId]);

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
      await refetchAttachments();
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
  };

  const STATUS_STYLE: Record<string, { fg: string; bg: string }> = {
    issued:    { fg: 'var(--status-success)', bg: 'rgba(46,125,79,0.08)' },
    draft:     { fg: 'var(--status-warning)', bg: 'rgba(199,122,0,0.08)' },
    cancelled: { fg: 'var(--brand-rot)',      bg: 'rgba(229,32,44,0.10)' },
    voided:    { fg: 'var(--fg-3)',           bg: 'var(--paper-sunk)' },
  };

  return (
    <>
    {/* === DOCUMENTS — generated + attached, single list === */}
    <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
        <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)', margin: 0 }}>
          Documents{attachments.length > 0 ? ` (${attachments.length})` : ''}
        </p>
        <div className="inline-flex items-center gap-2">
          <button
            onClick={handleIssue}
            disabled={issuing}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 14px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper)', color: 'var(--fg-1)', cursor: issuing ? 'not-allowed' : 'pointer', opacity: issuing ? 0.6 : 1 }}
          >
            {issuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Issue documents
          </button>
          <button
            type="button"
            onClick={() => setAttachModalOpen(true)}
            className="inline-flex items-center gap-1.5"
            style={{
              padding: '6px 14px',
              background: 'var(--brand-rot, #E5202C)',
              color: 'white',
              fontSize: 14,
              fontWeight: 600,
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <Plus size={14} /> Attach document
          </button>
        </div>
      </div>
      {attachments.length === 0 ? (
        <div style={{ padding: '24px 16px', textAlign: 'center' }}>
          <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: 0 }}>No documents yet — click "Issue documents" or "Attach document"</p>
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
              <th className="text-right px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>File</th>
              <th className="text-right px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)', width: '60px' }}></th>
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
                  <td className="px-4 py-3 text-right">
                    {att.file_url ? (
                      <a href={`https://dasoperator-api.dasexperten.workers.dev/api/documents/${att.id}/download`} target="_blank" rel="noopener noreferrer" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--brand-rot)', textDecoration: 'none' }}>
                        Download
                      </a>
                    ) : (
                      <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {att.parsed_from === 'invoicer' ? (
                      <button
                        type="button"
                        onClick={async () => {
                          if (!confirm(`Delete ${att.doc_number || labelKind(att.kind)}?\n\nThis removes our generated document. You can re-issue it via Issue documents.`)) return;
                          try {
                            await deleteDocument(att.id);
                            await refetchAttachments();
                          } catch (e) {
                            alert('Delete failed: ' + (e instanceof Error ? e.message : String(e)));
                          }
                        }}
                        title="Delete (regenerable)"
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 28, height: 28, padding: 0,
                          border: '1px solid var(--border-hairline)',
                          borderRadius: 'var(--radius-sm)',
                          backgroundColor: 'var(--paper)',
                          color: 'var(--brand-rot)',
                          cursor: 'pointer',
                        }}
                      >
                        <X size={14} />
                      </button>
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
    {attachModalOpen && (
      <AttachDocumentModal
        operationId={operationId}
        onClose={() => setAttachModalOpen(false)}
        onSuccess={async () => {
          await refetchAttachments();
          setAttachModalOpen(false);
        }}
      />
    )}
  </>
  );
}


// =============================================================================
// Payments tab
// =============================================================================
function PaymentsTab({
  partnerId,
  operationId,
  payments,
  currency,
  grandTotal,
  paidAmount,
  outstanding,
}: {
  partnerId: string | null;
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
          {partnerId ? (
            <Link
              href={`/partners/${partnerId}/payments/new?operation_id=${operationId}`}
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
          ) : (
            <span style={{ color: 'var(--fg-3)', fontSize: '14px' }}>
              Payments to manufacturers — coming soon
            </span>
          )}
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
        className="grid grid-cols-3 gap-4 p-4"
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
// Stock movements tab — physical inventory movements created by this operation.
// Sale: shipment row at "shipped" status (out wh_from).
// Purchase: receipt row at "delivered" status (in wh_to).
// Transfer: out at "shipped" + in at "delivered".
// Cancellation after shipped writes a return row.
// =============================================================================
const MOVEMENT_TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  receipt:             { bg: 'rgba(46,125,79,0.08)', fg: 'var(--status-success)' },
  shipment:            { bg: 'rgba(229,32,44,0.08)', fg: 'var(--brand-rot)' },
  transfer_in:         { bg: 'rgba(46,125,79,0.08)', fg: 'var(--status-success)' },
  transfer_out:        { bg: 'rgba(229,32,44,0.08)', fg: 'var(--brand-rot)' },
  return:              { bg: 'rgba(125,72,28,0.10)', fg: '#7D481C' },
  adjustment:          { bg: 'var(--paper-sunk)',    fg: 'var(--fg-2)' },
  session_correction:  { bg: 'var(--paper-sunk)',    fg: 'var(--fg-2)' },
  sync_correction:     { bg: 'var(--paper-sunk)',    fg: 'var(--fg-2)' },
  opening_balance:     { bg: 'rgba(31,73,125,0.08)', fg: 'var(--status-info)' },
  write_off:           { bg: 'rgba(229,32,44,0.08)', fg: 'var(--brand-rot)' },
};

function movementTypeLabel(t: string): string {
  return t.replace(/_/g, ' ');
}

function StockMovementsTab({ movements }: { movements: StockMovement[] }) {
  if (movements.length === 0) {
    return (
      <div
        className="px-4 py-12 text-center"
        style={{
          color: 'var(--fg-3)',
          fontSize: 'var(--fs-body-sm)',
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
        }}
      >
        No stock movements yet.
        <br />
        <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
          Movements appear when the operation status moves to{' '}
          <strong style={{ color: 'var(--fg-2)' }}>shipped</strong> or{' '}
          <strong style={{ color: 'var(--fg-2)' }}>delivered</strong> (depending on operation type).
        </span>
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
      <table className="w-full" style={{ fontSize: 'var(--fs-body-sm)' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
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
            const tc = MOVEMENT_TYPE_COLORS[m.movement_type] ?? { bg: 'var(--paper-sunk)', fg: 'var(--fg-2)' };
            const positive = m.quantity >= 0;
            return (
              <tr key={m.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <td className="px-4 py-3" style={{ color: 'var(--fg-3)' }}>
                  {formatDate(m.performed_at)}
                </td>
                <td className="px-4 py-3" style={{ color: 'var(--fg-1)', fontWeight: 600 }}>
                  {m.code ?? m.warehouse_id}
                </td>
                <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>
                  <span style={{ fontWeight: 700 }}>{m.product_id.toUpperCase()}</span>
                  <span style={{ color: 'var(--fg-3)', marginLeft: '8px' }}>{m.product_name ?? ''}</span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className="inline-block"
                    style={{
                      fontSize: '14px',
                      fontWeight: 500,
                      padding: '3px 10px',
                      backgroundColor: tc.bg,
                      color: tc.fg,
                      borderRadius: 'var(--radius-pill)',
                    }}
                  >
                    {movementTypeLabel(m.movement_type)}
                  </span>
                </td>
                <td
                  className="px-4 py-3 text-right"
                  style={{
                    color: positive ? 'var(--status-success)' : 'var(--brand-rot)',
                    fontWeight: 700,
                  }}
                >
                  {positive ? '+' : ''}{m.quantity.toLocaleString('en-US')}
                </td>
                <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 600 }}>
                  {m.balance_after.toLocaleString('en-US')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// Manual attach document modal — for documents arriving outside the auto-channels
// (whatsapp, hand-delivered, scanned-by-hand). Backend accepts:
//   direction, kind (required) + doc_number, doc_date, amount, currency,
//   issuer, file_url, notes (optional)
// File_url is a free-text URL — typed or pasted by the user. No file upload yet.
// =============================================================================

const KIND_OPTIONS = [
  'invoice', 'payment', 'act', 'upd',
  'ci', 'pl', 'bl', 'awb', 'cmr',
  'swift', 'proforma', 'customs_decl',
  'contract', 'certificate', 'photo', 'other',
];

const KIND_LABEL_RU: Record<string, string> = {
  invoice: 'INV (Invoice)',
  payment: 'PMT (Payment / SWIFT)',
  act: 'Акт',
  upd: 'УПД',
  ci: 'CI (Commercial Invoice)',
  pl: 'PL (Packing List)',
  bl: 'BL (Bill of Lading)',
  awb: 'AWB (Air Waybill)',
  cmr: 'CMR',
  swift: 'SWIFT',
  proforma: 'Proforma',
  customs_decl: 'ГТД (Customs)',
  contract: 'Contract',
  certificate: 'Certificate',
  photo: 'Photo',
  other: 'Other',
};

function AttachDocumentModal({
  operationId, onClose, onSuccess,
}: {
  operationId: string;
  onClose: () => void;
  onSuccess: () => void | Promise<void>;
}) {
  const [direction, setDirection] = useState<'incoming' | 'outgoing'>('incoming');
  const [kind, setKind] = useState('invoice');
  const [docNumber, setDocNumber] = useState('');
  const [docDate, setDocDate] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [issuer, setIssuer] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch(`${API_BASE}/api/operations/${operationId}/files`, {
        method: 'POST',
        body: fd,
      });
      const data = await r.json();
      if (data.success && data.result?.file_url) {
        // Server returns a path; combine with API base for full URL
        const path: string = data.result.file_url;
        const fullUrl = path.startsWith('http') ? path : `${API_BASE}${path}`;
        setFileUrl(fullUrl);
        setUploadedFileName(data.result.filename || file.name);
      } else {
        setUploadError(data.errors?.[0]?.message ?? 'Upload failed');
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setUploading(false);
      // Reset input so re-uploading same file fires onChange again
      e.target.value = '';
    }
  };

  const handleSubmit = async () => {
    if (!kind) {
      setError('Kind is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';
      const payload: Record<string, unknown> = {
        direction,
        kind: kind.trim(),
        parsed_from: 'manual',
      };
      if (docNumber.trim()) payload.doc_number = docNumber.trim();
      if (docDate) payload.doc_date = docDate; // ISO string, backend parses
      if (amount.trim()) {
        const n = parseFloat(amount.replace(',', '.'));
        if (!Number.isNaN(n)) payload.amount = n;
      }
      if (currency.trim()) payload.currency = currency.trim().toUpperCase();
      if (issuer.trim()) payload.issuer = issuer.trim();
      if (fileUrl.trim()) payload.file_url = fileUrl.trim();
      if (notes.trim()) payload.notes = notes.trim();

      const r = await fetch(`${API_BASE}/api/operations/${operationId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (data.success) {
        await onSuccess();
      } else {
        setError(data.errors?.[0]?.message ?? 'Failed to attach document');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--paper-base, #fff)',
          borderRadius: 'var(--radius-md)',
          padding: 24,
          width: '100%', maxWidth: 560,
          maxHeight: '90vh', overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ fontSize: 18, fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>
            Attach document
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" style={{ color: 'var(--fg-3)' }}>
            <X size={18} />
          </button>
        </div>

        {error && (
          <div
            className="flex items-center gap-2 mb-3 px-3 py-2"
            style={{
              background: 'rgba(229,32,44,0.08)',
              color: '#A82029',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
            }}
          >
            <AlertTriangle size={14} /> {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <Field label="Direction">
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'incoming' | 'outgoing')}
              style={modalInputStyle}
            >
              <option value="incoming">Incoming (we received)</option>
              <option value="outgoing">Outgoing (we issued)</option>
            </select>
          </Field>
          <Field label="Kind">
            <select value={kind} onChange={(e) => setKind(e.target.value)} style={modalInputStyle}>
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>{KIND_LABEL_RU[k] ?? k}</option>
              ))}
            </select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <Field label="Document number">
            <input
              type="text"
              value={docNumber}
              onChange={(e) => setDocNumber(e.target.value)}
              placeholder="e.g. INV-2026-042"
              style={modalInputStyle}
            />
          </Field>
          <Field label="Document date">
            <input
              type="date"
              value={docDate}
              onChange={(e) => setDocDate(e.target.value)}
              style={modalInputStyle}
            />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px', gap: 12, marginBottom: 12 }}>
          <Field label="Amount">
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              style={modalInputStyle}
            />
          </Field>
          <Field label="Currency">
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              maxLength={3}
              style={modalInputStyle}
            />
          </Field>
        </div>

        <div style={{ marginBottom: 12 }}>
          <Field label="Issuer">
            <input
              type="text"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="Counterparty name on the document"
              style={modalInputStyle}
            />
          </Field>
        </div>

        <div style={{ marginBottom: 12 }}>
          <Field label="File">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Upload button — primary path */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '7px 12px',
                    background: uploading ? 'var(--paper-sunk)' : 'var(--paper-raised)',
                    border: '1px solid var(--border-hairline)',
                    borderRadius: 'var(--radius-sm)',
                    cursor: uploading ? 'not-allowed' : 'pointer',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--fg-1)',
                  }}
                >
                  {uploading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {uploading ? 'Uploading…' : 'Upload file'}
                  <input
                    type="file"
                    onChange={handleFileUpload}
                    disabled={uploading}
                    accept=".pdf,.jpg,.jpeg,.png,.webp,.xlsx,.xls,.docx,.doc,.txt,.csv"
                    style={{ display: 'none' }}
                  />
                </label>
                {uploadedFileName && !uploading && (
                  <span style={{ fontSize: 12, color: 'var(--status-success, #2e7d4f)', fontWeight: 600 }}>
                    <Check size={12} style={{ display: 'inline', marginRight: 4 }} />
                    {uploadedFileName}
                  </span>
                )}
              </div>

              {uploadError && (
                <span style={{ fontSize: 12, color: 'var(--brand-rot, #a82029)' }}>
                  {uploadError}
                </span>
              )}

              {/* URL fallback — for cases when file already lives in Drive/etc */}
              <details style={{ marginTop: 4 }}>
                <summary
                  style={{
                    fontSize: 11,
                    color: 'var(--fg-3)',
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                >
                  Or paste a link instead
                </summary>
                <input
                  type="url"
                  value={fileUrl}
                  onChange={(e) => {
                    setFileUrl(e.target.value);
                    setUploadedFileName(null); // clear upload preview if pasting
                  }}
                  placeholder="https://drive.google.com/file/d/..."
                  style={{ ...modalInputStyle, marginTop: 4 }}
                />
              </details>
            </div>
          </Field>
        </div>

        <div style={{ marginBottom: 20 }}>
          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional context"
              style={{ ...modalInputStyle, resize: 'vertical', fontFamily: 'inherit' }}
            />
          </Field>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            style={{
              padding: '8px 14px',
              background: 'transparent',
              color: 'var(--fg-3)',
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="inline-flex items-center gap-1.5"
            style={{
              padding: '8px 16px',
              background: submitting ? 'var(--paper-sunk)' : 'var(--brand-rot, #E5202C)',
              color: submitting ? 'var(--fg-3)' : 'white',
              fontSize: 14,
              fontWeight: 700,
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {submitting ? 'Attaching…' : 'Attach'}
          </button>
        </div>
      </div>
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

const modalInputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--border-hairline)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 14,
  fontWeight: 700,
  background: 'var(--paper-base, #fff)',
  color: 'var(--fg-1)',
};
