// Diana answers Instagram Direct by herself (Owner 2026-10-16: «It should work
// automatically by itself»). Runs inside the ig_dm adaptive lane (3 / 15 / 30 min):
// every conversation whose last word is the blogger's gets one reply written by the
// model under DIANA_RULES and checked by guardReply. Money is never promised; what
// the model may not decide is left for a human (escalated, no reply).
import type { Env } from '../types';
import { callPro } from './llm';
import { DIANA_RULES, guardReply } from './ig-dm-reply-guard.mjs';
import { lastWordIsBlogger, sendIgDirect } from './ig-dm-watch';

const MAX_PER_RUN = 6;
// Let a burst of messages finish before answering.
const SETTLE_MS = 90_000;
const HANDLED_KEY = (cid: string) => `ig_reply:${cid}`;

type Msg = { direction: string; text: string | null; attachments_json: string | null; created_at: string };

export async function igDmReply(env: Env): Promise<{ replied: number; escalated: number; errors: number }> {
  const now = Date.now();
  const waiting = (await env.DB.prepare(
    `WITH last AS (SELECT conversation_id cid, MAX(created_at) t FROM ugc_ig_messages GROUP BY 1)
     SELECT m.conversation_id cid, m.created_at t, LOWER(m.from_username) h
       FROM ugc_ig_messages m JOIN last ON last.cid = m.conversation_id AND last.t = m.created_at
      WHERE m.direction = 'in' AND m.from_username IS NOT NULL
      ORDER BY m.created_at ASC LIMIT 40`
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
    const sent = await sendIgDirect(env, w.h, out.reply, { humanAgent: now - at > 23.5 * 3_600_000 });
    if (sent.ok) { replied++; await mark(); }
    else { errors++; console.warn(`[ig-reply] ${w.h}: send failed: ${sent.error}`); }
  }
  return { replied, escalated, errors };
}
