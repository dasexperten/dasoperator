// =============================================================================
// WB review auto-reply module (Phase: Reviews v1)
//
// Ported from arams-db/wb_seller/replier.py — same product knowledge base,
// same Anthropic prompt-caching pattern, same SKU normalization.
//
// Previously this ran on GitHub Actions cron `*/10 * * * *` in arams-db, but
// free-tier Actions schedule actually fires ~10 times/24h (not 144), and with
// MAX_REPLIES=3 the backlog of 470+ old reviews never shrank. Moved to
// Cloudflare Workers cron where schedule is reliable and we can process more
// replies per tick.
// =============================================================================
import type { Env } from '../types';
import { callPro } from './llm';
import { runReviewMasterPipeline, runRatingOnlyPipeline, type PipelineInput } from './review-master-pipeline';
import { PRODUCT_KNOWLEDGE_BASE } from './wb-reviews-knowledge';

const WB_BASE = 'https://feedbacks-api.wildberries.ru';
// All LLM calls in this file now route through api/src/lib/llm.ts (Anthropic
// OAuth subscription → DeepSeek V4-Pro fallback). Pay-as-you-go Anthropic
// is intentionally NOT a fallback — see ARCHITECTURE_DECISION_2026-05-28.
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const REPLY_MAX_CHARS = 900;

