'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Loader2, Plus, Trash2, Pencil, Save, X, Check } from 'lucide-react';
import {
  getOperation,
  getPartner,
  getPayments,
  getStockMovements,
  updateOperationStatus,
  getDocuments,
  issueDocuments,
  addLineItem,
  updateLineItem,
  deleteLineItem,
  getProductsList,
  type Operation,
  type OperationLineItem,
  type Partner,
  type Payment,
  type StockMovement,
  type OperationDocument,
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
  const [activeTab, setActiveTab] = useState<Tab>('items');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          currency={operation.currency}
          subtotal={subtotal}
          discount={discount}
          discountPct={discountPct}
          totalAfterDiscount={totalAfterDiscount}
          vatRate={operation.vat_rate}
          vatAmount={vatAmount}
          grandTotal={grandTotal}
          showVat={showVat}
          onMutated={async () => {
            const [opRes, docsRes] = await Promise.all([
              getOperation(operationId),
              getDocuments({ operation_id: operationId }),
            ]);
            if (opRes.success && opRes.result) {
              setOperation(opRes.result.operation);
              setLineItems(opRes.result.line_items);
            }
            if (docsRes.success && docsRes.result) {
              setDocuments(docsRes.result.documents);
            }
          }}
        />
      )}

      {activeTab === 'status' && (
        <StatusTab
          status={operation.status}
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
// Items tab — editable line items (Phase 4.5)
// Editing line items on issued+ ops will:
//   1. Cancel attached documents (visible as red striked rows)
//   2. Revert operation status to draft
//   3. Apply edit + recalc totals
// Read-only when operation is delivered or cancelled.
// =============================================================================
const EDITABLE_OP_STATUSES = new Set(['draft', 'issued', 'order_fulfilment', 'production', 'stocked']);

interface ProductOption {
  id: string;
  product_name: string | null;
  invoice_label: string | null;
}

function ItemsTab({
  operationId,
  operationStatus,
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
  onMutated,
}: {
  operationId: string;
  operationStatus: string;
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
  onMutated: () => Promise<void>;
}) {
  const editable = EDITABLE_OP_STATUSES.has(operationStatus);
  const showDiscount = discount > 0;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState<string>('');
  const [editUnitPrice, setEditUnitPrice] = useState<string>('');
  const [editDiscountPct, setEditDiscountPct] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [addProductId, setAddProductId] = useState('');
  const [addQty, setAddQty] = useState('');
  const [addUnitPrice, setAddUnitPrice] = useState('');
  const [addDiscountPct, setAddDiscountPct] = useState('0');

  const ensureProducts = useCallback(async () => {
    if (productsLoaded) return;
    try {
      const res = await getProductsList();
      if (res.success && res.result) {
        const list = (res.result as { products?: ProductOption[] }).products
          ?? (res.result as { items?: ProductOption[] }).items
          ?? (res.result as unknown as ProductOption[]);
        if (Array.isArray(list)) {
          setProducts(list);
          setProductsLoaded(true);
        }
      }
    } catch {
      // ignore — will show empty
    }
  }, [productsLoaded]);

  const handleStartEdit = (li: OperationLineItem) => {
    setEditingId(li.id);
    setEditQty(String(li.qty));
    setEditUnitPrice(String(li.unit_price));
    setEditDiscountPct(String(li.discount_pct));
    setErr(null);
    setInfo(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setErr(null);
  };

  const handleSaveEdit = async (li: OperationLineItem) => {
    const qty = Number(editQty);
    const unitPrice = Number(editUnitPrice);
    const discPct = Number(editDiscountPct);
    if (!Number.isFinite(qty) || qty <= 0) { setErr('Qty must be positive'); return; }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) { setErr('Unit price must be non-negative'); return; }
    if (!Number.isFinite(discPct) || discPct < 0 || discPct > 100) { setErr('Discount must be 0-100'); return; }

    setBusy(li.id);
    setErr(null);
    try {
      const res = await updateLineItem(operationId, li.id, {
        qty, unit_price: unitPrice, discount_pct: discPct,
      });
      if (res.success && res.result) {
        if (res.result.documents_cancelled > 0) {
          setInfo(`${res.result.documents_cancelled} document(s) cancelled, operation reverted to draft`);
        } else {
          setInfo('Line item updated');
        }
        setEditingId(null);
        await onMutated();
      } else {
        setErr(res.errors?.[0]?.message ?? 'Update failed');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (li: OperationLineItem) => {
    if (!confirm(`Delete line item ${li.product_id} (qty ${li.qty})?\n\nIf this operation has documents, they will be marked cancelled and the operation will revert to draft.`)) return;
    setBusy(li.id);
    setErr(null);
    try {
      const res = await deleteLineItem(operationId, li.id);
      if (res.success && res.result) {
        if (res.result.documents_cancelled > 0) {
          setInfo(`${res.result.documents_cancelled} document(s) cancelled, operation reverted to draft`);
        } else {
          setInfo('Line item deleted');
        }
        await onMutated();
      } else {
        setErr(res.errors?.[0]?.message ?? 'Delete failed');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  };

  const handleOpenAdd = async () => {
    setShowAdd(true);
    setAddProductId('');
    setAddQty('');
    setAddUnitPrice('');
    setAddDiscountPct('0');
    setErr(null);
    setInfo(null);
    await ensureProducts();
  };

  const handleSaveAdd = async () => {
    const qty = Number(addQty);
    const unitPrice = Number(addUnitPrice);
    const discPct = Number(addDiscountPct);
    if (!addProductId) { setErr('Pick a product'); return; }
    if (!Number.isFinite(qty) || qty <= 0) { setErr('Qty must be positive'); return; }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) { setErr('Unit price must be non-negative'); return; }
    if (!Number.isFinite(discPct) || discPct < 0 || discPct > 100) { setErr('Discount must be 0-100'); return; }

    setBusy('__add__');
    setErr(null);
    try {
      const res = await addLineItem(operationId, {
        product_id: addProductId,
        qty, unit_price: unitPrice, discount_pct: discPct,
      });
      if (res.success && res.result) {
        if (res.result.documents_cancelled > 0) {
          setInfo(`${res.result.documents_cancelled} document(s) cancelled, operation reverted to draft`);
        } else {
          setInfo('Line item added');
        }
        setShowAdd(false);
        await onMutated();
      } else {
        setErr(res.errors?.[0]?.message ?? 'Add failed');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {!editable && (
        <div className="px-4 py-3" style={{
          fontSize: '14px',
          color: 'var(--fg-2)',
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-sm)',
        }}>
          Line items are read-only — operation status is <strong>{operationStatus}</strong>.
          To make changes, edits are blocked once shipped, delivered, or cancelled.
        </div>
      )}

      {info && (
        <div className="px-4 py-3" style={{
          fontSize: '14px', color: 'var(--fg-1)',
          backgroundColor: 'rgba(46,125,79,0.08)',
          border: '1px solid rgba(46,125,79,0.2)',
          borderRadius: 'var(--radius-sm)',
        }}>{info}</div>
      )}
      {err && (
        <div className="px-4 py-3" style={{
          fontSize: '14px', color: 'var(--brand-rot)',
          backgroundColor: 'rgba(229,32,44,0.08)',
          border: '1px solid rgba(229,32,44,0.3)',
          borderRadius: 'var(--radius-sm)',
        }}>{err}</div>
      )}

      <div className="overflow-hidden" style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}>
        <table className="w-full" style={{ fontSize: 'var(--fs-body-sm)' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px' }}>SKU</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px' }}>Product</th>
              <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Qty</th>
              <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Unit</th>
              <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Disc%</th>
              <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Total</th>
              {editable && <th className="text-right px-4 py-3" style={{ fontSize: '14px' }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {lineItems.map((li) => {
              const isEditing = editingId === li.id;
              const isBusy = busy === li.id;
              return (
                <tr key={li.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                    {li.product_id.toUpperCase()}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>
                    {li.product_name ?? li.item_description ?? li.product_id}
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)' }}>
                    {isEditing ? (
                      <input
                        type="number"
                        value={editQty}
                        onChange={(e) => setEditQty(e.target.value)}
                        style={{ width: '80px', padding: '4px 8px', textAlign: 'right',
                          fontSize: '14px', fontWeight: 700,
                          border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
                        }}
                      />
                    ) : (
                      li.qty
                    )}
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)' }}>
                    {isEditing ? (
                      <input
                        type="number" step="0.01"
                        value={editUnitPrice}
                        onChange={(e) => setEditUnitPrice(e.target.value)}
                        style={{ width: '100px', padding: '4px 8px', textAlign: 'right',
                          fontSize: '14px', fontWeight: 700,
                          border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
                        }}
                      />
                    ) : (
                      formatMoney(li.unit_price, currency)
                    )}
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-3)' }}>
                    {isEditing ? (
                      <input
                        type="number" step="0.01"
                        value={editDiscountPct}
                        onChange={(e) => setEditDiscountPct(e.target.value)}
                        style={{ width: '70px', padding: '4px 8px', textAlign: 'right',
                          fontSize: '14px', fontWeight: 700,
                          border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
                        }}
                      />
                    ) : (
                      li.discount_pct > 0 ? `${li.discount_pct}%` : '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
                    {formatMoney(li.line_amount, currency)}
                  </td>
                  {editable && (
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        {isEditing ? (
                          <>
                            <button
                              onClick={() => handleSaveEdit(li)}
                              disabled={isBusy}
                              title="Save"
                              style={{
                                fontSize: '14px', fontWeight: 600, padding: '4px 8px',
                                border: '1px solid rgba(46,125,79,0.3)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--status-success)',
                                background: 'transparent',
                                cursor: isBusy ? 'wait' : 'pointer',
                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                              }}>
                              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              Save
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              disabled={isBusy}
                              title="Cancel edit"
                              style={{
                                fontSize: '14px', fontWeight: 600, padding: '4px 8px',
                                border: '1px solid var(--border-hairline)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--fg-2)',
                                background: 'transparent',
                                cursor: isBusy ? 'wait' : 'pointer',
                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                              }}>
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => handleStartEdit(li)}
                              disabled={busy !== null}
                              title="Edit"
                              style={{
                                fontSize: '14px', fontWeight: 600, padding: '4px 8px',
                                border: '1px solid var(--border-hairline)',
                                borderRadius: 'var(--radius-sm)',
                                color: 'var(--fg-2)',
                                background: 'transparent',
                                cursor: busy !== null ? 'not-allowed' : 'pointer',
                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                              }}>
                              <Pencil className="h-3.5 w-3.5" />
                              Edit
                            </button>
                            <button
                              onClick={() => handleDelete(li)}
                              disabled={busy !== null}
                              title="Delete line"
                              style={{
                                fontSize: '14px', fontWeight: 600, padding: '4px 8px',
                                border: '1px solid rgba(229,32,44,0.3)',
                                borderRadius: 'var(--radius-sm)',
                                color: '#A82029',
                                background: 'transparent',
                                cursor: busy !== null ? 'not-allowed' : 'pointer',
                                display: 'inline-flex', alignItems: 'center', gap: '4px',
                              }}>
                              {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}

            {/* Subtotal */}
            <tr>
              <td colSpan={editable ? 6 : 5} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '14px' }}>
                Subtotal
              </td>
              <td className="px-4 py-2 text-right" style={{ color: 'var(--fg-1)' }}>
                {formatMoney(subtotal, currency)}
              </td>
              {editable && <td className="px-4 py-2"></td>}
            </tr>

            {showDiscount && (
              <tr>
                <td colSpan={editable ? 6 : 5} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '14px' }}>
                  Discount {discountPct}%
                </td>
                <td className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)' }}>
                  −{formatMoney(discount, currency)}
                </td>
                {editable && <td className="px-4 py-2"></td>}
              </tr>
            )}

            {showVat && (
              <>
                <tr>
                  <td colSpan={editable ? 6 : 5} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '14px' }}>
                    Net
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--fg-1)' }}>
                    {formatMoney(totalAfterDiscount, currency)}
                  </td>
                  {editable && <td className="px-4 py-2"></td>}
                </tr>
                <tr>
                  <td colSpan={editable ? 6 : 5} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '14px' }}>
                    VAT {vatRate}%
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)' }}>
                    +{formatMoney(vatAmount, currency)}
                  </td>
                  {editable && <td className="px-4 py-2"></td>}
                </tr>
              </>
            )}

            <tr style={{ borderTop: '1px solid var(--border-hairline)' }}>
              <td colSpan={editable ? 6 : 5} className="px-4 py-3 text-right" style={{ fontSize: '14px' }}>
                Total
              </td>
              <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 700, fontSize: '15px' }}>
                {formatMoney(grandTotal, currency)} {currency}
              </td>
              {editable && <td className="px-4 py-3"></td>}
            </tr>
          </tbody>
        </table>
      </div>

      {editable && !showAdd && (
        <div>
          <button
            onClick={handleOpenAdd}
            disabled={busy !== null}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '6px 14px', fontSize: '14px', fontWeight: 600,
              border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)', color: 'var(--fg-1)',
              cursor: busy !== null ? 'not-allowed' : 'pointer',
            }}>
            <Plus className="h-4 w-4" />
            Add line item
          </button>
        </div>
      )}

      {editable && showAdd && (
        <div className="p-4" style={{
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper-sunk)',
        }}>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label style={{ fontSize: '14px', color: 'var(--fg-3)', display: 'block', marginBottom: '4px' }}>Product</label>
              <select
                value={addProductId}
                onChange={(e) => setAddProductId(e.target.value)}
                style={{ minWidth: '260px', padding: '6px 8px', fontSize: '14px', fontWeight: 700,
                  border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'var(--paper)' }}>
                <option value="">{productsLoaded ? '— pick product —' : 'Loading...'}</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id.toUpperCase()} · {p.invoice_label ?? p.product_name ?? p.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '14px', color: 'var(--fg-3)', display: 'block', marginBottom: '4px' }}>Qty</label>
              <input type="number" value={addQty} onChange={(e) => setAddQty(e.target.value)}
                style={{ width: '90px', padding: '6px 8px', textAlign: 'right',
                  fontSize: '14px', fontWeight: 700,
                  border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }} />
            </div>
            <div>
              <label style={{ fontSize: '14px', color: 'var(--fg-3)', display: 'block', marginBottom: '4px' }}>Unit price</label>
              <input type="number" step="0.01" value={addUnitPrice} onChange={(e) => setAddUnitPrice(e.target.value)}
                style={{ width: '110px', padding: '6px 8px', textAlign: 'right',
                  fontSize: '14px', fontWeight: 700,
                  border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }} />
            </div>
            <div>
              <label style={{ fontSize: '14px', color: 'var(--fg-3)', display: 'block', marginBottom: '4px' }}>Disc %</label>
              <input type="number" step="0.01" value={addDiscountPct} onChange={(e) => setAddDiscountPct(e.target.value)}
                style={{ width: '70px', padding: '6px 8px', textAlign: 'right',
                  fontSize: '14px', fontWeight: 700,
                  border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }} />
            </div>
            <button
              onClick={handleSaveAdd}
              disabled={busy !== null}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '6px 14px', fontSize: '14px', fontWeight: 600,
                border: '1px solid rgba(46,125,79,0.3)', borderRadius: 'var(--radius-sm)',
                color: 'var(--status-success)', background: 'transparent',
                cursor: busy !== null ? 'wait' : 'pointer',
              }}>
              {busy === '__add__' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Add
            </button>
            <button
              onClick={() => setShowAdd(false)}
              disabled={busy !== null}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px',
                padding: '6px 14px', fontSize: '14px', fontWeight: 600,
                border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
                color: 'var(--fg-2)', background: 'transparent',
                cursor: busy !== null ? 'wait' : 'pointer',
              }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Status tab
