// D1 side of the Konsol payouts (migration 0119) and the jobs built on it:
// refresh from Konsol, the callback, and the evening summary to the Owner.
// The full SBP phone lives only in ugc_payout_requisites, which no listing joins.
import type { Env } from '../types';
import { konsolClient } from './konsol';
import { sendOwnerTelegram } from './owner-telegram';
import { applyKonsolPayment, executePayout } from './ugc-payout-execute.mjs';
import { formatRub, ownRubMinor } from './ugc-payouts.mjs';

export function payoutStore(env: Env) {
  const db = env.DB;
  const touch = () => Date.now();
  return {
    getPayout: (id: string) => db.prepare(
      `SELECT p.*, c.normalized_handle creator_handle FROM ugc_payouts p JOIN ugc_creators c ON c.id = p.creator_id WHERE p.id=?1`
    ).bind(id).first<Record<string, any>>(),
    getRequisites: (id: string) => db.prepare(
      `SELECT fps_mobile_phone, first_name, last_name, patronymic FROM ugc_payout_requisites WHERE payout_id=?1`
    ).bind(id).first<Record<string, any>>(),
    async sameDayMinor(creatorId: string, day: string, excludeId: string | null) {
      const r = await db.prepare(`SELECT COALESCE(SUM(amount_minor),0) total FROM ugc_payouts
        WHERE creator_id=?1 AND payout_date=?2 AND status <> 'failed' AND (?3 IS NULL OR id <> ?3)`).bind(creatorId, day, excludeId).first<{ total: number }>();
      return Number(r?.total ?? 0);
    },
    async dayTotalMinor(day: string, excludeId: string | null) {
      const r = await db.prepare(`SELECT COALESCE(SUM(amount_minor),0) total FROM ugc_payouts
        WHERE payout_date=?1 AND status <> 'failed' AND (?2 IS NULL OR id <> ?2)`).bind(day, excludeId).first<{ total: number }>();
      return Number(r?.total ?? 0);
    },
    async claim(id: string, token: string, at: string) {
      const r = await db.prepare(`UPDATE ugc_payouts SET execute_claim=?2, execute_claimed_at=?3, konsol_error=NULL, updated_at=?4
        WHERE id=?1 AND execute_claim IS NULL AND konsol_payment_id IS NULL`).bind(id, token, at, touch()).run();
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
    markPaid: (id: string, s: { paidAt: string; konsolStatus: string }) => db.prepare(
      `UPDATE ugc_payouts SET status='paid', paid_at=?2, konsol_status=?3, updated_at=?4 WHERE id=?1`
    ).bind(id, s.paidAt, s.konsolStatus, touch()).run(),
    markFailed: (id: string, s: { failedAt: string; konsolStatus: string; error: string }) => db.prepare(
      `UPDATE ugc_payouts SET status='failed', failed_at=?2, konsol_status=?3, konsol_error=?4, updated_at=?5 WHERE id=?1`
    ).bind(id, s.failedAt, s.konsolStatus, s.error.slice(0, 500), touch()).run(),
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
    notifyOwner: (text: string) => sendOwnerTelegram(env, text),
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
export async function ugcPayoutSweep(env: Env): Promise<number> {
  const pending = await env.DB.prepare(
    `SELECT id FROM ugc_payouts WHERE status='sent' AND konsol_payment_id IS NOT NULL ORDER BY updated_at LIMIT 50`
  ).all<{ id: string }>();
  let refreshed = 0;
  for (const r of pending.results ?? []) {
    const out = await refreshUgcPayout(env, r.id);
    if (out.ok) refreshed++;
  }
  return refreshed;
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
  if (!rows.length) return `refreshed=${refreshed}; no Konsol payouts on ${day} — silent`;
  const sum = rows.reduce((s, r) => s + Number(r.amount_minor || 0), 0);
  const paid = rows.filter((r) => r.status === 'paid').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const accounts = await konsolClient(env).companyAccounts();
  const own = accounts.ok ? ownRubMinor(accounts.body) : null;
  const ownLine = own && own.ok ? `Свой рублёвый счёт Консоли: ${formatRub(own.own_minor)}.` : 'Свой рублёвый счёт Консоли сейчас не прочитан.';
  const [, m, d] = day.split('-');
  const text = `Выплаты блогерам за ${d}.${m}: ${rows.length} на ${formatRub(sum)}. Пришли: ${paid}` +
    (failed ? `, не прошли: ${failed}` : '') + `. ${ownLine}`;
  const sent = await sendOwnerTelegram(env, text);
  if (sent) {
    await env.DB.prepare(`INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).bind(key, day, now).run();
  } else {
    throw new Error('evening summary not delivered');
  }
  return `refreshed=${refreshed}; summary sent for ${day}: ${rows.length} payouts`;
}
