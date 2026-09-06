// =============================================================================
// Синхронизатор зеркала заказов русской витрины — слой 3.
// Владелец 2026-08-29 · BACKLOGS/2026-08-29_crm-orders-d1-mirror.md
//
// Лента dasexperten.ru/api/erp/orders.php (v2, с 29.08: сырой статус витрины,
// paid_at Т-Кассы, доставка Ozon) → таблица crm_orders_ru в D1. Витрина остаётся
// источником истины; экран CRM → Orders читает только D1.
//
// Правила (из бэклога, дословно):
//  - тело ленты читается текстом и сверяется с Content-Length до разбора
//    (MI-LAW-260816-05); total_count обязан совпасть с длиной массива, иначе
//    синк отменяется ЦЕЛИКОМ и старые строки не трогаются;
//  - запись батчами по 100 через env.DB.batch(), upsert по order_number;
//  - полного DELETE нет никогда; заказ, исчезнувший из ленты, остаётся;
//  - персональных данных в зеркале нет: имя, телефон, почта не пишутся.
//    customer_key — необратимый ключ, как отдаёт витрина;
//  - состояние синка — ключами ru_orders:* в crm_sync_state (таблица
//    ключ-значение с 0060; своей таблицы состояния у ленты нет — 0077).
// =============================================================================
import type { Env } from '../types';

export interface StorefrontOrder {
  id?: string;
  order_number?: number | string;
  status?: string;                     // словарь КИТ: NEW · PROCESSING · DELIVERY · COMPLETED · CANCELLED
  storefront_status?: string;          // сырой статус витрины (v2)
  source?: string;
  created_at?: string;
  updated_at?: string;
  paid_at?: string | null;
  total_final_price?: string;
  purchased_price?: string;
  total_price?: string;
  total_rub?: number;
  subtotal_rub?: number;
  discount_rub?: number;
  loyalty_rub?: number;
  delivery_rub?: number;
  payment?: { status?: string };
  client?: { phone?: string; email?: string | null; first_name?: string; last_name?: string };
  delivery_chunks?: Array<{ items?: Array<{
    sku?: string; article?: string; name?: string; title?: string; quantity?: number;
  }> }>;
  delivery?: {
    provider?: string; method?: string; status?: string;
    provider_order_id?: string | null; tracking_number?: string | null;
    cost_rub?: number; updated_at?: string | null;
    // Подстатус и разбивка приходят с ленты готовыми — витрина считает их при
    // опросе Ozon. Поля появились 05.09.2026; у старой ленты их нет, поэтому всё
    // необязательное и падает в null/0, а не ломает синк.
    substatus?: string | null;
    parts_total?: number; parts_at_point?: number; parts_received?: number;
  } | null;
}

export type StorefrontFeed = {
  total: number;
  orders: StorefrontOrder[];
  feed_version?: number | undefined;
  generated_at?: string | undefined;
  stale?: boolean;
};

export const RU_FEED_KEY = 'crm:ru-feed-raw|v1';            // одна лента на все страницы экрана, 120 с
export const RU_FEED_LAST_GOOD = 'crm:ru-feed-raw|v1|lastgood';
export const RU_SYNC_STALE_AFTER_SEC = 3 * 3600;             // плашка stale на экране

// Ключи состояния в crm_sync_state (key · value · updated_at).
export const SYNC_KEYS = {
  lastOkAt: 'ru_orders:last_ok_at',
  lastTryAt: 'ru_orders:last_try_at',
  lastError: 'ru_orders:last_error',
  lastTotal: 'ru_orders:last_total',
  lastUpserted: 'ru_orders:last_upserted',
  feedVersion: 'ru_orders:feed_version',
} as const;

