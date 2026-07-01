// =============================================================================
// Review-Master Pipeline v6 — Brief-driven architecture
//
// Architecture decision 2026-05-21 (Aram):
//   - DeepSeek reads ALL skills, analyzes, prepares compact brief
//   - Claude ONLY writes text (gets brief, not skills) — minimal token use
//   - All analytical work (classify, brief, technolog, sharpen, segment) → DeepSeek
//   - Claude touches input ONLY in step 3 (write) and step 6 (rewrite if needed)
//
// Pipeline:
//   1. classify           DeepSeek       → POS/NEG/MIX/Q-PROD/Q-SCI/Q-CERT/Q-DELIV/Q-USE
//   2. brief building     DeepSeek+R2    → reads SKU+review-master+product-skill, outputs ~500-token brief
//   3. write              CLAUDE         → ONLY brief + review → writes response (~700 tokens in, ~500 out)
//   4. technolog          DeepSeek       → verify clinical claims
//   5. conversion         DeepSeek       → marketolog+benefit-gate sharpen → returns either OK or notes
//   6. rewrite (cond.)    CLAUDE         → if technolog/conversion failed: brief + notes → rewrite
//   7. segment-check      DeepSeek       → readability for 8 personas
//
// Rating-only path (no text from buyer):
//   - skips conversion gate (no need for sharpening on 200-char POS)
//   - skips segment-check (always readable)
// =============================================================================

import type { Env } from '../types';
import { callPro } from './llm';
import { codexGenerate } from './openai-codex';
import { sanitizeReply } from './sanitize';
import { loadSkillMd, loadSkuKnowledge, loadSegmentCheck } from './skill-loader';

// All Anthropic calls in this file now route through api/src/lib/llm.ts
// (Anthropic OAuth subscription → DeepSeek V4-Pro fallback). Pay-as-you-go
// Anthropic is intentionally NOT a fallback.


export type ReviewType = 'POS' | 'NEG' | 'MIX' | 'Q-PROD' | 'Q-SCI' | 'Q-CERT' | 'Q-DELIV' | 'Q-USE';

export interface PipelineInput {
  feedbackId: string;
  rating: number;
  customerName?: string | null;
  productName?: string | null;
  productSku?: string | null;
  reviewText?: string | null;
  pros?: string | null;
  cons?: string | null;
}

export interface GateResult {
  gate: string;
  status: 'pass' | 'weak' | 'fail' | 'skip';
  provider: 'claude' | 'deepseek' | 'gemini' | 'qwen' | 'rule';
  reason?: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
}

export interface PipelineResult {
  ok: boolean;
  reply: string;
  reviewType: ReviewType;
  gates: GateResult[];
  totalDurationMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  warning?: string;
}

// =============================================================================
// Provider wrappers
// =============================================================================
const CODEX_COOLDOWN_KEY = 'codex:cooldown-until';

// GPT-5.5 (ChatGPT-Plus OAuth via codex-bridge on hermes-vps) is the PRIMARY
// engine for writing customer replies (per Aram, 2026-07). DeepSeek is the
// fallback the moment the subscription quota is spent. A short KV cooldown
// stops us wasting ~8s/review hammering codex while its quota is exhausted.
async function callGpt(env: Env, system: string, user: string, maxTokens: number, temp = 0.3): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  let skipCodex = false;
  if (env.CACHE) {
    try {
      const until = await env.CACHE.get(CODEX_COOLDOWN_KEY);
      if (until && Number(until) > Date.now()) skipCodex = true;
    } catch { /* ignore */ }
  }
  if (!skipCodex && env.CODEX_BRIDGE_URL) {
    try {
      const text = await codexGenerate(env, system, user);
      return { text: text.trim(), tokensIn: 0, tokensOut: 0 };
    } catch (e) {
      if (env.CACHE) {
        try { await env.CACHE.put(CODEX_COOLDOWN_KEY, String(Date.now() + 20 * 60 * 1000), { expirationTtl: 20 * 60 }); } catch { /* ignore */ }
      }
      console.warn('[review-pipeline] codex gpt-5.5 failed, falling back to DeepSeek: ' + String((e as any)?.message ?? e).slice(0, 160));
    }
  }
  return callDeepSeek(env, system, user, maxTokens, temp);
}

