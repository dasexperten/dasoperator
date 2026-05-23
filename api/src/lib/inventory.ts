// =============================================================================
// Inventory write primitives — atomic stock movement + balance update
//
// Used by:
//   - POST /api/stock-movements (manual movements)
//   - POST /api/inventory-sessions/:id/commit (session corrections)
//   - Future: PATCH /api/operations/:id/status (auto-movements)
// =============================================================================

export interface MovementInput {
  warehouse_id: string;
  product_id: string;
  movement_type:
    | 'receipt' | 'shipment' | 'transfer_in' | 'transfer_out'
    | 'adjustment' | 'session_correction' | 'sync_correction'
    | 'opening_balance' | 'write_off' | 'return';
  quantity: number;            // signed; +receipt/+transfer_in etc, -shipment/-write_off
  source:
    | 'manual' | 'operation' | 'session'
    | 'sync_wb' | 'sync_ozon' | 'sync_3pl' | 'sync_api'
    | 'cron' | 'opening';
  source_ref_type?: string | null;
  source_ref_id?: string | null;
  reason?: string | null;
  notes?: string | null;
  performed_by?: string | null;
  performed_at?: number;       // unix; defaults to now
  stock_state?: 'on_hand' | 'in_production' | 'in_transit';
}

export interface MovementResult {
  movement_id: string;
  balance_after: number;
  warehouse_id: string;
  product_id: string;
  quantity: number;
}

// Movement_type → fixed sign expectation. null = either sign accepted.
const SIGN_RULES: Record<MovementInput['movement_type'], 'pos' | 'neg' | null> = {
  receipt:           'pos',
  transfer_in:       'pos',
  opening_balance:   'pos',
  return:            'pos',
  shipment:          'neg',
  transfer_out:      'neg',
  write_off:         'neg',
  adjustment:        null,
  session_correction:'null' as never, // typed below
  sync_correction:   null,
} as Record<MovementInput['movement_type'], 'pos' | 'neg' | null>;

// Re-set the typo'd entry
SIGN_RULES.session_correction = null;

export function validateSign(input: MovementInput): string | null {
  const rule = SIGN_RULES[input.movement_type];
  if (rule === 'pos' && input.quantity <= 0) {
    return `${input.movement_type} requires positive quantity`;
  }
  if (rule === 'neg' && input.quantity >= 0) {
    return `${input.movement_type} requires negative quantity`;
  }
  if (input.quantity === 0) {
    return 'quantity must be non-zero';
  }
  return null;
}

// =============================================================================
// applyMovement — UPSERT stocks + INSERT stock_movements with balance_after
//
// Two sequential statements (D1 serializes by DB; race window microseconds).
// Future: wrap in true transaction when D1 supports BEGIN/COMMIT.
// =============================================================================
export async function applyMovement(
  db: D1Database,
  input: MovementInput
): Promise<MovementResult> {
  const now = input.performed_at ?? Math.floor(Date.now() / 1000);
  const stockId = `stk_${crypto.randomUUID()}`;

  // Step 1: UPSERT stocks, RETURNING the new on_hand (atomic per statement)
  // stocks UNIQUE constraint covers (warehouse_id, product_id, stock_state),
  // so ON CONFLICT must include all three; otherwise SQLite rejects with
  // 'ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint'.
  const stockState = input.stock_state ?? 'on_hand';
  const upsertResult = await db.prepare(`
    INSERT INTO stocks (id, warehouse_id, product_id, stock_state, on_hand, last_movement_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (warehouse_id, product_id, stock_state) DO UPDATE
    SET on_hand = stocks.on_hand + excluded.on_hand,
        last_movement_at = excluded.last_movement_at,
        updated_at = excluded.updated_at
    RETURNING on_hand
  `).bind(
    stockId, input.warehouse_id, input.product_id, stockState,
    input.quantity, now, now
  ).first<{ on_hand: number }>();

  if (!upsertResult) {
    throw new Error('UPSERT stocks returned no result');
  }
  const balanceAfter = upsertResult.on_hand;

  // Step 2: INSERT stock_movements with computed balance_after
  const movementId = `mov_${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO stock_movements (
      id, warehouse_id, product_id, movement_type, quantity, source,
      source_ref_type, source_ref_id, reason, notes,
      performed_by, performed_at, balance_after, stock_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    movementId, input.warehouse_id, input.product_id,
    input.movement_type, input.quantity, input.source,
    input.source_ref_type ?? null, input.source_ref_id ?? null,
    input.reason ?? null, input.notes ?? null,
    input.performed_by ?? null, now, balanceAfter, stockState, now
  ).run();

  return {
    movement_id: movementId,
    balance_after: balanceAfter,
    warehouse_id: input.warehouse_id,
    product_id: input.product_id,
    quantity: input.quantity,
  };
}