// =============================================================================
const STATUS_TARGETS = [
  { id: 'shipped',   label: 'Mark as shipped' },
  { id: 'delivered', label: 'Mark as delivered' },
  { id: 'cancelled', label: 'Cancel' },
] as const;

type StatusTarget = typeof STATUS_TARGETS[number]['id'];

function StatusTab({
  status,
  operationId,
  onStatusChange,
}: {
  status: string;
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
          {STATUS_TARGETS.map((target) => {
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
}: {
  operationId: string;
  initialDocs: OperationDocument[];
  onChange: (docs: OperationDocument[]) => void;
}) {
  const [docs, setDocs] = useState<OperationDocument[]>(initialDocs);
  const [loading, setLoading] = useState(initialDocs.length === 0);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueSuccess, setIssueSuccess] = useState<string | null>(null);

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

  const STATUS_STYLE: Record<string, { fg: string; bg: string; strike: boolean }> = {
    issued:    { fg: 'var(--status-success)', bg: 'rgba(46,125,79,0.08)',  strike: false },
    draft:     { fg: 'var(--status-warning)', bg: 'rgba(199,122,0,0.08)',  strike: false },
    voided:    { fg: 'var(--fg-3)',           bg: 'var(--paper-sunk)',     strike: false },
    cancelled: { fg: 'var(--brand-rot)',      bg: 'rgba(229,32,44,0.08)',  strike: true  },
  };

  return (
    <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      <div className="flex justify-between items-center px-4 py-3" style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
        <p style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)', margin: 0 }}>
          {loading ? 'Documents' : `Documents${docs.length > 0 ? ` (${docs.length})` : ''}`}
        </p>
        <button
          onClick={handleIssue}
          disabled={issuing}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 14px', fontSize: '14px', fontWeight: 600, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper)', color: 'var(--fg-1)', cursor: issuing ? 'not-allowed' : 'pointer', opacity: issuing ? 0.6 : 1 }}
        >
          {issuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Issue documents
        </button>
      </div>
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
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--fg-3)' }} />
        </div>
      ) : docs.length === 0 ? (
        <div style={{ padding: '32px 16px', textAlign: 'center' }}>
          <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: '0 0 4px' }}>No documents yet</p>
          <p style={{ fontSize: '14px', color: 'var(--fg-3)', margin: 0 }}>Click Issue documents to generate CI and PL</p>
        </div>
      ) : (
        <table className="w-full" style={{ fontSize: '14px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Document</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Type</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Date</th>
              <th className="text-left px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>Status</th>
              <th className="text-right px-4 py-3" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>File</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => {
              const statusStyle = STATUS_STYLE[doc.status] ?? STATUS_STYLE.draft!;
              const typeLabel = DOC_TYPE_LABELS[doc.document_type] ?? doc.document_type;
              const date = doc.document_date ? new Date(doc.document_date * 1000).toISOString().split('T')[0] : '—';
              const cancelledStyle = statusStyle.strike
                ? { textDecoration: 'line-through', textDecorationColor: 'var(--brand-rot)' }
                : {};
              return (
                <tr key={doc.id} style={{ borderBottom: '1px solid var(--border-hairline)', ...(statusStyle.strike ? { opacity: 0.7 } : {}) }}>
                  <td className="px-4 py-3" style={{ fontWeight: 700, color: statusStyle.strike ? 'var(--brand-rot)' : 'var(--fg-1)', ...cancelledStyle }}>{doc.document_number}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-2)', ...cancelledStyle }}>{typeLabel}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--fg-3)', ...cancelledStyle }}>{date}</td>
                  <td className="px-4 py-3">
                    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: '999px', fontSize: '14px', fontWeight: 500, color: statusStyle.fg, backgroundColor: statusStyle.bg }}>
                      {doc.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {doc.pdf_r2_url ? (
                      <a href={`https://dasoperator-api.dasexperten.workers.dev/api/documents/${doc.id}/download`} target="_blank" rel="noopener noreferrer" style={{ fontSize: '14px', fontWeight: 600, color: 'var(--brand-rot)', textDecoration: 'none' }}>
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