async function callClaude(env: Env, system: string, user: string, maxTokens: number): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  // Reply-writing gate → GPT-5.5 primary, DeepSeek fallback (see callGpt).
  return callGpt(env, system, user, maxTokens, 0.3);
}


async function callQwen(env: Env, system: string, user: string, maxTokens: number, temp = 0.4): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  // Rating-only reply-writing gate → GPT-5.5 primary, DeepSeek fallback.
  return callGpt(env, system, user, maxTokens, temp);
}

async function callDeepSeek(env: Env, system: string, user: string, maxTokens: number, temp = 0.3): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.DEEPSEEK_API_KEY) {
    throw new Error('No LLM provider configured (need CLAUDE_CODE_OAUTH_TOKEN or DEEPSEEK_API_KEY)');
  }
  const r = await callPro(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { env, maxTokens, temperature: temp, prefer: 'deepseek' },
  );
  return {
    text: r.text.trim(),
    tokensIn: r.usage.prompt_tokens ?? 0,
    tokensOut: r.usage.completion_tokens ?? 0,
  };
}

// =============================================================================
// Pipeline helpers
// =============================================================================
function formatInput(input: PipelineInput): string {
  const lines = [
    `Платформа: Wildberries`,
    `Рейтинг: ${input.rating} из 5`,
    `Имя покупателя: ${input.customerName ?? '(не указано)'}`,
    `Товар: ${input.productName ?? '(не указано)'}`,
    `SKU: ${input.productSku ?? '(не указан)'}`,
  ];
  if (input.reviewText) lines.push('', 'Текст отзыва:', input.reviewText);
  else lines.push('', '(Покупатель оставил только оценку — без текста)');
  if (input.pros) lines.push('', 'Достоинства:', input.pros);
  if (input.cons) lines.push('', 'Недостатки:', input.cons);
  return lines.join('\n');
}

function extractJson(text: string): any | null {
  // DeepSeek may wrap JSON in ```json ... ``` or just output it; also reasoning may leak
  const codeBlock = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1]); } catch {}
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

