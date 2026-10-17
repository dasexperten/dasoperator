// Owner 2026-10-17 (blog_lezginka_22): «такие сложные вопросы, сначала сверяйся со мной».
// Returns, cancelled orders and money back are the ONLY Diana questions that go to
// Telegram; everything else stays in the ERP. The question carries two or three
// buttons with the exact answer Diana will send; a tap sends it to the blogger.
import type { Env } from '../types';
import { HARD_ASK } from './ig-dm-reply-guard.mjs';
import { sendOwnerQuestion } from './owner-telegram';
import { sendIgDirect } from './ig-dm-watch';

export const HARD_REASON = 'return or money back, Owner decides';
const QUESTION_KEY = (messageId: number) => `ig_hard:${messageId}`;
const SELF = 'Напишу сам';

type Question = { cid: string; handle: string; at: string; options: Record<string, string[] | null>; answered_at?: string; choice?: string };

const rub = (minor: number) => `${Math.round(minor / 100)} ₽`;

/** The answers Diana offers; pure, so the wording is tested. */
export function hardAnswers(firstName: string | null, paidMinor: number | null): Record<string, string[] | null> {
  const name = firstName ? `${firstName}, ` : '';
  const cap = (s: string) => (name ? s : s.charAt(0).toUpperCase() + s.slice(1));
  if (paidMinor && paidMinor > 0) {
    return {
      'Не возвращать': [`${name}${cap('возвращать ничего не нужно.')}`, 'Снимите, пожалуйста, ролик по-своему, как вам удобно. Будем ждать!'],
      'Вернуть деньги': [`${name}${cap('хорошо, поняла вас.')}`, `Когда Ozon вернёт деньги, переведите, пожалуйста, ${rub(paidMinor)} обратно. Номер для перевода пришлю.`],
      [SELF]: null,
    };
  }
  return {
    'Не страшно': [`${name}${cap('ничего страшного.')}`, 'Если захотите попробовать TERMO, напишите, я на связи.'],
    [SELF]: null,
  };
}

/** 'sent' | 'not_hard' | 'failed' — only a hard question is sent; nothing else reaches Telegram. */
export async function askOwnerHardQuestion(env: Env, w: { cid: string; h: string; t: string }, reason: string): Promise<'sent' | 'not_hard' | 'failed'> {
  const rows = (await env.DB.prepare(
    `SELECT text FROM ugc_ig_messages WHERE conversation_id=?1 AND direction='in' AND COALESCE(text,'')<>'' ORDER BY created_at DESC LIMIT 3`
  ).bind(w.cid).all<{ text: string }>()).results ?? [];
  const said = rows.reverse().map((r) => r.text).join('\n');
  if (!String(reason ?? '').startsWith(HARD_REASON) && !HARD_ASK.test(said)) return 'not_hard';
  const pay = await env.DB.prepare(
    `SELECT p.amount_minor, p.payout_date, r.first_name FROM ugc_payouts p LEFT JOIN ugc_payout_requisites r ON r.payout_id=p.id
      WHERE LOWER(p.handle)=?1 AND p.status='paid' ORDER BY p.created_at DESC LIMIT 1`
  ).bind(w.h).first<{ amount_minor: number; payout_date: string | null; first_name: string | null }>();
  const options = hardAnswers(pay?.first_name ?? null, pay?.amount_minor ?? null);
  const paidLine = pay ? `Мы перевели ей ${rub(pay.amount_minor)}${pay.payout_date ? ` (${pay.payout_date.split('-').reverse().slice(0, 2).join('.')})` : ''}.` : 'Мы ей ещё не платили.';
  const answers = Object.entries(options).map(([label, parts]) =>
    parts ? `${label}:\n${parts.join('\n')}` : `${label}: ничего не отправляю, разговор ждёт вас в ERP.`).join('\n\n');
  const text = `Вопрос по @${w.h}: возврат или деньги назад.\n\nОна пишет:\n${said.slice(0, 700)}\n\n${paidLine}\n\nЧто ответить:\n\n${answers}\n\nhttps://erp.dasexperten.com/ugc?search=${encodeURIComponent(w.h)}`;
  const messageId = await sendOwnerQuestion(env, text, Object.keys(options));
  if (messageId == null) return 'failed';
  const q: Question = { cid: w.cid, handle: w.h, at: w.t, options };
  await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(QUESTION_KEY(messageId), JSON.stringify(q), Date.now()).run();
  return 'sent';
}

/** A button tap from Telegram. Unknown message → not ours, the bot chats as usual. */
export async function answerHardQuestion(env: Env, messageId: number, choice: string): Promise<{ handled: boolean; note?: string }> {
  const row = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(QUESTION_KEY(messageId)).first<{ value: string }>();
  if (!row) return { handled: false };
  const q = JSON.parse(row.value) as Question;
  if (q.answered_at) return { handled: true, note: `@${q.handle}: уже ответила (${q.choice}).` };
  if (!(choice in q.options)) return { handled: true, note: `@${q.handle}: не поняла выбор, ответ не отправлен.` };
  const parts = q.options[choice];
  const save = async () => {
    q.answered_at = new Date().toISOString(); q.choice = choice;
    await env.DB.prepare(`UPDATE crm_sync_state SET value=?2, updated_at=?3 WHERE key=?1`).bind(QUESTION_KEY(messageId), JSON.stringify(q), Date.now()).run();
  };
  if (!parts) { await save(); return { handled: true, note: `@${q.handle}: ничего не отправляю, разговор ждёт вас в ERP.` }; }
  const humanAgent = Date.now() - Date.parse(q.at) > 23.5 * 3_600_000;
  const first = await sendIgDirect(env, q.handle, parts[0] ?? '', { humanAgent });
  if (!first.ok) return { handled: true, note: `@${q.handle}: Instagram не принял сообщение, ответ не отправлен. Нажмите ещё раз позже.` };
  for (const part of parts.slice(1)) {
    await new Promise((r) => setTimeout(r, 1500));
    if (!(await sendIgDirect(env, q.handle, part, { humanAgent })).ok) break;
  }
  await save();
  // The conversation is answered: the auto-reply lane closes it (keys of ig-dm-reply.ts).
  await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(`ig_reply:${q.cid}`, q.at, Date.now()).run();
  await env.DB.prepare(`DELETE FROM crm_sync_state WHERE key=?1`).bind(`ig_reply_escalated:${q.cid}`).run();
  return { handled: true, note: `Отправила @${q.handle}:\n${parts.join('\n')}` };
}
