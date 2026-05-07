'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus } from 'lucide-react';
import {
  getOperation,
  getPartner,
  getPayments,
  updateOperationStatus,
  getDocuments,
  issueDocuments,
  type Operation,
  type OperationLineItem,
  type Partner,
  type Payment,
  type OperationDocument,
} from '@/lib/api';
import { formatMoney } from '@/lib/money';
import Breadcrumb from '@/components/layout/breadcrumb';

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
type Tab = 'items' | 'status' | 'documents' | 'payments';

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
  const [activeTab, setActiveTab] = useState<Tab>('items');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [documentCount, setDocumentCount] = useState(0);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [partnerRes, opRes, paysRes, docsRes] = await Promise.all([
          getPartner(partnerSlug),
          getOperation(operationId),
          getPayments({ operation_id: operationId }),
          getDocuments({ operation_id: operationId }),
        ]);

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
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [partnerSlug, operationId]);

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
            {operation.contract_no && (
              <> · Contract <span>{operation.contract_no}</span></>
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
          { id: 'items',     label: 'Line items', count: lineItems.length },
          { id: 'status',    label: 'Status',     count: null },
          { id: 'documents', label: 'Documents',  count: documentCount },
          { id: 'payments',  label: 'Payments',   count: payments.length },
        ] as { id: Tab; label: string; count: number | null }[]).map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-3 text-sm transition-colors"
              style={{
                color: isActive ? 'var(--fg-1)' : 'var(--fg-3)',
                fontWeight: isActive ? 600 : 400,
                borderBottom: isActive ? '2px solid var(--fg-1)' : '2px solid transparent',
                marginBottom: '-1px',
                backgroundColor: 'transparent',
                cursor: 'pointer',
              }}
            >
              {tab.label}
              {tab.count !== null && tab.count > 0 && (
                <span style={{ color: 'var(--fg-3)', marginLeft: '6px', fontSize: '14px' }}>
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

      {activeTab === 'documents' && (
        <DocumentsTab operationId={operationId} />
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
function DocumentsTab({ operationId }: { operationId: string }) {
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
  };

  const STATUS_STYLE: Record<string, { fg: string; bg: string }> = {
    issued:   { fg: 'var(--status-success)', bg: 'rgba(46,125,79,0.08)' },
    draft:    { fg: 'var(--status-warning)', bg: 'rgba(199,122,0,0.08)' },
    voided:   { fg: 'var(--fg-3)',           bg: 'var(--paper-sunk)' },
  };

  return (
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
  );
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
