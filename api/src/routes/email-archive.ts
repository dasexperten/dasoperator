// =============================================================================
// Read-only API for the Inbox R2 archive (api/src/lib/inbox-archive.ts) —
// backs the internal Cloudflare mail client on /emailer (the "Inbox" tab).
// This is deliberately independent of the EMAILER (Apps Script/Gmail) bridge
// — it only ever reads Inbox/<mailbox>/... records written by sendEmail().
//
//   GET /api/email/mailboxes                    — list mailboxes with an index
//   GET /api/email/mailboxes/:address            — one mailbox's message list
//   GET /api/email/mailboxes/:address/message    — one full message record
//
// Requires a valid session (any logged-in user) — this is internal system
// mail, not public data.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession } from '../lib/auth';
import type { IndexEntry, ArchivedAttachment } from '../lib/inbox-archive';
import { inlineCidImages } from '../lib/inbox-archive';
import {
  mirrorEnabled,
  mailboxEntriesFromD1,
  mailboxCountsFromD1,
  feedFromD1,
  indexSizes,
  sweepMailIndex,
  syncMailbox,
  snapshotMailbox,
  snapshotPass,
} from '../lib/mail-index-sync';
import { callFlash } from '../lib/llm';
import {
  agentsForUi,
  departmentsForUi,
  agentAvatarUrl,
  OWNER_PERSONAL_ADDRESS,
  OWNER_GMAIL_FORWARD,
} from '../lib/mailbox-registry';

const route = new Hono<{ Bindings: Env }>();

function bearer(c: import('hono').Context): string | null {
  const h = c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ? m[1].trim() : null;
}

async function requireSession(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  const token = bearer(c);
  if (!token) return false;
  const user = await validateSession(c.env.DB, token);
  return !!user;
}

function normalizeAddress(raw: string): string {
  return decodeURIComponent(raw).trim().toLowerCase();
}