// =============================================================================
// MAIN PIPELINE — used for text reviews (buyer wrote something)
// =============================================================================
export async function runReviewMasterPipeline(env: Env, input: PipelineInput): Promise<PipelineResult> {
  const startedAt = Date.now();
  const gates: GateResult[] = [];
  let totalIn = 0, totalOut = 0;

  // ===========================================================================
  // GATE 1 — classify (DeepSeek)
  // ===========================================================================
  const t1 = Date.now();
  const classifySystem = `Ты классификатор отзывов. Категории:
POS — позитивный (3-5★, доволен)
NEG — негативный (1-2★, жалоба)
MIX — нейтральный (3★, неоднозначный)
Q-PROD — вопрос про продукт/ингредиент
Q-SCI — научный вопрос
Q-CERT — про сертификаты/ГОСТ/ISO
Q-DELIV — про доставку
Q-USE — как использовать
Ответь ровно одной строкой: код категории.`;
  const r1 = await callDeepSeek(env, classifySystem, formatInput(input), 8000, 0.0);
  totalIn += r1.tokensIn; totalOut += r1.tokensOut;
  const validTypes: ReviewType[] = ['POS','NEG','MIX','Q-PROD','Q-SCI','Q-CERT','Q-DELIV','Q-USE'];
  let reviewType: ReviewType = 'POS';
  for (const t of validTypes) if (r1.text.toUpperCase().startsWith(t)) { reviewType = t; break; }
  if (!validTypes.some(t => r1.text.toUpperCase().startsWith(t))) {
    reviewType = input.rating >= 4 ? 'POS' : input.rating <= 2 ? 'NEG' : 'MIX';
  }
  gates.push({ gate: 'classify', status: 'pass', provider: 'deepseek', reason: reviewType, tokensIn: r1.tokensIn, tokensOut: r1.tokensOut, durationMs: Date.now() - t1 });

  // ===========================================================================
  // GATE 2 — brief building (DeepSeek reads review-master + product-skill + SKU)
  // ===========================================================================
  const t2 = Date.now();
  const skuKnowledge = await loadSkuKnowledge(env, input.productSku ?? '').catch(() => '');
  const reviewMaster = await loadSkillMd(env, 'review-master').catch(() => '');
  const productSkill = await loadSkillMd(env, 'product-skill').catch(() => '');

  const briefSystem = `Ты — brief-builder. Читаешь полные skill инструкции и SKU знание, составляешь КОМПАКТНОЕ задание для копирайтера на ~400 токенов.

ТЫ НЕ ПИШЕШЬ ОТВЕТ. Ты пишешь BRIEF в формате JSON.

JSON содержит:
{
  "type": "POS" | "NEG" | "MIX" | "Q-PROD" | "Q-SCI" | "Q-CERT" | "Q-DELIV" | "Q-USE",
  "customer_name": "имя или null",
  "product": "короткое название бренда (SCHWARZ, SYMBIOS и т.д.)",
  "key_fact": "ОДИН самый подходящий факт из SKU card — конкретный, с цифрой если есть",
  "tone": "уверенный/тёплый/нейтральный/направляющий",
  "length_chars": 200-600,
  "must_include": ["обращение по имени", "ключевой факт"],
  "must_avoid": ["спасибо за пятёрку", "к сожалению"],
  "voice_doctrine": "1-2 предложения из review-master skill — самые важные правила для этого типа",
  "neg_strategy": "только для NEG: do not apologize / redirect / recommend alternative"
}

ЗАДАЧА: прочитай skills, выбери только то что нужно ИМЕННО для этого отзыва, составь brief.
ВЫХОД: только JSON, без префиксов.

=== REVIEW-MASTER SKILL ===
${reviewMaster}

=== PRODUCT-SKILL ===
${productSkill}

=== SKU KNOWLEDGE ===
${skuKnowledge}`;

  const r2 = await callDeepSeek(env, briefSystem, formatInput(input), 8000, 0.2);
  totalIn += r2.tokensIn; totalOut += r2.tokensOut;
  let brief = extractJson(r2.text);
  if (!brief) {
    brief = {
      type: reviewType,
      customer_name: input.customerName ?? null,
      product: input.productName ?? '',
      key_fact: '(no brief extracted)',
      tone: 'уверенный',
      length_chars: 300,
      must_include: ['обращение по имени', 'конкретный факт'],
      must_avoid: ['спасибо за пятёрку'],
      voice_doctrine: 'без шаблонов, без извинений, конкретно',
    };
  }
  gates.push({ gate: 'brief', status: 'pass', provider: 'deepseek', reason: `keyFact: ${(brief.key_fact || '').slice(0,80)}`, tokensIn: r2.tokensIn, tokensOut: r2.tokensOut, durationMs: Date.now() - t2 });

  // ===========================================================================
  // GATE 3 — technolog PRE-FLIGHT (DeepSeek + technolog skill) — ALWAYS RUNS
  // Validates which clinical facts may be used BEFORE Claude writes anything.
  // ===========================================================================
  const t3 = Date.now();
  const technologMd = await loadSkillMd(env, 'technolog').catch(() => '');
  const technologSystem = `Ты — technolog gate (предполётная проверка фактов). Ты НЕ пишешь ответ.
На основе SKU-знания и отзыва определи, какие клинические/составные факты копирайтер МОЖЕТ использовать, и какие формулировки ЗАПРЕЩЕНЫ.

ВЫХОД строго:
CLEARED_FACTS:
- <конкретный проверенный факт с цифрой/механизмом, который можно использовать>
FORBIDDEN:
- <чего нельзя утверждать для этого SKU>

${technologMd}

SKU KNOWLEDGE:
${skuKnowledge.slice(0, 6000)}`;
  const r3t = await callDeepSeek(env, technologSystem, `BRIEF key_fact: ${brief.key_fact}\n\nОтзыв:\n${formatInput(input)}`, 8000, 0.1);
  totalIn += r3t.tokensIn; totalOut += r3t.tokensOut;
  const clearedFacts = r3t.text.trim();
  gates.push({ gate: 'technolog', status: 'pass', provider: 'deepseek', reason: clearedFacts.slice(0, 200), tokensIn: r3t.tokensIn, tokensOut: r3t.tokensOut, durationMs: Date.now() - t3 });

  // ===========================================================================
  // GATE 4 — marketolog PRE-FLIGHT (DeepSeek + marketolog + benefit-gate) — ALWAYS
  // Produces voice/conversion directive for the brief BEFORE Claude writes.
  // ===========================================================================
  const t4 = Date.now();
  const marketologMd = await loadSkillMd(env, 'marketolog').catch(() => '');
  const benefitMd = await loadSkillMd(env, 'benefit-gate').catch(() => '');
  const marketologSystem = `Ты — marketolog + benefit-gate (предполётная директива). Ты НЕ пишешь ответ.
Дай копирайтеру чёткую директиву, как написать ответ, который продаст следующим ~1000 читателям.

ВЫХОД строго:
ANGLE: <главный угол подачи>
HOOK: <как зацепить с первой строки>
SOCIAL_PROOF: <как усилить доверие, если уместно>
VOICE: <тон: уверенный, острый, без извинений>
SHARPEN: <2-3 конкретных приёма усиления для этого отзыва>

${marketologMd}

${benefitMd}`;
  const r4m = await callDeepSeek(env, marketologSystem, `BRIEF:\n${JSON.stringify(brief, null, 2)}\n\nОтзыв:\n${formatInput(input)}\n\nТип: ${reviewType}`, 8000, 0.2);
  totalIn += r4m.tokensIn; totalOut += r4m.tokensOut;
  const voiceDirective = r4m.text.trim();
  gates.push({ gate: 'marketolog', status: 'pass', provider: 'deepseek', reason: voiceDirective.slice(0, 200), tokensIn: r4m.tokensIn, tokensOut: r4m.tokensOut, durationMs: Date.now() - t4 });

  // ===========================================================================
  // Assemble ENRICHED brief — product brief + technolog-cleared facts +
  // marketolog voice directive. Claude (Sonnet) writes ONLY from this.
  // ===========================================================================
  const enrichedBrief = {
    ...brief,
    cleared_facts: clearedFacts,
    voice_directive: voiceDirective,
  };

  // ===========================================================================
  // GATE 5 — write (CLAUDE Sonnet) — single pass from the enriched brief
  // ===========================================================================
  const t5 = Date.now();
  const writeSystem = `Ты — копирайтер Das Experten. Пишешь ответы покупателям на маркетплейсах.

Ты получаешь ENRICHED BRIEF (JSON) и сам отзыв. Brief уже содержит:
- cleared_facts — проверенные technolog'ом факты. Клинические утверждения бери ТОЛЬКО отсюда.
- voice_directive — директива marketolog. Следуй её ANGLE/HOOK/VOICE/SHARPEN.

ВАЖНО:
- Никаких преамбул, JSON, метаданных. ТОЛЬКО текст ответа.
- Соблюдай длину из brief.length_chars (±50).
- Используй brief.must_include, избегай brief.must_avoid.
- Ничего не выдумывай сверх cleared_facts.
- Никогда не благодари за оценку, не извиняйся, не пиши "Спасибо за пятёрку".`;

  const writeUser = `ENRICHED BRIEF:\n${JSON.stringify(enrichedBrief, null, 2)}\n\nОТЗЫВ:\n${formatInput(input)}\n\nНапиши финальный ответ.`;
  const r5 = await callClaude(env, writeSystem, writeUser, 1000);
  let currentReply = r5.text;
  totalIn += r5.tokensIn; totalOut += r5.tokensOut;
  gates.push({ gate: 'write', status: currentReply.length > 50 ? 'pass' : 'fail', provider: 'claude', reason: `${currentReply.length} chars`, tokensIn: r5.tokensIn, tokensOut: r5.tokensOut, durationMs: Date.now() - t5 });

  if (currentReply.length < 50) {
    return { ok: false, reply: '', reviewType, gates, totalDurationMs: Date.now() - startedAt, totalTokensIn: totalIn, totalTokensOut: totalOut, warning: 'Claude write empty' };
  }

  // ===========================================================================
  // GATE 6 — segment-check (DeepSeek) — readability for 8 personas
  // ===========================================================================
  const t6 = Date.now();
  let segmentMd = '';
  try { segmentMd = await loadSegmentCheck(env); } catch {}
  const segmentSystem = `Ты — segment-check. Проверь читаемость для 8 разных читателей:
1. Тамара, 64, пенсионерка
2. Володя, 31, водитель
3. Анна, 28, врач
4. Дмитрий, 45, инженер
5. Светлана, 52, бухгалтер
6. Артём, 19, студент
7. Мария, 38, мама в декрете
8. Виктор, 71, ветеран

Выход:
- "PASS 8/8" — все понимают с первого раза
- "REWORK X/8 — <замечания>" — нужно упростить
- "FAIL X/8" — переписать с нуля

${segmentMd}`;
  const r6 = await callDeepSeek(env, segmentSystem, `Текст:\n${currentReply}`, 8000, 0.1);
  totalIn += r6.tokensIn; totalOut += r6.tokensOut;
  let sStatus: 'pass'|'weak'|'fail' = 'pass';
  if (r6.text.toUpperCase().includes('FAIL')) sStatus = 'fail';
  else if (r6.text.toUpperCase().includes('REWORK')) sStatus = 'weak';
  gates.push({ gate: 'segment-check', status: sStatus, provider: 'deepseek', reason: r6.text.slice(0, 200), tokensIn: r6.tokensIn, tokensOut: r6.tokensOut, durationMs: Date.now() - t6 });

  // ===========================================================================
  // GATE 7 — final polish (CLAUDE Sonnet) — only if segment-check flagged issues
  // ===========================================================================
  if (sStatus !== 'pass') {
    const t7 = Date.now();
    const r7 = await callClaude(env,
      writeSystem,
      `ENRICHED BRIEF:\n${JSON.stringify(enrichedBrief, null, 2)}\n\nЧерновик:\n${currentReply}\n\nЗамечания segment-check:\n${r6.text}\n\nПерепиши проще, чтобы понимал любой читатель. Только текст.`,
      1000
    );
    totalIn += r7.tokensIn; totalOut += r7.tokensOut;
    if (r7.text.length > 50) currentReply = r7.text;
    gates.push({ gate: 'rewrite-final', status: 'pass', provider: 'claude', reason: `${r7.text.length} chars`, tokensIn: r7.tokensIn, tokensOut: r7.tokensOut, durationMs: Date.now() - t7 });
  }

  return {
    ok: true,
    reply: sanitizeReply(currentReply),
    reviewType,
    gates,
    totalDurationMs: Date.now() - startedAt,
    totalTokensIn: totalIn,
    totalTokensOut: totalOut,
  };
}