// -----------------------------------------------------------------------------
// Забор ленты — один раз текстом, разбор после, размер сверен.
// -----------------------------------------------------------------------------
export async function fetchStorefrontOnce(env: Env): Promise<{ feed: StorefrontFeed | null; why: string }> {
  if (!env.RU_FEED_TOKEN) return { feed: null, why: 'RU_FEED_TOKEN не задан' };
  const res = await fetch(`https://dasexperten.ru/api/erp/orders.php?k=${env.RU_FEED_TOKEN}`, {
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  const text = await res.text();
  if (!res.ok) return { feed: null, why: `витрина .ru ответила ${res.status} (${text.length} знаков)` };
  const declared = Number(res.headers.get('content-length') ?? 0);
  const bytes = new TextEncoder().encode(text).length;
  if (declared && bytes < declared) return { feed: null, why: `лента оборвана: ${bytes} из ${declared} байт` };
  try {
    const data = JSON.parse(text) as { total_count?: number; orders?: StorefrontOrder[]; feed_version?: number; generated_at?: string };
    if (!Array.isArray(data.orders)) return { feed: null, why: 'лента без orders[]' };
    return {
      feed: { total: data.total_count ?? data.orders.length, orders: data.orders, feed_version: data.feed_version, generated_at: data.generated_at },
      why: '',
    };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { feed: null, why: `лента не разбирается (${bytes}${declared ? ` из ${declared}` : ''} байт): ${m}` };
  }
}

// Лента через общий KV-кэш (120 с) с двумя попытками и суточной копией.
// Экран пользуется этим же — пока он не переведён на D1 (файл 4).
export async function fetchStorefrontOrders(env: Env): Promise<StorefrontFeed> {
  try {
    const hit = await env.CACHE.get(RU_FEED_KEY);
    if (hit !== null) return JSON.parse(hit) as StorefrontFeed;
  } catch { /* KV read failure — идём на витрину */ }

  const reasons: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { feed, why } = await fetchStorefrontOnce(env);
    if (feed) {
      const body = JSON.stringify(feed);
      try {
        await env.CACHE.put(RU_FEED_KEY, body, { expirationTtl: 120 });
        await env.CACHE.put(RU_FEED_LAST_GOOD, body, { expirationTtl: 86400 });
      } catch { /* кэш не обязателен для ответа */ }
      return feed;
    }
    reasons.push(`попытка ${attempt}: ${why}`);
  }
  console.warn('лента .ru:', reasons.join(' | '));
  try {
    const last = await env.CACHE.get(RU_FEED_LAST_GOOD);
    if (last !== null) return { ...(JSON.parse(last) as StorefrontFeed), stale: true };
  } catch { /* нет копии */ }
  throw new Error(`лента заказов витрины недоступна — ${reasons.join(' | ')} — и целой копии за сутки нет`);
}

// -----------------------------------------------------------------------------
// Разметка позиции ленты в строку зеркала. Персональных полей здесь нет по
// построению: client.first_name/last_name/email не читаются вовсе.
// -----------------------------------------------------------------------------
function rubOf(o: StorefrontOrder, key: 'total_rub' | 'subtotal_rub', fallback: string | undefined): number {
  const v = o[key];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const n = parseFloat(fallback ?? '0');
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function unitsOf(o: StorefrontOrder): number {
  let n = 0;
  for (const ch of o.delivery_chunks ?? []) for (const it of ch.items ?? []) n += Number(it.quantity ?? 0) || 0;
  return n;
}

export function rowFromOrder(o: StorefrontOrder, now: number) {
  const d = o.delivery ?? null;
  const paid = o.payment?.status === 'PAYMENT_FINALLY_PAID' || Boolean(o.paid_at) ? 1 : 0;
  return {
    order_number: String(o.order_number ?? ''),
    storefront_id: o.id != null ? String(o.id) : null,
    status: String(o.status ?? 'NEW'),
    storefront_status: o.storefront_status ?? null,
    source: o.source ?? null,
    created_at: String(o.created_at ?? ''),
    updated_at: o.updated_at ?? null,
    paid,
    paid_at: o.paid_at ?? null,
    total_rub: rubOf(o, 'total_rub', o.total_final_price ?? o.purchased_price),
    subtotal_rub: rubOf(o, 'subtotal_rub', o.total_price),
    discount_rub: Math.round(o.discount_rub ?? 0),
    loyalty_rub: Math.round(o.loyalty_rub ?? 0),
    delivery_rub: Math.round(o.delivery_rub ?? 0),
    units: unitsOf(o),
    customer_key: o.client?.phone ? String(o.client.phone) : null,   // необратимый ключ витрины, не телефон
    delivery_provider: d?.provider ?? null,
    delivery_method: d?.method ?? null,
    delivery_status: d?.status ?? null,
    delivery_order_id: d?.provider_order_id ?? null,
    tracking_number: d?.tracking_number ?? null,
    delivery_cost_rub: Math.round(d?.cost_rub ?? 0),
    delivery_updated_at: d?.updated_at ?? null,
    delivery_substatus: d?.substatus ?? null,
    delivery_parts_total: Math.round(d?.parts_total ?? 0),
    delivery_parts_at_point: Math.round(d?.parts_at_point ?? 0),
    delivery_parts_received: Math.round(d?.parts_received ?? 0),
    raw_json: JSON.stringify(o),
    synced_at: now,
  };
}

const UPSERT_SQL = `
INSERT INTO crm_orders_ru (
  order_number, storefront_id, status, storefront_status, source, created_at, updated_at,
  paid, paid_at, total_rub, subtotal_rub, discount_rub, loyalty_rub, delivery_rub, units, customer_key,
  delivery_provider, delivery_method, delivery_status, delivery_order_id, tracking_number,
  delivery_cost_rub, delivery_updated_at,
  delivery_substatus, delivery_parts_total, delivery_parts_at_point, delivery_parts_received,
  raw_json, first_seen_at, synced_at
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?29)
ON CONFLICT(order_number) DO UPDATE SET
  storefront_id = excluded.storefront_id, status = excluded.status, storefront_status = excluded.storefront_status,
  source = excluded.source, created_at = excluded.created_at, updated_at = excluded.updated_at,
  paid = excluded.paid, paid_at = excluded.paid_at, total_rub = excluded.total_rub, subtotal_rub = excluded.subtotal_rub,
  discount_rub = excluded.discount_rub, loyalty_rub = excluded.loyalty_rub, delivery_rub = excluded.delivery_rub,
  units = excluded.units, customer_key = excluded.customer_key,
  delivery_provider = excluded.delivery_provider, delivery_method = excluded.delivery_method,
  delivery_status = excluded.delivery_status, delivery_order_id = excluded.delivery_order_id,
  tracking_number = excluded.tracking_number, delivery_cost_rub = excluded.delivery_cost_rub,
  delivery_updated_at = excluded.delivery_updated_at,
  delivery_substatus = excluded.delivery_substatus, delivery_parts_total = excluded.delivery_parts_total,
  delivery_parts_at_point = excluded.delivery_parts_at_point, delivery_parts_received = excluded.delivery_parts_received,
  raw_json = excluded.raw_json, synced_at = excluded.synced_at`;

const STATE_SQL = `INSERT INTO crm_sync_state (key, value, updated_at) VALUES (?1, ?2, ?3)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

async function writeState(env: Env, pairs: Array<[string, string | number | null]>, now: number): Promise<void> {
  await env.DB.batch(pairs.map(([k, v]) => env.DB.prepare(STATE_SQL).bind(k, v == null ? '' : String(v), now)));
}

export async function readSyncState(env: Env): Promise<Record<string, string>> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM crm_sync_state WHERE key LIKE 'ru_orders:%'`,
  ).all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of rows.results ?? []) out[r.key] = r.value;
  return out;
}

