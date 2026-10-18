// Owner 2026-10-18: «Мне не нужны никакие автоматические сообщения ни к какому из блогеров.
// ERP только проверяет, читает, анализирует… любой текст, любой месседж пишет Диана своим голосом.»
// The ERP hands Diana a brief (facts and intent, never the words); Diana writes the message from
// her full JEV context and the conversation, and the voice controller reads it before it leaves.
// No brief ever reaches the blogger as text: if Diana cannot write, nothing is sent.
import type { Env } from '../types';
import { callPro } from './llm';
import { prepareDianaContext } from './diana-context.mjs';
import { checkDianaVoice } from './diana-voice-check';
import { shortParts } from './ig-dm-reply-guard.mjs';

export async function dianaCompose(env: Env, handle: string, brief: string): Promise<string[] | null> {
  const conv = await env.DB.prepare(
    `SELECT conversation_id FROM ugc_ig_messages WHERE LOWER(from_username)=?1 AND direction='in' ORDER BY created_at DESC LIMIT 1`
  ).bind(handle.toLowerCase()).first<{ conversation_id: string }>();
  const history = conv ? ((await env.DB.prepare(
    `SELECT direction, text, created_at FROM ugc_ig_messages WHERE conversation_id=?1 ORDER BY created_at DESC LIMIT 30`
  ).bind(conv.conversation_id).all<{ direction: string; text: string | null; created_at: string }>()).results ?? []).reverse() : [];
  const lines = history.map((m) => `${m.direction === 'in' ? 'Блогер' : 'Мы'} (${m.created_at.slice(5, 16)}): ${(m.text ?? '').trim() || '[фото или вложение]'}`).join('\n');
  const task = `Блогер: @${handle}\n\nПереписка (последние сообщения):\n${lines || '(нет)'}\n\nПОРУЧЕНИЕ ERP (это факты и смысл, а не готовый текст — пиши своими словами, голосом Дианы):\n${brief}`;
  const prepared = await prepareDianaContext({ task,
    githubToken: (env as unknown as { GITHUB_TOKEN?: string }).GITHUB_TOKEN ?? '',
    jevKey: env.OPENROUTER_ERP ?? '' });
  // Owner 2026-10-18: «через JEV подгружает под каждую задачу нужную информацию». No JEV picks — no message.
  const receipt = (prepared as { receipt?: { entries?: unknown[]; skills?: unknown[]; method?: string } }).receipt ?? {};
  if (!Array.isArray(receipt.entries) || !receipt.entries.length) return null;
  await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(`diana_compose:${handle.toLowerCase()}`, JSON.stringify({ ...receipt, brief: brief.slice(0, 400), at: new Date().toISOString() }), Date.now()).run().catch(() => undefined);
  const spec = 'Верни строго JSON без пояснений: {"replies":["…","…"]} — 1–4 коротких сообщения подряд, каждое одно-два предложения, вопрос только в последнем. Без приветствия посреди разговора, без тире, без шаблонных фраз. Не обещай того, чего нет в поручении.';
  let feedback = '';
  for (let pass = 0; pass < 2; pass++) {
    const r = await callPro([{ role: 'system', content: `${prepared.system}\n\n${spec}` }, { role: 'user', content: task + feedback }], { env, maxTokens: 600, temperature: 0.4, prefer: 'anthropic' })
      .catch(() => callPro([{ role: 'system', content: `${prepared.system}\n\n${spec}` }, { role: 'user', content: task + feedback }], { env, maxTokens: 600, temperature: 0.4 }));
    const m = String(r.text ?? '').match(/\{[\s\S]*\}/);
    if (!m) continue;
    let replies: string[] = [];
    try { const j = JSON.parse(m[0]) as { replies?: unknown }; replies = Array.isArray(j.replies) ? j.replies.map((x) => String(x).trim()).filter(Boolean).slice(0, 4) : []; } catch { continue; }
    if (!replies.length || replies.some((x) => x.length > 600)) continue;
    const v = await checkDianaVoice(env, String((prepared as { voice?: string }).voice ?? ''), replies.join('\n'), history.filter((h) => h.direction === 'in').slice(-2).map((h) => h.text ?? '').join(' '));
    if (v.ok) return shortParts(replies); // Owner 2026-10-18: about 90 characters per bubble
    feedback = `\n\nПРОШЛЫЙ ВАРИАНТ ОТКЛОНЁН КОНТРОЛЁРОМ ГОЛОСА: ${v.why} Перепиши тем же смыслом строго в голосе Дианы.`;
  }
  return null;
}
