// =============================================================================
// Loyalty routes — /api/loyalty/*  (Phase 10.0, замена RetailCRM)
//
// POST /api/loyalty/webhook/kit?token=…   ← Yandex KIT ORDER_STATUS_CHANGED
// GET  /api/loyalty/accounts/:phone        ← баланс + уровень
// GET  /api/loyalty/accounts/:phone/transactions
// GET  /api/loyalty/stats                  ← сводка программы
// POST /api/loyalty/admin/activate-holds   ← pending → active (hold истёк)
// POST /api/loyalty/admin/reprocess-order  ← ручной прогон заказа {order_id}
//
// Защита вебхука: query ?token= должен совпадать с env.KIT_WEBHOOK_TOKEN.
// Admin-эндпоинты: тот же Bearer das-admin-2026-migrations, что и /admin/*.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import {
  processOrderEvent,
  activateExpiredHolds,
  normalizePhone,
  tierFor,
  TIERS,
} from '../lib/loyalty';

const loyalty = new Hono<{ Bindings: Env }>();
const ADMIN_SECRET = 'das-admin-2026-migrations';

// -----------------------------------------------------------------------------
// Webhook from Yandex KIT
// -----------------------------------------------------------------------------
loyalty.post('/webhook/kit', async (c) => {
  const token = c.req.query('token');
  if (!c.env.KIT_WEBHOOK_TOKEN || token !== c.env.KIT_WEBHOOK_TOKEN) {
    return fail(c, 403, [{ code: 'forbidden', message: 'bad webhook token' }]);
  }

  let payload: any = null;
  let raw = '';
  try {
    raw = await c.req.text();
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  // KIT payload shape is not strictly documented — extract order id defensively.
  const orderId: string | undefined =
    payload?.order_id ?? payload?.orderId ?? payload?.order?.id ?? payload?.id ?? payload?.data?.order_id;
  const eventType: string = payload?.event ?? payload?.event_type ?? payload?.type ?? 'ORDER_STATUS_CHANGED';

  const now = Math.floor(Date.now() / 1000);
  const logId = 'lw_' + crypto.randomUUID();

  if (!orderId) {
    await c.env.DB.prepare(
      'INSERT INTO loyalty_webhook_log (id, kit_order_id, event_type, payload, result, created_at) VALUES (?, NULL, ?, ?, ?, ?)'
    )
      .bind(logId, eventType, raw.slice(0, 4000), 'skipped:no_order_id', now)
      .run();
    // 200, чтобы KIT не ретраил бесконечно — но лог остаётся для разбора
    return ok(c, { processed: false, reason: 'no_order_id' });
  }

  let result: string;
  let details: Record<string, unknown> | undefined;
  try {
    const r = await processOrderEvent(c.env, orderId);
    result = r.action;
    details = r.details;
  } catch (err) {
    result = 'error:' + (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }

  await c.env.DB.prepare(
    'INSERT INTO loyalty_webhook_log (id, kit_order_id, event_type, payload, result, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(logId, String(orderId), eventType, raw.slice(0, 4000), result, now)
    .run();

  // lazy-активация холдов: дешёвая, выполняется на каждом событии — пока
  // отдельный cron не добавлен в scheduled.ts
  try {
    await activateExpiredHolds(c.env);
  } catch {
    // не валим вебхук из-за активации
  }

  return ok(c, { processed: true, action: result, details: details ?? null });
});

// -----------------------------------------------------------------------------
// Balance lookup
// -----------------------------------------------------------------------------
loyalty.get('/accounts/:phone', async (c) => {
  const phone = normalizePhone(c.req.param('phone'));
  if (!phone) return fail(c, 400, [{ code: 'bad_phone', message: 'cannot normalize phone' }]);

  const acc = await c.env.DB.prepare(
    `SELECT id, phone, email, name, balance, pending_balance, lifetime_spent, tier,
            status, registered_at, last_activity_at
     FROM loyalty_accounts WHERE phone = ?`
  )
    .bind(phone)
    .first();
  if (!acc) return fail(c, 404, [{ code: 'not_found', message: 'no loyalty account for this phone' }]);

  const lifetime = (acc as any).lifetime_spent as number;
  const current = tierFor(lifetime);
  const next = [...TIERS].reverse().find((t) => t.threshold > lifetime) ?? null;

  return ok(c, {
    ...acc,
    cashback_percent: current.percent,
    next_tier: next ? { key: next.key, threshold: next.threshold, remaining: next.threshold - lifetime } : null,
  });
});

loyalty.get('/accounts/:phone/transactions', async (c) => {
  const phone = normalizePhone(c.req.param('phone'));
  if (!phone) return fail(c, 400, [{ code: 'bad_phone', message: 'cannot normalize phone' }]);
  const acc = await c.env.DB.prepare('SELECT id FROM loyalty_accounts WHERE phone = ?').bind(phone).first<{ id: string }>();
  if (!acc) return fail(c, 404, [{ code: 'not_found', message: 'no loyalty account' }]);

  const txs = await c.env.DB.prepare(
    `SELECT id, type, points, status, kit_order_number, order_amount, cashback_percent,
            hold_until, note, created_at
     FROM loyalty_transactions WHERE account_id = ? ORDER BY created_at DESC LIMIT 100`
  )
    .bind(acc.id)
    .all();
  return ok(c, { transactions: txs.results ?? [] });
});

// -----------------------------------------------------------------------------
// Program stats
// -----------------------------------------------------------------------------
loyalty.get('/stats', async (c) => {
  const accounts = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(balance) AS active_points,
            SUM(pending_balance) AS pending_points,
            SUM(lifetime_spent) AS lifetime_spent
     FROM loyalty_accounts WHERE status = 'active'`
  ).first();
  const byTier = await c.env.DB.prepare(
    `SELECT tier, COUNT(*) AS cnt FROM loyalty_accounts WHERE status = 'active' GROUP BY tier`
  ).all();
  const recent = await c.env.DB.prepare(
    `SELECT result, COUNT(*) AS cnt FROM loyalty_webhook_log
     WHERE created_at > unixepoch() - 7 * 86400 GROUP BY result ORDER BY cnt DESC LIMIT 10`
  ).all();
  return ok(c, { accounts, by_tier: byTier.results ?? [], webhook_last_7d: recent.results ?? [] });
});

// -----------------------------------------------------------------------------
// Admin
// -----------------------------------------------------------------------------
loyalty.use('/admin/*', async (c, next) => {
  if (c.req.header('Authorization') !== `Bearer ${ADMIN_SECRET}`) {
    return fail(c, 403, [{ code: 'forbidden', message: 'admin secret required' }]);
  }
  await next();
  return;
});

loyalty.post('/admin/activate-holds', async (c) => {
  const r = await activateExpiredHolds(c.env);
  return ok(c, r);
});

loyalty.post('/admin/reprocess-order', async (c) => {
  const body = await c.req.json<{ order_id?: string }>().catch(() => ({} as any));
  if (!body.order_id) return fail(c, 400, [{ code: 'bad_request', message: 'order_id required' }]);
  const r = await processOrderEvent(c.env, body.order_id);
  return ok(c, r);
});

export default loyalty;
