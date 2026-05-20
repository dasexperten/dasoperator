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
import { PRODUCT_KNOWLEDGE_BASE } from './wb-reviews-knowledge';

const WB_BASE = 'https://feedbacks-api.wildberries.ru';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const REPLY_MAX_CHARS = 900;

// =============================================================================
// System prompt — full text from arams-db/wb_seller/replier.py (verbatim)
// =============================================================================
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

export async function draftReply(env: Env, fb: any, model = DEFAULT_MODEL): Promise<Draft> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  const userBody = formatFeedback(fb);
  const resp = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userBody }],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Anthropic HTTP ${resp.status}: ${body.slice(0, 500)}`);
  }
  const data = await resp.json<any>();
  const chunks = (data.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text);
  const text = chunks.join('\n').trim();
  const usage = data.usage ?? {};
  return {
    text,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    stopReason: data.stop_reason ?? null,
    model: data.model ?? model,
  };
}

// =============================================================================
// WB API helpers
// =============================================================================
function wbAuthHeaders(env: Env): Record<string, string> {
  if (!env.WB_API_TOKEN) throw new Error('WB_API_TOKEN not configured');
  return { Authorization: env.WB_API_TOKEN, 'Content-Type': 'application/json' };
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
  replied: number;
  ratingOnlySkipped: number;
  errors: { feedbackId?: string; stage: string; error: string }[];
  durationMs: number;
  details: { feedbackId: string; rating: number; productName: string; replyChars: number }[];
}

const THROTTLE_KEY = 'wb-reviews:throttled-until';
const THROTTLE_MINUTES = 30; // pause auto-tick for 30 min after a 429

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
  try {
    const counts = await fetchUnansweredCount(env);
    result.countTotal = counts.total;
    result.countToday = counts.today;
    console.log(`[wb-auto-reply] start max=${maxReplies} backlog=${counts.total} today=${counts.today}`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.warn(`[wb-auto-reply] count soft-fail: ${msg.slice(0, 200)}`);
    // do not push to errors, do not return — keep going
  }

  let skip = 0;
  const pageSize = Math.min(100, maxInspect);

  while (result.replied < maxReplies && result.inspected < maxInspect) {
    let page: any[];
    try {
      page = await fetchUnansweredList(env, pageSize, skip);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      result.errors.push({ stage: 'list', error: msg });
      // Honor WB-supplied retry-after instead of guessing
      if (e instanceof WbRateLimitError && env.CACHE) {
        const waitSec = e.retryAfterSec + 60; // 60s buffer above what WB asked
        const until = Date.now() + waitSec * 1000;
        await env.CACHE.put(THROTTLE_KEY, String(until), { expirationTtl: waitSec + 30 });
        console.warn(`[wb-auto-reply] 429 — throttling for ${Math.round(waitSec/60)}min as WB asked (retry=${e.retryAfterSec}s, limit=${e.limit})`);
      } else if (msg.includes('HTTP 429') && env.CACHE) {
        // fallback for any 429 we couldn't parse — use original 30min throttle
        const until = Date.now() + THROTTLE_MINUTES * 60_000;
        await env.CACHE.put(THROTTLE_KEY, String(until), { expirationTtl: THROTTLE_MINUTES * 60 + 30 });
        console.warn(`[wb-auto-reply] 429 (unparsed) hit, throttling for ${THROTTLE_MINUTES}min`);
      }
      break;
    }
    if (page.length === 0) break;

    for (const fb of page) {
      if (result.replied >= maxReplies || result.inspected >= maxInspect) break;
      result.inspected++;
      const fid = fb.id ?? '';
      const text = (fb.text ?? '').trim();
      const rating = fb.productValuation ?? 0;
      const productName = (fb.productDetails?.productName ?? '').slice(0, 60);
      const stars = '★'.repeat(rating);

      if (!text) {
        result.ratingOnlySkipped++;
        console.log(`  [${result.inspected}] skip ${fid}: rating-only (${stars})`);
        continue;
      }

      console.log(`  [${result.inspected}] ${fid}: ${stars} "${productName}" (${text.length} chars) — drafting...`);
      let draft: Draft;
      try {
        draft = await draftReply(env, fb);
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

      try {
        await postAnswer(env, fid, draft.text);
        console.log(`    ✓ posted to WB`);
        result.replied++;
        result.details.push({ feedbackId: fid, rating, productName, replyChars: draft.text.length });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.error(`    POST FAIL: ${msg}`);
        result.errors.push({ feedbackId: fid, stage: 'post', error: msg });
        // If WB rate-limited the POST — stop this tick, save quota for next */20
        if (e instanceof WbRateLimitError && env.CACHE) {
          const waitSec = e.retryAfterSec + 60;
          const until = Date.now() + waitSec * 1000;
          await env.CACHE.put(THROTTLE_KEY, String(until), { expirationTtl: waitSec + 30 });
          console.warn(`[wb-auto-reply] POST hit 429 — bail out, throttle ${Math.round(waitSec/60)}min`);
          result.durationMs = Date.now() - startedAt;
          return result;
        }
        continue;
      }

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
  console.log(`[wb-auto-reply] done replied=${result.replied}/${maxReplies} skipped=${result.ratingOnlySkipped} errors=${result.errors.length} ${result.durationMs}ms`);
  return result;
}