export interface SyncReport {
  ok: boolean;
  total: number;
  upserted: number;
  batches: number;
  feed_version: number | null;
  stale_feed: boolean;
  ms: number;
  error?: string;
}

// -----------------------------------------------------------------------------
// Сам синк. Живая лента (мимо KV: крон обязан видеть витрину, а не кэш),
// валидация, батчи, состояние. Любой сбой ДО записи — старые строки не тронуты.
// -----------------------------------------------------------------------------
export async function syncRuOrders(env: Env): Promise<SyncReport> {
  const t0 = Date.now();
  const now = Math.floor(t0 / 1000);
  await writeState(env, [[SYNC_KEYS.lastTryAt, now]], now);

  let feed: StorefrontFeed | null = null;
  const reasons: string[] = [];
  for (let attempt = 1; attempt <= 2 && !feed; attempt++) {
    const r = await fetchStorefrontOnce(env);
    if (r.feed) feed = r.feed; else reasons.push(`попытка ${attempt}: ${r.why}`);
  }
  if (!feed) {
    const error = reasons.join(' | ');
    await writeState(env, [[SYNC_KEYS.lastError, error]], now);
    return { ok: false, total: 0, upserted: 0, batches: 0, feed_version: null, stale_feed: false, ms: Date.now() - t0, error };
  }

  // Валидация до записи: total_count = длина массива, номера непустые и уникальные.
  if (feed.total !== feed.orders.length) {
    const error = `total_count ${feed.total} ≠ длина ${feed.orders.length} — синк отменён целиком`;
    await writeState(env, [[SYNC_KEYS.lastError, error]], now);
    return { ok: false, total: feed.total, upserted: 0, batches: 0, feed_version: feed.feed_version ?? null, stale_feed: false, ms: Date.now() - t0, error };
  }
  const rows = feed.orders.map((o) => rowFromOrder(o, now));
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.order_number || !r.created_at) {
      const error = `позиция без order_number/created_at (id=${r.storefront_id ?? '?'}) — синк отменён целиком`;
      await writeState(env, [[SYNC_KEYS.lastError, error]], now);
      return { ok: false, total: feed.total, upserted: 0, batches: 0, feed_version: feed.feed_version ?? null, stale_feed: false, ms: Date.now() - t0, error };
    }
    if (seen.has(r.order_number)) {
      const error = `дубль order_number ${r.order_number} в ленте — синк отменён целиком`;
      await writeState(env, [[SYNC_KEYS.lastError, error]], now);
      return { ok: false, total: feed.total, upserted: 0, batches: 0, feed_version: feed.feed_version ?? null, stale_feed: false, ms: Date.now() - t0, error };
    }
    seen.add(r.order_number);
  }

  // Запись батчами по 100.
  let batches = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await env.DB.batch(chunk.map((r) => env.DB.prepare(UPSERT_SQL).bind(
      r.order_number, r.storefront_id, r.status, r.storefront_status, r.source, r.created_at, r.updated_at,
      r.paid, r.paid_at, r.total_rub, r.subtotal_rub, r.discount_rub, r.loyalty_rub, r.delivery_rub, r.units, r.customer_key,
      r.delivery_provider, r.delivery_method, r.delivery_status, r.delivery_order_id, r.tracking_number,
      r.delivery_cost_rub, r.delivery_updated_at,
      r.delivery_substatus, r.delivery_parts_total, r.delivery_parts_at_point, r.delivery_parts_received,
      r.raw_json, r.synced_at,
    )));
    batches++;
  }

  await writeState(env, [
    [SYNC_KEYS.lastOkAt, now],
    [SYNC_KEYS.lastError, null],
    [SYNC_KEYS.lastTotal, feed.total],
    [SYNC_KEYS.lastUpserted, rows.length],
    [SYNC_KEYS.feedVersion, feed.feed_version ?? 1],
  ], now);

  // Освежаем и общий кэш экрана той же лентой — экран до файла 4 читает его.
  try {
    const body = JSON.stringify(feed);
    await env.CACHE.put(RU_FEED_KEY, body, { expirationTtl: 120 });
    await env.CACHE.put(RU_FEED_LAST_GOOD, body, { expirationTtl: 86400 });
  } catch { /* не обязательно */ }

  return { ok: true, total: feed.total, upserted: rows.length, batches, feed_version: feed.feed_version ?? null, stale_feed: false, ms: Date.now() - t0 };
}