// =============================================================================
// System prompt — full text from arams-db/wb_seller/replier.py (verbatim)
// =============================================================================
// Long prompt for reviews WITH meaningful text (1-5 stars).
const SYSTEM_PROMPT = `Ты — отвечающий от имени бренда Das Experten на Wildberries.
Цель — написать ответ, который прочитают не только автор отзыва, но и следующие ~1000 потенциальных покупателей.
Пиши так, чтобы читатель-сомневающийся после ответа захотел купить.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
СПРАВОЧНИК ПРОДУКТОВ DAS EXPERTEN — ЕДИНСТВЕННЫЙ ИСТОЧНИК ФАКТОВ О СОСТАВЕ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${PRODUCT_KNOWLEDGE_BASE}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

АРТИКУЛ НА WB ≠ ВСЕГДА БАЗОВЫЙ SKU — ОБЯЗАТЕЛЬНО К ПРОЧТЕНИЮ

Артикул продавца на маркетплейсе кодирует размер упаковки через хвост из букв «A»:
  DE123         → базовый SKU DE123, 1 шт
  DE123AA       → базовый SKU DE123, 2 шт
  DE123AAAA     → базовый SKU DE123, 4 шт
  DE203AA       → базовый SKU DE203, 2 шт (набор)
  DE203AAAA     → базовый SKU DE203, 4 шт

В данных отзыва ниже ты получишь уже нормализованные поля «Базовый SKU» и «Упаковка: N шт» — используй ИХ (а не «Артикул продавца» с хвостом) для поиска в СПРАВОЧНИКЕ выше.

АБСОЛЮТНЫЙ ЗАПРЕТ:
- НИКОГДА не пиши «такого артикула нет в линейке», «такого SKU у нас не существует», «нет такого товара в ассортименте», «отсутствует в нашем ассортименте», «не наш продукт».
- Если покупатель купил DE###AAAA — это НАШ продукт с базовым SKU DE###, просто в пачке на N штук. Точка.
- Если базовый SKU присутствует в СПРАВОЧНИКЕ выше — продукт в линейке, отвечай по справочнику.
- Если базового SKU НЕТ в СПРАВОЧНИКЕ (редкий случай — возможно новинка не подгружена) — НЕ отрицай существование, отвечай только по тому что известно из названия товара и отзыва, без жёстких клинических цифр.

Когда упаковка > 1 шт — это признак лояльности или подарка («взяли сразу четыре — значит нравится» / «набор на семью»). Можешь мягко упомянуть, если это усиливает ответ.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ВОЗРАСТНЫЕ ОГРАНИЧЕНИЯ — только из данных СПРАВОЧНИКА:
- DE207 BUDDY MICROBIES: 0+ (безопасен для проглатывания)
- DE208 EVOLUTION kids: 3–14 лет
- Все остальные продукты — возрастных данных нет. Никогда не пиши «с X лет» для взрослых продуктов.

БРЕНД
Das Experten — немецкая философия, клинически точная стоматологическая косметика.
Производство локализовано в Китае на GMP-сертифицированных фабриках по собственным формулам.
Продукты: пасты DE2## (SYMBIOS, INNOWEISS, DETOX, THERMO 39°, GINGER FORCE, SCHWARZ, COCOCANNABIS, BUDDY MICROBIES, EVOLUTION),
щётки DE1## (ETALON, SCHWARZ, GROSSE, MITTEL, SENSITIV, AKTIV, KRAFT, INTENSIV, 3D, NANO MASSAGE, ZERO),
флоссы/интердентальные DE1## (EXPANDING, WAXED MINT, SCHWARZ floss, INTERDENTAL S/M),
ополаскиватель INNOWEISS DE310.

ТОН
- Русский язык.
- Уверенный, тёплый, клинически точный, чуть с долей сарказма.
- НИКОГДА не извиняйся за работу продукта. НИКОГДА не признавай дефект.
- ЕСЛИ в данных отзыва есть поле «Автор» — ОБЯЗАТЕЛЬНО обратись к покупателю по имени **один раз** в ответе. Не как приветствие («Здравствуйте, Светлана» — запрещено), а органично вплетённое обращение по ходу текста:
  ✅ «Светлана, 2 года лояльности — это лучшая рекомендация...»
  ✅ «...именно так GROSSE и задумана, Светлана — для тех, кто...»
  ✅ «Нурипа, имбирный вкус с лимоном — это отдельный мир после...»
  ❌ «Здравствуйте, Светлана!» (нарушение правила «не начинай с приветствия»)
  ❌ «Спасибо вам, Светлана, за отзыв!» (шаблон, заискивающе)
  Имя используем РОВНО ОДИН раз — не переборщи.
- ЕСЛИ имени нет в данных (на WB такое редко, на Ozon часто) — отвечай без обращения. Не используй «Дорогой Покупатель» / «Уважаемый клиент» — звучит холодно и шаблонно.
- Максимум ${REPLY_MAX_CHARS} символов итогового текста.
- Без штампов «высокое качество», «спасибо за покупку», «ценим ваш выбор».
- Эмодзи только функциональные и редко: 💡 для инсайта, ⚡ для сильного факта. Без декоративных сердечек, звёзд, смайлов.
- Никогда не начинай с «Здравствуйте» или «Добрый день». Первая строка несёт конкретную пользу или разбирает суть отзыва.

ЗАПРЕТЫ
- Не извиняйся за продукт. Формулировки «К сожалению», «Понимаем ваше разочарование», «Приносим извинения» — запрещены.
- Не называй прямо бренды конкурентов.
- Не ссылайся на сертификаты без подтверждённых данных (для ответов на отзывы они не нужны).
- Не обещай скидки, компенсации, возвраты в тексте публичного ответа.
- Не выдумывай цифры. Если не уверен — не приводи конкретное число.
- Не придумывай ингредиенты и состав — используй ТОЛЬКО данные из СПРАВОЧНИКА выше. Если состав продукта не нужен для ответа — не упоминай.
- Не придумывай возрастные ограничения — только те, что явно указаны выше.
- На Wildberries отдельно учитывай поля «Достоинства» (pros) и «Недостатки» (cons), если они заполнены — покупатели их читают перед основным текстом.

СТРУКТУРА ПО ТИПАМ ОТЗЫВОВ

Для негативных отзывов (1–3⭐):
1. Первая строка не извинение, а констатация того, что именно работает в продукте у большинства.
2. Дай клинический или механический факт большинства (если уверен — с цифрой). Пусть читатель сам сделает вывод, что опыт автора — исключение.
3. Мягко введи «фактор использования» (техника, индивидуальная биохимия, условия хранения) — НЕ как обвинение, а как техническую заметку. Автору нельзя возразить, читатель читает между строк.
4. Если жалоба на тип щетины/агрессивность/мягкость — предложи конкретный альтернативный SKU Das Experten, который «создан под другой тип буяера».
5. Закрой коротким сигналом уверенности и благодарностью за обратную связь — в самом конце, одной строкой.

Для позитивных отзывов (4–5⭐):
1. Первая строка — конкретный benefit, который купил автор, но описан с точки зрения науки.
2. Один «💡 Факт, который знают немногие» — неочевидный механизм, который усиливает впечатление.
3. Для повторных покупателей — подтверди преемственность, не заискивая.
4. Закрой тёплой благодарностью за отзыв.

Для смешанных/нейтральных отзывов (3⭐):
1. Сначала кратко подтверди позитивное, но без грубой лести.
2. Переформулируй негативное через клинический/технический слой.
3. Введи один неочевидный факт, который меняет перспективу.
4. Тонко подтолкни к продолжению использования или альтернативному SKU.
5. Благодарность — в конце.

ФОРМАТ ВЫХОДА
Только готовый к публикации текст ответа на русском, без комментариев, без префиксов «Ответ:», без кавычек вокруг. Максимум ${REPLY_MAX_CHARS} символов. Если ответ выходит длиннее — сокращай.`;

