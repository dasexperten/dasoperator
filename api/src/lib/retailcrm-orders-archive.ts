// =============================================================================
// Спасение истории заказов RetailCRM в R2 — до удаления аккаунта.
// Владелец 02.09.2026: письмо «до удаления аккаунта 2 дня», решение — выгружать.
//
// Что спасаем. Покупатели RetailCRM у нас уже есть: 1673 строки в crm_customers
// и девять сырых файлов в R2 (crm/imports/retailcrm/customers-p*.json). А вот
// заказов нет нигде: ни таблицы в D1, ни выгрузки в R2. Живой код до сих пор
// ходил за составом заказов прямо в RetailCRM (yandex-pay-sale.ts) — после
// удаления аккаунта эта история пропадёт совсем.
//
// Как. Забираем страницы /api/v5/orders как есть и кладём сырым JSON рядом с
// покупателями: crm/imports/retailcrm/orders-pN-pM.json. Ничего не разбираем и
// не раскладываем по таблицам — сейчас важно успеть снять копию, разложить её
// можно и после удаления аккаунта. В заказах лежит то, чего нет в карточке
// покупателя: состав по позициям, суммы, адреса доставки, города.
//
// Почему кроном. Тем же порядком, что и связка ключей: партиями, с продолжением
// после обрыва (страница запоминается в crm_sync_state). Читаем только —
// ничего в RetailCRM не меняем и не удаляем.
//
// Останавливается сам: дойдя до последней страницы, пишет в состояние 'done' и
// больше не просыпается. Чтобы пройти заново — снять ключ retailcrm:orders_page.
//
// Откат: удалить файлы crm/imports/retailcrm/orders-*.json из R2. На работу ERP
// выгрузка не влияет — её пока никто не читает.
// =============================================================================
import type { Env } from '../types';

const PAGE_KEY = 'retailcrm:orders_page';
const PAGE_SIZE = 100;

export type OrdersArchiveReport = {
  ok: boolean;
  skipped?: 'done' | 'not_configured';
  fromPage: number;
  pagesDone: number;
  orders: number;
  totalPages: number;
  done: boolean;
  file?: string;
  ms: number;
  error?: string;
};

async function getState(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key = ?1')
    .bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, value, Math.floor(Date.now() / 1000)).run();
}

/** Снять очередную партию страниц заказов. Возвращает отчёт, ничего не бросает. */
export async function archiveRetailCrmOrders(env: Env, pagesPerRun = 10): Promise<OrdersArchiveReport> {
  const t0 = Date.now();
  const base: OrdersArchiveReport = {
    ok: false, fromPage: 0, pagesDone: 0, orders: 0, totalPages: 0, done: false, ms: 0,
  };
  if (!env.RETAIL_CRM_DOMAIN || !env.RETAIL_CRM_TOKEN) {
    return { ...base, ok: true, skipped: 'not_configured', ms: Date.now() - t0 };
  }
  if (!env.CUSTOMERS_DB) {
    return { ...base, ms: Date.now() - t0, error: 'R2 CUSTOMERS_DB не подключён — класть выгрузку некуда' };
  }

  try {
    const state = await getState(env, PAGE_KEY);
    if (state === 'done') return { ...base, ok: true, skipped: 'done', done: true, ms: Date.now() - t0 };

    const startPage = Math.max(1, Number(state ?? 1) || 1);
    let page = startPage;
    let totalPages = startPage;
    const raw: any[] = [];

    while (page <= totalPages && page < startPage + pagesPerRun) {
      const url = new URL(`https://${env.RETAIL_CRM_DOMAIN}.retailcrm.ru/api/v5/orders`);
      url.searchParams.set('apiKey', env.RETAIL_CRM_TOKEN);
      url.searchParams.set('page', String(page));
      url.searchParams.set('limit', String(PAGE_SIZE));
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        // Страница не далась — то, что уже собрали, всё равно кладём, а
        // состояние оставляем на этой странице: следующий тик начнёт с неё.
        break;
      }
      const data = (await res.json()) as any;
      if (!data?.success) break;
      totalPages = Number(data?.pagination?.totalPageCount ?? 1) || 1;
      for (const o of data?.orders ?? []) raw.push(o);
      page += 1;
    }

    let file: string | undefined;
    if (raw.length) {
      file = `crm/imports/retailcrm/orders-p${startPage}-p${page - 1}.json`;
      await env.CUSTOMERS_DB.put(file, JSON.stringify({
        imported_at: Math.floor(Date.now() / 1000),
        source: `${env.RETAIL_CRM_DOMAIN}.retailcrm.ru`,
        from_page: startPage, to_page: page - 1, total_pages: totalPages,
        count: raw.length,
        orders: raw,
      }, null, 2), { httpMetadata: { contentType: 'application/json' } });
    }

    const done = page > totalPages;
    await setState(env, PAGE_KEY, done ? 'done' : String(page));

    const report: OrdersArchiveReport = {
      ok: true, fromPage: startPage, pagesDone: page - startPage, orders: raw.length,
      totalPages, done, ms: Date.now() - t0,
    };
    if (file) report.file = file;
    return report;
  } catch (e) {
    return { ...base, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}
