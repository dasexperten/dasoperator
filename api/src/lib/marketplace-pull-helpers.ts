// ============================================================================
// marketplace-pull-helpers.ts
// ----------------------------------------------------------------------------
// Backfill helpers for monthly site-sales operations. Wraps the
// rebuildPriorMonthDasexpertenCom logic to operate on an explicit month range
// rather than only the previous calendar month.
// ============================================================================

import type { Env } from '../types';

const DASCOM_PARTNER_ID = 'dasexperten_com';
const DASCOM_CONTRAGENT_NAMES = ['NETWORK INTERNATIONAL LLC'];

export interface MonthRebuildResult {
  target_month: string;
  bank_tx_count: number;
  total_amount: number;
  operation_id: string;
  operation_reference: string;
  payments_created: number;
}

/**
 * Build/rebuild a single month for dasexperten.com. Internal helper.
 */
async function rebuildOneMonthDasexpertenCom(
  env: Env,
  year: number,
  monthIdx: number, // 0-11
): Promise<MonthRebuildResult> {
  const month = String(monthIdx + 1).padStart(2, '0');
  const targetYM = `${year}-${month}`;
  const startTs = Math.floor(Date.UTC(year, monthIdx, 1) / 1000);
  const endTs = Math.floor(Date.UTC(year, monthIdx + 1, 1) / 1000);

  const nameList = DASCOM_CONTRAGENT_NAMES.map(() => '?').join(',');
  const txnsResult = await env.DB.prepare(
    `SELECT id, executed_at, amount, currency
     FROM bank_transactions
     WHERE contragent_name IN (${nameList})
       AND contragent_inn IS NULL
       AND direction = 'incoming'
       AND deleted_at IS NULL
       AND executed_at >= ?
       AND executed_at < ?
     ORDER BY executed_at`,
  ).bind(...DASCOM_CONTRAGENT_NAMES, startTs, endTs).all<{
    id: string; executed_at: number; amount: number; currency: string;
  }>();

  const txns = txnsResult.results;
  const totalMinor = txns.reduce((s, t) => s + (t.amount || 0), 0);
  const totalAmount = Math.round(totalMinor) / 100;
  const reference = `DASCOM-${year}${month}`;

  // Skip month if no txns at all
  if (txns.length === 0) {
    return {
      target_month: targetYM,
      bank_tx_count: 0,
      total_amount: 0,
      operation_id: '',
      operation_reference: reference,
      payments_created: 0,
    };
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM operations WHERE reference = ? AND deleted_at IS NULL LIMIT 1`,
  ).bind(reference).first<{ id: string }>();

  const nowTs = Math.floor(Date.now() / 1000);
  let operationId: string;

  if (existing) {
    operationId = existing.id;
    await env.DB.prepare(
      `UPDATE operations
       SET total_amount = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(
      totalAmount,
      `[CONSOLIDATED — dasexperten.com monthly] Stripe via Wio Bank — ${targetYM} — ${txns.length} payments, total ${totalAmount.toFixed(2)} AED (backfill ${new Date().toISOString().slice(0, 10)})`,
      nowTs,
      operationId,
    ).run();
  } else {
    operationId = `op_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO operations (
        id, operation_date, operation_type, partner_id, our_company_id,
        status, currency, total_amount, notes,
        reference, delivery_status, operation_track, created_at, updated_at
      ) VALUES (?, ?, 'sale', ?, 'dei', 'issued', 'AED', ?, ?, ?, 'delivered', 'goods', ?, ?)`,
    ).bind(
      operationId, startTs, DASCOM_PARTNER_ID, totalAmount,
      `[CONSOLIDATED — dasexperten.com monthly] Stripe via Wio Bank — ${targetYM} — ${txns.length} payments, total ${totalAmount.toFixed(2)} AED (backfill)`,
      reference, nowTs, nowTs,
    ).run();
  }

  // Unmatch and remove old payments for clean rebuild
  await env.DB.prepare(
    `UPDATE bank_transactions
     SET matched_operation_id = NULL, matched_payment_id = NULL, matched_at = NULL, match_method = NULL
     WHERE matched_operation_id = ?`,
  ).bind(operationId).run();
  await env.DB.prepare(
    `UPDATE payments SET deleted_at = ? WHERE operation_id = ? AND deleted_at IS NULL`,
  ).bind(nowTs, operationId).run();

  // Re-link
  let paymentsCreated = 0;
  for (const tx of txns) {
    const amtMajor = tx.amount / 100;
    const paymentId = `pay_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO payments (id, partner_id, contract_id, operation_id, amount, currency,
                               payment_date, type, direction, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'partial', 'incoming', ?, ?, ?)`,
      ).bind(
        paymentId, DASCOM_PARTNER_ID, 'placeholder_dasexperten_com_aed', operationId,
        amtMajor, tx.currency, tx.executed_at,
        `[AUTO-MATCH dasexperten-com-monthly] bank_tx ${tx.id} → ${reference}`,
        nowTs, nowTs,
      ),
      env.DB.prepare(
        `UPDATE bank_transactions
         SET matched_operation_id = ?, matched_payment_id = ?, matched_at = ?,
             match_method = 'matched_by_dasexperten_com_monthly', matched_by = 'system_auto', updated_at = ?
         WHERE id = ?`,
      ).bind(operationId, paymentId, nowTs, nowTs, tx.id),
    ]);
    paymentsCreated++;
  }

  return {
    target_month: targetYM,
    bank_tx_count: txns.length,
    total_amount: totalAmount,
    operation_id: operationId,
    operation_reference: reference,
    payments_created: paymentsCreated,
  };
}

/**
 * Backfill range of months for dasexperten.com. Inclusive on both ends.
 * Format: "YYYY-MM".
 */
export async function rebuildPriorMonthDasexpertenComForRange(
  env: Env,
  fromYM: string,
  toYM: string,
): Promise<MonthRebuildResult[]> {
  const [fy, fm] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  const results: MonthRebuildResult[] = [];
  let curY = fy;
  let curM = fm - 1; // 0-indexed
  const endY = ty;
  const endM = tm - 1;
  while (curY < endY || (curY === endY && curM <= endM)) {
    const r = await rebuildOneMonthDasexpertenCom(env, curY, curM);
    results.push(r);
    curM++;
    if (curM > 11) {
      curM = 0;
      curY++;
    }
  }
  return results;
}