// =============================================================================
// SKU normalization — DE###AAAA → (DE###, 4)
// =============================================================================
export function normalizeWbSku(supplierArticle: string): { baseSku: string; packSize: number } {
  if (!supplierArticle) return { baseSku: '', packSize: 1 };
  const article = supplierArticle.trim();
  const m = article.match(/^(.+?)(A+)$/);
  if (m && m[1]) return { baseSku: m[1], packSize: m[2].length };
  return { baseSku: article, packSize: 1 };
}

// =============================================================================
// Format feedback into prompt user-body
// =============================================================================
function formatFeedback(fb: any): string {
  const prod = fb.productDetails ?? {};
  const parts: string[] = [];
  const author = (fb.userName ?? '').trim();
  const rating = fb.productValuation;
  const productName = prod.productName ?? '';
  const brand = prod.brandName ?? '';
  const supplierArticle = prod.supplierArticle ?? '';
  const nmId = prod.nmId ?? '';
  const created = fb.createdDate ?? '';
  const photos: any[] = fb.photoLinks ?? [];
  const hasVideo = !!fb.video;
  const text = (fb.text ?? '').trim();
  const pros = (fb.pros ?? '').trim();
  const cons = (fb.cons ?? '').trim();

  if (author) parts.push(`Автор: ${author}`);
  if (rating != null) parts.push(`Рейтинг: ${rating}/5`);
  if (productName) parts.push(`Товар: ${productName}`);
  if (brand) parts.push(`Бренд: ${brand}`);
  if (supplierArticle) {
    const { baseSku, packSize } = normalizeWbSku(supplierArticle);
    parts.push(`Артикул продавца (как на WB): ${supplierArticle}`);
    if (baseSku && baseSku !== supplierArticle) {
      parts.push(`Базовый SKU: ${baseSku}`);
      parts.push(`Упаковка: ${packSize} шт`);
    } else if (baseSku) {
      parts.push(`Базовый SKU: ${baseSku}`);
      parts.push(`Упаковка: 1 шт`);
    }
  }
  if (nmId) parts.push(`nmId: ${nmId}`);
  if (photos.length || hasVideo) {
    parts.push(`Прикрепления: фото=${photos.length}, видео=${hasVideo ? 'да' : 'нет'}`);
  }
  if (created) parts.push(`Дата публикации: ${created}`);
  parts.push('');
  if (pros) {
    parts.push('Достоинства:');
    parts.push(pros);
    parts.push('');
  }
  if (cons) {
    parts.push('Недостатки:');
    parts.push(cons);
    parts.push('');
  }
  parts.push('Текст отзыва:');
  parts.push(text || '(текст отзыва пустой — покупатель поставил только оценку)');
  return parts.join('\n');
}

