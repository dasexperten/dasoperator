// =============================================================================
// Emailer Dark UI v3 — release 1 state layer, on top of the read-only R2
// archive (email-archive.ts) and its origin/trigger tagging
// (api/src/lib/inbox-archive.ts).
//
//   POST /api/email/read              {keys: string[], mailbox: string}
//   GET  /api/email/unread-count?group=human|system
//   GET  /api/email/attention         — human correspondents waiting >48h for a reply
//   GET  /api/email/orders?period=24h|7d
//
// Requires a valid session, same as email-archive.ts.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession, type AuthUser } from '../lib/auth';
import type { IndexEntry, MailOrigin } from '../lib/inbox-archive';
import { OWNER_PERSONAL_ADDRESS, isAgentToAgentMail } from '../lib/mailbox-registry';

const route = new Hono<{ Bindings: Env }>();

function bearer(c: import('hono').Context): string | null {
  const h = c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1] ? m[1].trim() : null;
}

async function requireUser(c: import('hono').Context<{ Bindings: Env }>): Promise<AuthUser | null> {
  const token = bearer(c);
  if (!token) return null;
  return validateSession(c.env.DB, token);
}

async function requireSession(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  return !!(await requireUser(c));
}

async function ensureGmailProcessTables(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS email_flags (
      message_key TEXT PRIMARY KEY,
      mailbox TEXT NOT NULL,
      starred INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      trashed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS email_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      to_addr TEXT NOT NULL DEFAULT '',
      cc_addr TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      in_reply_to TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`
  ).run();
}

// A mailbox is a system sender (notify./my. subdomain) vs a human-facing
// dasexperten.com apex address — matches the split already live in the
// legacy inbox view (CloudflareInboxView.isGroup).
function isSystemMailbox(address: string): boolean {
  return address.includes('@notify.') || address.includes('@my.');
}

// Legacy records (written before migration 0062) carry no origin field —
// fall back to the mailbox's own nature rather than leaving them unclassified.
function deriveOrigin(entry: IndexEntry, mailboxAddress: string): MailOrigin {
  return entry.origin ?? (isSystemMailbox(mailboxAddress) ? 'auto' : 'human');
}

function correspondentOf(entry: IndexEntry): string {
  const raw = entry.direction === 'received' ? entry.from : Array.isArray(entry.to) ? entry.to[0] : entry.to;
  return (raw || '').trim().toLowerCase();
}

interface MailboxIndex { address: string; entries: IndexEntry[] }

async function listAllMailboxIndices(env: Env): Promise<MailboxIndex[]> {
  const listed = await env.ARCHIVE.list({ prefix: 'Inbox/', delimiter: '/' });
  const indexKeys = listed.objects
    .map((o) => o.key)
    .filter((k) => k.endsWith('.json') && !k.slice('Inbox/'.length).includes('/'));

  const results = await Promise.all(indexKeys.map(async (key) => {
    const address = key.slice('Inbox/'.length, -'.json'.length);
    try {
      const obj = await env.ARCHIVE.get(key);
      if (!obj) return { address, entries: [] };
      const parsed = JSON.parse(await obj.text());
      return { address, entries: Array.isArray(parsed) ? (parsed as IndexEntry[]) : [] };
    } catch {
      return { address, entries: [] };
    }
  }));
  return results;
}

async function readKeySet(env: Env): Promise<Set<string>> {
  try {
    const rows = await env.DB.prepare('SELECT message_key FROM email_read_state').all<{ message_key: string }>();
    return new Set((rows.results || []).map((r) => r.message_key));
  } catch {
    return new Set(); // table not migrated yet — treat everything as unread rather than fail
  }
}

// -----------------------------------------------------------------------------
// POST /read — mark a batch of message keys read.
// -----------------------------------------------------------------------------
route.post('/read', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'invalid JSON body' }]);
  }
  const keys = (body as { keys?: unknown })?.keys;
  const mailbox = String((body as { mailbox?: unknown })?.mailbox || '');
  if (!Array.isArray(keys) || keys.length === 0) {
    return fail(c, 422, [{ code: 'bad_keys', message: 'keys must be a non-empty array' }]);
  }

  try {
    await c.env.DB.batch(
      keys.slice(0, 200).map((k) =>
        c.env.DB.prepare('INSERT OR IGNORE INTO email_read_state (message_key, mailbox) VALUES (?, ?)').bind(String(k), mailbox)
      )
    );
  } catch (err) {
    return fail(c, 500, [{ code: 'd1_error', message: err instanceof Error ? err.message : String(err) }]);
  }

  return ok(c, { marked: Math.min(keys.length, 200) });
});

// -----------------------------------------------------------------------------
// GET /unread-count?group=human|system — received messages not in email_read_state.
// -----------------------------------------------------------------------------
route.get('/unread-count', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  const group = c.req.query('group') === 'system' ? 'system' : 'human';

  try {
    const [mailboxes, readKeys] = await Promise.all([listAllMailboxIndices(c.env), readKeySet(c.env)]);
    let count = 0;
    for (const mb of mailboxes) {
      for (const e of mb.entries) {
        if (e.direction !== 'received') continue;
        const origin = deriveOrigin(e, mb.address);
        const wantGroup = origin === 'auto' ? 'system' : 'human';
        if (wantGroup !== group) continue;
        if (!readKeys.has(e.key)) count++;
      }
    }
    return ok(c, { group, count });
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

// -----------------------------------------------------------------------------
// GET /attention — human correspondents whose latest exchange is a message WE
// sent, still unanswered after 48h. KV-cached 15 min (attention is expensive:
// crosses every mailbox).
// -----------------------------------------------------------------------------
const ATTENTION_THRESHOLD_MS = 48 * 60 * 60 * 1000;
const ATTENTION_CACHE_KEY = 'email:attention:v1';
const ATTENTION_CACHE_TTL_S = 15 * 60;

route.get('/attention', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  try {
    const cached = await c.env.CACHE.get(ATTENTION_CACHE_KEY);
    if (cached) return ok(c, JSON.parse(cached));
  } catch { /* cache miss/unavailable — compute fresh */ }

  try {
    const mailboxes = await listAllMailboxIndices(c.env);
    // Group by correspondent across every human mailbox they've touched.
    const byCorrespondent = new Map<string, IndexEntry[]>();
    for (const mb of mailboxes) {
      if (isSystemMailbox(mb.address)) continue;
      for (const e of mb.entries) {
        if (deriveOrigin(e, mb.address) !== 'human') continue;
        const who = correspondentOf(e);
        if (!who) continue;
        if (!byCorrespondent.has(who)) byCorrespondent.set(who, []);
        byCorrespondent.get(who)!.push(e);
      }
    }

    const now = Date.now();
    const waiting: Array<{ correspondent: string; subject: string; sent_at: string; hours_waiting: number }> = [];
    for (const [who, entries] of byCorrespondent) {
      entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)); // newest first
      const latest = entries[0];
      if (!latest || latest.direction !== 'sent') continue; // they replied last, or we haven't heard yet either way — not waiting on them
      const sentAt = Date.parse(latest.timestamp);
      if (Number.isNaN(sentAt)) continue;
      const elapsed = now - sentAt;
      if (elapsed < ATTENTION_THRESHOLD_MS) continue;
      waiting.push({
        correspondent: who,
        subject: latest.subject || '(no subject)',
        sent_at: latest.timestamp,
        hours_waiting: Math.floor(elapsed / (60 * 60 * 1000)),
      });
    }
    waiting.sort((a, b) => b.hours_waiting - a.hours_waiting);

    const result = { count: waiting.length, waiting: waiting.slice(0, 30) };
    try {
      await c.env.CACHE.put(ATTENTION_CACHE_KEY, JSON.stringify(result), { expirationTtl: ATTENTION_CACHE_TTL_S });
    } catch { /* best-effort cache write */ }

    return ok(c, result);
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

// -----------------------------------------------------------------------------
// GET /orders?period=24h|7d — auto-origin entries tagged with an order/form
// trigger. "processed" = a human-sent reply to the same correspondent exists
// after this entry's timestamp.
// -----------------------------------------------------------------------------
const ORDER_TRIGGERS = new Set(['order-confirmation', 'form-ack', 'lead']);

route.get('/orders', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  const period = c.req.query('period') === '7d' ? '7d' : '24h';
  const windowMs = (period === '7d' ? 7 : 1) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  try {
    const mailboxes = await listAllMailboxIndices(c.env);

    // Human sent-entries per correspondent, for the "processed" check below.
    const humanSentByCorrespondent = new Map<string, string[]>(); // correspondent -> sorted timestamps
    for (const mb of mailboxes) {
      if (isSystemMailbox(mb.address)) continue;
      for (const e of mb.entries) {
        if (e.direction !== 'sent') continue;
        if (deriveOrigin(e, mb.address) !== 'human') continue;
        const who = Array.isArray(e.to) ? e.to[0] : e.to;
        const key = (who || '').trim().toLowerCase();
        if (!key) continue;
        if (!humanSentByCorrespondent.has(key)) humanSentByCorrespondent.set(key, []);
        humanSentByCorrespondent.get(key)!.push(e.timestamp);
      }
    }

    const items: Array<{
      key: string; mailbox: string; direction: 'sent' | 'received'; trigger: string; subject: string; timestamp: string;
      correspondent: string; status: 'new' | 'processed';
    }> = [];

    for (const mb of mailboxes) {
      for (const e of mb.entries) {
        if (e.origin !== 'auto' || !e.trigger || !ORDER_TRIGGERS.has(e.trigger)) continue;
        const ts = Date.parse(e.timestamp);
        if (Number.isNaN(ts) || ts < cutoff) continue;
        const who = correspondentOf(e);
        const repliesAfter = humanSentByCorrespondent.get(who) || [];
        const processed = repliesAfter.some((t) => Date.parse(t) > ts);
        items.push({
          key: e.key,
          mailbox: mb.address,
          direction: e.direction,
          trigger: e.trigger,
          subject: e.subject || '(no subject)',
          timestamp: e.timestamp,
          correspondent: who,
          status: processed ? 'processed' : 'new',
        });
      }
    }
    items.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    return ok(c, { period, count: items.length, items });
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

const FEED_CACHE_KEY = 'email:feed:week:v5';
const FEED_CACHE_TTL_S = 600;
const FEED_MAX_ENTRIES = 400;
const FEED_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type FeedEntry = IndexEntry & { mailbox: string };

function tsMs(timestamp: string): number {
  const t = Date.parse(timestamp);
  return Number.isFinite(t) ? t : 0;
}

/** Prefer last 7 days. Never return empty if the archive has letters. */
async function buildSlimFeed(env: Env): Promise<FeedEntry[]> {
  const now = Date.now();
  const listed = await env.ARCHIVE.list({ prefix: 'Inbox/', delimiter: '/', limit: 80 });
  const objs = (listed.objects || [])
    .filter((o) => o.key.endsWith('.json') && !o.key.slice('Inbox/'.length).includes('/'))
    .filter((o) => typeof o.size !== 'number' || o.size < 400_000);

  const chunks = await Promise.all(objs.map(async (o) => {
    const address = o.key.slice('Inbox/'.length, -'.json'.length);
    if (address.toLowerCase() === OWNER_PERSONAL_ADDRESS) return [] as FeedEntry[];
    try {
      const obj = await env.ARCHIVE.get(o.key);
      if (!obj) return [] as FeedEntry[];
      const parsed = JSON.parse(await obj.text());
      if (!Array.isArray(parsed)) return [] as FeedEntry[];
      return (parsed as IndexEntry[])
        .filter((e) => !isAgentToAgentMail({ ...e, mailbox: address }))
        .map((e) => ({ ...e, mailbox: address }));
    } catch {
      return [] as FeedEntry[];
    }
  }));

  const all = chunks.flat().sort((a, b) => tsMs(b.timestamp) - tsMs(a.timestamp));
  const week = all.filter((e) => {
    const t = tsMs(e.timestamp);
    if (!t) return true;
    return now - t <= FEED_WEEK_MS;
  });
  const picked = week.length >= 20 ? week : all;
  return picked.slice(0, FEED_MAX_ENTRIES);
}

route.get('/feed', async (c) => {
  const user = await requireUser(c);
  if (!user) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  const fresh = c.req.query('fresh') === '1';

  let entries: FeedEntry[] | null = null;
  if (!fresh) {
    try {
      const cached = await c.env.CACHE.get(FEED_CACHE_KEY);
      if (cached) entries = JSON.parse(cached) as FeedEntry[];
    } catch { /* miss */ }
  } else {
    try { await c.env.CACHE.delete(FEED_CACHE_KEY); } catch { /* ignore */ }
  }

  if (!entries) {
    try {
      entries = await buildSlimFeed(c.env);
      if (entries.length) {
        try {
          await c.env.CACHE.put(FEED_CACHE_KEY, JSON.stringify(entries), { expirationTtl: FEED_CACHE_TTL_S });
        } catch { /* best-effort */ }
      }
    } catch (err) {
      return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
    }
  }

  const keys = entries.map((e) => e.key);
  let flags: Array<{ message_key: string; mailbox?: string; starred: number; archived: number; trashed: number }> = [];
  let readKeys: string[] = [];
  let drafts: Array<{
    id: string; mailbox: string; to_addr: string; cc_addr: string; subject: string; body: string;
    in_reply_to: string | null; updated_at: number;
  }> = [];
  try {
    const [flagRows, draftRows] = await Promise.all([
      c.env.DB.prepare('SELECT message_key, mailbox, starred, archived, trashed FROM email_flags LIMIT 400').all<{
        message_key: string; mailbox: string; starred: number; archived: number; trashed: number;
      }>(),
      user
        ? c.env.DB.prepare(
            'SELECT id, mailbox, to_addr, cc_addr, subject, body, in_reply_to, updated_at FROM email_drafts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30'
          ).bind(user.id).all<{
            id: string; mailbox: string; to_addr: string; cc_addr: string; subject: string; body: string;
            in_reply_to: string | null; updated_at: number;
          }>()
        : Promise.resolve({ results: [] as never[] }),
    ]);
    const want = new Set(keys);
    flags = (flagRows.results || []).filter((f) => want.has(f.message_key));
    drafts = draftRows.results || [];
  } catch { /* flags/drafts optional until tables exist */ }

  return ok(c, { entries, flags, read: readKeys, drafts });
});

route.post('/flags', async (c) => {
  const user = await requireUser(c);
  if (!user) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  let body: unknown;
  try { body = await c.req.json(); } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'invalid JSON body' }]);
  }
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return fail(c, 422, [{ code: 'bad_items', message: 'items must be a non-empty array' }]);
  }

  try {
    await ensureGmailProcessTables(c.env);
    const stmts = [];
    for (const raw of items.slice(0, 200)) {
      const it = raw as { message_key?: unknown; mailbox?: unknown; starred?: unknown; archived?: unknown; trashed?: unknown };
      const key = String(it.message_key || '');
      const mailbox = String(it.mailbox || '');
      if (!key || !mailbox) continue;
      const starred = it.starred ? 1 : 0;
      const archived = it.archived ? 1 : 0;
      const trashed = it.trashed ? 1 : 0;
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO email_flags (message_key, mailbox, starred, archived, trashed, updated_at)
           VALUES (?, ?, ?, ?, ?, unixepoch())
           ON CONFLICT(message_key) DO UPDATE SET
             mailbox=excluded.mailbox,
             starred=excluded.starred,
             archived=excluded.archived,
             trashed=excluded.trashed,
             updated_at=unixepoch()`
        ).bind(key, mailbox, starred, archived, trashed)
      );
    }
    if (stmts.length) await c.env.DB.batch(stmts);
    return ok(c, { updated: stmts.length });
  } catch (err) {
    return fail(c, 500, [{ code: 'd1_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

route.post('/unread', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'invalid JSON body' }]);
  }
  const keys = (body as { keys?: unknown })?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return fail(c, 422, [{ code: 'bad_keys', message: 'keys must be a non-empty array' }]);
  }
  try {
    await c.env.DB.batch(
      keys.slice(0, 200).map((k) =>
        c.env.DB.prepare('DELETE FROM email_read_state WHERE message_key = ?').bind(String(k))
      )
    );
    return ok(c, { unmarked: Math.min(keys.length, 200) });
  } catch (err) {
    return fail(c, 500, [{ code: 'd1_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

route.put('/drafts', async (c) => {
  const user = await requireUser(c);
  if (!user) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'invalid JSON body' }]);
  }
  const d = body as {
    id?: unknown; mailbox?: unknown; to?: unknown; cc?: unknown; subject?: unknown; body?: unknown; in_reply_to?: unknown;
  };
  const id = String(d.id || crypto.randomUUID());
  try {
    await ensureGmailProcessTables(c.env);
    await c.env.DB.prepare(
      `INSERT INTO email_drafts (id, user_id, mailbox, to_addr, cc_addr, subject, body, in_reply_to, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         mailbox=excluded.mailbox, to_addr=excluded.to_addr, cc_addr=excluded.cc_addr,
         subject=excluded.subject, body=excluded.body, in_reply_to=excluded.in_reply_to,
         updated_at=unixepoch()`
    ).bind(
      id,
      user.id,
      String(d.mailbox || 'sales@dasexperten.com'),
      String(d.to || ''),
      String(d.cc || ''),
      String(d.subject || ''),
      String(d.body || ''),
      d.in_reply_to ? String(d.in_reply_to) : null,
    ).run();
    return ok(c, { id });
  } catch (err) {
    return fail(c, 500, [{ code: 'd1_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

route.delete('/drafts/:id', async (c) => {
  const user = await requireUser(c);
  if (!user) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  const id = c.req.param('id');
  try {
    await ensureGmailProcessTables(c.env);
    await c.env.DB.prepare('DELETE FROM email_drafts WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    return ok(c, { deleted: true });
  } catch (err) {
    return fail(c, 500, [{ code: 'd1_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

export default route;
