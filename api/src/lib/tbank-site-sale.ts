// =============================================================================
// tbank-site-sale.ts — dasexperten.ru own-site sales, one operation per month.
//
// Owner 2026-10-07: the operation is named after how the payment came in.
// Orders on our own dasexperten.ru site (source = 'site', live since
// 2026-08-25) are paid through T-Kassa (T-Bank, formerly Tinkoff), so each
// calendar month (Moscow time) becomes TBANK-YYYYMM on partner 'tbank'.
// The older Yandex KIT storefront orders (source = 'kit') are paid through
// Yandex Pay and stay with yandex-pay-sale.ts (YANDEXKIT-…) — never counted here.
//
// Source: crm_orders_ru (the D1 mirror of the storefront feed), paid orders only.
// Owner 2026-10-07: one line per month, fixed on its LAST day (operation_date),
// with the T-Bank total; its dropdown lists every order that makes the amount.
// One payment per paid order with a fixed id (pay_tbank_<order_number>), so the
// run is idempotent on the frequent erp-ru-orders cron.
// =============================================================================
import type { Env } from '../types';

const TBANK_PARTNER_ID = 'tbank';
const TBANK_CONTRACT_ID = 'tbank_kassa_dasexperten_ru';
const TBANK_OUR_COMPANY = 'dee';
const TBANK_CURRENCY = 'RUB';
const MONTHS_BACK = 3; // current month + two before it

export interface TbankMonthResult {
  month: string;               // YYYY-MM
  orders: number;
  total_rub: number;
  operation_reference: string;
  operation_id: string | null;
  payments_added: number;
  payments_removed: number;
}

function monthsToRebuild(now: Date): Array<{ y: number; m: number }> {
  // Moscow is UTC+3 all year — month keys follow the paid_at local date.
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const out: Array<{ y: number; m: number }> = [];
  for (let i = MONTHS_BACK - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth() - i, 1));
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
  }
  return out;
}

async function rebuildOneMonth(env: Env, y: number, m: number): Promise<TbankMonthResult> {
  const mm = String(m).padStart(2, '0');
  const ym = `${y}-${mm}`;
  const reference = `TBANK-${y}${mm}`;

  const orders = (await env.DB.prepare(
    `SELECT order_number, paid_at, total_rub
     FROM crm_orders_ru
     WHERE source = 'site' AND paid = 1 AND paid_at IS NOT NULL
       AND status != 'CANCELLED' AND total_rub > 0
       AND substr(paid_at, 1, 7) = ?
     ORDER BY paid_at`
  ).bind(ym).all<{ order_number: string; paid_at: string; total_rub: number }>()).results ?? [];

  const existing = await env.DB.prepare(
    `SELECT id FROM operations WHERE reference = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(reference).first<{ id: string }>();

  if (orders.length === 0 && !existing) {
    return { month: ym, orders: 0, total_rub: 0, operation_reference: reference, operation_id: null, payments_added: 0, payments_removed: 0 };
  }

  const total = Math.round(orders.reduce((s, o) => s + (o.total_rub || 0), 0) * 100) / 100;
  const nowTs = Math.floor(Date.now() / 1000);
  const note = `[T-BANK — dasexperten.ru monthly] T-Kassa — ${ym} — ${orders.length} paid orders, total ${total.toFixed(2)} RUB`;

  let operationId: string;
  if (existing) {
    operationId = existing.id;
    await env.DB.prepare(
      `UPDATE operations SET total_amount = ?, notes = ?, operation_date = ?, updated_at = ? WHERE id = ?`
    ).bind(total, note, Math.floor(Date.UTC(y, m, 0) / 1000), nowTs, operationId).run();
  } else {
    operationId = `op_${crypto.randomUUID()}`;
    const opDate = Math.floor(Date.UTC(y, m, 0) / 1000); // last day of the month
    await env.DB.prepare(
      `INSERT INTO operations (
        id, operation_date, operation_type, partner_id, our_company_id, contract_id,
        status, currency, total_amount, notes, reference, operation_track, created_at, updated_at
      ) VALUES (?, ?, 'sale', ?, ?, ?, 'issued', ?, ?, ?, ?, 'goods', ?, ?)`
    ).bind(
      operationId, opDate, TBANK_PARTNER_ID, TBANK_OUR_COMPANY, TBANK_CONTRACT_ID,
      TBANK_CURRENCY, total, note, reference, nowTs, nowTs,
    ).run();
  }

  // A row changes only when it is new, revived or its amount moved.
  const wanted = new Set(orders.map((o) => `pay_tbank_${o.order_number}`));
  let added = 0;
  const stmts = orders.map((o) => env.DB.prepare(
    `INSERT INTO payments (id, partner_id, contract_id, operation_id, amount, currency,
                           payment_date, type, direction, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'partial', 'incoming', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       deleted_at = NULL, amount = excluded.amount, operation_id = excluded.operation_id,
       updated_at = excluded.updated_at
     WHERE payments.deleted_at IS NOT NULL OR payments.amount != excluded.amount
        OR payments.operation_id IS NOT excluded.operation_id`
  ).bind(
    `pay_tbank_${o.order_number}`, TBANK_PARTNER_ID, TBANK_CONTRACT_ID, operationId,
    o.total_rub, TBANK_CURRENCY, Math.floor(Date.parse(o.paid_at) / 1000),
    `T-Kassa · order ${o.order_number}`,
    nowTs, nowTs,
  ));
  for (let i = 0; i < stmts.length; i += 50) {
    const res = await env.DB.batch(stmts.slice(i, i + 50));
    for (const r of res) added += r.meta?.changes ?? 0;
  }

  // An order that stopped qualifying (cancelled, refunded) loses its payment.
  const current = (await env.DB.prepare(
    `SELECT id FROM payments WHERE operation_id = ? AND deleted_at IS NULL AND id LIKE 'pay_tbank_%'`
  ).bind(operationId).all<{ id: string }>()).results ?? [];
  let removed = 0;
  for (const p of current) {
    if (wanted.has(p.id)) continue;
    await env.DB.prepare(`UPDATE payments SET deleted_at = ?, updated_at = ? WHERE id = ?`)
      .bind(nowTs, nowTs, p.id).run();
    removed++;
  }

  return { month: ym, orders: orders.length, total_rub: total, operation_reference: reference, operation_id: operationId, payments_added: added, payments_removed: removed };
}

// Rebuild the last MONTHS_BACK months. Cheap: a few dozen orders a month.
export async function rebuildTbankSiteSales(env: Env, now = new Date()): Promise<TbankMonthResult[]> {
  const out: TbankMonthResult[] = [];
  for (const { y, m } of monthsToRebuild(now)) out.push(await rebuildOneMonth(env, y, m));
  return out;
}
