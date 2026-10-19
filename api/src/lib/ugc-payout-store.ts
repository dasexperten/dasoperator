// D1 side of the Konsol payouts (migration 0119) and the jobs built on it:
// refresh from Konsol, the callback, and the evening summary to the Owner.
// The full SBP phone lives only in ugc_payout_requisites, which no listing joins.
import type { Env } from '../types';
import { konsolClient } from './konsol';
import { sendOwnerTelegram } from './owner-telegram';
import { applyKonsolPayment, bloggerFailedText, bloggerPaidText, executePayout, matchRegistryPayment, REGISTRY_LINK_IDS } from './ugc-payout-execute.mjs';
import { sendIgDirect } from './ig-dm-watch';
import { formatRub, ownRubMinor, UGC_PAYOUT_MAX_MINOR } from './ugc-payouts.mjs';
import { dianaCompose } from './diana-compose';

export function payoutStore(env: Env) {
  const db = env.DB;
  const touch = () => Date.now();
  // DH-LAW-261016-01: dates do not reserve budget for waiting payouts.
  const committed = `status <> 'failed' AND (status IN ('sent','paid') OR konsol_payment_id IS NOT NULL OR execute_claim IS NOT NULL)`;
  const sendDay = `date(COALESCE(sent_at, execute_claimed_at, paid_at, payout_date || 'T12:00:00Z'), '+4 hours')`;
  return {
    getPayout: (id: string) => db.prepare(
      `SELECT p.*, c.normalized_handle creator_handle FROM ugc_payouts p JOIN ugc_creators c ON c.id = p.creator_id WHERE p.id=?1`
    ).bind(id).first<Record<string, any>>(),
    getRequisites: (id: string) => db.prepare(
      `SELECT fps_mobile_phone, first_name, last_name, patronymic FROM ugc_payout_requisites WHERE payout_id=?1`
    ).bind(id).first<Record<string, any>>(),
    async sameDayMinor(creatorId: string, day: string, excludeId: string | null) {
      const r = await db.prepare(`SELECT COALESCE(SUM(amount_minor),0) total FROM ugc_payouts
        WHERE creator_id=?1 AND ${sendDay}=?2 AND ${committed} AND (?3 IS NULL OR id <> ?3)`).bind(creatorId, day, excludeId).first<{ total: number }>();
      return Number(r?.total ?? 0);
    },
    /** Other payouts of this creator on that day already handed to Konsol (or being handed). */
    async handedToday(creatorId: string, day: string, excludeId: string) {
      const r = await db.prepare(`SELECT COUNT(*) n FROM ugc_payouts WHERE creator_id=?1 AND ${sendDay}=?2 AND id<>?3 AND ${committed}`).bind(creatorId, day, excludeId).first<{ n: number }>();
      return Number(r?.n ?? 0);
    },
    async dayTotalMinor(day: string, excludeId: string | null) {
      const r = await db.prepare(`SELECT COALESCE(SUM(amount_minor),0) total FROM ugc_payouts
        WHERE ${sendDay}=?1 AND ${committed} AND (?2 IS NULL OR id <> ?2)`).bind(day, excludeId).first<{ total: number }>();
      return Number(r?.total ?? 0);
    },
    async claim(id: string, token: string, at: string) {
      const r = await db.prepare(`UPDATE ugc_payouts SET execute_claim=?2, execute_claimed_at=?3, konsol_error=NULL, updated_at=?4
        WHERE id=?1 AND execute_claim IS NULL AND konsol_payment_id IS NULL
          AND status IN ('awaiting_approval','approved')
          AND NOT EXISTS (SELECT 1 FROM crm_sync_state h WHERE h.key = 'payout_hold:' || ugc_payouts.id)
          AND amount_minor + (SELECT COALESCE(SUM(amount_minor),0) FROM ugc_payouts p
            WHERE p.id<>?1 AND p.creator_id=ugc_payouts.creator_id AND ${sendDay}=?5 AND ${committed}) <= ?6
          AND (status='approved' OR NOT EXISTS (SELECT 1 FROM ugc_payouts p
            WHERE p.id<>?1 AND p.creator_id=ugc_payouts.creator_id AND ${sendDay}=?5 AND ${committed}))`
      ).bind(id, token, at, touch(), yerevanDay(Date.parse(at)), UGC_PAYOUT_MAX_MINOR).run();
      return (r.meta?.changes ?? 0) === 1;
    },
    release: (id: string, error: string) => db.prepare(
      `UPDATE ugc_payouts SET execute_claim=NULL, konsol_error=?2, updated_at=?3 WHERE id=?1`
    ).bind(id, error.slice(0, 500), touch()).run(),
    holdUnclear: (id: string, error: string) => db.prepare(
      `UPDATE ugc_payouts SET konsol_error=?2, updated_at=?3 WHERE id=?1`
    ).bind(id, error.slice(0, 500), touch()).run(),
    setContractor: (id: string, contractorId: string) => db.prepare(
      `UPDATE ugc_payouts SET konsol_contractor_id=?2, updated_at=?3 WHERE id=?1`
    ).bind(id, contractorId, touch()).run(),
    markSent: (id: string, s: { paymentId: string; contractorId: string; konsolStatus: string | null; sentAt: string; day: string; phoneMasked: string | null; bankRef: string | null }) => db.prepare(
      `UPDATE ugc_payouts SET konsol_payment_id=?2, konsol_contractor_id=?3, konsol_status=?4, status='sent', sent_at=?5,
         approved_at=COALESCE(approved_at, ?5), approved_by=COALESCE(approved_by, 'auto (limits)'), payout_date=?6,
         phone_masked=COALESCE(?7, phone_masked), bank_ref=COALESCE(bank_ref, ?8), konsol_error=NULL, updated_at=?9
       WHERE id=?1 AND konsol_payment_id IS NULL`
    ).bind(id, s.paymentId, s.contractorId, s.konsolStatus, s.sentAt, s.day, s.phoneMasked, s.bankRef, touch()).run(),
    markPaid: async (id: string, s: { paidAt: string; konsolStatus: string }) => {
      const r = await db.prepare(
        `UPDATE ugc_payouts SET status='paid', paid_at=?2, konsol_status=?3, updated_at=?4 WHERE id=?1`
      ).bind(id, s.paidAt, s.konsolStatus, touch()).run();
      // Owner 2026-10-18: the status follows the facts — money out moves the creator to «paid», forward only.
      await db.prepare(`UPDATE ugc_creators SET lifecycle_stage='paid', updated_at=?2 WHERE id=(SELECT creator_id FROM ugc_payouts WHERE id=?1)
        AND COALESCE(lifecycle_stage,'') IN ('','new','sent','replied','agreed','cart','failed')`).bind(id, Date.now()).run().catch(() => undefined);
      return r;
    },
    markFailed: async (id: string, s: { failedAt: string; konsolStatus: string; error: string }) => {
      const r = await db.prepare(
        `UPDATE ugc_payouts SET status='failed', failed_at=?2, konsol_status=?3, konsol_error=?4, updated_at=?5 WHERE id=?1`
      ).bind(id, s.failedAt, s.konsolStatus, s.error.slice(0, 500), touch()).run();
      // Owner 2026-10-18: failed = the bank declined our transfer; a later paid moves her on.
      await db.prepare(`UPDATE ugc_creators SET lifecycle_stage='failed', updated_at=?2 WHERE id=(SELECT creator_id FROM ugc_payouts WHERE id=?1)
        AND COALESCE(lifecycle_stage,'') IN ('','new','sent','replied','agreed','cart')`).bind(id, Date.now()).run().catch(() => undefined);
      return r;
    },
    setKonsolStatus: (id: string, status: string) => db.prepare(
      `UPDATE ugc_payouts SET konsol_status=?2, updated_at=?3 WHERE id=?1`
    ).bind(id, status, touch()).run(),
    async claimNotice(id: string, at: string) {
      const r = await db.prepare(`UPDATE ugc_payouts SET paid_notice_at=?2 WHERE id=?1 AND paid_notice_at IS NULL`).bind(id, at).run();
      return (r.meta?.changes ?? 0) === 1;
    },
    releaseNotice: (id: string) => db.prepare(`UPDATE ugc_payouts SET paid_notice_at=NULL WHERE id=?1`).bind(id).run(),
  };
}

