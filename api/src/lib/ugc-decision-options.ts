import type { Env } from '../types';
import { callFlash } from './llm';

// Owner 2026-11-04: on a business exclamation mark the Owner (or Diana's manager) picks a ready decision
// instead of typing one. The options are written from the blogger's own message; the pick is saved as the
// decision text and Diana answers by it through the existing delivery path (Jev included).
export type DecisionOption = { title: string; detail: string; decision: string };

const KEY = (cid: string) => `ig_decision_options_v3:${cid}`;

const FALLBACK: DecisionOption[] = [
  { title: 'Выяснить подробности', detail: 'Мягко спросить, что именно мешает', decision: 'Ничего не обещай и не закрывай. Мягко и с теплом спроси, что именно мешает выполнить условия, и предложи вместе найти вариант.' },
  { title: 'Предложить другой вариант', detail: 'Подстроиться под блогера, срок продлить', decision: 'Предложи блогеру удобный ей вариант выполнения условий и продли срок на две недели. Деньги не возвращать и сотрудничество не закрывать.' },
  { title: 'Закрыть сотрудничество', detail: 'Принять отказ вежливо', decision: 'Принять отказ блогера. Поблагодари её, скажи, что дверь для сотрудничества остаётся открытой. Выплату не обсуждай, если она сама не подняла вопрос.' },
];

export type DecisionSet = { summary: string; quote: string; options: DecisionOption[] };

function parseOptions(raw: string): DecisionSet | null {
  try {
    const top = JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] ?? 'null');
    const j = top?.options;
    if (!Array.isArray(j)) return null;
    const out = j.map((o) => ({
      title: String(o?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 48),
      detail: String(o?.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 110),
      decision: String(o?.decision ?? '').replace(/\s+/g, ' ').trim().slice(0, 480),
    })).filter((o) => o.title && o.decision);
    const clean = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    return out.length >= 3 ? { summary: clean(top.summary, 110), quote: clean(top.quote, 120), options: out.slice(0, 3) } : null;
  } catch { return null; }
}

