'use client';

/**
 * StatusStages — fixed-slot lifecycle indicator for the Operations table.
 *
 * Four slots in a fixed order, so the same stage always sits in the same
 * column across rows (Payment under Payment, Documents under Documents):
 *
 *   SRV · DOC · PAY · SHP
 *
 * A slot lights up when its stage is done, shows dim when the stage applies
 * but isn't done yet, and is rendered as an empty cell when the stage does
 * not apply to that operation type.
 *
 * Applicability per type:
 *   service   → SRV · DOC · PAY  (DOC lights on issued)
 *   sale      → DOC · PAY · SHP
 *   purchase  → DOC · PAY · SHP
 *   transfer  → DOC · SHP
 *   tax       → DOC · PAY  (no service stage)
 *
 * Lit logic mirrors the detail-page ServiceStatusBar for service ops
 * (acceptance / invoice attachments + payment), and derives goods stages
 * from status / delivery_status / payment_state.
 */

import { Check, FileText, Coins, Truck } from 'lucide-react';
import type { Operation } from '@/lib/api';

type SlotKey = 'SRV' | 'DOC' | 'PAY' | 'SHP';
type SlotState = 'lit' | 'dim' | 'off';

const SLOT_ORDER: SlotKey[] = ['SRV', 'DOC', 'PAY', 'SHP'];

const SLOT_META: Record<
  SlotKey,
  { label: string; icon: React.ReactNode; solid: string; tint: string; border: string }
> = {
  SRV: { label: 'Service provided', icon: <Check className="h-4 w-4" />,    solid: 'var(--status-success)', tint: 'rgba(46,125,79,0.10)',  border: 'rgba(46,125,79,0.45)' },
  DOC: { label: 'Documents issued', icon: <FileText className="h-4 w-4" />, solid: '#0D199E',               tint: 'rgba(13,25,158,0.10)',  border: 'rgba(13,25,158,0.40)' },
  PAY: { label: 'Payment',          icon: <Coins className="h-4 w-4" />,    solid: '#C46B14',               tint: 'rgba(255,159,64,0.16)', border: 'rgba(196,107,20,0.45)' },
  SHP: { label: 'Shipment',         icon: <Truck className="h-4 w-4" />,    solid: '#534AB7',               tint: 'rgba(83,74,183,0.12)',  border: 'rgba(83,74,183,0.40)' },
};

function computeSlots(op: Operation): Record<SlotKey, SlotState> {
  const type = op.operation_type;
  const isService = op.operation_track === 'service' || type === 'service';
  const status = op.status;

  const issued = status !== 'draft' && status !== 'cancelled';
  const shipped =
    status === 'shipped' || status === 'delivered' || op.delivery_status === 'delivered';
  const paid = (op.payment_state ?? 'neutral') === 'paid';

  // Service-track signals (now returned by the list endpoint).
  const subscription = op.partner_acceptance_required === 0;
  const hasAcc = op.has_acceptance_attachment === true;
  const hasInv = op.has_invoice_attachment === true;
  const serviceProvided = subscription ? hasAcc || hasInv : hasAcc;

  const slots: Record<SlotKey, SlotState> = { SRV: 'off', DOC: 'off', PAY: 'off', SHP: 'off' };
  const ld = (b: boolean): SlotState => (b ? 'lit' : 'dim');

  if (type === 'tax') {
    // Tax ops carry operation_track='service' in the DB, so they must be
    // matched before the service branch — a tax payment has no 'service
    // provided' stage. Documents light on issued, payment on settled.
    slots.DOC = ld(issued);
    slots.PAY = ld(paid);
  } else if (isService) {
    slots.SRV = ld(serviceProvided);
    // Option B: Documents light once the invoice is issued in the ERP
    // (status beyond draft), not only when a file is attached.
    slots.DOC = ld(hasInv || issued);
    slots.PAY = ld(paid);
  } else if (type === 'sale' || type === 'purchase') {
    slots.DOC = ld(issued);
    slots.PAY = ld(paid);
    slots.SHP = ld(shipped);
  } else if (type === 'transfer') {
    slots.DOC = ld(issued);
    slots.SHP = ld(shipped);
  }

  return slots;
}

export default function StatusStages({ op }: { op: Operation }) {
  const slots = computeSlots(op);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 30px)', gap: '6px' }}>
      {SLOT_ORDER.map((key) => {
        const state = slots[key];
        if (state === 'off') {
          return <span key={key} style={{ width: '30px', height: '30px' }} />;
        }
        const meta = SLOT_META[key];
        const lit = state === 'lit';
        return (
          <span
            key={key}
            title={`${meta.label} — ${lit ? 'done' : 'pending'}`}
            style={{
              width: '30px',
              height: '30px',
              borderRadius: '8px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: lit ? meta.tint : 'var(--paper)',
              border: `1px solid ${lit ? meta.border : 'var(--border-hairline)'}`,
              color: lit ? meta.solid : 'var(--fg-muted)',
              opacity: lit ? 1 : 0.4,
            }}
          >
            {meta.icon}
          </span>
        );
      })}
    </div>
  );
}