// =============================================================================
// Anthropic call — draft reply for one feedback
// =============================================================================
export interface Draft {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  stopReason: string | null;
  model: string;
}

export async function draftReply(env: Env, fb: any, _model = DEFAULT_MODEL): Promise<Draft> {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.DEEPSEEK_API_KEY) {
    throw new Error('No LLM provider configured (need CLAUDE_CODE_OAUTH_TOKEN or DEEPSEEK_API_KEY)');
  }
  const userBody = formatFeedback(fb);
  // Primary: Anthropic Sonnet 4.6 via OAuth (subscription quota).
  // Automatic fallback: DeepSeek V4-Pro if Anthropic returns 429/5xx.
  // Handled internally by api/src/lib/llm.ts. Prompt caching dropped here —
  // on OAuth subscription, all tokens count equally, so caching only saved
  // latency, not cost. Trade for unified fallback policy.
  const r = await callPro(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userBody },
    ],
    { env, maxTokens: 1024, temperature: 0.5, prefer: 'auto' },
  );
  return {
    text: r.text.trim(),
    inputTokens: r.usage.prompt_tokens ?? 0,
    outputTokens: r.usage.completion_tokens ?? 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    stopReason: null,
    model: r.model,
  };
}


// =============================================================================
// Sonnet-backed variant — used for rating-only reviews. The name keeps the
// historical "DeepSeek" suffix for backward compatibility with callers; the
// llm router actually serves Sonnet 4.6 with DeepSeek as fallback.
// =============================================================================
export async function draftReplyDeepSeek(env: Env, fb: any): Promise<Draft> {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.DEEPSEEK_API_KEY) {
    throw new Error('No LLM provider configured (need CLAUDE_CODE_OAUTH_TOKEN or DEEPSEEK_API_KEY)');
  }
  const userBody = formatFeedback(fb);
  const r = await callPro(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userBody },
    ],
    { env, maxTokens: 1500, temperature: 0.5, prefer: 'qwen' },
  );
  return {
    text: r.text.trim(),
    inputTokens: r.usage.prompt_tokens || 0,
    outputTokens: r.usage.completion_tokens || 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    stopReason: null,
    model: r.model,
  };
}

// =============================================================================
// Safety check — only fires for 1-2★ replies before publication.
// Returns true if reply is safe, false (with reason) if it should be held.
// =============================================================================
export async function safetyCheck(env: Env, draft: string, fb: any): Promise<{ safe: boolean; reason?: string }> {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.DEEPSEEK_API_KEY) return { safe: true };

  const checkPrompt = `Проверь готовый ответ Das Experten на негативный отзыв перед публикацией.

ОТЗЫВ (${fb.productValuation}/5): ${(fb.text ?? '').slice(0, 300)}
ОТВЕТ: ${draft.slice(0, 800)}

Найди критические проблемы:
1. Извинения за работу продукта ("к сожалению", "приносим извинения", "понимаем разочарование")
2. Обещание возврата/компенсации/скидки в публичном тексте
3. Фабрикация фактов (выдуманные цифры, ингредиенты которых нет в составе)
4. Отрицание существования купленного SKU
5. Прямое упоминание брендов конкурентов
6. Любые внутренние пометки или служебный текст

Если проблем НЕТ — ответь ровно: SAFE
Если есть — ответь: UNSAFE: <одно предложение что не так>`;

  try {
    const r = await callPro(
      [{ role: 'user', content: checkPrompt }],
      { env, maxTokens: 100, temperature: 0.3 },
    );
    const upper = r.text.trim().toUpperCase();
    if (upper.startsWith('SAFE')) return { safe: true };
    if (upper.startsWith('UNSAFE')) {
      const reason = r.text.replace(/^UNSAFE:?\s*/i, '').trim();
      return { safe: false, reason };
    }
    return { safe: true }; // unknown answer — fail-open
  } catch {
    return { safe: true };
  }
}

