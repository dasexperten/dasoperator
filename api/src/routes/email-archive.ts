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
import type { IndexEntry } from '../lib/inbox-archive';

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
// Index files sit directly under the Inbox/ prefix (no further "/"), so a
// delimited list() call separates them from the per-mailbox sent/received
// subfolders in one pass.
// -----------------------------------------------------------------------------
route.get('/mailboxes', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

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

    mailboxes.sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''));
    return ok(c, { mailboxes });
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

// -----------------------------------------------------------------------------
// GET /mailboxes/:address — index entries for one mailbox, newest first.
// -----------------------------------------------------------------------------
route.get('/mailboxes/:address', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  const address = normalizeAddress(c.req.param('address'));
  if (!address) return fail(c, 422, [{ code: 'bad_address', message: 'address is required' }]);

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
    return ok(c, { address, entries });
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
route.get('/mailboxes/:address/message', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);

  const address = normalizeAddress(c.req.param('address'));
  const key = c.req.query('key') || '';
  const expectedPrefix = `Inbox/${address}/`;

  if (!address) return fail(c, 422, [{ code: 'bad_address', message: 'address is required' }]);
  if (!key || !key.startsWith(expectedPrefix)) {
    return fail(c, 422, [{ code: 'bad_key', message: `key must start with ${expectedPrefix}` }]);
  }

  try {
    const obj = await c.env.ARCHIVE.get(key);
    if (!obj) return fail(c, 404, [{ code: 'not_found', message: key }]);

    let record: unknown;
    try {
      record = JSON.parse(await obj.text());
    } catch {
      return fail(c, 500, [{ code: 'corrupt_record', message: `${key} is not valid JSON` }]);
    }
    return ok(c, { record });
  } catch (err) {
    return fail(c, 500, [{ code: 'r2_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

export default route;