export async function decisionOptions(env: Env, creatorId: string): Promise<(DecisionSet & { source: 'model' | 'fallback' | 'cache' }) | { error: string }> {
  const handles = ((await env.DB.prepare('SELECT normalized_handle h FROM ugc_creator_platforms WHERE creator_id=?1').bind(creatorId).all<{ h: string }>()).results ?? []).map((r) => String(r.h).toLowerCase());
  if (!handles.length) return { error: 'Creator not found' };
  const conv = await env.DB.prepare(`SELECT conversation_id cid FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username) IN (${handles.map((_, i) => `?${i + 1}`).join(',')}) ORDER BY created_at DESC LIMIT 1`).bind(...handles).first<{ cid: string }>();
  if (!conv) return { error: 'Переписки нет' };
  const msgs = ((await env.DB.prepare('SELECT direction, text, created_at FROM ugc_ig_messages WHERE conversation_id=?1 ORDER BY created_at DESC LIMIT 8').bind(conv.cid).all<{ direction: string; text: string | null; created_at: string }>()).results ?? []).reverse();
  const lastAt = msgs.length ? msgs[msgs.length - 1]!.created_at : '';
  const cached = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(KEY(conv.cid)).first<{ value: string }>();
  try { const c = JSON.parse(cached?.value ?? 'null'); if (c && c.at === lastAt && Array.isArray(c.options) && c.options.length === 3) return { summary: c.summary ?? '', quote: c.quote ?? '', options: c.options, source: 'cache' }; } catch { /* regenerate */ }

  const payouts = ((await env.DB.prepare('SELECT status, amount_minor FROM ugc_payouts WHERE creator_id=?1 ORDER BY created_at DESC LIMIT 3').bind(creatorId).all<{ status: string; amount_minor: number }>()).results ?? [])
    .map((p) => `${p.status} ${Math.round(p.amount_minor / 100)} ₽`).join('; ') || 'выплат нет';
  const dialog = msgs.map((m) => `${m.direction === 'in' ? 'Блогер' : 'Мы'}: ${String(m.text ?? '[вложение]').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const system = `Ты помогаешь владельцу бренда ухода за зубами быстро принять решение по блогеру из бартерной программы в Instagram. Диана, наш менеджер, потом сама напишет блогеру по выбранному решению.
Предложи РОВНО 3 РАЗНЫХ решения, которые ведут к разным исходам (например: сохранить сотрудничество с уступкой, перенести срок, принять отказ и закрыть). Опирайся только на сообщения блогера и факты ниже, ничего не выдумывай: ни сумм, ни сроков, которых там нет, ни реквизитов. Решение по возврату денег предлагай, только если блогер сам об этом пишет.
Ответь ТОЛЬКО JSON-объектом без пояснений: {"summary":"до 12 слов: чего хочет блогер, например Блогер просит вернуть деньги, отказывается от ролика","quote":"самая суть её слов одной короткой фразой, её словами, до 12 слов","options":[{"title":"3-5 слов, что делаем; три названия примерно одной длины","detail":"до 14 слов, что это значит","decision":"готовое указание Диане одним-двумя предложениями: что ответить блогеру и чего не делать"}]}.
Никогда не называй в решении реквизиты, номера счетов, телефоны или банки и не поручай Диане их писать: если речь о возврате денег, поручи сказать, что реквизиты для возврата пришлёт ответственный сотрудник отдельным сообщением. Пиши по-русски, спокойно и без лишних слов. Кавычки в тексте не используй.`;
  const user = `Факты по выплате: ${payouts}\n\nПереписка:\n${dialog}`;
  let options: DecisionSet | null = null;
  try {
    const r = await callFlash([{ role: 'system', content: system }, { role: 'user', content: user }], { env, maxTokens: 700, temperature: 0.3, prefer: 'anthropic' })
      .catch(() => callFlash([{ role: 'system', content: system }, { role: 'user', content: user }], { env, maxTokens: 700, temperature: 0.3 }));
    options = parseOptions(r.text);
  } catch { options = null; }
  if (!options) return { summary: 'Блогер написал, нужно решение', quote: '', options: FALLBACK, source: 'fallback' };
  await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(KEY(conv.cid), JSON.stringify({ at: lastAt, ...options }), Date.now()).run();
  return { ...options, source: 'model' };
}

// Owner 2026-11-04: the hover card was slow because the model ran on hover. Every minute the direct lane warms the
// options for creators whose chat waits for a business decision, so the card opens from the cache.
export async function warmDecisionOptions(env: Env, limit = 3): Promise<number> {
  const rows = (await env.DB.prepare(`
    WITH latest AS (SELECT conversation_id, MAX(created_at) at FROM ugc_ig_messages GROUP BY conversation_id)
    SELECT COALESCE((SELECT p.creator_id FROM ugc_creator_platforms p WHERE p.platform='instagram' AND p.normalized_handle=json_extract(state.value,'$.handle') LIMIT 1),
        (SELECT p.creator_id FROM ugc_creator_platforms p WHERE p.platform='other' AND p.normalized_handle=json_extract(state.value,'$.handle') LIMIT 1)) creator_id,
      latest.conversation_id cid, latest.at at
    FROM crm_sync_state state
      JOIN latest ON state.key='ig_reply_escalated:'||latest.conversation_id
      JOIN ugc_ig_messages m ON m.conversation_id=latest.conversation_id AND m.created_at=latest.at
    WHERE m.direction='in' AND json_valid(state.value) AND json_extract(state.value,'$.at')=latest.at
      AND json_extract(state.value,'$.kind')='business' AND json_extract(state.value,'$.status')='needs_review'
      AND NOT EXISTS (SELECT 1 FROM crm_sync_state c WHERE c.key='${'ig_decision_options_v3:'}'||latest.conversation_id AND json_extract(c.value,'$.at')=latest.at)
    LIMIT ?1`).bind(limit).all<{ creator_id: string | null }>().catch(() => ({ results: [] as Array<{ creator_id: string | null }> }))).results ?? [];
  let done = 0;
  for (const r of rows) { if (!r.creator_id) continue; const out = await decisionOptions(env, r.creator_id).catch(() => null); if (out && !('error' in out)) done++; }
  return done;
}