function deps(env: Env) {
  return {
    store: payoutStore(env),
    konsol: konsolClient(env),
    // Owner 2026-10-17: Diana sends Telegram only for hard questions; a payout stop waits in the ERP.
    notifyOwner: async (_text: string) => true,
    notifyBlogger: async (row: Record<string, any>, text: string, kind: 'paid' | 'failed' = 'paid') => {
      const handle = String(row.creator_handle || row.handle || '');
      // Owner 2026-10-18: the ERP text is a brief only; Diana writes the words. No words, no message.
      const head = kind === 'failed' ? 'Выплата не прошла, Консоль подтвердила. Смысл сообщения:' : 'Выплата исполнена, ERP и Консоль подтвердили. Смысл сообщения:';
      let parts = await dianaCompose(env, handle, `${head}\n${text}`).catch(() => null);
      // Owner 2026-10-19: a failed payout never falls back to the paid wording; no words — retried next check.
      if (kind === 'failed' && (!parts || !parts.length)) return { ok: false, error: 'Диана не написала текст о неудачной выплате' };
      // Owner 2026-10-18: «нужно моментальное реагирование… в этот же момент». If Diana's three drafts do not
      // pass, the Owner's own approved paid wording goes at once instead of waiting for the next run.
      if (!parts || !parts.length) {
        const amount = Number(row.amount_minor);
        if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Диана не написала текст (JEV или контролёр голоса)' };
        parts = [`Перевели ${formatRub(amount)} по СБП.`, 'Проверьте, пожалуйста, должно быть уже дошло.', 'Оформите, пожалуйста, заказ и пришлите скрин.'];
      }
      const [first, ...rest] = parts;
      // Owner 2026-10-18 (mari__blog666 and 5 more: paid, no message): after 24 h of the blogger's
      // silence Instagram takes a message only with the human-agent tag (7-day window).
      const lastIn = await env.DB.prepare(`SELECT MAX(created_at) t FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username)=?1`).bind(handle.toLowerCase()).first<{ t: string | null }>();
      const humanAgent = !lastIn?.t || Date.now() - Date.parse(lastIn.t) > 23.5 * 3_600_000;
      const sent = await sendIgDirect(env, handle, first!, { humanAgent });
      for (const part of sent.ok ? rest : []) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!(await sendIgDirect(env, handle, part, { humanAgent })).ok) break;
      }
      // Owner 2026-10-18: closed window — Diana's words wait for the browser and count as delivered here.
      if (!sent.ok && /allowed window/i.test(String(sent.error ?? ''))) {
        const { queueForBrowser } = await import('./ig-dm-reply');
        await queueForBrowser(env, handle, kind === 'failed' ? 'failed_notice' : 'paid_notice', parts.join('\n'));
        return { ok: true, queued: true };
      }
      // After a new payment the scenario cards follow the bridge (Owner 2026-10-16); an old debt gets thanks only.
      // Owner 2026-10-18: no scenario cards with the payment — they wait for the order screenshot.
      return sent;
    },
    now: Date.now(),
    claimToken: crypto.randomUUID(),
  };
}

