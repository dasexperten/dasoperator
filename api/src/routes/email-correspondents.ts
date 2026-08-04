// =============================================================================
// email-correspondents — who writes to us and is not in the directory.
//
// Owner 2026-08-03. Measured that day: 287 letters in the archive, and not one
// of them matched a partner — the 19 addresses the directory holds belong to
// companies nobody actually corresponds with, while everyone we do talk to is
// missing. Running the historical linker in that state would have produced 287
// empty rows and the appearance of work.
//
// So the order is reversed: fill the directory from the correspondence first,
// by hand, ten companies not a hundred. This route is that worklist — every
// external address, how many letters, which box, what was last said.
//
// Reading, not working: it aggregates what the archive already holds and
// decides nothing. ERP stays a window.
//
//   GET /api/email/correspondents?limit=100&all=1
//     all=1 keeps the noise (robots, our own domain) that is hidden by default.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession } from '../lib/auth';
import type { IndexEntry } from '../lib/inbox-archive';

const route = new Hono<{ Bindings: Env }>();

async function requireSession(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  const header = c.req.header('Authorization');
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  const token = match?.[1]?.trim();
  if (!token) return false;
  return !!(await validateSession(c.env.DB, token));
}

// Robots, our own domain, and delivery plumbing. Hidden by default because a
// worklist of 86 rows where 70 are machines is not a worklist.
const NOISE = /(noreply|no-reply|notify|notification|resend\.dev|@resend|google\.com|microsoft\.com|mailer|bounce|postmaster|newsletter|@dasexperten\.)/i;

function bareAddress(raw: unknown): string {
  const value = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  const angle = value.match(/<([^>]+)>/);
  return (angle ? angle[1]! : value).trim().toLowerCase();
}

/** Every address a partner row carries, whatever shape the column is in. */
function addressesOf(raw: string | null | undefined): string[] {
  const value = (raw || '').trim();
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
    } catch { /* fall through */ }
  }
  return value.split(/[,;\s]+/).map((a) => a.trim().toLowerCase()).filter((a) => a.includes('@'));
}

interface Row {
  address: string;
  letters: number;
  mailboxes: string[];
  lastAt: string;
  lastSubject: string;
  partnerSlug?: string;
  partnerName?: string;
}

route.get('/correspondents', async (c) => {
  if (!(await requireSession(c))) {
    return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  }

  const limit = Math.min(Math.max(Number(c.req.query('limit') || 100) || 100, 1), 300);
  const keepNoise = c.req.query('all') === '1';

  try {
    // Who we already know, by every address they carry.
    const partners = await c.env.DB.prepare(
      `SELECT slug, trade_name, email FROM partners
        WHERE email IS NOT NULL AND deleted_at IS NULL`
    ).all<{ slug: string; trade_name: string; email: string | null }>();

    const known = new Map<string, { slug: string; name: string }>();
    for (const p of partners.results || []) {
      for (const a of addressesOf(p.email)) known.set(a, { slug: p.slug, name: p.trade_name });
    }

    // One R2 GET per mailbox index — not per letter.
    const listed = await c.env.ARCHIVE.list({ prefix: 'Inbox/', delimiter: '/' });
    const indexKeys = listed.objects.map((o) => o.key).filter((k) => k.endsWith('.json'));

    const agg = new Map<string, Row>();

    await Promise.all(indexKeys.map(async (key) => {
      const mailbox = key.slice('Inbox/'.length, -'.json'.length);
      try {
        const obj = await c.env.ARCHIVE.get(key);
        if (!obj) return;
        const entries = JSON.parse(await obj.text());
        if (!Array.isArray(entries)) return;

        for (const e of entries as IndexEntry[]) {
          const address = bareAddress(e.direction === 'received' ? e.from : e.to);
          if (!address || !address.includes('@')) continue;
          if (!keepNoise && NOISE.test(address)) continue;

          const row = agg.get(address) || {
            address, letters: 0, mailboxes: [], lastAt: '', lastSubject: '',
          };
          row.letters += 1;
          if (!row.mailboxes.includes(mailbox)) row.mailboxes.push(mailbox);
          if ((e.timestamp || '') > row.lastAt) {
            row.lastAt = e.timestamp || '';
            row.lastSubject = e.subject || '';
          }
          const hit = known.get(address);
          if (hit) { row.partnerSlug = hit.slug; row.partnerName = hit.name; }
          agg.set(address, row);
        }
      } catch { /* one broken index must not cost the whole list */ }
    }));

    const rows = [...agg.values()].sort((a, b) => b.letters - a.letters);
    const unknown = rows.filter((r) => !r.partnerSlug);

    return ok(c, {
      total: rows.length,
      unknownCount: unknown.length,
      rows: rows.slice(0, limit),
    });
  } catch (err) {
    return fail(c, 500, [{ code: 'correspondents_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

export default route;
