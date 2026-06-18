// Reply engine: Nemotron analyzes (on the distilled canon) -> Opus 4.8 writes.
// Produces a draft only. Sending stays with the emailer skill.
import type { Env } from '../types';

let CANON_CACHE = '';
async function canon(env: Env): Promise<string> {
  if (CANON_CACHE) return CANON_CACHE;
  const o = await env.ARCHIVE.get('email-canon/DISTILL_FULL.md');
  CANON_CACHE = o ? await o.text() : '';
  return CANON_CACHE;
}

async function nemotron(env: Env, sys: string, usr: string): Promise<string> {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENROUTER_ERP}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nvidia/nemotron-3-ultra-550b-a55b', temperature: 0.2, max_tokens: 1200,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }] }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await r.json<any>();
  return j?.choices?.[0]?.message?.content || '';
}

async function opus(env: Env, sys: string, usr: string): Promise<string> {
  // Opus 4.8 via OpenRouter (Anthropic direct key is stale) — ERP contour.
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.OPENROUTER_ERP}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'anthropic/claude-opus-4.8', max_tokens: 1600, temperature: 0.3,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }] }),
    signal: AbortSignal.timeout(180_000),
  });
  const j = await r.json<any>();
  return (j?.choices?.[0]?.message?.content) || (j?.error ? `[opus error: ${j.error?.message}]` : '');
}

const ANALYST_SYS = 'Ты Nemotron — аналитический слой email-агента Арама (Das Experten, oral care). Тебе дают КАНОН (классификация + playbook-и из реальной почты) и входящее письмо. Выдай СТРОГО компактный JSON-бриф: {"group":"","route":"","key_facts":"","must":"","avoid":"","outline":""}. Без рассуждений.';
const WRITER_SYS = 'Ты пишешь email от лица Арама (Das Experten). Тебе дают бриф анализа и канон стиля. Напиши ГОТОВЫЙ ответ на языке входящего письма, в голосе Арама из канона: кратко, по делу, без воды и лишних извинений. Соблюдай hard rules: не выдумывай реквизиты/IBAN/номера; не упоминай немецкое происхождение; подпись как в каноне. Выдай ТОЛЬКО текст письма.';

export async function draftReply(env: Env, inc: { sender: string; subject: string; body: string }) {
  const k = await canon(env);
  const incTxt = `От: ${inc.sender}\nТема: ${inc.subject || '(без темы)'}\nТекст:\n${(inc.body || '').slice(0, 2500)}`;
  const brief = await nemotron(env, ANALYST_SYS, `КАНОН:\n${k.slice(0, 9000)}\n\nВХОДЯЩЕЕ:\n${incTxt}`);
  const draft = await opus(env, WRITER_SYS, `БРИФ (Nemotron):\n${brief}\n\nКАНОН (стиль и playbook):\n${k.slice(0, 9000)}\n\nВХОДЯЩЕЕ ПИСЬМО:\n${incTxt}\n\nНапиши ответ.`);
  return { brief, draft };
}
