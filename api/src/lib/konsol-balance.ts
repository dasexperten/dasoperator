// Owner 2026-10-20: «показывать остаток своих рублей Консоли прямо в строке оплаченных и писать в Telegram,
// когда его не хватает на очередь». Own RUB only (balance − overdraft), never the overdraft figure.
import type { Env } from '../types';
import { konsolClient } from './konsol';
import { formatRub, ownRubMinor } from './ugc-payouts.mjs';
import { sendOwnerTelegram } from './owner-telegram';

const FEE_MINOR = 3000;

const OWN_KEY = 'konsol_own_rub:last';
const OWN_FRESH_MS = 60_000;      // younger than this: shown as is, Konsol is not asked
const OWN_TOO_OLD_MS = 15 * 60_000; // refresh keeps failing: show nothing rather than an old figure

export async function konsolOwnRub(env: Env): Promise<number | null> {
  const r = await konsolClient(env).companyAccounts().catch(() => null);
  if (!r || !r.ok) return null;
  const own = ownRubMinor(r.body);
  if (!own.ok) return null;
  const minor = Number(own.own_minor);
  // Every live answer is kept, so a screen can show the balance without asking Konsol itself.
  await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(OWN_KEY, JSON.stringify({ minor }), Date.now()).run().catch(() => undefined);
  return minor;
}

/**
 * Owner 2026-11-17: the UGC list waited 2–3 s (up to 25 s) for Konsol on every load.
 * The list reads the last stored balance at once; when it is older than a minute the live
 * figure is fetched behind the answer (`background`) and the next load shows it.
 * Without `background` and without any stored value the live figure is awaited.
 */
export async function konsolOwnRubStored(env: Env, background?: (work: Promise<unknown>) => void, now = Date.now()): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT value, updated_at FROM crm_sync_state WHERE key=?1`).bind(OWN_KEY).first<{ value: string; updated_at: number }>().catch(() => null);
  let stored: number | null = null;
  try { const minor = row ? JSON.parse(row.value).minor : null; stored = Number.isFinite(Number(minor)) && minor != null ? Number(minor) : null; } catch { stored = null; }
  const age = row ? now - Number(row.updated_at) : Infinity;
  if (age <= OWN_FRESH_MS) return stored;
  const live = konsolOwnRub(env).catch(() => null);
  if (!background) return stored == null ? live : (age <= OWN_TOO_OLD_MS ? stored : live);
  background(live);
  return age <= OWN_TOO_OLD_MS ? stored : null;
}

/** Queue = payouts waiting for the Owner's click, each with the 30 ₽ fee. */
export async function queueNeedMinor(env: Env): Promise<{ n: number; minor: number }> {
  const r = await env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount_minor),0) s FROM ugc_payouts WHERE status IN ('awaiting_approval','approved') AND konsol_payment_id IS NULL`).first<{ n: number; s: number }>();
  const n = Number(r?.n ?? 0);
  return { n, minor: Number(r?.s ?? 0) + n * FEE_MINOR };
}

/** One Telegram line when own RUB cannot cover the queue; silent again once it can. Called on events only. */
export async function warnIfShort(env: Env, ownGiven?: number | null): Promise<void> {
  const own = ownGiven ?? await konsolOwnRub(env);
  if (own == null) return;
  const q = await queueNeedMinor(env);
  const key = 'konsol_short:warned';
  if (!q.n || own >= q.minor) { await env.DB.prepare(`DELETE FROM crm_sync_state WHERE key=?1`).bind(key).run().catch(() => undefined); return; }
  const once = await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO NOTHING`)
    .bind(key, JSON.stringify({ own, need: q.minor, n: q.n }), Date.now()).run().catch(() => null);
  if ((once?.meta?.changes ?? 0) !== 1) return;
  await sendOwnerTelegram(env, `На своём счёте Консоли ${formatRub(own)}. Очередь блогерам: ${q.n} на ${formatRub(q.minor)} с комиссией. Не хватает ${formatRub(q.minor - own)}, пополните счёт. Овердрафт не трогаем.`, 'justina-timber').catch(() => false);
}