export function executeUgcPayout(env: Env, id: string) {
  return executePayout(id, deps(env));
}

/** Re-reads one payout's payment from Konsol and applies its status. */
export async function refreshUgcPayout(env: Env, id: string) {
  const d = deps(env);
  const row = await d.store.getPayout(id);
  if (!row) return { http: 404, ok: false, code: 'not_found' };
  if (!row.konsol_payment_id) return { http: 409, ok: false, code: 'not_sent', message: 'No Konsol payment on this payout' };
  const payment = await d.konsol.getPayment(String(row.konsol_payment_id));
  if (!payment.ok) return { http: 502, ok: false, code: 'konsol_unreachable', message: payment.error };
  const applied = await applyKonsolPayment(row, payment.body, d);
  return { http: 200, ok: true, id, ...applied };
}

/**
 * Konsol callback. The body only names a payment; its status is re-read from
 * Konsol. Unknown ids are acknowledged and ignored (Konsol retries otherwise).
 */
export async function handleKonsolCallback(env: Env, body: any) {
  const paymentId = typeof body?.payload?.id === 'string' ? body.payload.id : null;
  if (!paymentId) return { ok: true, ignored: 'no payment id' };
  const row = await env.DB.prepare(`SELECT id FROM ugc_payouts WHERE konsol_payment_id=?1`).bind(paymentId).first<{ id: string }>();
  if (!row) return { ok: true, ignored: 'unknown payment' };
  return refreshUgcPayout(env, row.id);
}

