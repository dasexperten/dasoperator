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

export async function kitPost<T = any>(env: Env, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${KIT_API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.YANDEX_KIT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`KIT API ${res.status} on POST ${path}: ${(await res.text()).slice(0, 300)}`);
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
  const id = 'la_' + crypto.randomUUID();
  // Atomic upsert by phone. Previous read-then-write (SELECT, then INSERT or
  // UPDATE) raced: two concurrent ORDER_STATUS_CHANGED webhooks for the same
  // new phone both saw "not found" and both INSERTed -> "UNIQUE constraint
  // failed: loyalty_accounts.phone", dropping the accrual. ON CONFLICT makes
  // insert-or-update a single statement, so the second caller updates instead
  // of crashing. Balance / tier / lifetime are untouched on conflict.
  const row = await env.DB.prepare(
    `INSERT INTO loyalty_accounts
       (id, phone, email, name, kit_customer_id, balance, pending_balance, lifetime_spent,
        tier, status, source, registered_at, last_activity_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 'svoy', 'active', 'kit', ?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET
       email = COALESCE(excluded.email, loyalty_accounts.email),
       name = COALESCE(excluded.name, loyalty_accounts.name),
       kit_customer_id = COALESCE(excluded.kit_customer_id, loyalty_accounts.kit_customer_id),
       last_activity_at = excluded.last_activity_at,
       updated_at = excluded.updated_at
     RETURNING id, balance, pending_balance, lifetime_spent, tier`
  )
    .bind(id, args.phone, args.email ?? null, args.name ?? null, args.kitCustomerId ?? null, now, now, now, now)
    .first<{ id: string; balance: number; pending_balance: number; lifetime_spent: number; tier: string }>();
  return row!;
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
// Redemption: списание баллов → персональный одноразовый промокод KIT.
// Правило «до 50% заказа» обеспечивается minimum_order_amount = 2×amount.
// Код живёт REDEEM_TTL_HOURS; неиспользованный истёкший → возврат баллов.
// -----------------------------------------------------------------------------
export const REDEEM_TTL_HOURS = 48;
export const REDEEM_MIN_POINTS = 50;

function genCode(): string {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const pick = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => abc[b % abc.length]).join('');
  return `DAS-${pick(4)}-${pick(2)}`;
}

export async function createRedemption(
  env: Env,
  phone: string,
  amount: number
): Promise<
  | { ok: true; code: string; amount: number; expires_at: number; email: string | null }
  | { ok: false; error: string }
> {
  const now = Math.floor(Date.now() / 1000);
  const acc = await env.DB.prepare(
    'SELECT id, balance, email FROM loyalty_accounts WHERE phone = ? AND status = ?'
  )
    .bind(phone, 'active')
    .first<{ id: string; balance: number; email: string | null }>();
  if (!acc) return { ok: false, error: 'account_not_found' };
  if (!Number.isInteger(amount) || amount < REDEEM_MIN_POINTS) return { ok: false, error: 'amount_too_small' };
  if (amount > acc.balance) return { ok: false, error: 'insufficient_balance' };

  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM loyalty_redemptions WHERE account_id = ? AND status = 'issued' AND expires_at > ?`
  )
    .bind(acc.id, now)
    .first<{ c: number }>();
  if ((open?.c ?? 0) > 0) return { ok: false, error: 'active_code_exists' };

  const code = genCode();
  const expiresAt = now + REDEEM_TTL_HOURS * 3600;
  const promo = await kitPost<{ id: string }>(env, '/promocodes', {
    code,
    title: `Списание баллов Клуба Экспертов (${amount} ₽)`,
    discount_value: { type: 'VALUE', value: String(amount) },
    promocode_dates: {
      start_date: new Date(now * 1000).toISOString(),
      end_date: new Date(expiresAt * 1000).toISOString(),
    },
    type: 'ORDER',
    minimum_order_amount: String(amount * 2),
    max_usage: 1,
    one_time_use: true,
    first_order_only: false,
  });

  const txId = 'lt_' + crypto.randomUUID();
  const redId = 'lr_' + crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO loyalty_transactions
         (id, account_id, type, points, status, kit_order_id, kit_order_number, order_amount,
          cashback_percent, hold_until, note, created_at, updated_at)
       VALUES (?, ?, 'redemption', ?, 'active', NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`
    ).bind(txId, acc.id, -amount, `Списание · код ${code}`, now, now),
    env.DB.prepare(
      `INSERT INTO loyalty_redemptions
         (id, account_id, tx_id, code, kit_promocode_id, amount, status, delivery, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?)`
    ).bind(redId, acc.id, txId, code, promo.id ?? null, amount, acc.email, expiresAt, now, now),
    env.DB.prepare(
      `UPDATE loyalty_accounts SET balance = balance - ?, last_activity_at = ?, updated_at = ? WHERE id = ?`
    ).bind(amount, now, now, acc.id),
  ]);

  return { ok: true, code, amount, expires_at: expiresAt, email: acc.email };
}

// Истёкшие неиспользованные коды → возврат баллов; использованные → пометить.
export async function reconcileRedemptions(env: Env): Promise<{ used: number; refunded: number }> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    `SELECT id, account_id, tx_id, kit_promocode_id, amount FROM loyalty_redemptions
     WHERE status = 'issued' AND expires_at <= ? LIMIT 25`
  )
    .bind(now)
    .all<{ id: string; account_id: string; tx_id: string; kit_promocode_id: string | null; amount: number }>();

  let used = 0;
  let refunded = 0;
  for (const r of rows.results ?? []) {
    let usageCount = 0;
    if (r.kit_promocode_id) {
      try {
        const promo = await kitGet<{ usage_count?: number }>(env, `/promocodes/${r.kit_promocode_id}`);
        usageCount = promo.usage_count ?? 0;
      } catch {
        continue; // KIT недоступен — попробуем в следующий проход
      }
    }
    if (usageCount > 0) {
      await env.DB.prepare(`UPDATE loyalty_redemptions SET status = 'used', updated_at = ? WHERE id = ?`).bind(now, r.id).run();
      used++;
    } else {
      await env.DB.batch([
        env.DB.prepare(`UPDATE loyalty_redemptions SET status = 'refunded', updated_at = ? WHERE id = ?`).bind(now, r.id),
        env.DB.prepare(`UPDATE loyalty_transactions SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(now, r.tx_id),
        env.DB.prepare(
          `INSERT INTO loyalty_transactions
             (id, account_id, type, points, status, kit_order_id, kit_order_number, order_amount,
              cashback_percent, hold_until, note, created_at, updated_at)
           VALUES (?, ?, 'adjust', ?, 'active', NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`
        ).bind('lt_' + crypto.randomUUID(), r.account_id, r.amount, 'Возврат баллов: код истёк неиспользованным', now, now),
        env.DB.prepare(`UPDATE loyalty_accounts SET balance = balance + ?, updated_at = ? WHERE id = ?`).bind(r.amount, now, r.account_id),
      ]);
      refunded++;
    }
  }
  return { used, refunded };
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
