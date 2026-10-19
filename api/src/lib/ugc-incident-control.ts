// Owner 2026-10-19: «Ввести закон контроля обращений, проверка раз в час».
// Once an hour: every exclamation mark (an open auto-reply incident) older than an hour gets its owner.
// Technical → Mina (fix the cause). Business, waiting for a decision → one Telegram line to the Owner.
// Each incident is handed over once; the hour gate lives in crm_sync_state, the tick only asks «is it time?».
import type { Env } from '../types';
import { readReplyState } from './ig-dm-reply-state.mjs';
import { handToMina } from './mina-alert';
import { sendOwnerTelegram } from './owner-telegram';

const HOUR = 3_600_000;
const GATE = 'incident_control:last';

export async function incidentControl(env: Env, now = Date.now()): Promise<string> {
  const gate = await env.DB.prepare(`SELECT value FROM crm_sync_state WHERE key=?1`).bind(GATE).first<{ value: string }>();
  if (gate?.value && now - Number(gate.value) < HOUR) return 'incident control: not due';
  await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(GATE, String(now), now).run();
  const rows = (await env.DB.prepare(`
    WITH latest AS (SELECT conversation_id cid, MAX(created_at) at FROM ugc_ig_messages GROUP BY conversation_id)
    SELECT s.key, s.value, latest.cid,
      (SELECT GROUP_CONCAT(COALESCE(NULLIF(m.text,''),'[фото]'), ' / ') FROM (SELECT text FROM ugc_ig_messages
         WHERE conversation_id=latest.cid AND direction='in' ORDER BY created_at DESC LIMIT 3) m) last_in
    FROM crm_sync_state s JOIN latest ON s.key='ig_reply_escalated:'||latest.cid
    JOIN ugc_ig_messages w ON w.conversation_id=latest.cid AND w.created_at=latest.at AND w.direction='in'
    WHERE json_valid(s.value) AND json_extract(s.value,'$.at')=latest.at`).all<{ key: string; value: string; cid: string; last_in: string | null }>()).results ?? [];
  let mina = 0; const owner: string[] = [];
  for (const r of rows) {
    const st = readReplyState(r.value);
    if (!st || now - Date.parse(st.at) < HOUR) continue;
    const technical = st.kind === 'technical' || st.kind === 'stuck' || st.status === 'retry';
    const id = `${r.cid}:${st.at}`;
    if (technical) {
      const text = [`ERP, контроль обращений: восклицательный знак у @${st.handle} висит больше часа.`,
        `Причина: ${st.reason}. Попыток: ${st.attempts ?? '?'}.`, `Последнее от блогера: ${(r.last_in ?? '').slice(0, 300)}.`,
        'Найди причину в ERP и почини её, не перезапуская вслепую. Блогер ждёт ответа Дианы.'].join('\n');
      if (await handToMina(env, `mina_alert:incident:${id}`, text).catch(() => false)) mina++;
    } else {
      const once = await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO NOTHING`)
        .bind(`owner_alert:incident:${id}`, st.reason, now).run().catch(() => null);
      if ((once?.meta?.changes ?? 0) === 1) owner.push(`@${st.handle}: ${st.reason.slice(0, 140)}. Последнее: ${(r.last_in ?? '').slice(0, 120)}`);
    }
  }
  if (owner.length) await sendOwnerTelegram(env, [`Диана ждёт вашего решения больше часа (${owner.length}):`, ...owner.map((l) => `• ${l}`), 'Подробно: https://erp.dasexperten.com/ugc'].join('\n'), 'diana-helios').catch(() => false);
  return `incident control: ${rows.length} open, Mina ${mina}, Owner ${owner.length}`;
}
