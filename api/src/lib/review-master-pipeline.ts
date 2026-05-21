// =============================================================================
// Review-Master Pipeline — full 6-gate implementation backed by R2 skills.
//
// Hybrid model B (per Aram's decision 2026-05-21):
//   - Gates 1, 2, 4, 6 → DeepSeek v4-pro  (cheap, fast, analytical)
//   - Gate 3 (draft) + Gate 5 (sharpening) → Claude Sonnet (brand voice)
//
// Pipeline (every review):
//   1. classify           DeepSeek      → POS/NEG/MIX/Q-PROD/Q-SCI/Q-CERT/Q-DELIV/Q-USE
//   2. product-knowledge  DeepSeek      → load SKU card + ingredients + clinical
//   3. draft              Claude Sonnet → write the reply (brand voice)
//   4. technolog          DeepSeek      → verify clinical claims (CLEARED/IMPRECISE/FALSE)
//   5. marketolog + benefit  Claude Sonnet → sharpen, conversion check, regenerate if FAIL
//   6. segment-check      DeepSeek      → readability (8 grandmothers test)
//
// Each gate result is appended to the audit trail returned with the final reply.
// =============================================================================

import type { Env } from '../types';
import { callPro } from './deepseek';
import { loadSkillMd, loadSkuKnowledge, loadSegmentCheck } from './skill-loader';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';

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
  provider: 'claude' | 'deepseek' | 'rule';
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
async function callClaude(env: Env, system: string, user: string, maxTokens: number): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Claude HTTP ${resp.status}: ${t.slice(0, 400)}`);
  }
  const data = await resp.json<any>();
  const text = (data.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  return {
    text,
    tokensIn: (data.usage?.input_tokens ?? 0) + (data.usage?.cache_read_input_tokens ?? 0),
    tokensOut: data.usage?.output_tokens ?? 0,
  };
}

async function callDeepSeek(env: Env, system: string, user: string, maxTokens: number, temp = 0.3): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured');
  const r = await callPro(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { apiKey: env.DEEPSEEK_API_KEY, maxTokens, temperature: temp },
  );
  return {
    text: r.text.trim(),
    tokensIn: r.usage.prompt_tokens ?? 0,
    tokensOut: r.usage.completion_tokens ?? 0,
  };
}

// =============================================================================
// Pipeline helper — formats input for prompts
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

// =============================================================================
// MAIN ENTRY
// =============================================================================
export async function runReviewMasterPipeline(env: Env, input: PipelineInput): Promise<PipelineResult> {
  const startedAt = Date.now();
  const gates: GateResult[] = [];
  let totalIn = 0, totalOut = 0;

  // ---------------- GATE 1: classify ----------------
  const t1 = Date.now();
  const classifySystem = `Ты классификатор отзывов. Категории:
POS — позитивный (3-5★, доволен)
NEG — негативный (1-2★, жалоба)
MIX — нейтральный (3★, неоднозначный)
Q-PROD — вопрос про продукт/ингредиент
Q-SCI — научный вопрос
Q-CERT — про сертификаты/ГОСТ/ISO
Q-DELIV — про доставку/логистику
Q-USE — как использовать
ОТВЕТЬ ровно одной строкой: код категории. Ничего больше.`;
  const classifyResult = await callDeepSeek(env, classifySystem, formatInput(input), 200, 0.0);
  const classifyText = classifyResult.text.toUpperCase().replace(/[^A-Z-]/g, '');
  const validTypes: ReviewType[] = ['POS','NEG','MIX','Q-PROD','Q-SCI','Q-CERT','Q-DELIV','Q-USE'];
  let reviewType: ReviewType = 'POS';
  for (const t of validTypes) if (classifyText.startsWith(t)) { reviewType = t; break; }
  // Fallback: rating-based
  if (!validTypes.some(t => classifyText.startsWith(t))) {
    reviewType = input.rating >= 4 ? 'POS' : input.rating <= 2 ? 'NEG' : 'MIX';
  }
  totalIn += classifyResult.tokensIn; totalOut += classifyResult.tokensOut;
  gates.push({ gate: 'classify', status: 'pass', provider: 'deepseek', reason: reviewType, tokensIn: classifyResult.tokensIn, tokensOut: classifyResult.tokensOut, durationMs: Date.now() - t1 });

  // ---------------- GATE 2: product-knowledge ----------------
  const t2 = Date.now();
  let skuKnowledge = '';
  try {
    skuKnowledge = await loadSkuKnowledge(env, input.productSku ?? '');
  } catch (e: any) {
    skuKnowledge = `[knowledge load failed: ${e?.message}]`;
  }
  gates.push({ gate: 'product-knowledge', status: skuKnowledge.length > 100 ? 'pass' : 'weak', provider: 'rule', reason: `${skuKnowledge.length} bytes loaded`, tokensIn: 0, tokensOut: 0, durationMs: Date.now() - t2 });

  // ---------------- GATE 3: DRAFT (Claude Sonnet) ----------------
  const t3 = Date.now();
  const reviewMasterMd = await loadSkillMd(env, 'review-master');
  const productSkillMd = await loadSkillMd(env, 'product-skill');

  const draftSystem = `Ты — review-master, единый голос для Das Experten. Следуй полной инструкции skill'а ниже.
