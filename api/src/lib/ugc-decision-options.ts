import type { Env } from '../types';
import { callPro } from './llm';

// Owner 2026-11-04: on a business exclamation mark the Owner (or Diana's manager) picks a ready decision
// instead of typing one. The options are written from the blogger's own message; the pick is saved as the
// decision text and Diana answers by it through the existing delivery path (Jev included).
export type DecisionOption = { title: string; detail: string; decision: string };

const KEY = (cid: string) => `ig_decision_options:${cid}`;

const FALLBACK: DecisionOption[] = [
  { title: 'Выяснить подробности', detail: 'Мягко спросить, что именно мешает', decision: 'Ничего не обещай и не закрывай. Мягко и с теплом спроси, что именно мешает выполнить условия, и предложи вместе найти вариант.' },
  { title: 'Предложить другой вариант', detail: 'Подстроиться под блогера, срок продлить', decision: 'Предложи блогеру удобный ей вариант выполнения условий и продли срок на две недели. Деньги не возвращать и сотрудничество не закрывать.' },
  { title: 'Закрыть сотрудничество', detail: 'Принять отказ вежливо', decision: 'Принять отказ блогера. Поблагодари её, скажи, что дверь для сотрудничества остаётся открытой. Выплату не обсуждай, если она сама не подняла вопрос.' },
];

function parseOptions(raw: string): DecisionOption[] | null {
  try {
    const j = JSON.parse(String(raw).match(/\[[\s\S]*\]/)?.[0] ?? 'null');
    if (!Array.isArray(j)) return null;
    const out = j.map((o) => ({
      title: String(o?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 70),
      detail: String(o?.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 110),
      decision: String(o?.decision ?? '').replace(/\s+/g, ' ').trim().slice(0, 480),
    })).filter((o) => o.title && o.decision);
    return out.length >= 2 ? out.slice(0, 4) : null;
  } catch { return null; }
}

export async function decisionOptions(env: Env, creatorId: string): Promise<{ options: DecisionOption[]; source: 'model' | 'fallback' | 'cache' } | { error: string }> {
  const handles = ((await env.DB.prepare('SELECT normalized_handle h FROM ugc_creator_platforms WHERE creator_id=?1').bind(creatorId).all<{ h: string }>()).results ?? []).map((r) => String(r.h).toLowerCase());
  if (!handles.length) return { error: 'Creator not found' };
  const conv = await env.DB.prepare(`SELECT conversation_id cid FROM ugc_ig_messages WHERE direction='in' AND LOWER(from_username) IN (${handles.map((_, i) => `?${i + 1}`).join(',')}) ORDER BY created_at DESC LIMIT 1`).bind(...handles).first<{ cid: string }>();
  if (!conv) return { error: 'Переписки нет' };
  const msgs = ((await env.DB.prepare('SELECT direction, text, created_at FROM ugc_ig_messages WHERE conversation_id=?1 ORDER BY created_at DESC LIMIT 8').bind(conv.cid).all<{ direction: string; text: string | null; created_at: string }>()).results ?? []).reverse();
  const lastAt = msgs.length ? msgs[msgs.length - 1]!.created_at : '';
  const cached = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(KEY(conv.cid)).first<{ value: string }>();
  try { const c = JSON.parse(cached?.value ?? 'null'); if (c && c.at === lastAt && Array.isArray(c.options) && c.options.length) return { options: c.options, source: 'cache' }; } catch { /* regenerate */ }

  const payouts = ((await env.DB.prepare('SELECT status, amount_minor FROM ugc_payouts WHERE creator_id=?1 ORDER BY created_at DESC LIMIT 3').bind(creatorId).all<{ status: string; amount_minor: number }>()).results ?? [])
    .map((p) => `${p.status} ${Math.round(p.amount_minor / 100)} ₽`).join('; ') || 'выплат нет';
  const dialog = msgs.map((m) => `${m.direction === 'in' ? 'Блогер' : 'Мы'}: ${String(m.text ?? '[вложение]').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const system = `Ты помогаешь владельцу бренда ухода за зубами быстро принять решение по блогеру из бартерной программы в Instagram. Диана, наш менеджер, потом сама напишет блогеру по выбранному решению.
Предложи от 2 до 4 РАЗНЫХ решений, которые ведут к разным исходам (например: сохранить сотрудничество с уступкой, перенести срок, принять отказ и закрыть). Опирайся только на сообщения блогера и факты ниже, ничего не выдумывай: ни сумм, ни сроков, которых там нет, ни реквизитов. Решение по возврату денег предлагай, только если блогер сам об этом пишет.
Ответь ТОЛЬКО JSON-массивом без пояснений: [{"title":"до 7 слов, что делаем","detail":"до 14 слов, что это значит для блогера и для нас","decision":"готовое указание Диане одним-двумя предложениями: что ответить блогеру и чего не делать"}].
Пиши по-русски, спокойно и без лишних слов. Кавычки в тексте не используй.`;
  const user = `Факты по выплате: ${payouts}\n\nПереписка:\n${dialog}`;
  let options: DecisionOption[] | null = null;
  try {
    const r = await callPro([{ role: 'system', content: system }, { role: 'user', content: user }], { env, maxTokens: 900, temperature: 0.3, prefer: 'anthropic' })
      .catch(() => callPro([{ role: 'system', content: system }, { role: 'user', content: user }], { env, maxTokens: 900, temperature: 0.3 }));
    options = parseOptions(r.text);
  } catch { options = null; }
  if (!options) return { options: FALLBACK, source: 'fallback' };
  await env.DB.prepare(`INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(KEY(conv.cid), JSON.stringify({ at: lastAt, options }), Date.now()).run();
  return { options, source: 'model' };
}
