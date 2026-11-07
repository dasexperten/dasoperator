// A stock balance is not a receipt for a shipment (Owner 2026-11-07).
// Neither pooled marketplace stocks nor the F4 SKU-overlap suggestion can
// establish that this operation arrived. The current integrations expose no
// authoritative receipt tied to an individual shipped purchase/transfer.
// Keep those operations in transit for the existing human confirmation path.
// Do not turn an F4 acceptance's imported_op_id into proof: that identifies a
// separate already-posted operation and would risk posting its receipt twice.

import type { Env } from './types';

interface ShippedPurchase {
  id: string;
}

export interface AutoDeliveryResult {
  scanned: number;
  delivered: string[];
  skipped: Array<{ id: string; reason: string }>;
  evidence_policy: 'shipment_receipt_required_manual_confirmation_only';
  awaiting_confirmation: number;
}

export async function runAutoDeliverySweep(env: Env): Promise<AutoDeliveryResult> {
  const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;
  const candidates = await env.DB.prepare(`
    SELECT o.id
    FROM operations o
    JOIN warehouses w ON w.id = o.warehouse_to_id
    WHERE o.status = 'shipped'
      AND o.operation_type IN ('purchase', 'transfer')
      AND o.deleted_at IS NULL
      AND o.updated_at >= ?
      AND EXISTS (
        SELECT 1 FROM stock_movements m
        WHERE m.source_ref_id = o.id
          AND m.movement_type = 'in_transit_in'
      )
  `).bind(ninetyDaysAgo).all<ShippedPurchase>();

  return {
    scanned: candidates.results.length,
    evidence_policy: 'shipment_receipt_required_manual_confirmation_only',
    awaiting_confirmation: candidates.results.length,
    delivered: [],
    skipped: candidates.results.map(op => ({ id: op.id, reason: 'shipment_receipt_not_confirmed' })),
  };
}
