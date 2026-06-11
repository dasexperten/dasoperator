// =============================================================================
// Loyalty Engine — «Клуб Экспертов» (Phase 10.0, замена RetailCRM)
// Spec: CoWork/PROJECTS/loyalty-program/kit-loyalty-engine-spec.md
//
// Уровни (lifetime_spent, ₽ товаров без доставки, по завершённым заказам):
//   Свой        0+      → 5%
//   Ценитель    10 000+ → 10%
//   Эксперт     25 000+ → 15%
//   Амбассадор  50 000+ → 20%
// 1 балл = 1 ₽. Hold начисления 7 дней (защита от возвратов).
// Источник заказов: Yandex KIT API. Вебхук: ORDER_STATUS_CHANGED.
// =============================================================================
import type { Env } from '../types';

export const TIERS = [
  { key: 'ambassador', threshold: 50000, percent: 20 },
  { key: 'expert', threshold: 25000, percent: 15 },
  { key: 'tsenitel', threshold: 10000, percent: 10 },
  { key: 'svoy', threshold: 0, percent: 5 },
] as const;

export type TierKey = (typeof TIERS)[number]['key'];

export const HOLD_DAYS = 7;
export const POINTS_LIFETIME_DAYS = 365;

// Начисляем на этих статусах. DELIVERED — с hold 7 дней; COMPLETED — hold уже
// не нужен (заказ финален), активируем сразу.
const ACCRUAL_STATUSES = new Set(['DELIVERED', 'COMPLETED']);
// Снимаем начисление, если заказ откатился.
const REVERSAL_STATUSES = new Set(['CANCELLED', 'FULL_REFUND', 'DELIVERY_CANCELLED']);

export function tierFor(lifetimeSpent: number): { key: TierKey; percent: number } {
  for (const t of TIERS) {
    if (lifetimeSpent >= t.threshold) return { key: t.key, percent: t.percent };
  }
  return { key: 'svoy', percent: 5 };
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = '+' + digits.slice(1).replace(/\D/g, '');
  else digits = digits.replace(/\D/g, '');
  if (!digits) return null;
  // RU normalization: 8XXXXXXXXXX → +7XXXXXXXXXX
  if (/^8\d{10}$/.test(digits)) return '+7' + digits.slice(1);
  if (/^7\d{10}$/.test(digits)) return '+' + digits;
  if (digits.startsWith('+')) return digits;
  return '+' + digits;
}

// -----------------------------------------------------------------------------
// KIT API client
// -----------------------------------------------------------------------------
const KIT_API_BASE = 'https://api.kit.yandex.net/v1';

