// =============================================================================
// stripe-month-date.ts — date each STRIPE-YYYYMM line by the month's last order.
//
// Owner 2026-10-08: a monthly line sits on the day of its LAST ORDER, not on the
// calendar's last day. For dasexperten.com that is the latest paid order placed
// in that month (crm_orders, UTC month — the same orders its dropdown lists).
// A month with no paid order falls back to its latest Stripe payout, then keeps
// the date it has. Only rows whose date actually moves are written.
// =============================================================================
import type { Env } from '../types';

export async function refreshStripeMonthDates(env: Env): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT o.id, o.operation_date AS cur,
            COALESCE(
              (SELECT MAX(c.placed_at) FROM crm_orders c
                WHERE c.financial_status = 'paid'
                  AND strftime('%Y%m', c.placed_at, 'unixepoch') = substr(o.reference, 8, 6)),
              (SELECT MAX(p.payment_date) FROM payments p
                WHERE p.operation_id = o.id AND p.deleted_at IS NULL),
              o.operation_date) AS want
       FROM operations o
      WHERE o.reference LIKE 'STRIPE-%' AND o.deleted_at IS NULL`
  ).all<{ id: string; cur: number; want: number }>()).results ?? [];
  const nowTs = Math.floor(Date.now() / 1000);
  const moves = rows.filter((r) => r.want !== r.cur);
  if (moves.length) {
    await env.DB.batch(moves.map((r) => env.DB.prepare(
      `UPDATE operations SET operation_date = ?, updated_at = ? WHERE id = ?`
    ).bind(r.want, nowTs, r.id)));
  }
  return moves.length;
}
