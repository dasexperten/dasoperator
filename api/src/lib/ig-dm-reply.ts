// Diana answers Instagram Direct by herself (Owner 2026-10-16: «It should work
// automatically by itself»). Runs inside the ig_dm adaptive lane (3 / 15 / 30 min):
// every conversation whose last word is the blogger's gets one reply written by the
// model under DIANA_RULES and checked by guardReply. Money is never promised; what
// the model may not decide is left for a human (escalated, no reply).
import type { Env } from '../types';
import { callPro } from './llm';
import { DIANA_RULES, SCENARIO_CARDS, guardReply, type CleanRequisites } from './ig-dm-reply-guard.mjs';
import { lastWordIsBlogger, sendIgCards, sendIgDirect } from './ig-dm-watch';

const MAX_PER_RUN = 6;
// Let a burst of messages finish before answering.
const SETTLE_MS = 90_000;
const HANDLED_KEY = (cid: string) => `ig_reply:${cid}`;

type Msg = { direction: string; text: string | null; attachments_json: string | null; created_at: string };

async function stableId(prefix: string, input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return `${prefix}_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24)}`;
}

/** One awaiting payout per blogger: creates the creator if new, skips when a row is already open. */
async function registerPayout(env: Env, handle: string, r: CleanRequisites): Promise<void> {
  const now = Date.now();
  const known = await env.DB.prepare(`SELECT creator_id, id FROM ugc_creator_platforms WHERE platform='instagram' AND normalized_handle=?1`).bind(handle).first<{ creator_id: string; id: string }>();
  const cid = known?.creator_id ?? await stableId('ugc', `instagram:${handle}`);
  const pid = known?.id ?? await stableId('ugcp', `instagram:${handle}`);
  if (!known) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO ugc_creators (id, normalized_handle, lifecycle_stage, created_at, updated_at) VALUES (?1, ?2, 'agreed', ?3, ?3) ON CONFLICT(id) DO NOTHING`).bind(cid, handle, now),
      env.DB.prepare(`INSERT INTO ugc_creator_platforms (id, creator_id, platform, handle, normalized_handle, profile_url, source, created_at, updated_at) VALUES (?1, ?2, 'instagram', ?3, ?3, ?4, 'ugc_payout', ?5, ?5) ON CONFLICT(platform, normalized_handle) DO NOTHING`).bind(pid, cid, handle, `https://www.instagram.com/${handle}/`, now),
    ]);
  }
  const open = await env.DB.prepare(`SELECT COUNT(*) n FROM ugc_payouts WHERE creator_id=?1 AND status IN ('awaiting_approval','approved','sent')`).bind(cid).first<{ n: number }>();
  if (Number(open?.n ?? 0) > 0) return;
  const id = crypto.randomUUID();
  const day = new Date(now + 4 * 3_600_000).toISOString().slice(0, 10);
  const masked = `${r.phone.slice(0, 5)}*****${r.phone.slice(-2)}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ugc_payouts (id, creator_id, creator_platform_id, platform, handle, amount_minor, currency, status, payout_date, phone_masked, fps_bank_member_id, note, created_by, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'instagram', ?4, ?5, 'RUB', 'awaiting_approval', ?6, ?7, ?8, 'Реквизиты из переписки — заведено автоответом Дианы.', 'Diana Helios (auto)', ?9, ?9)`)
      .bind(id, cid, pid, handle, r.amount_minor, day, masked, r.bank, now),
    env.DB.prepare(`INSERT INTO ugc_payout_requisites (payout_id, fps_mobile_phone, first_name, last_name, patronymic, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`)
      .bind(id, r.phone, r.first_name, r.last_name, r.patronymic, now),
  ]);
}

