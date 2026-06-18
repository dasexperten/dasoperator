// Reply engine: Nemotron analyzes (on the distilled canon) -> Opus 4.8 writes.
// Produces a draft only. Sending stays with the emailer skill.
import type { Env } from '../types';

let CANON_CACHE = '';
export function clearCanonCache() { CANON_CACHE = ''; }
async function canon(env: Env): Promise<string> {
  if (CANON_CACHE) return CANON_CACHE;
  // D1 hot cache first (fast), fall back to R2 source.
  try {
    const row = await env.DB.prepare("SELECT content FROM email_canon WHERE branch='email' AND key='full'").first<{ content: string }>();
    if (row?.content) { CANON_CACHE = row.content; return CANON_CACHE; }
  } catch { /* table may not exist yet */ }
  const o = await env.ARCHIVE.get('emails/email-canon/DISTILL_FULL.md');
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

  // Approved rules + stop-phrases the operator confirmed — highest priority, applied every draft.
  let approved = '';
  let appliedRules = 0, appliedStops = 0;
  try {
    const pb = await env.DB.prepare(
      "SELECT lesson, kind FROM email_playbook WHERE active = 1 ORDER BY approved_at DESC LIMIT 120"
    ).all<{ lesson: string; kind: string }>();
    const rules = (pb.results || []).filter((x) => x.kind === 'lesson');
    const stops = (pb.results || []).filter((x) => x.kind === 'stop_phrase');
    appliedRules = rules.length; appliedStops = stops.length;
    if (rules.length) approved += '\n\nОДОБРЕННЫЕ ПРАВИЛА (высший приоритет, применяй обязательно):\n' + rules.map((x) => '• ' + x.lesson).join('\n');
    if (stops.length) approved += '\n\nСТОП-ФРАЗЫ / запреты (никогда не используй):\n' + stops.map((x) => '• ' + x.lesson).join('\n');
  } catch { /* table may be empty */ }
  const brief = await nemotron(env, ANALYST_SYS, `КАНОН:\n${k.slice(0, 9000)}${approved}\n\nВХОДЯЩЕЕ:\n${incTxt}`);
  const draft = await opus(env, WRITER_SYS, `БРИФ (Nemotron):\n${brief}\n\nКАНОН (стиль и playbook):\n${k.slice(0, 9000)}${approved}\n\nВХОДЯЩЕЕ ПИСЬМО:\n${incTxt}\n\nНапиши ответ.`);
  return { brief, draft, applied_rules: appliedRules, applied_stops: appliedStops };
}