export async function kitGet<T = any>(env: Env, path: string): Promise<T> {
  const res = await fetch(`${KIT_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${env.YANDEX_KIT_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`KIT API ${res.status} on ${path}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface KitOrder {
  id: string;
  order_number: number;
  status: string;
  purchased_price: string; // сумма товаров после скидок, без доставки
  total_final_price: string;
  client?: { phone?: string; email?: string; first_name?: string; last_name?: string };
  created_at?: string;
}

// -----------------------------------------------------------------------------
// Account upsert by phone
// -----------------------------------------------------------------------------
export async function upsertAccount(
  env: Env,
  args: { phone: string; email?: string | null; name?: string | null; kitCustomerId?: string | null }
): Promise<{ id: string; balance: number; pending_balance: number; lifetime_spent: number; tier: string }> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare(
    'SELECT id, balance, pending_balance, lifetime_spent, tier FROM loyalty_accounts WHERE phone = ?'
  )
    .bind(args.phone)
    .first<{ id: string; balance: number; pending_balance: number; lifetime_spent: number; tier: string }>();

  if (existing) {
    await env.DB.prepare(
      `UPDATE loyalty_accounts SET
         email = COALESCE(?, email), name = COALESCE(?, name),
         kit_customer_id = COALESCE(?, kit_customer_id),
         last_activity_at = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(args.email ?? null, args.name ?? null, args.kitCustomerId ?? null, now, now, existing.id)
      .run();
    return existing;
  }

  const id = 'la_' + crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO loyalty_accounts
       (id, phone, email, name, kit_customer_id, balance, pending_balance, lifetime_spent,
        tier, status, source, registered_at, last_activity_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'svoy', 'active', 'kit', ?, ?, ?, ?)`
  )
    .bind(id, args.phone, args.email ?? null, args.name ?? null, args.kitCustomerId ?? null, now, now, now, now)
    .run();
  return { id, balance: 0, pending_balance: 0, lifetime_spent: 0, tier: 'svoy' };
}

// -----------------------------------------------------------------------------
// Core: process an order event (from webhook or manual reprocess).
// Fetches the order from KIT (source of truth), decides accrual / reversal.
// Idempotent: unique index on (kit_order_id) for type='accrual'.
// -----------------------------------------------------------------------------
export async function processOrderEvent(
  env: Env,
  orderId: string
): Promise<{ action: string; details?: Record<string, unknown> }> {
  const order = await kitGet<KitOrder>(env, `/orders/${orderId}`);
  const now = Math.floor(Date.now() / 1000);

  if (REVERSAL_STATUSES.has(order.status)) {
    // откат начисления, если было и ещё не отменено
    const tx = await env.DB.prepare(
      `SELECT id, account_id, points, status FROM loyalty_transactions
       WHERE kit_order_id = ? AND type = 'accrual' AND status IN ('pending','active')`
    )
      .bind(order.id)
      .first<{ id: string; account_id: string; points: number; status: string }>();
    if (!tx) return { action: 'skipped:no_accrual_to_reverse', details: { status: order.status } };

    const balanceCol = tx.status === 'pending' ? 'pending_balance' : 'balance';
    await env.DB.batch([
      env.DB.prepare(`UPDATE loyalty_transactions SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(now, tx.id),
      env.DB.prepare(
        `UPDATE loyalty_accounts SET ${balanceCol} = MAX(0, ${balanceCol} - ?),
           lifetime_spent = MAX(0, lifetime_spent - (SELECT COALESCE(order_amount,0) FROM loyalty_transactions WHERE id = ?)),
           updated_at = ? WHERE id = ?`
      ).bind(tx.points, tx.id, now, tx.account_id),
    ]);
    await recomputeTier(env, tx.account_id);
    return { action: 'reversed', details: { points: tx.points, order_status: order.status } };
  }

  if (!ACCRUAL_STATUSES.has(order.status)) {
    return { action: 'skipped:status_not_final', details: { status: order.status } };
  }

  const phone = normalizePhone(order.client?.phone);
  if (!phone) return { action: 'skipped:no_phone' };

  const goodsAmount = Math.round(parseFloat(order.purchased_price || '0'));
  if (!goodsAmount || goodsAmount <= 0) return { action: 'skipped:zero_amount' };

  const name = [order.client?.first_name, order.client?.last_name].filter(Boolean).join(' ') || null;
  const account = await upsertAccount(env, { phone, email: order.client?.email ?? null, name });

  // процент уровня считается ПО ТЕКУЩЕМУ уровню (до зачёта этого заказа)
  const tier = tierFor(account.lifetime_spent);
  const points = Math.floor((goodsAmount * tier.percent) / 100);
  if (points <= 0) return { action: 'skipped:zero_points' };

  // COMPLETED — активируем сразу; DELIVERED — hold 7 дней
  const instant = order.status === 'COMPLETED';
  const holdUntil = instant ? null : now + HOLD_DAYS * 86400;
  const txId = 'lt_' + crypto.randomUUID();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO loyalty_transactions
           (id, account_id, type, points, status, kit_order_id, kit_order_number,
            order_amount, cashback_percent, hold_until, note, created_at, updated_at)
         VALUES (?, ?, 'accrual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        txId, account.id, points, instant ? 'active' : 'pending', order.id, order.order_number,
        goodsAmount, tier.percent, holdUntil,
        `Кешбэк ${tier.percent}% (${tier.key}) за заказ №${order.order_number}`, now, now
      ),
      env.DB.prepare(
        `UPDATE loyalty_accounts SET
           ${instant ? 'balance = balance + ?' : 'pending_balance = pending_balance + ?'},
           lifetime_spent = lifetime_spent + ?,
           last_activity_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(points, goodsAmount, now, now, account.id),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE')) return { action: 'skipped:already_accrued', details: { order_id: order.id } };
    throw err;
  }

  await recomputeTier(env, account.id);
  return {
    action: 'accrued',
    details: { phone, points, percent: tier.percent, tier: tier.key, order_number: order.order_number, hold_until: holdUntil, instant },
  };
}

export async function recomputeTier(env: Env, accountId: string): Promise<void> {
  const acc = await env.DB.prepare('SELECT lifetime_spent, tier FROM loyalty_accounts WHERE id = ?')
    .bind(accountId)
    .first<{ lifetime_spent: number; tier: string }>();
  if (!acc) return;
  const t = tierFor(acc.lifetime_spent);
  if (t.key !== acc.tier) {
    await env.DB.prepare('UPDATE loyalty_accounts SET tier = ?, updated_at = ? WHERE id = ?')
      .bind(t.key, Math.floor(Date.now() / 1000), accountId)
      .run();
  }
}

// -----------------------------------------------------------------------------
// Activate accruals whose 7-day hold has passed: pending → active.
// Called from cron (and available via admin route).
// -----------------------------------------------------------------------------
export async function activateExpiredHolds(env: Env): Promise<{ activated: number }> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    `SELECT id, account_id, points FROM loyalty_transactions
     WHERE type = 'accrual' AND status = 'pending' AND hold_until IS NOT NULL AND hold_until <= ?`
  )
    .bind(now)
    .all<{ id: string; account_id: string; points: number }>();

  let activated = 0;
  for (const tx of rows.results ?? []) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE loyalty_transactions SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending'`).bind(now, tx.id),
      env.DB.prepare(
        `UPDATE loyalty_accounts SET pending_balance = MAX(0, pending_balance - ?), balance = balance + ?, updated_at = ? WHERE id = ?`
      ).bind(tx.points, tx.points, now, tx.account_id),
    ]);
    activated++;
  }
  return { activated };
}