Конкретная задача СЕЙЧАС: написать ответ покупателю на Wildberries на отзыв категории ${reviewType}.

ВАЖНО:
- Без emoji (только 💡, ⚡, 🦷 если уместно)
- Обращение по имени, если есть
- Никаких шаблонов «Спасибо за пятёрку» и подобных
- На NEG — следуй doctrine: not apologize, redirect, recommend alternative
- Финальный текст без префиксов и метаданных — только сам ответ

=== INSTRUCTION (review-master) ===
${reviewMasterMd}

=== PRODUCT KNOWLEDGE FOR ${input.productSku ?? '(no sku)'} ===
${skuKnowledge}

=== PRODUCT-SKILL DOCTRINE ===
${productSkillMd}`;
  const draftResult = await callClaude(env, draftSystem, formatInput(input), 1500);
  let currentReply = draftResult.text;
  totalIn += draftResult.tokensIn; totalOut += draftResult.tokensOut;
  gates.push({ gate: 'draft', status: currentReply.length > 50 ? 'pass' : 'fail', provider: 'claude', reason: `${currentReply.length} chars`, tokensIn: draftResult.tokensIn, tokensOut: draftResult.tokensOut, durationMs: Date.now() - t3 });

  if (currentReply.length < 50) {
    return { ok: false, reply: '', reviewType, gates, totalDurationMs: Date.now() - startedAt, totalTokensIn: totalIn, totalTokensOut: totalOut, warning: 'Draft empty or too short' };
  }

  // ---------------- GATE 4: technolog ----------------
  const t4 = Date.now();
  const technologMd = await loadSkillMd(env, 'technolog');
  const technologSystem = `Ты — technolog gate из system Das Experten. Проверь черновик ответа на клиническую достоверность.

ВАЖНО:
- Выискивай ложные/преувеличенные клинические утверждения, выдуманные проценты, несуществующие ингредиенты
- Если всё чисто — ответь "CLEARED"
- Если есть неточности — ответь "IMPRECISE: <короткая правка>"
- Если ложь — ответь "FALSE: <что неправда + как исправить>"

=== INSTRUCTION ===
${technologMd}

=== PRODUCT KNOWLEDGE ===
${skuKnowledge}`;
  const technologInput = `Черновик ответа для проверки:\n\n${currentReply}\n\nОтзыв клиента (контекст):\n${formatInput(input)}`;
  const technologResult = await callDeepSeek(env, technologSystem, technologInput, 500, 0.1);
  totalIn += technologResult.tokensIn; totalOut += technologResult.tokensOut;
  const technologText = technologResult.text.toUpperCase();
  let technologStatus: 'pass' | 'weak' | 'fail' = 'pass';
  let technologReason = '';
  if (technologText.startsWith('FALSE')) { technologStatus = 'fail'; technologReason = technologResult.text; }
  else if (technologText.startsWith('IMPRECISE')) { technologStatus = 'weak'; technologReason = technologResult.text; }
  gates.push({ gate: 'technolog', status: technologStatus, provider: 'deepseek', reason: technologReason, tokensIn: technologResult.tokensIn, tokensOut: technologResult.tokensOut, durationMs: Date.now() - t4 });

  // If technolog FAIL — regenerate via Claude with correction instruction
  if (technologStatus === 'fail' || technologStatus === 'weak') {
    const fixSystem = draftSystem + `\n\n=== TECHNOLOG FOUND ISSUE — FIX IT ===\n${technologReason}`;
    const fixResult = await callClaude(env, fixSystem, `Перепиши ответ, устранив указанную клиническую проблему. Сам ответ:\n\n${currentReply}`, 1500);
    currentReply = fixResult.text;
    totalIn += fixResult.tokensIn; totalOut += fixResult.tokensOut;
  }

  // ---------------- GATE 5: marketolog + benefit-gate (Claude) ----------------
  const t5 = Date.now();
  const marketologMd = await loadSkillMd(env, 'marketolog');
  const benefitMd = await loadSkillMd(env, 'benefit-gate');
  const sharpSystem = `Ты — sharpen gate (marketolog + benefit-gate conversion check) Das Experten.