// -----------------------------------------------------------------------------
// GET /mailboxes — every mailbox that has an Inbox/<address>.json index.
// Owner personal (dr.badalyan@) is filtered out of the list — Gmail-only.
// Index files sit directly under the Inbox/ prefix (no further "/"), so a
// delimited list() call separates them from the per-mailbox sent/received
// subfolders in one pass.
// -----------------------------------------------------------------------------
route.get('/mailboxes', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  // Ход 1 (02.09): счётчики — одна выборка с GROUP BY вместо скачивания и
  // разбора описи каждого ящика. Тот обход 02.09 не ответил за 13 минут.
  if (mirrorEnabled(c.env)) {
    try {
      const counts = await mailboxCountsFromD1(c.env);
      if (counts.size) {
        const mailboxes = Array.from(counts.entries())
          .map(([address, m]) => ({ address, count: m.count, last_activity: m.last_activity }))
          .filter((m) => m.address !== OWNER_PERSONAL_ADDRESS);
        mailboxes.sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''));
        return ok(c, { mailboxes });
      }
    } catch (err) {
      console.log(JSON.stringify({
        scope: 'email-archive', success: false, stage: 'mirror_mailboxes',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  try {
    const listed = await c.env.ARCHIVE.list({ prefix: 'Inbox/', delimiter: '/' });
    const indexKeys = listed.objects
      .map((o) => o.key)
      .filter((k) => k.endsWith('.json') && !k.slice('Inbox/'.length).includes('/'));

    const mailboxes = await Promise.all(indexKeys.map(async (key) => {
      const address = key.slice('Inbox/'.length, -'.json'.length);
      let count = 0;
      let lastActivity: string | null = null;
      try {
        const obj = await c.env.ARCHIVE.get(key);
        if (obj) {
          const entries: IndexEntry[] = JSON.parse(await obj.text());
          if (Array.isArray(entries)) {
            count = entries.length;
            lastActivity = entries.reduce<string | null>(
              (max, e) => (!max || e.timestamp > max ? e.timestamp : max),
              null
            );
          }
        }
      } catch { /* corrupt index — report what we can (count 0) rather than fail the whole list */ }
      return { address, count, last_activity: lastActivity };
    }));

    // Never surface Owner personal mailbox in ERP mail lists.
    const filtered = mailboxes.filter(
      (m) => m.address.toLowerCase() !== OWNER_PERSONAL_ADDRESS,
    );
    filtered.sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''));
    return ok(c, { mailboxes: filtered });
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

// -----------------------------------------------------------------------------
// GET /nav — Agents + Departments for /emailer accordion (registry + R2 counts).
// Always returns full agent/department sets even when R2 is empty (count 0).
// Owner personal is never included.
// -----------------------------------------------------------------------------
route.get('/nav', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  try {
    // Ход 1 (02.09): счётчики левой колонки — из зеркала. Прежний обход всех
    // описей остаётся ниже как запасной путь и как поведение при флаге "r2".
    let countBy = new Map<string, { count: number; last_activity: string | null }>();
    if (mirrorEnabled(c.env)) {
      try {
        countBy = await mailboxCountsFromD1(c.env);
      } catch (err) {
        console.log(JSON.stringify({
          scope: 'email-archive', success: false, stage: 'mirror_nav',
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    if (!countBy.size) {
    const listed = await c.env.ARCHIVE.list({ prefix: 'Inbox/', delimiter: '/' });
    const indexKeys = listed.objects
      .map((o) => o.key)
      .filter((k) => k.endsWith('.json') && !k.slice('Inbox/'.length).includes('/'));

    await Promise.all(indexKeys.map(async (key) => {
      const address = key.slice('Inbox/'.length, -'.json'.length).toLowerCase();
      if (address === OWNER_PERSONAL_ADDRESS) return;
      try {
        const obj = await c.env.ARCHIVE.get(key);
        if (!obj) return;
        const entries: IndexEntry[] = JSON.parse(await obj.text());
        if (!Array.isArray(entries)) return;
        const last = entries.reduce<string | null>(
          (max, e) => (!max || e.timestamp > max ? e.timestamp : max),
          null,
        );
        countBy.set(address, { count: entries.length, last_activity: last });
      } catch { /* skip corrupt */ }
    }));
    }

    const mapEntry = (m: ReturnType<typeof agentsForUi>[number]) => {
      const meta = countBy.get(m.address.toLowerCase()) || { count: 0, last_activity: null };
      return {
        address: m.address,
        label: m.label,
        role: m.role ?? null,
        slug: m.slug ?? null,
        avatar_url: m.slug ? agentAvatarUrl(m.slug) : null,
        count: meta.count,
        last_activity: meta.last_activity,
      };
    };

    return ok(c, {
      agents: agentsForUi().map(mapEntry),
      departments: departmentsForUi().map(mapEntry),
      owner: {
        address: OWNER_PERSONAL_ADDRESS,
        show_in_ui: false,
        inbound: 'forward_gmail',
        forward_to: OWNER_GMAIL_FORWARD,
        note: 'Owner personal mail is read in Gmail only; not listed under Agents.',
      },
    });
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

// -----------------------------------------------------------------------------
// GET /mailboxes/:address — index entries for one mailbox, newest first.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// GET /feed?limit=400 — вся лента одним запросом (ход 1, Владелец 2026-09-02).
//
// До сегодня экран собирал ленту сам: тридцать с лишним обходов хранилища, из
// них шесть строго по очереди. Тяжёлый ящик держал весь экран, и открытое
// письмо ждало вместе со списком. Здесь — одна выборка из зеркала.
//
// Пустое зеркало отвечает пустой лентой и признаком mirror:false: клиент по
// нему возвращается на прежний путь и показывает письма, а не пустоту.
// -----------------------------------------------------------------------------
route.get('/feed', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  if (!mirrorEnabled(c.env)) return ok(c, { mirror: false, entries: [] });

  const limit = Number(c.req.query('limit') || 400);
  try {
    const entries = await feedFromD1(c.env, Number.isFinite(limit) ? limit : 400);
    return ok(c, { mirror: entries.length > 0, entries });
  } catch (err) {
    console.log(JSON.stringify({
      scope: 'email-archive', success: false, stage: 'mirror_feed',
      error: err instanceof Error ? err.message : String(err),
    }));
    return ok(c, { mirror: false, entries: [] });
  }
});

// -----------------------------------------------------------------------------
// POST /index-sync — наполнить зеркало из описей R2.
//   ?mailbox=<адрес>  один ящик (первичная заливка тяжёлых — по одному)
//   ?max=<n>          сколько ящиков взять за проход обхода (по умолчанию 6)
//   ?force=1          разобрать опись, даже если она не менялась
// Тот же код зовёт крон — руками и по часам путь один.
// -----------------------------------------------------------------------------
route.post('/index-sync', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  const mailbox = c.req.query('mailbox');
  const force = c.req.query('force') === '1';
  try {
    // ?snapshot=1 — собрать описи из зеркала (ход 2) вместо чтения описей.
    if (c.req.query('snapshot') === '1') {
      if (mailbox) return ok(c, await snapshotMailbox(c.env, normalizeAddress(mailbox)));
      const max = Number(c.req.query('max') || 4);
      // Рука замок не слушает: прогон по требованию должен идти сразу.
      return ok(c, await snapshotPass(c.env, { max: Number.isFinite(max) ? max : 4, ignoreLock: true }));
    }
    if (mailbox) {
      const r = await syncMailbox(c.env, normalizeAddress(mailbox), { force: true });
      return ok(c, r);
    }
    const max = Number(c.req.query('max') || 6);
    const r = await sweepMailIndex(c.env, { max: Number.isFinite(max) ? max : 6, force });
    return ok(c, r);
  } catch (err) {
    return fail(c, 500, [{ code: 'sync_failed', message: err instanceof Error ? err.message : String(err) }]);
  }
});

// -----------------------------------------------------------------------------
// GET /index-sizes — размеры описей без разбора (head, не get). Это ответ на
// вопрос «какой ящик стоит поперёк»: измерение, а не догадка.
// -----------------------------------------------------------------------------
route.get('/index-sizes', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  try {
    const sizes = await indexSizes(c.env);
    return ok(c, { total_bytes: sizes.reduce((s, x) => s + Math.max(0, x.bytes), 0), sizes });
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

route.get('/mailboxes/:address', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  const address = normalizeAddress(c.req.param('address'));
  if (!address) return fail(c, 422, [{ code: 'bad_address', message: 'address is required' }]);

  // Ход 1 (02.09): опись ящика берётся из зеркала в D1. Пустое зеркало — не
  // повод показать пустой ящик: тогда читаем описи из R2, как читали раньше.
  if (mirrorEnabled(c.env)) {
    try {
      const entries = await mailboxEntriesFromD1(c.env, address, 100);
      if (entries.length) return ok(c, { address, entries });
    } catch (err) {
      console.log(JSON.stringify({
        scope: 'email-archive', success: false, stage: 'mirror_mailbox', address,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  try {
    const obj = await c.env.ARCHIVE.get(`Inbox/${address}.json`);
    if (!obj) return ok(c, { address, entries: [] });

    let entries: IndexEntry[] = [];
    try {
      const parsed = JSON.parse(await obj.text());
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      return fail(c, 500, [{ code: 'corrupt_index', message: `Inbox/${address}.json is not valid JSON` }]);
    }

    entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)); // newest first
    return ok(c, { address, entries: entries.slice(0, 100) });
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

// -----------------------------------------------------------------------------
// GET /mailboxes/:address/message?key=... — one full record.
// `key` must fall under this mailbox's own Inbox/<address>/ prefix — refuses
// to fetch any other R2 key (defense against path traversal / cross-mailbox
// reads via a crafted key param).
// -----------------------------------------------------------------------------
// Готовое тело письма живёт в KV семь дней (Владелец 2026-09-04: «нужно
// быстрее»). Кэшируется РЕЗУЛЬТАТ — запись, в которой картинки уже вклеены:
// у письма с картинками вклейка стоит отдельного чтения на каждую, и второй
// раз платить за неё незачем. Письмо в архиве не меняется, поэтому ключ
// кэша — сам ключ записи, а протухание нужно только чтобы кэш не рос вечно.
const BODY_CACHE_PREFIX = 'mailbody:v1:';
const BODY_CACHE_TTL_S = 7 * 24 * 3600;
const BODY_CACHE_MAX_BYTES = 900_000;

route.get('/mailboxes/:address/message', async (c) => {
  const t0 = Date.now();
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  const tAuth = Date.now() - t0;

  const address = normalizeAddress(c.req.param('address'));
  const key = c.req.query('key') || '';
  const expectedPrefix = `Inbox/${address}/`;

  if (!address) return fail(c, 422, [{ code: 'bad_address', message: 'address is required' }]);
  if (!key || !key.startsWith(expectedPrefix)) {
    return fail(c, 422, [{ code: 'bad_key', message: `key must start with ${expectedPrefix}` }]);
  }

  const cacheKey = `${BODY_CACHE_PREFIX}${key}`;
  const tCache0 = Date.now();
  let cached: string | null = null;
  try {
    cached = await c.env.CACHE.get(cacheKey);
  } catch { /* кэш молчит — идём в архив, это не отказ */ }
  const tCache = Date.now() - tCache0;

  if (cached) {
    try {
      const record: unknown = JSON.parse(cached);
      c.header('Server-Timing', `auth;dur=${tAuth}, kv;dur=${tCache}, total;dur=${Date.now() - t0}`);
      c.header('X-Mail-Body-Cache', 'hit');
      return ok(c, { record });
    } catch { /* испорченная строка в кэше — перечитаем из архива */ }
  }

  try {
    const tR2 = Date.now();
    const obj = await c.env.ARCHIVE.get(key);
    if (!obj) return fail(c, 404, [{ code: 'not_found', message: key }]);

    let record: unknown;
    try {
      record = JSON.parse(await obj.text());
    } catch {
      return fail(c, 500, [{ code: 'corrupt_record', message: `${key} is not valid JSON` }]);
    }
    const r2ms = Date.now() - tR2;

    // Inline images are stored as separate R2 objects; the sandboxed viewer
    // cannot fetch them, so swap cid: references for data: URIs on the way out.
    const tInline = Date.now();
    const r = record as { html?: string; attachments?: ArchivedAttachment[] };
    if (r && typeof r === 'object' && r.html && r.attachments?.length) {
      try {
        r.html = await inlineCidImages(c.env, r.html, r.attachments);
      } catch (err) {
        // A broken image is survivable; a 500 on the whole letter is not.
        console.log(JSON.stringify({
          scope: 'email-archive',
          success: false,
          stage: 'inline_cid',
          key,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }
    const inlinems = Date.now() - tInline;

    // Кладём готовую запись в кэш ПОСЛЕ ответа: письмо не должно ждать
    // записи в кэш ни миллисекунды.
    try {
      const body = JSON.stringify(record);
      if (body.length <= BODY_CACHE_MAX_BYTES) {
        c.executionCtx.waitUntil(
          c.env.CACHE.put(cacheKey, body, { expirationTtl: BODY_CACHE_TTL_S }).catch(() => { /* кэш не обязателен */ }),
        );
      }
    } catch { /* не сериализовалось — значит и кэшировать нечего */ }

    c.header('Server-Timing', `auth;dur=${tAuth}, kv;dur=${tCache}, r2;dur=${r2ms}, inline;dur=${inlinems}, total;dur=${Date.now() - t0}`);
    c.header('X-Mail-Body-Cache', 'miss');
    return ok(c, { record });
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

// -----------------------------------------------------------------------------
// GET /mailboxes/:address/summary?key=... — a 2-sentence AI summary of the
// message body, so the inbox list can show the gist instead of raw first lines.
// Cached in D1 (email_summaries) keyed by the R2 record key, so each message is
// summarized once. Same path-prefix guard as /message.
// -----------------------------------------------------------------------------
function bodyText(record: any): string {
  let t = String(record?.text || '');
  if (!t && record?.html) {
    t = String(record.html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

// v1 = 2-sentence preview (inbox list rows). v2 = 3-4 line "what they want"
// digest for the dark message screen: gist, ask, deadline, deal temperature.
const SUMMARY_PROMPTS: Record<1 | 2, string> = {
  1: 'You summarize one email for a busy operator. Reply with exactly two short, factual sentences capturing what the sender wants or reports. No greeting, no preamble, no quotation marks.',
  2: 'You summarize one email for a busy operator triaging their inbox. Reply with exactly 3-4 short lines, each a plain factual statement, covering in order: (1) the gist of the message, (2) what they are asking for or reporting, (3) any deadline or timing mentioned (or "No deadline mentioned" if none), (4) the deal temperature — hot/warm/cold/informational. No greeting, no preamble, no markdown, no quotation marks, one statement per line.',
};

route.get('/mailboxes/:address/summary', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  const address = normalizeAddress(c.req.param('address'));
  const key = c.req.query('key') || '';
  const expectedPrefix = `Inbox/${address}/`;
  const version: 1 | 2 = c.req.query('v') === '2' ? 2 : 1;
  if (!address) return fail(c, 422, [{ code: 'bad_address', message: 'address is required' }]);
  if (!key || !key.startsWith(expectedPrefix)) {
    return fail(c, 422, [{ code: 'bad_key', message: `key must start with ${expectedPrefix}` }]);
  }

  // Lazy cache table — self-healing, no migration round-trip needed. The
  // `version` column may already exist (migration 0062) or not yet in an
  // environment that hasn't run migrations; ALTER failure there is fine,
  // the SELECT below just won't filter by version until it does.
  try {
    await c.env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS email_summaries (
        msg_key TEXT PRIMARY KEY, summary TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL)`
    ).run();
    try {
      await c.env.DB.prepare('ALTER TABLE email_summaries ADD COLUMN version INTEGER NOT NULL DEFAULT 1').run();
    } catch { /* column already exists */ }
    const cached = await c.env.DB.prepare(
      'SELECT summary FROM email_summaries WHERE msg_key = ? AND version = ?'
    ).bind(key, version).first<{ summary: string }>();
    if (cached?.summary) return ok(c, { summary: cached.summary, cached: true });
  } catch {
    /* cache is best-effort — fall through and summarize */
  }

  let record: any;
  try {
    const obj = await c.env.ARCHIVE.get(key);
    if (!obj) return fail(c, 404, [{ code: 'not_found', message: key }]);
    record = JSON.parse(await obj.text());
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }

  const subject = String(record?.subject || '');
  const text = bodyText(record);
  if (!text) {
    return ok(c, { summary: subject ? `${subject}. No message body.` : 'No message content.', cached: false });
  }

  let summary = '';
  try {
    const r = await callFlash(
      [
        { role: 'system', content: SUMMARY_PROMPTS[version] },
        { role: 'user', content: `Subject: ${subject}\n\n${text.slice(0, 6000)}` },
      ],
      { env: c.env, maxTokens: version === 2 ? 260 : 160, temperature: 0.2 }
    );
    summary = (r.text || '').replace(/[ \t]+/g, ' ').trim();
  } catch {
    /* LLM unavailable — fall back to the raw opening below */
  }
  if (!summary) summary = text.slice(0, 200);

  try {
    await c.env.DB.prepare(
      'INSERT OR REPLACE INTO email_summaries (msg_key, summary, model, created_at, version) VALUES (?, ?, ?, ?, ?)'
    ).bind(key, summary, 'flash', Math.floor(Date.now() / 1000), version).run();
  } catch {
    /* best-effort cache write */
  }

  return ok(c, { summary, cached: false });
});

export default route;
