// =============================================================================
// Зеркало почтовой описи в D1 — ход 1 (Владелец 2026-09-02, миграция 0085).
//
// R2 остаётся архивом: каждое письмо лежит записью Inbox/<адрес>/<направление>/…
// и попадает в опись Inbox/<адрес>.json. Экран «Почта» больше не читает эти
// описи на каждом открытии — он читает таблицу mail_index.
//
// Почему: опись тяжёлого ящика переписывается целиком на каждое письмо, и
// чтение той же горячей записи встаёт в очередь за записями. Замер 02.09:
// mina@ (7 писем) 0,6 с · orders@ (100) 0,5 с · support@ 20 с и при повторе
// молчание 8 минут · sales@ 17 минут · обход всех описей ради счётчиков —
// молчание 13 минут. Тело письма из той же R2 приходит за 0,5 с: медленным
// был обход описей, а не хранилище.
//
// Две руки наполняют зеркало:
//  1. Сквозная запись — archiveEmail() кладёт строку сразу, лучшим усилием;
//     упасть она не имеет права: письмо уже в R2, и потеря строки в зеркале
//     лечится обходом, а потеря письма не лечится ничем.
//  2. Обход — sweepMailIndex() раз в 15 минут сверяет описи и добирает всё,
//     что записали не через этот воркер (места шлют со своих ключей).
//     Ящик, чья опись не изменилась, не разбирается вовсе: сверяется etag,
//     а не содержимое.
//
// Возврат целиком: MAIL_INDEX_SOURCE="r2" на воркере — чтение возвращается
// на описи, зеркало остаётся лежать и никому не мешает.
// =============================================================================
import type { Env } from '../types';
import type { IndexEntry, MailDirection } from './inbox-archive';

/** Строка зеркала — ровно поля описи, ничего сверх. */
export interface MailRow {
  message_key: string;
  mailbox: string;
  direction: MailDirection;
  timestamp: string;
  subject: string;
  from_addr: string | null;
  to_addr: string | null;
  message_id: string | null;
  thread_id: string | null;
  plus_tag: string | null;
  origin: string | null;
  trigger_name: string | null;
  agent: string | null;
  attachment_count: number;
  auth_json: string | null;
}

const UPSERT_SQL = `
INSERT INTO mail_index (
  message_key, mailbox, direction, timestamp, subject, from_addr, to_addr,
  message_id, thread_id, plus_tag, origin, trigger_name, agent,
  attachment_count, auth_json, synced_at
) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
ON CONFLICT(message_key) DO UPDATE SET
  mailbox          = excluded.mailbox,
  direction        = excluded.direction,
  timestamp        = excluded.timestamp,
  subject          = excluded.subject,
  from_addr        = excluded.from_addr,
  to_addr          = excluded.to_addr,
  message_id       = excluded.message_id,
  thread_id        = excluded.thread_id,
  plus_tag         = excluded.plus_tag,
  origin           = excluded.origin,
  trigger_name     = excluded.trigger_name,
  agent            = excluded.agent,
  attachment_count = excluded.attachment_count,
  auth_json        = excluded.auth_json,
  synced_at        = excluded.synced_at`;

