// =============================================================================
// Packing figures for the invoice-specification (IS-V1 / IS-V2).
// The operation's packing_details is the factory's word on cartons and weights;
// product cards are only the fallback. The PL already read the override, the IS
// did not, so a corrected PL sat next to an IS with the old card weights
// (Owner 09.10.2026, IS-YZJX-26100901: 4 584 kg on the IS against 4 994 kg from
// the factory).
// =============================================================================

import type { LineItemRow, PackingDetails } from '../types';

export interface PackedLine {
  cartons: number;
  netKg: number | null;
  grossKg: number | null;
}

export interface PackedTotals {
  netKg: number | null;
  grossKg: number | null;
}

export function packedLine(li: LineItemRow, packing?: PackingDetails): PackedLine {
  const override = packing?.lines?.[li.product_id];
  const perCtn = override?.qty_per_carton ?? li.ctn_qty ?? 0;
  const cartons = override?.cartons
    ?? (li.cartons > 0 ? li.cartons : (perCtn > 0 ? Math.ceil(li.qty / perCtn) : 0));
  const netKg = override?.net_weight_kg
    ?? (li.unit_net_weight_g !== null ? (li.qty * li.unit_net_weight_g) / 1000 : null);
  const grossKg = override?.gross_weight_kg
    ?? (li.ctn_weight_gross_kg !== null && cartons > 0 ? cartons * li.ctn_weight_gross_kg : null);
  return { cartons, netKg, grossKg };
}

/** Totals row: the factory's stated totals win; otherwise the sum when every line is known. */
export function packedTotals(lines: PackedLine[], packing?: PackingDetails): PackedTotals {
  const allNet = lines.every((l) => l.netKg !== null);
  const allGross = lines.every((l) => l.grossKg !== null);
  return {
    netKg: packing?.totals?.net_weight_kg
      ?? (allNet ? lines.reduce((s, l) => s + (l.netKg ?? 0), 0) : null),
    grossKg: packing?.totals?.gross_weight_kg
      ?? (allGross ? lines.reduce((s, l) => s + (l.grossKg ?? 0), 0) : null),
  };
}