/**
 * Re-reads every payout still "sent" in Konsol (Owner 15.10.2026: check every
 * 15 minutes, no browser, no PC). Runs on the 15-minute tick and before the evening
 * summary; a paid payout turns green and Diana gets her notice at once.
 */
/**
 * Links the two registry payouts of 14.10 to their executed Konsol payments
 * (GET only). Runs on the sweep until both carry an id, then does nothing.
 * Diana's «деньги пришли» notice is not sent: these were paid on 14.10.
 */
export async function linkRegistryPayouts(env: Env): Promise<string> {
  const placeholders = REGISTRY_LINK_IDS.map((_, i) => `?${i + 1}`).join(',');
  const rows = (await env.DB.prepare(
    `SELECT id, amount_minor, payout_date FROM ugc_payouts WHERE id IN (${placeholders}) AND konsol_payment_id IS NULL`
  ).bind(...REGISTRY_LINK_IDS).all<Record<string, any>>()).results ?? [];
  if (!rows.length) return 'registry: nothing to link';
  const konsol = konsolClient(env);
  const payments: any[] = [];
  let from: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r = await konsol.listPayments(from);
    if (!r.ok) return `registry: Konsol list failed (${r.error ?? r.status})`;
    payments.push(...(r.body?.collection ?? []));
    const next = r.body?.pagination;
    if (!next?.next_page || !next.to || String(next.to) === from) break;
    from = String(next.to);
  }
  const linked = new Set(((await env.DB.prepare(`SELECT konsol_payment_id FROM ugc_payouts WHERE konsol_payment_id IS NOT NULL`).all<{ konsol_payment_id: string }>()).results ?? []).map((r) => String(r.konsol_payment_id)));
  const notes: string[] = [];
  for (const row of rows) {
    const hit = matchRegistryPayment(row, payments, linked);
    if (!hit.payment) { notes.push(`${row.id}: ${hit.reason}`); continue; }
    const p = hit.payment;
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE ugc_payouts SET konsol_payment_id=?2, konsol_contractor_id=COALESCE(konsol_contractor_id, ?3), konsol_status=?4,
         status='paid', paid_at=?5, paid_notice_at=COALESCE(paid_notice_at, ?6), updated_at=?7
       WHERE id=?1 AND konsol_payment_id IS NULL`
    ).bind(row.id, String(p.id), p.contractor_id != null ? String(p.contractor_id) : null, p.status, p.paid_at || p.created_at || now, now, Date.now()).run();
    linked.add(String(p.id));
    notes.push(`${row.id}: linked`);
  }
  return `registry: ${notes.join('; ')}`;
}

export async function ugcPayoutSweep(env: Env): Promise<number> {
  try { await linkRegistryPayouts(env); } catch { /* GET-only link; retried next tick */ }
  const pending = await env.DB.prepare(
    `SELECT id FROM ugc_payouts WHERE status='sent' AND konsol_payment_id IS NOT NULL ORDER BY updated_at LIMIT 50`
  ).all<{ id: string }>();
  let refreshed = 0;
  for (const r of pending.results ?? []) {
    const out = await refreshUgcPayout(env, r.id);
    if (out.ok) refreshed++;
  }
  // Owner 2026-10-18: a paid payout whose message did not go out is retried until it does (within 6 days).
  const unsent = await env.DB.prepare(
    `SELECT * FROM ugc_payouts WHERE status='paid' AND konsol_payment_id IS NOT NULL AND paid_notice_at IS NULL
       AND paid_at > ?1 ORDER BY paid_at LIMIT 5`
  ).bind(new Date(Date.now() - 6 * 86_400_000).toISOString()).all<Record<string, any>>();
  const d = deps(env);
  for (const row of unsent.results ?? []) {
    if (!(await d.store.claimNotice(row.id, new Date().toISOString()))) continue;
    const sent = await d.notifyBlogger(row, bloggerPaidText(row)).catch((e) => ({ ok: false, error: String(e) })) as { ok: boolean; error?: string };
    if (sent && sent.ok) refreshed++;
    else {
      // Owner 2026-10-18: «писать надо сразу» — an unsent paid notice keeps the payouts lane on its fast 3-minute step.
      refreshed++;
      await d.store.releaseNotice(row.id);
      // Owner 2026-10-18: a notice that keeps failing says why (Instagram or Diana), visible to the ERP.
      await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(`paid_notice_error:${row.id}`, JSON.stringify({ handle: row.handle, error: String(sent?.error ?? 'unknown').slice(0, 300), at: new Date().toISOString() }), Date.now()).run().catch(() => undefined);
    }
  }
  // Owner 2026-10-19: a failed payout whose message did not go out is retried the same way. Only failures from
  // this rule on (older ones were already handled by hand: madifood_, eseniya__oo3__).
  const unsentFailed = await env.DB.prepare(
    `SELECT * FROM ugc_payouts WHERE status='failed' AND konsol_payment_id IS NOT NULL AND paid_notice_at IS NULL
       AND failed_at > ?1 ORDER BY failed_at LIMIT 5`
  ).bind('2026-10-19T09:30:00.000Z').all<Record<string, any>>();
  for (const row of unsentFailed.results ?? []) {
    if (!(await d.store.claimNotice(row.id, new Date().toISOString()))) continue;
    const sent = await d.notifyBlogger(row, bloggerFailedText(row, row.konsol_error), 'failed').catch((e) => ({ ok: false, error: String(e) })) as { ok: boolean; error?: string };
    refreshed++;
    if (!(sent && sent.ok)) await d.store.releaseNotice(row.id);
  }
  refreshed += await paidOrderReminders(env).catch(() => 0);
  return refreshed;
}

/**
 * Owner 2026-10-18: «если мы сделали им оплату, обязательно всем нужно писать. Мы что, благотворительная
 * организация?» — three days after our transfer, if the blogger is still at «paid» (no order screenshot)
 * and has not written for three days, Diana reminds her once about the order. Diana writes the words.
 * If Instagram's 7-day window is closed, the reminder waits in the browser queue (browser_queue:<handle>).
 */
export async function paidOrderReminders(env: Env, now = Date.now()): Promise<number> {
  const rows = (await env.DB.prepare(
    `SELECT p.id, p.handle, p.amount_minor, p.paid_at FROM ugc_payouts p JOIN ugc_creators c ON c.id = p.creator_id
      WHERE p.status = 'paid' AND p.paid_at <= ?1 AND p.paid_at >= ?2 AND c.lifecycle_stage = 'paid'
        AND NOT EXISTS (SELECT 1 FROM crm_sync_state k WHERE k.key = 'paid_reminder:' || p.id)
      ORDER BY p.paid_at LIMIT 5`
  ).bind(new Date(now - 3 * 86_400_000).toISOString(), new Date(now - 30 * 86_400_000).toISOString()).all<{ id: string; handle: string; amount_minor: number; paid_at: string }>()).results ?? [];
  let sent = 0;
  for (const row of rows) {
    const handle = String(row.handle || '').toLowerCase();
    const lastIn = await env.DB.prepare(`SELECT MAX(created_at) t FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username)=?1`).bind(handle).first<{ t: string | null }>();
    // She wrote anything after our transfer (a photo the ERP may not see, a question): the reply lane
    // and the Owner handle it; the reminder is only for silence since the money went out.
    if (lastIn?.t && lastIn.t > row.paid_at) continue;
    const save = (value: Record<string, unknown>) => env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .bind(`paid_reminder:${row.id}`, JSON.stringify({ handle, at: new Date(now).toISOString(), ...value }), now).run();
    const brief = [`Мы перевели ${formatRub(row.amount_minor)} ${row.paid_at.slice(8, 10)}.${row.paid_at.slice(5, 7)}, а скрина оформленного заказа пока нет, и блогер молчит.`,
      'Мягко напомни про оплату и попроси оформить заказ пасты на Ozon и прислать скрин оформленного заказа.',
      'Про сценарий и ролик сейчас НЕ пиши.'].join('\n');
    const parts = await dianaCompose(env, handle, brief).catch(() => null);
    if (!parts || !parts.length) continue; // Diana could not write: retried on the next run.
    const humanAgent = !lastIn?.t || now - Date.parse(lastIn.t) > 23.5 * 3_600_000;
    const first = await sendIgDirect(env, handle, parts[0]!, { humanAgent });
    if (first.ok) {
      for (const part of parts.slice(1)) { await new Promise((r) => setTimeout(r, 1500)); if (!(await sendIgDirect(env, handle, part, { humanAgent })).ok) break; }
      await save({ via: 'instagram', text: parts.join('\n') });
      sent++;
    } else if (/allowed window/i.test(String(first.error ?? ''))) {
      // Instagram's 7-day window is closed: only a person (or the browser) can write now.
      await save({ via: 'browser_queue', text: parts.join('\n') });
      const { queueForBrowser } = await import('./ig-dm-reply');
      await queueForBrowser(env, handle, 'paid_order_reminder', parts.join('\n'));
    }
  }
  return sent;
}

function yerevanDay(ms: number): string {
  return new Date(ms + 4 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Evening summary (erp-ugc-payout-summary). First catches up every payout
 * still "sent" in Konsol (a missed callback), then one message a day to the
 * Owner: count, sum, own RUB left. Silent on a day with no Konsol payouts.
 */
export async function ugcPayoutEvening(env: Env, opts: { force?: boolean } = {}): Promise<string> {
  const refreshed = await ugcPayoutSweep(env);
  // Owner 2026-10-17: «только эти вопросы» go to Telegram; the evening payout summary is not sent.
  if (!opts.force) return `refreshed=${refreshed}; evening summary off (Owner 2026-10-17: Telegram only for hard questions)`;
  const now = Date.now();
  const day = yerevanDay(now);
  const key = 'ugc_payout_summary:last_day';
  const last = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(key).first<{ value: string }>();
  if (last?.value === day && !opts.force) return `refreshed=${refreshed}; summary already sent for ${day}`;
  // Payouts handed to Konsol on this Yerevan day (sent_at is UTC ISO).
  const startUtc = new Date(Date.parse(`${day}T00:00:00Z`) - 4 * 3600_000).toISOString();
  const endUtc = new Date(Date.parse(`${day}T00:00:00Z`) + 20 * 3600_000).toISOString();
  const rows = (await env.DB.prepare(
    `SELECT status, amount_minor FROM ugc_payouts WHERE konsol_payment_id IS NOT NULL AND sent_at >= ?1 AND sent_at < ?2`
  ).bind(startUtc, endUtc).all<{ status: string; amount_minor: number }>()).results ?? [];
  // «Отправлено» with no Konsol payment for more than 2 days (Owner 2026-10-15):
  // the money did not go through Konsol — always named in the summary.
  const staleBefore = new Date(now - 2 * 24 * 3600_000).toISOString();
  const stale = (await env.DB.prepare(
    `SELECT amount_minor FROM ugc_payouts WHERE status='sent' AND konsol_payment_id IS NULL
       AND COALESCE(sent_at, payout_date || 'T00:00:00.000Z') < ?1`
  ).bind(staleBefore).all<{ amount_minor: number }>()).results ?? [];
  const staleLine = stale.length
    ? ` Отправлено, но в Консоли нет платежа больше 2 дней: ${stale.length} на ${formatRub(stale.reduce((s, r) => s + Number(r.amount_minor || 0), 0))}.`
    : '';
  if (!rows.length && !stale.length) return `refreshed=${refreshed}; no Konsol payouts on ${day} — silent`;
  const sum = rows.reduce((s, r) => s + Number(r.amount_minor || 0), 0);
  const paid = rows.filter((r) => r.status === 'paid').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const accounts = await konsolClient(env).companyAccounts();
  const own = accounts.ok ? ownRubMinor(accounts.body) : null;
  const ownLine = own && own.ok ? `Свой рублёвый счёт Консоли: ${formatRub(own.own_minor)}.` : 'Свой рублёвый счёт Консоли сейчас не прочитан.';
  const [, m, d] = day.split('-');
  const text = (rows.length
    ? `Выплаты блогерам за ${d}.${m}: ${rows.length} на ${formatRub(sum)}. Пришли: ${paid}` + (failed ? `, не прошли: ${failed}` : '') + '.'
    : `Выплаты блогерам за ${d}.${m}: через Консоль сегодня не было.`) + staleLine + ` ${ownLine}`;
  const sent = await sendOwnerTelegram(env, text, 'diana-helios');
  if (sent) {
    await env.DB.prepare(`INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(key, day, now).run();
  } else {
    throw new Error('evening summary not delivered');
  }
  return `refreshed=${refreshed}; summary sent for ${day}: ${rows.length} payouts`;
}