const STATE_SQL = `
INSERT INTO mail_index_state (key, value, updated_at) VALUES (?1, ?2, ?3)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

const INDEX_PREFIX = 'Inbox/';

/** Опись, разбор которой занял больше этого, считается тяжёлой. */
const HEAVY_MS = 20_000;
/** Тяжёлую опись обход трогает не чаще раза в час. */
const HEAVY_EVERY_S = 3600;

export function rowFromEntry(mailbox: string, e: IndexEntry): MailRow {
  return {
    message_key: e.key,
    mailbox: mailbox.toLowerCase(),
    direction: e.direction,
    timestamp: e.timestamp,
    subject: e.subject ?? '',
    from_addr: e.from ?? null,
    to_addr: e.to == null ? null : Array.isArray(e.to) ? JSON.stringify(e.to) : e.to,
    message_id: e.messageId ?? null,
    thread_id: e.threadId ?? null,
    plus_tag: e.plusTag ?? null,
    origin: e.origin ?? null,
    trigger_name: e.trigger ?? null,
    agent: e.agent ?? null,
    attachment_count: e.attachmentCount ?? 0,
    auth_json: e.auth ? JSON.stringify(e.auth) : null,
  };
}

/** Обратно в форму описи — экран и всё ниже по течению не переписываются. */
export function entryFromRow(r: Record<string, unknown>): IndexEntry & { mailbox: string } {
  const to = r['to_addr'] == null ? undefined : String(r['to_addr']);
  let toValue: string | string[] | undefined = to;
  if (to && to.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(to);
      if (Array.isArray(parsed)) toValue = parsed as string[];
    } catch { /* не JSON — значит обычный адрес строкой */ }
  }
  let auth: IndexEntry['auth'];
  if (r['auth_json']) {
    try { auth = JSON.parse(String(r['auth_json'])) as IndexEntry['auth']; } catch { auth = undefined; }
  }
  return {
    key: String(r['message_key']),
    mailbox: String(r['mailbox']),
    direction: String(r['direction']) as MailDirection,
    timestamp: String(r['timestamp']),
    subject: String(r['subject'] ?? ''),
    ...(r['from_addr'] ? { from: String(r['from_addr']) } : {}),
    ...(toValue ? { to: toValue } : {}),
    ...(r['message_id'] ? { messageId: String(r['message_id']) } : {}),
    ...(r['thread_id'] ? { threadId: String(r['thread_id']) } : {}),
    ...(r['plus_tag'] ? { plusTag: String(r['plus_tag']) } : {}),
    ...(r['origin'] ? { origin: String(r['origin']) as IndexEntry['origin'] } : {}),
    ...(r['trigger_name'] ? { trigger: String(r['trigger_name']) } : {}),
    ...(r['agent'] ? { agent: String(r['agent']) } : {}),
    ...(Number(r['attachment_count'] ?? 0) ? { attachmentCount: Number(r['attachment_count']) } : {}),
    ...(auth ? { auth } : {}),
  };
}

async function putState(env: Env, pairs: Array<[string, string]>): Promise<void> {
  if (!pairs.length) return;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch(pairs.map(([k, v]) => env.DB.prepare(STATE_SQL).bind(k, v, now)));
}

export async function readState(env: Env, prefix?: string): Promise<Record<string, string>> {
  const sql = prefix
    ? 'SELECT key, value FROM mail_index_state WHERE key LIKE ?1'
    : 'SELECT key, value FROM mail_index_state';
  const stmt = prefix ? env.DB.prepare(sql).bind(`${prefix}%`) : env.DB.prepare(sql);
  const rows = await stmt.all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of rows.results ?? []) out[r.key] = r.value;
  return out;
}

/** Пишет пачку строк батчами по 100. Возвращает, сколько строк ушло. */
export async function upsertMailRows(env: Env, rows: MailRow[]): Promise<number> {
  if (!rows.length) return 0;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    await env.DB.batch(chunk.map((r) => env.DB.prepare(UPSERT_SQL).bind(
      r.message_key, r.mailbox, r.direction, r.timestamp, r.subject,
      r.from_addr, r.to_addr, r.message_id, r.thread_id, r.plus_tag,
      r.origin, r.trigger_name, r.agent, r.attachment_count, r.auth_json, now,
    )));
  }
  return rows.length;
}

// -----------------------------------------------------------------------------
// Сквозная запись из archiveEmail(). Лучшее усилие: письмо уже в R2, и ошибка
// здесь не имеет права всплыть выше — обход доберёт строку через 15 минут.
// -----------------------------------------------------------------------------
export async function recordMailIndexRow(env: Env, mailbox: string, entry: IndexEntry): Promise<void> {
  try {
    await upsertMailRows(env, [rowFromEntry(mailbox, entry)]);
  } catch (err) {
    console.log(JSON.stringify({
      scope: 'mail-index', success: false, stage: 'write_through',
      mailbox, error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// -----------------------------------------------------------------------------
// Список описей в R2 — только имена ящиков, без чтения содержимого.
// -----------------------------------------------------------------------------
export async function listIndexKeys(env: Env): Promise<string[]> {
  const listed = await env.ARCHIVE.list({ prefix: INDEX_PREFIX, delimiter: '/' });
  return listed.objects
    .map((o) => o.key)
    .filter((k) => k.endsWith('.json') && !k.slice(INDEX_PREFIX.length).includes('/'));
}

export function addressFromIndexKey(key: string): string {
  return key.slice(INDEX_PREFIX.length, -'.json'.length).toLowerCase();
}

/**
 * Размеры описей без разбора — head(), не get(). Диагностика: именно этим
 * меряется, какой ящик стоит поперёк, и стоит ли ротировать его опись.
 */
export async function indexSizes(env: Env): Promise<Array<{ address: string; bytes: number; uploaded: string | null }>> {
  const keys = await listIndexKeys(env);
  const out = await Promise.all(keys.map(async (key) => {
    try {
      const h = await env.ARCHIVE.head(key);
      return {
        address: addressFromIndexKey(key),
        bytes: h?.size ?? 0,
        uploaded: h?.uploaded ? new Date(h.uploaded).toISOString() : null,
      };
    } catch {
      return { address: addressFromIndexKey(key), bytes: -1, uploaded: null };
    }
  }));
  return out.sort((a, b) => b.bytes - a.bytes);
}

export interface MailboxSyncResult {
  address: string;
  skipped: boolean;      // опись не менялась с прошлого обхода
  entries: number;
  upserted: number;
  bytes: number;
  ms: number;
  error?: string;
}

/**
 * Один ящик: сверить etag описи, при изменении — разобрать и записать.
 * Неизменившийся ящик стоит одного head() и ничего больше.
 */
export async function syncMailbox(env: Env, address: string, opts?: { force?: boolean }): Promise<MailboxSyncResult> {
  const t0 = Date.now();
  const addr = address.toLowerCase();
  const key = `${INDEX_PREFIX}${addr}.json`;
  const stateKey = `mailbox:${addr}:etag`;

  try {
    const head = await env.ARCHIVE.head(key);
    if (!head) return { address: addr, skipped: true, entries: 0, upserted: 0, bytes: 0, ms: Date.now() - t0 };

    if (!opts?.force) {
      const state = await readState(env, stateKey);
      if (state[stateKey] && state[stateKey] === head.etag) {
        return { address: addr, skipped: true, entries: 0, upserted: 0, bytes: head.size, ms: Date.now() - t0 };
      }
    }

    const obj = await env.ARCHIVE.get(key);
    if (!obj) return { address: addr, skipped: true, entries: 0, upserted: 0, bytes: head.size, ms: Date.now() - t0 };

    let entries: IndexEntry[] = [];
    const parsed: unknown = JSON.parse(await obj.text());
    if (Array.isArray(parsed)) entries = parsed as IndexEntry[];

    const rows = entries
      .filter((e) => e && typeof e.key === 'string' && typeof e.timestamp === 'string')
      .map((e) => rowFromEntry(addr, e));
    const upserted = await upsertMailRows(env, rows);

    const ms = Date.now() - t0;
    await putState(env, [
      [stateKey, obj.etag],
      [`mailbox:${addr}:rows`, String(rows.length)],
      [`mailbox:${addr}:ms`, String(ms)],
      [`mailbox:${addr}:at`, String(Math.floor(Date.now() / 1000))],
    ]);

    return { address: addr, skipped: false, entries: entries.length, upserted, bytes: head.size, ms };
  } catch (err) {
    return {
      address: addr, skipped: false, entries: 0, upserted: 0, bytes: 0, ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SweepResult {
  ok: boolean;
  boxes: number;          // сколько ящиков тронули на этом тике
  changed: number;        // сколько разбирали
  upserted: number;
  cursor: string | null;  // с какого ящика продолжит следующий тик
  ms: number;
  results: MailboxSyncResult[];
}

/**
 * Обход по кругу: за тик берём несколько ящиков, остальное — в следующий.
 * Так один тяжёлый ящик не забирает весь тик, а лёгкие проверяются часто.
 */
export async function sweepMailIndex(env: Env, opts?: { max?: number; force?: boolean }): Promise<SweepResult> {
  const t0 = Date.now();
  const max = Math.max(1, Math.min(40, opts?.max ?? 6));
  try {
    const addresses = (await listIndexKeys(env)).map(addressFromIndexKey).sort();
    if (!addresses.length) {
      return { ok: true, boxes: 0, changed: 0, upserted: 0, cursor: null, ms: Date.now() - t0, results: [] };
    }

    const state = await readState(env, 'sweep:');
    const cursor = state['sweep:cursor'] ?? '';
    let start = addresses.findIndex((a) => a > cursor);
    if (start < 0) start = 0;

    const plan: string[] = [];
    for (let i = 0; i < max; i++) {
      const addr = addresses[(start + i) % addresses.length];
      if (addr) plan.push(addr);
    }

    // Курсор двигается ДО работы, а не после. Ящик, который убьёт этот тик
    // (у тяжёлых описей это минуты), иначе встанет пробкой: следующий тик
    // начал бы с него же, и лёгкие ящики за ним не обновились бы никогда.
    const last = plan[plan.length - 1] ?? cursor;
    const now = Math.floor(Date.now() / 1000);
    await putState(env, [
      ['sweep:cursor', last],
      ['sweep:last_try_at', String(now)],
    ]);

    // Тяжёлая опись (разбор дольше HEAVY_MS) не читается чаще раза в час:
    // такой ящик пишется постоянно, etag меняется каждый тик, и без этого
    // правила обход занимался бы только им.
    const results: MailboxSyncResult[] = [];
    for (const addr of plan) {
      const ms = Number(state[`mailbox:${addr}:ms`] ?? 0);
      const at = Number(state[`mailbox:${addr}:at`] ?? 0);
      if (!opts?.force && ms > HEAVY_MS && now - at < HEAVY_EVERY_S) {
        results.push({ address: addr, skipped: true, entries: 0, upserted: 0, bytes: 0, ms: 0 });
        continue;
      }
      results.push(await syncMailbox(env, addr, { force: opts?.force ?? false }));
    }

    await putState(env, [
      ['sweep:last_ok_at', String(Math.floor(Date.now() / 1000))],
      ['sweep:last_error', ''],
    ]);

    return {
      ok: true,
      boxes: results.length,
      changed: results.filter((r) => !r.skipped && !r.error).length,
      upserted: results.reduce((s, r) => s + r.upserted, 0),
      cursor: last,
      ms: Date.now() - t0,
      results,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { await putState(env, [['sweep:last_error', msg]]); } catch { /* состояние — не повод падать */ }
    return { ok: false, boxes: 0, changed: 0, upserted: 0, cursor: null, ms: Date.now() - t0, results: [] };
  }
}

// -----------------------------------------------------------------------------
// Чтение экрана. Одна выборка вместо тридцати обходов хранилища.
// -----------------------------------------------------------------------------

/** Живо ли зеркало: без единой строки читать из него нечего. */
export async function mirrorReady(env: Env): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT 1 AS ok FROM mail_index LIMIT 1').first<{ ok: number }>();
    return !!row;
  } catch {
    return false;
  }
}

export async function mailboxEntriesFromD1(env: Env, address: string, limit = 100): Promise<IndexEntry[]> {
  const rows = await env.DB
    .prepare('SELECT * FROM mail_index WHERE mailbox = ?1 ORDER BY timestamp DESC LIMIT ?2')
    .bind(address.toLowerCase(), Math.max(1, Math.min(500, limit)))
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(entryFromRow);
}

/** Лента всех ящиков одним запросом — то, ради чего затевалось. */
export async function feedFromD1(env: Env, limit = 400): Promise<Array<IndexEntry & { mailbox: string }>> {
  const rows = await env.DB
    .prepare('SELECT * FROM mail_index ORDER BY timestamp DESC LIMIT ?1')
    .bind(Math.max(1, Math.min(2000, limit)))
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(entryFromRow);
}

export async function mailboxCountsFromD1(env: Env): Promise<Map<string, { count: number; last_activity: string | null }>> {
  const rows = await env.DB
    .prepare('SELECT mailbox, COUNT(*) AS n, MAX(timestamp) AS last FROM mail_index GROUP BY mailbox')
    .all<{ mailbox: string; n: number; last: string | null }>();
  const out = new Map<string, { count: number; last_activity: string | null }>();
  for (const r of rows.results ?? []) out.set(r.mailbox, { count: Number(r.n), last_activity: r.last ?? null });
  return out;
}

/** Флаг возврата: MAIL_INDEX_SOURCE="r2" — читаем описи, как читали до 02.09. */
export function mirrorEnabled(env: Env): boolean {
  return (env.MAIL_INDEX_SOURCE ?? 'd1') !== 'r2';
}
