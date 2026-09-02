// =============================================================================
// Связка ключа витрины .ru со счётом лояльности — чтобы в CRM был виден остаток
// баллов. Владелец разрешил разовый обход витрины 02.09.2026.
//
// Зачем. Счёт лояльности заведён на телефон, а обезличенная лента отдаёт
// покупателя необратимым 12-hex ключом. Соединение давало 0 совпадений из 1482,
// и графа Balance стояла пустой при 32 422 баллах на 685 счетах в базе.
//
// Как. Витрина умеет назвать телефон по ключу (customer.php?key=…) — той же
// штатной кнопкой, что и показ карточки. Идём по ключам, которых ещё нет в
// таблице, спрашиваем телефон, находим счёт, записываем ключ → номер счёта.
// Телефон живёт только в памяти обработчика и никуда не пишется: в базе уже
// есть свой, а второй копии заводить незачем.
//
// Почему кроном, а не одной кнопкой. Обход идёт партиями по расписанию: так
// он переживает обрыв, не упирается в лимит подзапросов воркера, не бьёт по
// витрине залпом — и, что важнее разового обхода, сам подхватывает новых
// покупателей дальше. Спросили и не нашли счёта — пишем строку с пустым
// account_id, чтобы не спрашивать про этот ключ снова.
//
// Откат: DROP TABLE crm_loyalty_key_map (миграция 0083).
// =============================================================================
import type { Env } from '../types';
import { normalizePhone } from './loyalty';

const KEY_RE = /^[0-9a-f]{12}$/i;

// Таблица заводится на месте: миграции накатываются отдельной ручкой, а крон
// обязан работать и до неё. Форма — один в один с 0083.
const DDL = `CREATE TABLE IF NOT EXISTS crm_loyalty_key_map (
  customer_key TEXT PRIMARY KEY,
  account_id   TEXT,
  checked_at   INTEGER NOT NULL
)`;

export type KeyMapReport = {
  ok: boolean;
  asked: number;        // сколько ключей спросили у витрины
  matched: number;      // из них нашли счёт
  missed: number;       // из них счёта нет
  failed: number;       // витрина не ответила — попробуем в следующий раз
  remaining: number;    // сколько ключей ещё не разобрано
  ms: number;
  error?: string;
};

/** Разобрать очередную партию ключей. Возвращает отчёт, ничего не бросает. */
export async function resolveLoyaltyKeys(env: Env, limit = 250): Promise<KeyMapReport> {
  const t0 = Date.now();
  const base: KeyMapReport = { ok: false, asked: 0, matched: 0, missed: 0, failed: 0, remaining: 0, ms: 0 };
  if (!env.RU_FEED_TOKEN) return { ...base, ms: Date.now() - t0, error: 'RU_FEED_TOKEN не задан' };

  try {
    await env.DB.prepare(DDL).run();

    const todo = await env.DB.prepare(
      `SELECT DISTINCT customer_key AS k FROM crm_orders_ru
        WHERE customer_key IS NOT NULL
          AND customer_key NOT IN (SELECT customer_key FROM crm_loyalty_key_map)
        LIMIT ?1`
    ).bind(limit).all<{ k: string }>();
    const keys = (todo.results ?? []).map((r) => r.k).filter((k) => KEY_RE.test(k));

    const remainingRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT customer_key FROM crm_orders_ru
          WHERE customer_key IS NOT NULL
            AND customer_key NOT IN (SELECT customer_key FROM crm_loyalty_key_map))`
    ).first<{ n: number }>();
    const remainingBefore = Number(remainingRow?.n ?? 0);

    if (!keys.length) {
      return { ...base, ok: true, remaining: remainingBefore, ms: Date.now() - t0 };
    }

    // Счета берём один раз списком: 1172 строки дешевле, чем запрос на ключ.
    const accs = await env.DB.prepare('SELECT id, phone FROM loyalty_accounts').all<{ id: string; phone: string }>();
    const idByPhone = new Map<string, string>();
    for (const a of accs.results ?? []) idByPhone.set(a.phone, a.id);

    const now = Math.floor(Date.now() / 1000);
    const writes: D1PreparedStatement[] = [];
    let matched = 0, missed = 0, failed = 0;

    // По восемь за раз: витрина живёт на обычном хостинге, залпом её бить нельзя.
    const CONCURRENCY = 8;
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      const chunk = keys.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (key) => {
        try {
          const res = await fetch(
            `https://dasexperten.ru/api/erp/customer.php?k=${env.RU_FEED_TOKEN}` +
            `&key=${encodeURIComponent(key)}&who=erp-key-map`,
            { cf: { cacheTtl: 0, cacheEverything: false } },
          );
          if (!res.ok) {
            // 404 — витрина такого ключа не знает. Это ответ, а не сбой:
            // записываем пустую связку, чтобы не спрашивать снова.
            if (res.status === 404) {
              missed += 1;
              writes.push(env.DB.prepare(
                'INSERT OR REPLACE INTO crm_loyalty_key_map (customer_key, account_id, checked_at) VALUES (?1, NULL, ?2)'
              ).bind(key, now));
            } else {
              failed += 1;
            }
            return;
          }
          const data = await res.json().catch(() => null) as any;
          const phone = normalizePhone(data?.customer?.phone);
          const accountId = phone ? idByPhone.get(phone) ?? null : null;
          if (accountId) matched += 1; else missed += 1;
          writes.push(env.DB.prepare(
            'INSERT OR REPLACE INTO crm_loyalty_key_map (customer_key, account_id, checked_at) VALUES (?1, ?2, ?3)'
          ).bind(key, accountId, now));
        } catch {
          // Витрина не ответила — строку не пишем, ключ достанется следующему разу.
          failed += 1;
        }
      }));
    }

    // Пишем партиями по сто: одна батч-операция на сто строк вместо ста запросов.
    for (let i = 0; i < writes.length; i += 100) {
      await env.DB.batch(writes.slice(i, i + 100));
    }

    return {
      ok: true, asked: keys.length, matched, missed, failed,
      remaining: Math.max(0, remainingBefore - writes.length),
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ...base, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}