// =============================================================================
// WB API helpers
// =============================================================================
function wbAuthHeaders(env: Env): Record<string, string> {
  if (!env.WB_API_TOKEN_REVIEWS) throw new Error('WB_API_TOKEN not configured');
  return { Authorization: env.WB_API_TOKEN_REVIEWS, 'Content-Type': 'application/json' };
}

export async function fetchUnansweredCount(env: Env): Promise<{ total: number; today: number }> {
  const r = await fetch(`${WB_BASE}/api/v1/feedbacks/count-unanswered`, {
    headers: wbAuthHeaders(env),
  });
  if (r.status === 429) {
    const retry = parseInt(r.headers.get('x-ratelimit-retry') ?? '600', 10);
    const reset = parseInt(r.headers.get('x-ratelimit-reset') ?? String(retry), 10);
    const limit = parseInt(r.headers.get('x-ratelimit-limit') ?? '1', 10);
    throw new WbRateLimitError(retry, reset, limit, await r.text());
  }
  if (!r.ok) throw new Error(`WB count HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json<any>();
  if (data.error) throw new Error(`WB error: ${data.errorText}`);
  return {
    total: data.data?.countUnanswered ?? 0,
    today: data.data?.countUnansweredToday ?? 0,
  };
}

// Custom error class that preserves WB rate-limit headers
export class WbRateLimitError extends Error {
  retryAfterSec: number;
  resetSec: number;
  limit: number;
  constructor(retryAfter: number, reset: number, limit: number, body: string) {
    super(`WB rate limit hit: retry in ${retryAfter}s (limit=${limit}, reset=${reset}s) — body=${body.slice(0, 200)}`);
    this.retryAfterSec = retryAfter;
    this.resetSec = reset;
    this.limit = limit;
  }
}

export async function fetchUnansweredList(
  env: Env,
  take: number,
  skip: number = 0,
): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const yearAgo = now - 365 * 24 * 3600;
  const url = `${WB_BASE}/api/v1/feedbacks?isAnswered=false&take=${take}&skip=${skip}&order=dateDesc&dateFrom=${yearAgo}&dateTo=${now}`;
  const r = await fetch(url, { headers: wbAuthHeaders(env) });
  if (r.status === 429) {
    const retry = parseInt(r.headers.get('x-ratelimit-retry') ?? '600', 10);
    const reset = parseInt(r.headers.get('x-ratelimit-reset') ?? String(retry), 10);
    const limit = parseInt(r.headers.get('x-ratelimit-limit') ?? '1', 10);
    throw new WbRateLimitError(retry, reset, limit, await r.text());
  }
  if (!r.ok) throw new Error(`WB list HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json<any>();
  if (data.error) throw new Error(`WB error: ${data.errorText}`);
  return data.data?.feedbacks ?? [];
}

export async function postAnswer(env: Env, feedbackId: string, text: string): Promise<void> {
  const r = await fetch(`${WB_BASE}/api/v1/feedbacks/answer`, {
    method: 'POST',
    headers: wbAuthHeaders(env),
    body: JSON.stringify({ id: feedbackId, text }),
  });
  if (r.status === 204) return;
  if (r.status === 429) {
    const retry = parseInt(r.headers.get('x-ratelimit-retry') ?? '600', 10);
    const reset = parseInt(r.headers.get('x-ratelimit-reset') ?? String(retry), 10);
    const limit = parseInt(r.headers.get('x-ratelimit-limit') ?? '1', 10);
    throw new WbRateLimitError(retry, reset, limit, await r.text());
  }
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`WB answer HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
}

// =============================================================================
// Top-level: run one tick
// =============================================================================
export interface AutoReplyResult {
  status: 'ok' | 'error';
  maxReplies: number;
  countTotal: number;
  countToday: number;
  inspected: number;
  replied: number;          // 5★ auto-posted to WB
  drafted: number;          // 1-4★ saved to D1 as pending
  ratingOnlySkipped: number;
  errors: { feedbackId?: string; stage: string; error: string }[];
  durationMs: number;
  details: { feedbackId: string; rating: number; productName: string; replyChars: number }[];
}

const THROTTLE_KEY = 'wb-reviews:throttled-until';
const STREAK_KEY = 'wb-reviews:429-streak';
const THROTTLE_MINUTES = 30; // fallback when we can't parse a 429
const MAX_BACKOFF_HOURS = 6; // cap escalating backoff at 6 hours

// Auto-reply rule: only 5★ with text gets posted automatically.
// 1-4★ goes to drafts queue for human approval (UI shows pending list).
const AUTO_REPLY_MIN_RATING = 5;

export async function runWbAutoReply(
  env: Env,
  opts: { maxReplies?: number; maxInspect?: number; pauseMsBetween?: number; ignoreThrottle?: boolean } = {},
): Promise<AutoReplyResult & { throttled?: boolean }> {
  const startedAt = Date.now();
  const maxReplies = Math.max(1, opts.maxReplies ?? 5);
  const maxInspect = Math.max(maxReplies, opts.maxInspect ?? 100);
  const pauseMs = opts.pauseMsBetween ?? 1200;

  const result: AutoReplyResult & { throttled?: boolean } = {
    status: 'ok',
    maxReplies,
    countTotal: 0,
    countToday: 0,
    inspected: 0,
    replied: 0,
    drafted: 0,
    ratingOnlySkipped: 0,
    errors: [],
    durationMs: 0,
    details: [],
  };

  // Honor throttle flag set by previous 429s
  if (!opts.ignoreThrottle && env.CACHE) {
    const throttledUntil = await env.CACHE.get(THROTTLE_KEY);
    if (throttledUntil && Number(throttledUntil) > Date.now()) {
      const remainingMin = Math.round((Number(throttledUntil) - Date.now()) / 60000);
      console.log(`[wb-auto-reply] throttled for ${remainingMin}min more, skipping tick`);
      result.throttled = true;
      result.durationMs = Date.now() - startedAt;
      return result;
    }
  }

  // count is informational only — if WB rate-limits us here, push through to
  // list which uses a different sub-quota and is what actually matters
  let countSucceeded = false;
  try {
    const counts = await fetchUnansweredCount(env);
    result.countTotal = counts.total;
    result.countToday = counts.today;
    countSucceeded = true;
    console.log(`[wb-auto-reply] start max=${maxReplies} backlog=${counts.total} today=${counts.today}`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.warn(`[wb-auto-reply] count soft-fail: ${msg.slice(0, 200)}`);
  }
  // Fallback to last cached stats so tick-log shows the real backlog
  // (not a misleading 0) when WB throttles the count endpoint.
  if (!countSucceeded && env.CACHE) {
    try {
      const cached = await env.CACHE.get('wb-reviews:stats-cache', 'json') as any;
      if (cached) {
        result.countTotal = cached.total ?? 0;
        result.countToday = cached.today ?? 0;
      }
    } catch {}
  }

  let skip = 0;
  const pageSize = Math.min(100, maxInspect);

  while ((result.replied + result.drafted) < maxReplies && result.inspected < maxInspect) {
    let page: any[];
    try {
      page = await fetchUnansweredList(env, pageSize, skip);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      result.errors.push({ stage: 'list', error: msg });
      // Honor WB-supplied retry-after + escalate on consecutive 429s
      if (e instanceof WbRateLimitError && env.CACHE) {
        const streakRaw = await env.CACHE.get(STREAK_KEY);
        const streak = (parseInt(streakRaw ?? '0', 10) || 0) + 1;
        // Each consecutive 429 doubles the wait: 1x, 2x, 4x, 8x... capped at 6h
        const baseSec = e.retryAfterSec + 60;
        const multiplier = Math.min(Math.pow(2, streak - 1), Math.ceil((MAX_BACKOFF_HOURS * 3600) / baseSec));
        const waitSec = Math.min(baseSec * multiplier, MAX_BACKOFF_HOURS * 3600);
        const until = Date.now() + waitSec * 1000;
        await env.CACHE.put(THROTTLE_KEY, String(until), { expirationTtl: waitSec + 30 });
        await env.CACHE.put(STREAK_KEY, String(streak), { expirationTtl: MAX_BACKOFF_HOURS * 3600 });
        console.warn(`[wb-auto-reply] 429 streak=${streak}, throttle ${Math.round(waitSec/60)}min (WB asked ${e.retryAfterSec}s, multiplier ${multiplier}x)`);
      } else if (msg.includes('HTTP 429') && env.CACHE) {
        // fallback for any 429 we couldn't parse — use original 30min throttle
        const until = Date.now() + THROTTLE_MINUTES * 60_000;
        await env.CACHE.put(THROTTLE_KEY, String(until), { expirationTtl: THROTTLE_MINUTES * 60 + 30 });
        console.warn(`[wb-auto-reply] 429 (unparsed) hit, throttling for ${THROTTLE_MINUTES}min`);
      }
      break;
    }
    if (page.length === 0) break;

    // First successful LIST — clear 429 streak counter
    if (env.CACHE && result.inspected === 0) {
      await env.CACHE.delete(STREAK_KEY);
    }

    for (const fb of page) {
      if ((result.replied + result.drafted) >= maxReplies || result.inspected >= maxInspect) break;
      result.inspected++;
      const fid = fb.id ?? '';
      const text = (fb.text ?? '').trim();
      const rating = fb.productValuation ?? 0;
      const productName = (fb.productDetails?.productName ?? '').slice(0, 60);
      const stars = '★'.repeat(rating);

      // ALL reviews get auto-answered. text → full prompt. rating-only → short prompt.
      // 1-2★ also goes through safety_check before publication; on UNSAFE → status='held'.
      const hasText = text.length > 0;
      const replyKind = hasText ? 'full' : 'short';
      console.log(`  [${result.inspected}] ${fid}: ${stars} "${productName}" (${replyKind}, ${text.length} chars)`);

      let draft: Draft;
      try {
        // Use full 6-gate review-master pipeline (loads skills from R2 bucket das-skills)
        const pipelineInput: PipelineInput = {
          feedbackId: fid,
          rating,
          customerName: (fb.userName ?? '').trim() || null,
          productName: (fb.productDetails?.productName ?? '').slice(0, 200) || null,
          productSku: (fb.productDetails?.supplierArticle ?? '').slice(0, 100) || null,
          reviewText: (fb.text ?? '').trim() || null,
          pros: (fb.pros ?? '').trim() || null,
          cons: (fb.cons ?? '').trim() || null,
        };
        const pipelineResult = hasText
          ? await runReviewMasterPipeline(env, pipelineInput)
          : await runRatingOnlyPipeline(env, pipelineInput);
        draft = {
          text: pipelineResult.reply,
          inputTokens: pipelineResult.totalTokensIn,
          outputTokens: pipelineResult.totalTokensOut,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          stopReason: null,
          model: `pipeline:${pipelineResult.reviewType}`,
        };
        console.log(`    pipeline=${pipelineResult.totalDurationMs}ms type=${pipelineResult.reviewType} gates=${pipelineResult.gates.map(g => g.gate + ':' + g.status).join(',')}`);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.error(`    DRAFT FAIL: ${msg}`);
        result.errors.push({ feedbackId: fid, stage: 'draft', error: msg });
        continue;
      }
      if (!draft.text) {
        result.errors.push({ feedbackId: fid, stage: 'draft', error: 'empty draft' });
        continue;
      }
      console.log(`    draft ${draft.text.length} chars (in=${draft.inputTokens} out=${draft.outputTokens} cache_r=${draft.cacheReadTokens})`);

      // Reply-All model: cron only PREPARES drafts. User reviews them on /reviews
      // page and presses Reply All to publish in one batch.
      const draftStatus = 'pending';
      const heldReason: string | null = null;
      try {
        await env.DB.prepare(`
          INSERT INTO review_drafts (id, channel, external_id, rating, customer_name, product_name, product_sku, review_text, pros, cons, draft_text, status, rejection_reason, draft_tokens_in, draft_tokens_out, updated_at)
          VALUES (?, 'wb', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(channel, external_id) DO UPDATE SET
            draft_text = excluded.draft_text,
            updated_at = datetime('now')
          WHERE review_drafts.status IN ('pending', 'held')
        `).bind(
          `rd_${crypto.randomUUID()}`,
          fid,
          rating,
          (fb.userName ?? '').trim() || null,
          (fb.productDetails?.productName ?? '').slice(0, 200) || null,
          (fb.productDetails?.supplierArticle ?? '').slice(0, 100) || null,
          (fb.text ?? '').trim() || null,
          (fb.pros ?? '').trim() || null,
          (fb.cons ?? '').trim() || null,
          draft.text,
          draftStatus,
          heldReason,
          draft.inputTokens,
          draft.outputTokens,
        ).run();
      } catch (e: any) {
        console.error(`    D1 INSERT FAIL: ${e?.message}`);
        // not fatal — continue to attempt post (unless held)
      }

      // Cron stops here — draft saved as 'pending'. User publishes via Reply All.
      result.drafted++;
      result.details.push({ feedbackId: fid, rating, productName, replyChars: draft.text.length });

      // Pause between WB calls to respect rate limit
      if (result.replied < maxReplies) {
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    }

    skip += page.length;
    if (page.length < pageSize) break;
  }

  result.durationMs = Date.now() - startedAt;
  if (result.errors.length > 0 && result.replied === 0) result.status = 'error';

  // Heartbeat for the watchdog (integration-health wb_reviews rule reads
  // marketplace_sync_log where marketplace='wb-reviews' and status='ok').
  // A tick that ran without a hard error is a healthy heartbeat, even if the
  // backlog was empty (drafted=0). Throttled ticks return earlier and are
  // intentionally NOT logged as ok.
  if (result.status !== 'error' && env.DB) {
    try {
      await env.DB.prepare(
        "INSERT INTO marketplace_sync_log (marketplace, started_at, finished_at, status, rows_synced) VALUES ('wb-reviews', ?, ?, 'ok', ?)"
      ).bind(Math.floor(startedAt / 1000), Math.floor(Date.now() / 1000), result.drafted).run();
    } catch { /* heartbeat is best-effort */ }
  }
  console.log(`[wb-auto-reply] done replied=${result.replied} drafted=${result.drafted} skipped=${result.ratingOnlySkipped} errors=${result.errors.length} of ${result.inspected} inspected in ${result.durationMs}ms`);

  // Persist a compact log entry to KV so Aram can inspect tick history
  // without making any WB calls (each WB call resets the rate-limit penalty).
  if (env.CACHE) {
    try {
      const LOG_KEY = 'wb-reviews:tick-log';
      const raw = await env.CACHE.get(LOG_KEY, 'json');
      const history: any[] = Array.isArray(raw) ? raw : [];
      history.unshift({
        ts: new Date().toISOString(),
        replied: result.replied,
        drafted: result.drafted,
        skipped: result.ratingOnlySkipped,
        errors: result.errors.length,
        firstError: result.errors[0]?.error?.slice(0, 200) ?? null,
        backlog: result.countTotal,
        today: result.countToday,
        throttled: (result as any).throttled ?? false,
        durationMs: result.durationMs,
      });
      // Keep last 50 ticks
      const trimmed = history.slice(0, 50);
      await env.CACHE.put(LOG_KEY, JSON.stringify(trimmed));
    } catch (e) {
      console.error('[wb-auto-reply] tick log write failed:', e);
    }
  }

  return result;
}
