'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus } from 'lucide-react';
import {
  getOperation,
  getPartner,
  getPayments,
  getStockMovements,
  updateOperationStatus,
  type Operation,
  type OperationLineItem,
  type Partner,
  type Payment,
  type StockMovement,
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
  const [activeTab, setActiveTab] = useState<Tab>('items');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [opRes, paysRes, movesRes] = await Promise.all([
          getOperation(operationId),
          getPayments({ operation_id: operationId }),
          getStockMovements({ source_ref_id: operationId, source: 'operation' }),
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
          { id: 'items',     label: 'Line items',      count: lineItems.length },
          { id: 'status',    label: 'Status',          count: null },
          { id: 'stock',     label: 'Stock movements', count: stockMovements.length },
          { id: 'documents', label: 'Documents',       count: 0 }, // placeholder until backend join
          { id: 'payments',  label: 'Payments',        count: payments.length },
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
        <DocumentsTab operationId={operationId} />
      )}

      {activeTab === 'payments' && (
        <PaymentsTab
          partnerId={operation.partner_id}
          operationId={operationId}
          payments={payments}
          currency={operation.currency}
          grandTotal={grandTotal}
          paidMinor={paidAmount}
          outstanding={outstanding}
        />
      )}
    </div>
  );
}

// =============================================================================
// Items tab
// =============================================================================
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
}) {
  const showDiscount = discount > 0;
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
              <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)' }}>
                {li.qty}
              </td>
              <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)' }}>
                {formatMoney(li.unit_price, currency)}
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
// Documents tab — placeholder until parallel chat exposes operation→docs join
// =============================================================================
function DocumentsTab({ operationId }: { operationId: string }) {
  return (
    <div
      className="p-6 space-y-3"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div className="flex justify-between items-center">
        <p style={{ color: 'var(--fg-2)', fontSize: 'var(--fs-body-sm)' }}>
          Documents will appear here once issued.
        </p>
        <button
          disabled
          className="inline-flex items-center gap-2 px-4 py-2 text-sm"
          style={{
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--fg-2)',
            opacity: 0.6,
            cursor: 'not-allowed',
          }}
          title="Issue Document UI lands in next PR"
        >
          <Plus className="h-4 w-4" />
          Issue document
        </button>
      </div>
      <p style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
        Available types: Commercial invoice · Packing list · Issuance statement
      </p>
      <p style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
        Operation id: {operationId}
      </p>
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
  paidMinor,
  outstanding,
}: {
  partnerId: string | null;
  operationId: string;
  payments: Payment[];
  currency: string;
  grandTotal: number;
  paidMinor: number;
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
            {formatMoney(paidMinor, currency)}
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
