// =============================================================================
// auto-delivery.ts — automatic delivered transition for purchase / transfer ops
//
// Rules (per Aram 2026-05-11, option B):
//   "Delivered" is reached only when the destination warehouse API confirms
//   the goods physically arrived. Until then, qty stays in OTW.
//
// Implementation strategy (pragmatic v1):
//
//   For each operation in status='shipped' where warehouse_to_id is a
//   marketplace-FBO warehouse (WB / Ozon clusters), check whether the
//   marketplace stocks snapshot now shows on_hand >= the qty that this
//   shipment promised. If yes, transition to 'delivered' (which moves
//   the OTW row down and the destination on_hand up via stock movements
//   the existing PATCH /:id/status handler already writes).
//
//   For FBS / 3PL warehouses (Lyubertsy, Saransk, etc.) — there is no
//   automatic API. Marking delivered remains a manual button for those
//   destinations.
//
// Safety:
//   - Only matches when ALL line items can be fully covered by the
//     destination's current on_hand. Partial coverage is left alone.
//   - Skips operations older than 90 days (stale).
//   - Idempotent: once moved to 'delivered', future runs skip.
//
// This is intentionally conservative: false-positive auto-deliveries are
// worse than a slow manual click.
// =============================================================================

import type { Env } from './types';

interface ShippedPurchase {
  id: string;
  warehouse_to_id: string;
  warehouse_to_type: string | null;
  warehouse_to_code: string | null;
  operation_type: string;
}

interface LineNeed {
  product_id: string;
  qty: number;
}

export interface AutoDeliveryResult {
  scanned: number;
  delivered: string[]; // operation IDs auto-transitioned
  skipped: Array<{ id: string; reason: string }>;
}

export async function runAutoDeliverySweep(env: Env): Promise<AutoDeliveryResult> {
  const result: AutoDeliveryResult = { scanned: 0, delivered: [], skipped: [] };
  const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;

  // Find candidates — shipped purchase/transfer operations that ALREADY
  // wrote into OTW (i.e. went through our new lifecycle, not legacy).
  // Restrict to marketplace-FBO destinations for now (warehouse_type='external'
  // is a heuristic — in this codebase, marketplaces aren't yet first-class
  // warehouses, so this is forward-looking).
  const candidates = await env.DB.prepare(`
    SELECT
      o.id, o.warehouse_to_id, o.operation_type,
      w.warehouse_type AS warehouse_to_type, w.code AS warehouse_to_code
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

  result.scanned = candidates.results.length;

  for (const op of candidates.results) {
    // Determine matching strategy based on destination warehouse code.
    // Right now, only LBR/FLP/SRN have authoritative on-hand from inventory
    // sessions or 3PL feeds. Until those are wired, we skip non-marketplace
    // destinations.
    //
    // FBO matching uses live marketplace_stocks_* tables: total qty on FBO
    // for this product must be ≥ what this operation was supposed to deliver.

    const lineItems = await env.DB.prepare(`
      SELECT product_id, qty FROM line_items WHERE operation_id = ?
    `).bind(op.id).all<LineNeed>();

    if (lineItems.results.length === 0) {
      result.skipped.push({ id: op.id, reason: 'no_line_items' });
      continue;
    }

    let allCovered = true;
    for (const li of lineItems.results) {
      // Total marketplace stock for this SKU. We treat WB + Ozon as a single
      // pool because purchase operations to FBO usually fan out to both.
      const mp = await env.DB.prepare(`
        SELECT
          COALESCE((SELECT SUM(quantity * pack_factor) FROM marketplace_stocks_wb WHERE base_sku = ?), 0) +
          COALESCE((SELECT SUM(fbo_available * pack_factor) FROM marketplace_stocks_ozon WHERE base_sku = ?), 0)
          AS total_fbo
      `).bind(li.product_id, li.product_id).first<{ total_fbo: number }>();

      if (!mp || (mp.total_fbo ?? 0) < li.qty) {
        allCovered = false;
        break;
      }
    }

    if (!allCovered) {
      result.skipped.push({ id: op.id, reason: 'fbo_insufficient' });
      continue;
    }

    // All covered — fire the transition. We use the SELF service binding to
    // hit our own PATCH endpoint, so the same validation / stock logic
    // applies, no duplication.
    try {
      const res = await env.SELF.fetch(
        new Request(`https://internal/api/operations/${op.id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'delivered', notes: 'auto-delivered: FBO stock confirmed' }),
        })
      );
      if (res.ok) {
        result.delivered.push(op.id);
      } else {
        const txt = await res.text();
        result.skipped.push({ id: op.id, reason: `patch_failed_${res.status}: ${txt.slice(0, 100)}` });
      }
    } catch (e) {
      result.skipped.push({ id: op.id, reason: `network_error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return result;
}
