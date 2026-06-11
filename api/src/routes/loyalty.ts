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
  createRedemption,
  reconcileRedemptions,
  REDEEM_MIN_POINTS,
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

  // Валидация вебхука: KIT шлёт {"event":"WEBHOOK_VALIDATE"}, ждёт 2xx с телом
  // {"message":"validated_store_{store_id}"} → вебхук переходит в ACTIVE.
  if (payload?.event === 'WEBHOOK_VALIDATE' || payload?.event_type === 'WEBHOOK_VALIDATE') {
    const store = await (async () => {
      try {
        const res = await fetch('https://api.kit.yandex.net/v1/store', {
          headers: { Authorization: `Bearer ${c.env.YANDEX_KIT_TOKEN}` },
        });
        return (await res.json()) as { id?: string };
      } catch {
        return {} as { id?: string };
      }
    })();
    return c.json({ message: `validated_store_${store.id ?? ''}` });
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

  // Письмо о начислении: клиент видит баллы после каждой покупки.
  // Шлём только при реальном начислении (идемпотентность начисления = одно письмо на заказ).
  if (result === 'accrued' && details) {
    try {
      const d = details as { phone: string; points: number; percent: number; order_number: number; instant: boolean };
      const acc = await c.env.DB.prepare(
        'SELECT email, name, balance, pending_balance FROM loyalty_accounts WHERE phone = ?'
      )
        .bind(d.phone)
        .first<{ email: string | null; name: string | null; balance: number; pending_balance: number }>();
      if (acc?.email) {
        const firstName = (acc.name ?? '').split(' ')[0];
        const holdLine = d.instant
          ? `Баллы уже активны — можно тратить.`
          : `Баллы активируются через 7 дней (защита периода возврата).`;
        await c.env.EMAILER.fetch(
          new Request('https://emailer/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'send',
              recipient: acc.email,
              subject: `+${d.points} баллов за заказ №${d.order_number} — Клуб Экспертов`,
              body_plain:
                `Здравствуйте${firstName ? ', ' + firstName : ''}!\n\n` +
                `За заказ №${d.order_number} начислено +${d.points} баллов (кешбэк ${d.percent}%).\n` +
                `${holdLine}\n\n` +
                `Ваш баланс: ${acc.balance} баллов` +
                (acc.pending_balance > 0 ? ` (+${acc.pending_balance} на активации)` : '') +
                `\n1 балл = 1 рубль. Списать можно до 50% любого заказа.\n\n` +
                `Посмотреть баланс и получить код на скидку:\nhttps://bonus.dasexperten.ru\n\n` +
                `Das Experten · Клуб Экспертов\n` +
                `Баллы живут 12 месяцев с последней покупки — любой заказ продлевает их все.`,
            }),
            signal: AbortSignal.timeout(30_000),
          })
        );
      }
    } catch {
      // письмо не критично — начисление уже в базе
    }
  }

  return ok(c, { processed: true, action: result, details: details ?? null });
});

