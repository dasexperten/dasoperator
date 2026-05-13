'use client';

/**
 * ServiceStatusBar — replaces the goods progress strip (CI · PL · IS · RFQ ·
 * Production · Shipped · Delivered) for operations on the service track.
 *
 * Two binary status chips:
 *   • Service provided   — derived from operation.delivery_status === 'delivered'
 *   • Paid               — derived from sum(payments) >= operation.total_amount
 *
 * No new columns required (see migration 0034). Both signals already exist:
 *   delivery_status: added in 0031
 *   payments:        own table since 0006
 *
 * The component is intentionally read-mostly. Admins flip Service provided
 * by issuing an Acceptance Certificate (which sets delivery_status='delivered'
 * upstream) or by manual override on the operation page. The Paid chip flips
 * automatically when payments cover the invoice total.
 */

import { Check, Coins } from 'lucide-react';

interface ServiceStatusBarProps {
  /** Operation delivery status from /api/operations/:id */
  deliveryStatus: 'pending' | 'delivered' | 'disputed' | 'refunded';
  /** Confirmed payment sum for this operation, in operation currency */
  paidAmount: number | null;
  /** Operation total_amount, in operation currency */
  totalAmount: number | null;
  /** ISO timestamp of when delivery_status became 'delivered' (optional) */
  deliveredAt?: string | null;
  /** ISO timestamp of when the operation first became fully paid (optional) */
  paidAt?: string | null;
}

export default function ServiceStatusBar({
  deliveryStatus,
  paidAmount,
  totalAmount,
  deliveredAt,
  paidAt,
}: ServiceStatusBarProps) {
  const serviceProvided = deliveryStatus === 'delivered';
  const paid =
    totalAmount !== null && totalAmount > 0 && (paidAmount ?? 0) >= totalAmount;

  return (
    <div
      className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3"
      style={{
        backgroundColor: 'var(--paper-sunk)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <Chip
        icon={<Check className="h-5 w-5" />}
        label="Service provided"
        active={serviceProvided}
        sublabel={
          serviceProvided
            ? deliveredAt
              ? formatDate(deliveredAt)
              : 'Acceptance issued'
            : describePending(deliveryStatus)
        }
      />
      <Chip
        icon={<Coins className="h-5 w-5" />}
        label="Paid"
        active={paid}
        sublabel={
          paid
            ? paidAt
              ? formatDate(paidAt)
              : 'Invoice settled'
            : describePaymentGap(paidAmount, totalAmount)
        }
      />
    </div>
  );
}

// ----------------------------------------------------------------------------

interface ChipProps {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  active: boolean;
}

function Chip({ icon, label, sublabel, active }: ChipProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 16px',
        borderRadius: 'var(--radius-md)',
        border: active
          ? '2px solid var(--status-success)'
          : '2px solid var(--border-hairline)',
        backgroundColor: active ? 'rgba(46,125,79,0.08)' : 'var(--paper)',
        transition: 'all 120ms ease',
      }}
    >
      <div
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '50%',
          backgroundColor: active ? 'var(--status-success)' : 'var(--fg-4)',
          color: active ? '#fff' : 'var(--paper)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 'var(--fs-body-md)',
            fontWeight: 600,
            color: active ? 'var(--status-success)' : 'var(--fg-1)',
            lineHeight: 1.2,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: '13px',
            color: 'var(--fg-3)',
            marginTop: '2px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sublabel}
        </div>
      </div>
      <div
        style={{
          fontSize: '11px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          padding: '3px 10px',
          borderRadius: '999px',
          backgroundColor: active ? 'var(--status-success)' : 'var(--fg-4)',
          color: active ? '#fff' : 'var(--paper)',
          flexShrink: 0,
        }}
      >
        {active ? 'Active' : 'Inactive'}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------

function describePending(status: string): string {
  switch (status) {
    case 'pending':
      return 'Awaiting acceptance certificate';
    case 'disputed':
      return 'Disputed — see operation notes';
    case 'refunded':
      return 'Refunded — service was not delivered';
    default:
      return 'Not yet delivered';
  }
}

function describePaymentGap(
  paid: number | null,
  total: number | null
): string {
  if (total === null || total === 0) return 'Total amount not set';
  const p = paid ?? 0;
  const remaining = total - p;
  if (remaining <= 0) return 'Invoice settled';
  return `Outstanding: ${formatMoney(remaining)}`;
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