export async function igDmReply(env: Env): Promise<{ replied: number; escalated: number; errors: number }> {
  const now = Date.now();
  const waiting = (await env.DB.prepare(
    `WITH last AS (SELECT conversation_id cid, MAX(created_at) t FROM ugc_ig_messages GROUP BY 1)
     SELECT m.conversation_id cid, m.created_at t, LOWER(m.from_username) h
       FROM ugc_ig_messages m JOIN last ON last.cid = m.conversation_id AND last.t = m.created_at
      WHERE m.direction = 'in' AND m.from_username IS NOT NULL
      ORDER BY m.created_at DESC LIMIT 40`
  ).all<{ cid: string; t: string; h: string }>()).results ?? [];
  let replied = 0, escalated = 0, errors = 0;
  for (const w of waiting) {
    if (replied + escalated >= MAX_PER_RUN) break;
    const at = Date.parse(w.t);
    if (!Number.isFinite(at) || now - at < SETTLE_MS || now - at > 7 * 86_400_000) continue;
    const done = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(HANDLED_KEY(w.cid)).first<{ value: string }>();
    if (done?.value === w.t) continue;
    const mark = () => env.DB.prepare(
      `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(HANDLED_KEY(w.cid), w.t, Date.now()).run();

    const history = ((await env.DB.prepare(
      `SELECT direction, text, attachments_json, created_at FROM ugc_ig_messages WHERE conversation_id=?1 ORDER BY created_at DESC LIMIT 20`
    ).bind(w.cid).all<Msg>()).results ?? []).reverse();
    const creator = await env.DB.prepare(
      `SELECT c.id, c.display_name, c.city FROM ugc_creators c WHERE c.normalized_handle=?1`
    ).bind(w.h).first<{ id: string; display_name: string | null; city: string | null }>();
    const payouts = creator ? ((await env.DB.prepare(
      `SELECT amount_minor, status, payout_date FROM ugc_payouts WHERE creator_id=?1 ORDER BY created_at DESC LIMIT 5`
    ).bind(creator.id).all<{ amount_minor: number; status: string; payout_date: string }>()).results ?? []) : [];
    const paid = payouts.some((p) => p.status === 'paid');
    const erp = payouts.length
      ? payouts.map((p) => `${Math.round(p.amount_minor / 100)} ₽ — ${p.status === 'paid' ? 'paid (перевод исполнен)' : p.status === 'failed' ? 'failed (банк отклонил)' : 'ждёт оплаты'} (${p.payout_date})`).join('; ')
      : 'выплат нет';
    const lines = history.map((m) => {
      const body = (m.text && m.text.trim()) || (m.attachments_json && m.attachments_json !== '[]' ? '[фото или вложение]' : '');
      return `${m.direction === 'in' ? 'Блогер' : 'Мы'} (${m.created_at.slice(5, 16)}): ${body}`;
    }).join('\n');
    const context = `Блогер: @${w.h}${creator?.display_name ? `, ${creator.display_name}` : ''}${creator?.city ? `, ${creator.city}` : ''}\nERP, выплаты: ${erp}\n\nПереписка (последние сообщения):\n${lines}\n\nНапиши следующий ответ Дианы.`;

    let raw = '';
    try {
      const r = await callPro([{ role: 'system', content: DIANA_RULES }, { role: 'user', content: context }], { env, maxTokens: 400, temperature: 0.2, prefer: 'anthropic' })
        .catch(() => callPro([{ role: 'system', content: DIANA_RULES }, { role: 'user', content: context }], { env, maxTokens: 400, temperature: 0.2 }));
      raw = r.text;
    } catch (e) {
      errors++;
      console.warn(`[ig-reply] ${w.h}: model failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const out = guardReply(raw, { paid });
    if (!out.reply) {
      if (out.escalate) {
        escalated++;
        await env.DB.prepare(
          `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).bind(`ig_reply_escalated:${w.cid}`, JSON.stringify({ handle: w.h, at: w.t, reason: out.reason }), Date.now()).run();
      }
      await mark();
      continue;
    }
    // The ERP copy can lag behind Instagram; never answer a conversation we already answered.
    if (!(await lastWordIsBlogger(env, w.cid))) { await mark(); continue; }
    // Full requisites in the chat → a brown payout row at once (DH-LAW-261015-04 p.6, Owner 2026-10-16).
    if (out.requisites) { try { await registerPayout(env, w.h, out.requisites); } catch (e) { console.warn(`[ig-reply] ${w.h}: payout row failed: ${e instanceof Error ? e.message : String(e)}`); } }
    const sent = await sendIgDirect(env, w.h, out.reply, { humanAgent: now - at > 23.5 * 3_600_000 });
    if (sent.ok && out.sendCards) await sendIgCards(env, w.h, SCENARIO_CARDS, { humanAgent: now - at > 23.5 * 3_600_000 });
    if (sent.ok) { replied++; await mark(); }
    else { errors++; console.warn(`[ig-reply] ${w.h}: send failed: ${sent.error}`); }
  }
  return { replied, escalated, errors };
}
