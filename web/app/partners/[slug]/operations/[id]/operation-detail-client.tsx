'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus } from 'lucide-react';
import {
  getOperation,
  getPartner,
  getPayments,
  type Operation,
  type OperationLineItem,
  type Partner,
  type Payment,
} from '@/lib/api';
import Breadcrumb from '@/components/layout/breadcrumb';

// =============================================================================
// Helpers
// =============================================================================
function formatDate(unixSec?: number | null): string {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toISOString().split('T')[0]!;
}

function formatMoney(minor: number, currency: string): string {
  const factor = ['VND', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
  return (minor / factor).toLocaleString('en-US', {
    minimumFractionDigits: factor === 1 ? 0 : 2,
    maximumFractionDigits: factor === 1 ? 0 : 2,
  });
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
        letterSpacing: '0.02em',
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

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [partnerRes, opRes, paysRes] = await Promise.all([
          getPartner(partnerSlug),
          getOperation(operationId),
          getPayments({ operation_id: operationId }),
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
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [partnerSlug, operationId]);

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
  const vatAmount = Math.round(totalAfterDiscount * (operation.vat_rate / 100));
  const grandTotal = totalAfterDiscount + vatAmount;
  const showVat = operation.vat_rate > 0;

  // Payments aggregation — incoming reduces outstanding, outgoing increases it.
  const paidMinor = payments.reduce(
    (sum, p) => sum + (p.direction === 'incoming' ? p.amount : -p.amount),
    0
  );
  const outstanding = grandTotal - paidMinor;

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
          <p className="dx-eyebrow" style={{ fontSize: '11px' }}>
            {operation.operation_type} operation
          </p>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--fs-display-md)',
              fontWeight: 900,
              letterSpacing: '-0.025em',
              color: 'var(--fg-1)',
              marginTop: '4px',
            }}
          >
            {operation.reference ?? operationId.slice(0, 12)}
          </h1>
          <p style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)', marginTop: '4px' }}>
            {partner?.trade_name ?? partnerSlug}
            {operation.contract_no && (
              <> · Contract <span className="dx-mono">{operation.contract_no}</span></>
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
          <p className="dx-eyebrow" style={{ fontSize: '10px' }}>Date</p>
          <p className="mt-1 dx-mono" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
            {formatDate(operation.operation_date)}
          </p>
        </div>
        <div>
          <p className="dx-eyebrow" style={{ fontSize: '10px' }}>Entity</p>
          <p className="mt-1" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
            {operation.entity_abbreviation ?? '—'}
          </p>
        </div>
        <div>
          <p className="dx-eyebrow" style={{ fontSize: '10px' }}>Warehouse</p>
          <p className="mt-1 dx-mono" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
            {operation.warehouse_from_id ?? '—'}
          </p>
        </div>
        <div>
          <p className="dx-eyebrow" style={{ fontSize: '10px' }}>Currency</p>
          <p className="mt-1 dx-mono" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-1)' }}>
            {operation.currency}
          </p>
        </div>
        <div>
          <p className="dx-eyebrow" style={{ fontSize: '10px' }}>VAT</p>
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
          { id: 'documents', label: 'Documents',  count: 0 }, // placeholder until backend join
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
                <span style={{ color: 'var(--fg-3)', marginLeft: '6px', fontSize: '11px' }}>
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
        <StatusTab status={operation.status} />
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
          paidMinor={paidMinor}
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
            <th className="text-left px-4 py-3 dx-eyebrow" style={{ fontSize: '10px' }}>SKU</th>
            <th className="text-left px-4 py-3 dx-eyebrow" style={{ fontSize: '10px' }}>Product</th>
            <th className="text-right px-4 py-3 dx-eyebrow" style={{ fontSize: '10px' }}>Qty</th>
            <th className="text-right px-4 py-3 dx-eyebrow" style={{ fontSize: '10px' }}>Unit</th>
            <th className="text-right px-4 py-3 dx-eyebrow" style={{ fontSize: '10px' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {lineItems.map((li) => (
            <tr key={li.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
              <td className="px-4 py-3 dx-mono" style={{ fontSize: '12px', color: 'var(--fg-1)' }}>
                {li.product_id.toUpperCase()}
              </td>
              <td className="px-4 py-3" style={{ color: 'var(--fg-1)' }}>
                {li.product_name ?? li.item_description ?? li.product_id}
              </td>
              <td className="px-4 py-3 text-right dx-mono" style={{ color: 'var(--fg-1)' }}>
                {li.qty}
              </td>
              <td className="px-4 py-3 text-right dx-mono" style={{ color: 'var(--fg-1)' }}>
                {formatMoney(li.unit_price, currency)}
              </td>
              <td className="px-4 py-3 text-right dx-mono" style={{ color: 'var(--fg-1)', fontWeight: 600 }}>
                {formatMoney(li.line_amount, currency)}
              </td>
            </tr>
          ))}

          {/* Subtotal */}
          <tr>
            <td colSpan={4} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '12px' }}>
              Subtotal
            </td>
            <td className="px-4 py-2 text-right dx-mono" style={{ color: 'var(--fg-1)' }}>
              {formatMoney(subtotal, currency)}
            </td>
          </tr>

          {/* Discount (only if >0) */}
          {showDiscount && (
            <tr>
              <td colSpan={4} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '12px' }}>
                Discount {discountPct}%
              </td>
              <td className="px-4 py-2 text-right dx-mono" style={{ color: 'var(--fg-2)' }}>
                −{formatMoney(discount, currency)}
              </td>
            </tr>
          )}

          {/* VAT — Net + VAT lines (only if rate > 0) */}
          {showVat && (
            <>
              <tr>
                <td colSpan={4} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '12px' }}>
                  Net
                </td>
                <td className="px-4 py-2 text-right dx-mono" style={{ color: 'var(--fg-1)' }}>
                  {formatMoney(totalAfterDiscount, currency)}
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="px-4 py-2 text-right" style={{ color: 'var(--fg-2)', fontSize: '12px' }}>
                  VAT {vatRate}%
                </td>
                <td className="px-4 py-2 text-right dx-mono" style={{ color: 'var(--fg-2)' }}>
                  +{formatMoney(vatAmount, currency)}
                </td>
              </tr>
            </>
          )}

          {/* Total */}
          <tr style={{ borderTop: '1px solid var(--border-hairline)' }}>
            <td colSpan={4} className="px-4 py-3 text-right dx-eyebrow" style={{ fontSize: '11px' }}>
              Total
            </td>
            <td className="px-4 py-3 text-right dx-mono" style={{ color: 'var(--fg-1)', fontWeight: 700, fontSize: '15px' }}>
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