Дано: черновик ответа покупателю. Твоя задача — улучшить если слабо, иначе оставить.

КРИТЕРИИ:
- audience: реальный читатель — не сам покупатель, а следующие 1000 человек которые увидят этот ответ под товаром
- conversion levers: intrigue, social proof, superiority frame, alternative CTA, specificity
- voice: confident, sharp, без оправдательных интонаций
- никаких "к сожалению", "приносим извинения", "просим прощения"

ВЫХОД: только финальный текст ответа. Без префиксов, без метаданных, без "Вот финальная версия:".
Если черновик уже отличный — верни его как есть, не порти.

=== MARKETOLOG INSTRUCTION ===
${marketologMd}

=== BENEFIT-GATE CONVERSION RULES ===
${benefitMd}`;
  const sharpResult = await callClaude(env, sharpSystem, `Черновик к улучшению:\n\n${currentReply}\n\nОтзыв клиента:\n${formatInput(input)}\n\nТип отзыва: ${reviewType}`, 1500);
  if (sharpResult.text.length > 50) currentReply = sharpResult.text;
  totalIn += sharpResult.tokensIn; totalOut += sharpResult.tokensOut;
  gates.push({ gate: 'sharpen', status: 'pass', provider: 'claude', reason: `${sharpResult.text.length} chars`, tokensIn: sharpResult.tokensIn, tokensOut: sharpResult.tokensOut, durationMs: Date.now() - t5 });

  // ---------------- GATE 6: segment-check (readability) ----------------
  const t6 = Date.now();
  let segmentMd = '';
  try { segmentMd = await loadSegmentCheck(env); } catch {}
  const segmentSystem = `Ты — segment-check gate. Проверь читаемость ответа для 8 разных персонажей.

8 PERSONAS (тест понимания с первого чтения):
1. Тамара, 64, пенсионерка, читает медленно
2. Володя, 31, водитель, читает по диагонали
3. Анна, 28, врач-стоматолог
4. Дмитрий, 45, инженер
5. Светлана, 52, бухгалтер
6. Артём, 19, студент
7. Мария, 38, мама в декрете
8. Виктор, 71, ветеран

ВЫХОД:
- "PASS 8/8" если все понимают с первого раза
- "PASS 7/8" если один не понимает (укажи имя)
- "REWORK X/8" если 4-5 не понимают (укажи имена + что заменить)
- "FAIL X/8" если ≤3 понимают

=== SPEC ===
${segmentMd || '(spec not loaded, use common sense)'}`;
  const segmentResult = await callDeepSeek(env, segmentSystem, `Текст для теста:\n\n${currentReply}`, 400, 0.1);
  totalIn += segmentResult.tokensIn; totalOut += segmentResult.tokensOut;
  const segmentText = segmentResult.text.toUpperCase();
  let segmentStatus: 'pass' | 'weak' | 'fail' = 'pass';
  if (segmentText.includes('FAIL')) segmentStatus = 'fail';
  else if (segmentText.includes('REWORK')) segmentStatus = 'weak';
  gates.push({ gate: 'segment-check', status: segmentStatus, provider: 'deepseek', reason: segmentResult.text.slice(0, 200), tokensIn: segmentResult.tokensIn, tokensOut: segmentResult.tokensOut, durationMs: Date.now() - t6 });

  // If segment-check FAIL — one rewrite attempt via Claude
  if (segmentStatus === 'fail' || segmentStatus === 'weak') {
    const rewriteResult = await callClaude(env,
      `Перепиши ответ так, чтобы его понимал любой читатель (от пенсионерки 64 до студента 19). Сохрани клиническую точность и брендовый голос. Без терминологического балласта.`,
      `Текст:\n\n${currentReply}\n\nЗамечания segment-check:\n${segmentResult.text}`,
      1500
    );
    if (rewriteResult.text.length > 50) currentReply = rewriteResult.text;
    totalIn += rewriteResult.tokensIn; totalOut += rewriteResult.tokensOut;
  }

  return {
    ok: true,
    reply: currentReply,
    reviewType,
    gates,
    totalDurationMs: Date.now() - startedAt,
    totalTokensIn: totalIn,
    totalTokensOut: totalOut,
  };
}