// =============================================================================
// RATING-ONLY PIPELINE — used for reviews without text body
// Skips conversion gate (no body to convert from) and segment-check (always readable on 200 chars)
// =============================================================================
export async function runRatingOnlyPipeline(env: Env, input: PipelineInput): Promise<PipelineResult> {
  const startedAt = Date.now();
  const gates: GateResult[] = [];
  let totalIn = 0, totalOut = 0;

  // GATE 1: classify — rule-based (rating decides)
  const reviewType: ReviewType = input.rating >= 4 ? 'POS' : input.rating <= 2 ? 'NEG' : 'MIX';
  gates.push({ gate: 'classify', status: 'pass', provider: 'rule', reason: reviewType, tokensIn: 0, tokensOut: 0, durationMs: 0 });

  // GATE 2: brief building (DeepSeek reads skills + SKU, outputs compact brief)
  const t2 = Date.now();
  const skuKnowledge = await loadSkuKnowledge(env, input.productSku ?? '').catch(() => '');
  const productSkill = await loadSkillMd(env, 'product-skill').catch(() => '');

  const briefSystem = `Ты — brief-builder для rating-only отзыва (без текста, только звёзды).

Составь компактный brief в JSON для копирайтера. Ответ должен быть коротким (150-300 символов), с ОДНИМ конкретным фактом из SKU.

JSON:
{
  "customer_name": "имя или null",
  "product": "короткое название бренда",
  "key_fact": "ОДИН факт из SKU card — конкретный, с цифрой если есть",
  "type": "POS" | "NEG" | "MIX",
  "must_avoid": ["спасибо за пятёрку", "к сожалению", "извините"],
  "neg_strategy": "только для NEG: redirect to alternative product or support"
}

ТОЛЬКО JSON. Без префиксов.

=== PRODUCT-SKILL ===
${productSkill}

=== SKU KNOWLEDGE ===
${skuKnowledge}`;

  const r2 = await callDeepSeek(env, briefSystem, formatInput(input), 8000, 0.2);
  totalIn += r2.tokensIn; totalOut += r2.tokensOut;
  let brief = extractJson(r2.text);
  if (!brief) {
    brief = {
      customer_name: input.customerName ?? null,
      product: input.productName ?? '',
      key_fact: '(no brief)',
      type: reviewType,
      must_avoid: ['спасибо за пятёрку'],
    };
  }
  gates.push({ gate: 'brief', status: 'pass', provider: 'deepseek', reason: `${(brief.key_fact || '').slice(0,80)}`, tokensIn: r2.tokensIn, tokensOut: r2.tokensOut, durationMs: Date.now() - t2 });

  // GATE 3: write — Claude with minimal input
  const t3 = Date.now();
  const writeSystem = `Ты — копирайтер Das Experten. Пишешь короткий ответ на отзыв без текста (только звёзды).

Получаешь brief в JSON. Пишешь 150-300 символов.

ПРАВИЛА:
- ТОЛЬКО текст ответа, без преамбул
- Обращение по имени из brief.customer_name
- Встрой brief.key_fact
- Не пиши "спасибо за пятёрку", "к сожалению", "извините"
- Без эмодзи (можно 💡 редко)`;
  const r3 = await callQwen(env, writeSystem,
    `BRIEF:\n${JSON.stringify(brief, null, 2)}\n\nОТЗЫВ:\n${formatInput(input)}\n\nНапиши ответ.`,
    600, 0.5);
  let currentReply = r3.text;
  totalIn += r3.tokensIn; totalOut += r3.tokensOut;
  gates.push({ gate: 'write', status: currentReply.length > 50 ? 'pass' : 'fail', provider: 'qwen', reason: `${currentReply.length} chars`, tokensIn: r3.tokensIn, tokensOut: r3.tokensOut, durationMs: Date.now() - t3 });

  if (currentReply.length < 50) {
    return { ok: false, reply: '', reviewType, gates, totalDurationMs: Date.now() - startedAt, totalTokensIn: totalIn, totalTokensOut: totalOut, warning: 'write empty' };
  }

  // GATE 4: technolog (DeepSeek) — skip for POS rating-only with very short reply
  // Only run for NEG or longer replies
  if (reviewType === 'NEG' || currentReply.length > 250) {
    const t4 = Date.now();
    const technologSystem = `Проверь черновик на клиническую достоверность.
- CLEARED — всё чисто
- IMPRECISE: <что> — неточности
- FALSE: <что> — ложь

SKU:
${skuKnowledge.slice(0, 5000)}`;
    const r4 = await callDeepSeek(env, technologSystem, `Черновик:\n${currentReply}`, 8000, 0.1);
    totalIn += r4.tokensIn; totalOut += r4.tokensOut;
    let tStatus: 'pass'|'weak'|'fail' = 'pass';
    const u = r4.text.toUpperCase();
    if (u.startsWith('FALSE')) tStatus = 'fail';
    else if (u.startsWith('IMPRECISE')) tStatus = 'weak';
    gates.push({ gate: 'technolog', status: tStatus, provider: 'deepseek', reason: r4.text.slice(0, 150), tokensIn: r4.tokensIn, tokensOut: r4.tokensOut, durationMs: Date.now() - t4 });

    if (tStatus !== 'pass') {
      const t4b = Date.now();
      const fix = await callQwen(env, writeSystem,
        `BRIEF:\n${JSON.stringify(brief, null, 2)}\n\nЧерновик:\n${currentReply}\n\nЗамечание technolog:\n${r4.text}\n\nПерепиши устранив проблему.`,
        600, 0.5);
      totalIn += fix.tokensIn; totalOut += fix.tokensOut;
      if (fix.text.length > 50) currentReply = fix.text;
      gates.push({ gate: 'rewrite', status: 'pass', provider: 'qwen', reason: `${fix.text.length} chars`, tokensIn: fix.tokensIn, tokensOut: fix.tokensOut, durationMs: Date.now() - t4b });
    }
  }

  return {
    ok: true,
    reply: sanitizeReply(currentReply),
    reviewType,
    gates,
    totalDurationMs: Date.now() - startedAt,
    totalTokensIn: totalIn,
    totalTokensOut: totalOut,
  };
}
