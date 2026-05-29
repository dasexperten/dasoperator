'use client';

/**
 * ServiceStatusBar — three-chip status indicator for service-track operations.
 *
 * Layout (left → right, fits horizontally on desktop ≥768px):
 *
 *   ┌──────────────────────┬───────────────────────┬──────────────────────┐
 *   │  Service provided    │  Documents issued     │  Payment             │
 *   │  GREEN when active   │  RED when active      │  BLUE when active    │
 *   ├──────────────────────┼───────────────────────┼──────────────────────┤
 *   │  Signal: ACP attached│  Signal: INV attached │  Signal: PAY found   │
 *   │  (or INV for         │                       │  (sum payments ≥     │
 *   │  subscription        │                       │  total_amount)       │
 *   │  partners — see      │                       │                      │
 *   │  partnerAcceptance-  │                       │                      │
 *   │  Required)           │                       │                      │
 *   └──────────────────────┴───────────────────────┴──────────────────────┘
 *
 * Subscription-partner shortcut (partnerAcceptanceRequired === 0):
 *   When the partner is flagged as not-needing-acceptance (rent, accounting,
 *   banking, hosting), the Service provided chip lights up the moment the
 *   invoice is attached — no separate ACP needed. The chip sublabel says
 *   "Invoice serves as acceptance" so the operator knows it's intentional.
 *
 * Inactive chips show as grey (no border accent, neutral text). Active chips
 * use their semantic color (green/red/blue) on a tinted background with
 * matching border.
 *
 * Migration 0038 added the partner-level flag. The /api/operations/:id route
 * returns the three boolean signals (has_acceptance_attachment,
 * has_invoice_attachment, partner_acceptance_required).
 */

import { Check, FileText, Coins } from 'lucide-react';

interface ServiceStatusBarProps {
  /** True when an operation_attachments row with kind='acceptance' exists. */
  hasAcceptance: boolean;
  /** True when an operation_attachments row with kind='invoice' exists. */
  hasInvoice: boolean;
  /** Confirmed payment sum for this operation, in operation currency. */
  paidAmount: number | null;
  /** Operation total_amount, in operation currency. */
  totalAmount: number | null;
  /**
   * Partner-level flag from migration 0038. When 0, this partner runs on a
   * subscription model where the invoice itself serves as the acceptance —
   * Service provided chip lights up on invoice attach. Defaults to 1 (require
   * separate acceptance) for safety.
   */
  partnerAcceptanceRequired: 0 | 1 | null | undefined;

  /** ISO timestamp of acceptance attach (optional, shown in sublabel). */
  acceptanceAt?: string | null;
  /** ISO timestamp of invoice attach (optional, shown in sublabel). */
  invoiceAt?: string | null;
  /** ISO timestamp of the operation first becoming fully paid (optional). */
  paidAt?: string | null;
  /** Acceptance doc number for the sublabel (e.g. ACP-2026-04-30-001). */
  acceptanceRef?: string | null;
  /** Invoice doc number for the sublabel (e.g. INV-1142). */
  invoiceRef?: string | null;
  /** Operation currency for the outstanding-amount sublabel. */
  currency?: string | null;
}

export default function ServiceStatusBar({
  hasAcceptance,
  hasInvoice,
  paidAmount,
  totalAmount,
  partnerAcceptanceRequired,
  acceptanceAt,
  invoiceAt,
  paidAt,
  acceptanceRef,
  invoiceRef,
  currency,
}: ServiceStatusBarProps) {
  // ── Service Provided ──────────────────────────────────────────────────────
  // For subscription partners (acceptance_required=0), the invoice substitutes
  // for the acceptance — fire the chip on either signal.
  const subscriptionPartner = partnerAcceptanceRequired === 0;
  const serviceProvided = subscriptionPartner
    ? hasAcceptance || hasInvoice
    : hasAcceptance;

  // ── Documents Issued ──────────────────────────────────────────────────────
  const documentsIssued = hasInvoice;

  // ── Payment ───────────────────────────────────────────────────────────────
  const paid =
    totalAmount !== null && totalAmount > 0 && (paidAmount ?? 0) >= totalAmount;

  // ── Sublabels ─────────────────────────────────────────────────────────────
  let serviceSub: string;
  if (serviceProvided) {
    if (subscriptionPartner && !hasAcceptance && hasInvoice) {
      serviceSub = 'Invoice serves as acceptance';
    } else if (acceptanceRef) {
      serviceSub = `Acceptance ${acceptanceRef} attached`;
    } else if (acceptanceAt) {
      serviceSub = `Accepted ${formatDate(acceptanceAt)}`;
    } else {
      serviceSub = 'Acceptance attached';
    }
  } else {
    serviceSub = 'No acceptance attached';
  }

  let docsSub: string;
  if (documentsIssued) {
    if (invoiceRef) {
      docsSub = `Invoice ${invoiceRef} attached`;
    } else if (invoiceAt) {
      docsSub = `Invoiced ${formatDate(invoiceAt)}`;
    } else {
      docsSub = 'Invoice attached';
    }
  } else {
    docsSub = 'No invoice yet';
  }

  let paySub: string;
  if (paid) {
    paySub = paidAt ? `Paid ${formatDate(paidAt)}` : 'Invoice settled';
  } else {
    const remaining = (totalAmount ?? 0) - (paidAmount ?? 0);
    if (totalAmount === null || totalAmount === 0) {
      paySub = 'Total amount not set';
    } else if (remaining <= 0) {
      paySub = 'Invoice settled';
    } else {
      paySub = `Outstanding: ${formatMoney(remaining)}${currency ? ' ' + currency : ''}`;
    }
  }

  return (
    <div
      className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3"
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
        color="green"
        sublabel={serviceSub}
      />
      <Chip
        icon={<FileText className="h-5 w-5" />}
        label="Documents issued"
        active={documentsIssued}
        color="green"
        sublabel={docsSub}
      />
      <Chip
        icon={<Coins className="h-5 w-5" />}
        label="Payment"
        active={paid}
        color="green"
        sublabel={paySub}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------

type ChipColor = 'green' | 'red' | 'blue';

interface ChipProps {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  active: boolean;
  color: ChipColor;
}

const COLOR_TOKENS: Record<ChipColor, { solid: string; tint: string; label: string }> = {
  green: { solid: 'var(--status-success)', tint: 'rgba(46,125,79,0.08)',  label: 'var(--status-success)' },
  red:   { solid: 'var(--brand-rot)',      tint: 'rgba(229,32,44,0.08)',  label: 'var(--brand-rot)' },
  blue:  { solid: '#1e6fb8',                tint: 'rgba(30,111,184,0.08)', label: '#1e6fb8' },
};

function Chip({ icon, label, sublabel, active, color }: ChipProps) {
  const tokens = COLOR_TOKENS[color];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 16px',
        borderRadius: 'var(--radius-md)',
        border: active
          ? `2px solid ${tokens.solid}`
          : '2px solid var(--border-hairline)',
        backgroundColor: active ? tokens.tint : 'var(--paper)',
        transition: 'all 120ms ease',
      }}
    >
      <div
        style={{
          width: '36px',
          height: '36px',
          borderRadius: '50%',
          backgroundColor: active ? tokens.solid : 'var(--fg-4)',
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
            color: active ? tokens.label : 'var(--fg-1)',
            lineHeight: 1.2,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: '14px',
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
          fontSize: '14px',
          fontWeight: 700,
          padding: '3px 10px',
          borderRadius: '999px',
          backgroundColor: active ? tokens.solid : 'var(--fg-4)',
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