// -----------------------------------------------------------------------------
// Balance lookup
// -----------------------------------------------------------------------------
loyalty.get('/accounts/:phone', async (c) => {
  if (c.req.header('Authorization') !== `Bearer ${ADMIN_SECRET}`) {
    return fail(c, 403, [{ code: 'forbidden', message: 'admin secret required' }]);
  }
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
  if (c.req.header('Authorization') !== `Bearer ${ADMIN_SECRET}`) {
    return fail(c, 403, [{ code: 'forbidden', message: 'admin secret required' }]);
  }
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
// Public cabinet API (bonus.dasexperten.ru) — маскированные данные
// -----------------------------------------------------------------------------
function maskEmail(e: string | null): string | null {
  if (!e) return null;
  const [u, d] = e.split('@');
  if (!d) return null;
  return u.slice(0, 2) + '***@' + d;
}

loyalty.get('/lookup/:phone', async (c) => {
  const phone = normalizePhone(c.req.param('phone'));
  if (!phone) return fail(c, 400, [{ code: 'bad_phone', message: 'cannot normalize phone' }]);

  try {
    await reconcileRedemptions(c.env);
  } catch {
    // не блокируем кабинет
  }

  const acc = await c.env.DB.prepare(
    `SELECT id, name, email, balance, pending_balance, lifetime_spent, tier
     FROM loyalty_accounts WHERE phone = ? AND status = 'active'`
  )
    .bind(phone)
    .first<{ id: string; name: string | null; email: string | null; balance: number; pending_balance: number; lifetime_spent: number; tier: string }>();
  if (!acc) return fail(c, 404, [{ code: 'not_found', message: 'no loyalty account for this phone' }]);

  const current = tierFor(acc.lifetime_spent);
  const next = [...TIERS].reverse().find((t) => t.threshold > acc.lifetime_spent) ?? null;
  const txs = await c.env.DB.prepare(
    `SELECT type, points, status, note, hold_until, created_at FROM loyalty_transactions
     WHERE account_id = ? AND status IN ('pending','active') ORDER BY created_at DESC LIMIT 10`
  )
    .bind(acc.id)
    .all();
  const openCode = await c.env.DB.prepare(
    `SELECT amount, expires_at FROM loyalty_redemptions
     WHERE account_id = ? AND status = 'issued' AND expires_at > unixepoch()`
  )
    .bind(acc.id)
    .first();

  return ok(c, {
    first_name: (acc.name ?? '').split(' ')[0] || null,
    email_masked: maskEmail(acc.email),
    has_email: !!acc.email,
    balance: acc.balance,
    pending_balance: acc.pending_balance,
    lifetime_spent: acc.lifetime_spent,
    tier: acc.tier,
    cashback_percent: current.percent,
    next_tier: next ? { key: next.key, threshold: next.threshold, remaining: next.threshold - acc.lifetime_spent } : null,
    open_redemption: openCode ?? null,
    redeem_min: REDEEM_MIN_POINTS,
    transactions: txs.results ?? [],
  });
});

loyalty.post('/redeem', async (c) => {
  const body = await c.req.json<{ phone?: string; amount?: number }>().catch(() => ({} as any));
  const phone = normalizePhone(body.phone);
  const amount = Math.floor(Number(body.amount));
  if (!phone || !amount) return fail(c, 400, [{ code: 'bad_request', message: 'phone and amount required' }]);

  try {
    await reconcileRedemptions(c.env);
  } catch {
    // continue
  }

  const r = await createRedemption(c.env, phone, amount);
  if (!r.ok) return fail(c, 422, [{ code: r.error, message: r.error }]);

  // Код уходит на email владельца счёта (анти-угон: чужой телефон ввести можно,
  // но код получит только владелец почты). Без email — показываем на экране.
  if (r.email) {
    try {
      await c.env.EMAILER.fetch(
        new Request('https://emailer/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'send',
            recipient: r.email,
            subject: `Ваш код на ${r.amount} ₽ скидки — Клуб Экспертов`,
            body_plain:
              `Здравствуйте!\n\nВаш персональный код: ${r.code}\n` +
              `Скидка: ${r.amount} ₽ (списано ${r.amount} баллов)\n` +
              `Действует 48 часов, на заказ от ${r.amount * 2} ₽.\n\n` +
              `Вставьте код в поле «Промокод» при оформлении заказа на dasexperten.ru.\n\n` +
              `Das Experten · Клуб Экспертов`,
          }),
          signal: AbortSignal.timeout(30_000),
        })
      );
      return ok(c, { delivery: 'email', email_masked: maskEmail(r.email), amount: r.amount, expires_at: r.expires_at });
    } catch {
      // email не ушёл — отдаём код на экран, чтобы клиент не потерял баллы
      return ok(c, { delivery: 'screen', code: r.code, amount: r.amount, expires_at: r.expires_at });
    }
  }
  return ok(c, { delivery: 'screen', code: r.code, amount: r.amount, expires_at: r.expires_at });
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
  const rec = await reconcileRedemptions(c.env);
  return ok(c, { ...r, ...rec });
});

loyalty.post('/admin/reprocess-order', async (c) => {
  const body = await c.req.json<{ order_id?: string }>().catch(() => ({} as any));
  if (!body.order_id) return fail(c, 400, [{ code: 'bad_request', message: 'order_id required' }]);
  const r = await processOrderEvent(c.env, body.order_id);
  return ok(c, r);
});

export default loyalty;
