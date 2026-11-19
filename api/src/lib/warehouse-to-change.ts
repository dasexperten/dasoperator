// Manual change of a purchase/transfer destination warehouse (Owner 19.11.2026).
//
// A shipment can be booked to one warehouse and physically land in another
// (HHUI-26073001: booked to LBR, received in Saransk). Before goods arrive the
// change is just the operation field. After arrival the stock already sits on
// the old warehouse, so the change is posted as a correction pair dated at the
// original arrival: minus on the old warehouse, plus on the new one. History is
// never rewritten; refusing is better than driving the old warehouse negative.

export interface ArrivalRow {
  product_id: string;
  quantity: number;
  performed_at: number;
}

export interface CorrectionSpec {
  warehouseId: string;
  productId: string;
  movementType: 'arrival' | 'transfer_in';
  qty: number;
  reason: 'destination_corrected_out' | 'destination_corrected_in';
  performedAt: number;
}

export interface Shortage {
  product_id: string;
  on_hand: number;
  needed: number;
}

export function planDestinationChange(input: {
  fromWarehouseId: string;
  toWarehouseId: string;
  movementType: 'arrival' | 'transfer_in';
  arrivals: ArrivalRow[];
  oldOnHand: Record<string, number>;
}): { specs: CorrectionSpec[]; shortages: Shortage[] } {
  // Net per product: earlier corrections already moved some arrivals away.
  const net = new Map<string, { qty: number; at: number }>();
  for (const a of input.arrivals) {
    const cur = net.get(a.product_id) ?? { qty: 0, at: a.performed_at };
    cur.qty += a.quantity;
    if (a.quantity > 0) cur.at = a.performed_at;
    net.set(a.product_id, cur);
  }

  const specs: CorrectionSpec[] = [];
  const shortages: Shortage[] = [];
  for (const [productId, { qty, at }] of net) {
    if (qty <= 0) continue;
    const onHand = input.oldOnHand[productId] ?? 0;
    if (onHand < qty) {
      shortages.push({ product_id: productId, on_hand: onHand, needed: qty });
      continue;
    }
    specs.push({ warehouseId: input.fromWarehouseId, productId, movementType: input.movementType,
      qty: -qty, reason: 'destination_corrected_out', performedAt: at });
    specs.push({ warehouseId: input.toWarehouseId, productId, movementType: input.movementType,
      qty, reason: 'destination_corrected_in', performedAt: at });
  }
  return { specs, shortages };
}