function StatusTab({ status }: { status: string }) {
  return (
    <div
      className="p-6 space-y-6"
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div className="flex items-center gap-3">
        <span className="dx-eyebrow" style={{ fontSize: '11px' }}>Current</span>
        {statusChip(status)}
      </div>

      <div>
        <p className="dx-eyebrow mb-3" style={{ fontSize: '11px' }}>Move to</p>
        <div className="flex flex-wrap gap-2">
          {STATUS_TARGETS.map((target) => (
            <button
              key={target.id}
              disabled
              className="px-4 py-2 text-sm transition-colors"
              style={{
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'transparent',
                color: target.id === 'cancelled' ? 'var(--brand-rot)' : 'var(--fg-1)',
                opacity: 0.5,
                cursor: 'not-allowed',
              }}
              title="Status update wiring lands in next PR"
            >
              {target.label}
            </button>
          ))}
        </div>
        <p className="mt-3" style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
          Backend PATCH endpoint already deployed — buttons get wired in next PR.
        </p>
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
      <p style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
        Available types: Commercial invoice · Packing list · Issuance statement
      </p>
      <p className="dx-mono" style={{ fontSize: '10px', color: 'var(--fg-3)' }}>
        Operation id: {operationId}
      </p>
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
  paidMinor,
  outstanding,
}: {
  partnerSlug: string;
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
                <th className="text-left px-4 py-2 dx-eyebrow" style={{ fontSize: '10px' }}>Date</th>
                <th className="text-left px-4 py-2 dx-eyebrow" style={{ fontSize: '10px' }}>Type</th>
                <th className="text-left px-4 py-2 dx-eyebrow" style={{ fontSize: '10px' }}>Direction</th>
                <th className="text-right px-4 py-2 dx-eyebrow" style={{ fontSize: '10px' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="px-4 py-3 dx-mono" style={{ color: 'var(--fg-2)' }}>
                    {formatDate(p.payment_date)}
                  </td>
                  <td className="px-4 py-3 dx-eyebrow" style={{ color: 'var(--fg-1)', fontSize: '10px', letterSpacing: '0.15em' }}>
                    {p.type}
                  </td>
                  <td className="px-4 py-3 dx-eyebrow" style={{ color: 'var(--fg-2)', fontSize: '10px', letterSpacing: '0.15em' }}>
                    {p.direction}
                  </td>
                  <td className="px-4 py-3 text-right dx-mono" style={{ color: 'var(--fg-1)', fontWeight: 600 }}>
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
          <p className="dx-eyebrow" style={{ fontSize: '10px' }}>Operation</p>
          <p className="mt-1 dx-mono" style={{ fontSize: 'var(--fs-body-md)', color: 'var(--fg-1)', fontWeight: 600 }}>
            {formatMoney(grandTotal, currency)}
          </p>
        </div>
        <div>
          <p className="dx-eyebrow" style={{ fontSize: '10px' }}>Paid</p>
          <p className="mt-1 dx-mono" style={{ fontSize: 'var(--fs-body-md)', color: 'var(--status-success)', fontWeight: 600 }}>
            {formatMoney(paidMinor, currency)}
          </p>
        </div>
        <div>
          <p className="dx-eyebrow" style={{ fontSize: '10px' }}>Outstanding</p>
          <p
            className="mt-1 dx-mono"
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
