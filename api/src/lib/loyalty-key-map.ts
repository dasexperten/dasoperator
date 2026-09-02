// =============================================================================
// Связка ключа витрины .ru с данными покупателя — счёт лояльности и город.
// Владелец разрешил обход витрины 02.09.2026 и попросил город второй графой.
//
// Зачем. Счёт лояльности заведён на телефон, а обезличенная лента отдаёт
// покупателя необратимым 12-hex ключом: соединение давало 0 совпадений из 1482
// при 32 422 баллах на 685 счетах. Города в ленте нет вовсе — проверено по всем
// 1850 строкам зеркала: city 0, region 0, address 0.
//
// Как. Витрина отдаёт карточку по номеру заказа (customer.php?order=…): там и
// телефон, и delivery.city. Берём последний заказ покупателя, спрашиваем один
// раз — и получаем сразу счёт и город. Раньше обход спрашивал по ключу и города
// не видел; теперь один запрос вместо двух.
//
// Что храним. Ключ, номер счёта и город. Телефон живёт мгновение в обработчике,
// чтобы найти счёт, и выбрасывается: свои телефоны уже лежат в loyalty_accounts,
// вторая копия ни к чему. Город — не персональные данные: это населённый пункт
// пункта выдачи, а не адрес человека.
//
// Почему кроном, а не одной кнопкой. Партиями по расписанию: так обход
// переживает обрыв, не упирается в лимит подзапросов воркера, не бьёт по
// витрине залпом — и сам подхватывает новых покупателей дальше.
//
// Пустой account_id значит «спросили, счёта нет»; пустая строка в city —
// «спросили, города в заказе нет». NULL в city — ещё не спрашивали. Так ни один
// ключ не спрашивается дважды впустую.
//
// Откат: DROP TABLE crm_loyalty_key_map (миграции 0083, 0084).
// =============================================================================
import type { Env } from '../types';
import { normalizePhone } from './loyalty';

const KEY_RE = /^[0-9a-f]{12}$/i;

// Таблица заводится на месте: миграции накатываются отдельной ручкой, а крон
// обязан работать и до неё. Форма — один в один с 0083 + 0084.
const DDL = `CREATE TABLE IF NOT EXISTS crm_loyalty_key_map (
  customer_key TEXT PRIMARY KEY,
  account_id   TEXT,
  checked_at   INTEGER NOT NULL,
  city         TEXT
)`;

export type KeyMapReport = {
  ok: boolean;
  asked: number;        // сколько карточек спросили у витрины
  matched: number;      // из них нашли счёт
  withCity: number;     // из них узнали город
  failed: number;       // витрина не ответила — попробуем в следующий раз
  remaining: number;    // сколько покупателей ещё не разобрано
  ms: number;
  error?: string;
};

/** Разобрать очередную партию покупателей. Возвращает отчёт, ничего не бросает. */
export async function resolveLoyaltyKeys(env: Env, limit = 250): Promise<KeyMapReport> {
  const t0 = Date.now();
  const base: KeyMapReport = {
    ok: false, asked: 0, matched: 0, withCity: 0, failed: 0, remaining: 0, ms: 0,
  };
  if (!env.RU_FEED_TOKEN) return { ...base, ms: Date.now() - t0, error: 'RU_FEED_TOKEN не задан' };

  try {
    await env.DB.prepare(DDL).run();
    // Таблица могла родиться на версии 0083, без города. Пробуем добавить и
    // молчим, если столбец уже на месте: ALTER в SQLite повторно не проходит.
    try {
      await env.DB.prepare('ALTER TABLE crm_loyalty_key_map ADD COLUMN city TEXT').run();
    } catch { /* столбец уже есть */ }

    // Берём по последнему заказу на покупателя — в нём город свежее всего.
    // Разбору подлежат и новые ключи, и старые строки без города.
    const TODO_SQL = `
      SELECT o.customer_key AS k, o.order_number AS ord
        FROM crm_orders_ru o
        JOIN (SELECT customer_key, MAX(created_at) AS mx
                FROM crm_orders_ru WHERE customer_key IS NOT NULL
               GROUP BY customer_key) t
          ON t.customer_key = o.customer_key AND t.mx = o.created_at
        LEFT JOIN crm_loyalty_key_map m ON m.customer_key = o.customer_key
       WHERE o.customer_key IS NOT NULL
         AND (m.customer_key IS NULL OR m.city IS NULL)
       GROUP BY o.customer_key`;

    const [todo, remainingRow] = await Promise.all([
      env.DB.prepare(`${TODO_SQL} LIMIT ?1`).bind(limit).all<{ k: string; ord: string }>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM (${TODO_SQL})`).first<{ n: number }>(),
    ]);
    const rows = (todo.results ?? []).filter((r) => KEY_RE.test(r.k) && r.ord);
    const remainingBefore = Number(remainingRow?.n ?? 0);

    if (!rows.length) {
      return { ...base, ok: true, remaining: remainingBefore, ms: Date.now() - t0 };
    }

    // Счета берём один раз списком: 1172 строки дешевле, чем запрос на ключ.
    const accs = await env.DB.prepare('SELECT id, phone FROM loyalty_accounts').all<{ id: string; phone: string }>();
    const idByPhone = new Map<string, string>();
    for (const a of accs.results ?? []) idByPhone.set(a.phone, a.id);

    const now = Math.floor(Date.now() / 1000);
    const writes: D1PreparedStatement[] = [];
    let matched = 0, withCity = 0, failed = 0;

    const upsert = (key: string, accountId: string | null, city: string) =>
      env.DB.prepare(
        `INSERT INTO crm_loyalty_key_map (customer_key, account_id, checked_at, city)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(customer_key) DO UPDATE SET
           account_id = COALESCE(excluded.account_id, crm_loyalty_key_map.account_id),
           city       = excluded.city,
           checked_at = excluded.checked_at`
      ).bind(key, accountId, now, city);

    // По восемь за раз: витрина живёт на обычном хостинге, залпом её бить нельзя.
    const CONCURRENCY = 8;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const chunk = rows.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async ({ k, ord }) => {
        try {
          const res = await fetch(
            `https://dasexperten.ru/api/erp/customer.php?k=${env.RU_FEED_TOKEN}` +
            `&order=${encodeURIComponent(ord)}&who=erp-key-map`,
            { cf: { cacheTtl: 0, cacheEverything: false } },
          );
          if (!res.ok) {
            // 404 — витрина такого заказа не знает. Это ответ, а не сбой:
            // помечаем пустотой, чтобы не спрашивать снова.
            if (res.status === 404) writes.push(upsert(k, null, ''));
            else failed += 1;
            return;
          }
          const data = await res.json().catch(() => null) as any;
          const phone = normalizePhone(data?.customer?.phone);
          const accountId = phone ? idByPhone.get(phone) ?? null : null;
          const city = typeof data?.delivery?.city === 'string' ? data.delivery.city.trim() : '';
          if (accountId) matched += 1;
          if (city) withCity += 1;
          writes.push(upsert(k, accountId, city));
        } catch {
          // Витрина не ответила — строку не пишем, ключ достанется следующему разу.
          failed += 1;
        }
      }));
    }

    // Пишем партиями по сто: одна батч-операция вместо сотни запросов.
    for (let i = 0; i < writes.length; i += 100) {
      await env.DB.batch(writes.slice(i, i + 100));
    }

    return {
      ok: true, asked: rows.length, matched, withCity, failed,
      remaining: Math.max(0, remainingBefore - writes.length),
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ...base, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}
