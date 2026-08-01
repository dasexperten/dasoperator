// =============================================================================
// Учи from the Emailer reader (Owner 2026-07-31).
//
// The learning engine is NOT rebuilt here. It already lives on the org board:
//   organizacia · api/learn-from-source.mjs · POST /api/agents/:slug/learn
// with Lena's novelty law (report only what is NEW vs the seat's charter,
// skills and playbook) and a study log in knowledge/sources/log/.
//
// The board engine used to take a URL only. On 2026-07-31 it also accepts an
// already-fetched `text`, so a letter can be studied. This route is the second
// calling surface: it reads the letter out of R2, works out whose mailbox it
// is, and hands the body to that agent's seat on the board.
//
// Owner-mail law (2026-07-31): letters from the Owner's three addresses are
// instructions, not material. Ownership is settled — the agent may not answer
// "not mine" and may not hand the letter on. Everything else is an ordinary
// source and goes through the novelty law unchanged.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession } from '../lib/auth';
import { MAILBOX_REGISTRY } from '../lib/mailbox-registry';

const route = new Hono<{ Bindings: Env }>();

const BOARD = 'https://org.dasexperten.com';

/** The Owner's own addresses — a closed circle (Owner 2026-07-31). */
const OWNER_ADDRESSES = [
  'a.v.badalyan@gmail.com',
  'dasexperten@gmail.com',
  'aram49@mail.ru',
];

async function requireSession(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  const h = c.req.header('Authorization');
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  if (!m?.[1]) return false;
  return !!(await validateSession(c.env.DB, m[1].trim()));
}

/** Which agent owns this mailbox — primary address or a retired alias. */
function ownerOf(address: string) {
  const a = (address || '').trim().toLowerCase();
  return MAILBOX_REGISTRY.find(
    (m) =>
      m.kind === 'agent' &&
      (m.address.toLowerCase() === a ||
        (m.aliases || []).some((x: string) => x.toLowerCase() === a))
  );
}

function isOwnerMail(from: string): boolean {
  const f = (from || '').toLowerCase();
  return OWNER_ADDRESSES.some((a) => f.includes(a));
}

/** Strip quoted history and signatures so the model studies the letter, not the thread. */
function readableBody(rec: Record<string, unknown>): string {
  const txt = String(rec.text || rec.plaintextBody || '').trim();
  if (txt) return txt.slice(0, 18000);
  const html = String(rec.html || rec.htmlBody || '');
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18000);
}

/** Drop quoted history and signature — a thread already supplies the earlier turns. */
function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trimEnd();
    // Gmail / Outlook / Apple attribution lines, and the sig delimiter.
    if (/^\s*[-—]{2,}\s*$/.test(l)) break;
    if (/^\s*(On .+ wrote:|В .+ (написал|пишет).*:|From:\s|От:\s|-{3,}\s*(Original|Forwarded|Пересланное))/i.test(l)) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // If stripping ate almost everything, the heuristic was wrong — keep the original.
  return body.length >= 40 ? body : text.trim();
}

/** Newest-last transcript of a conversation, capped so a long thread stays affordable. */
const THREAD_MAX_LETTERS = 12;
const THREAD_MAX_CHARS = 18000;

// POST /learn  { key }  — study one archived letter as the mailbox owner.
route.post('/learn', async (c) => {
  if (!(await requireSession(c))) return fail(c, 401, [{ code: 'unauthorized', message: `unauthorized` }]);

  const body = await c.req
    .json<{ key?: string; keys?: string[]; note?: string }>()
    .catch(() => ({} as { key?: string; keys?: string[]; note?: string }));
  // `keys` = the whole conversation, oldest first (the reader groups it).
  // `key`  = a single letter. The last key is always the one on screen.
  const threadKeys = (Array.isArray(body.keys) ? body.keys : [])
    .map((k) => String(k || '').trim())
    .filter((k) => k.startsWith('Inbox/') && k.endsWith('.json'))
    .slice(-THREAD_MAX_LETTERS);
  const key = String(body.key || threadKeys[threadKeys.length - 1] || '').trim();
  if (!key.startsWith('Inbox/') || !key.endsWith('.json')) {
    return fail(c, 400, [{ code: 'bad_key', message: `bad_key: expected an Inbox/<address>/<dir>/<record>.json key` }]);
  }

  const orgKey = c.env.DASORG_API_KEY;
  if (!orgKey) return fail(c, 503, [{ code: 'board_not_configured', message: `board_not_configured: DASORG_API_KEY missing` }]);

  const obj = await c.env.ARCHIVE.get(key);
  if (!obj) return fail(c, 404, [{ code: 'not_found', message: `not_found: no such letter in the archive` }]);

  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(await obj.text());
  } catch {
    return fail(c, 422, [{ code: 'unreadable_record', message: `unreadable_record` }]);
  }

  // The mailbox is the second path segment: Inbox/<address>/<direction>/<file>
  const address = key.split('/')[1] || '';
  const seat = ownerOf(address);
  if (!seat?.slug) {
    return fail(c, 422, [{ code: 'no_agent_for_mailbox', message: `no_agent_for_mailbox: ${address} is not an agent mailbox` }]);
  }

  // One letter or the whole conversation. Quoted history is stripped from each
  // turn, so a four-letter thread costs four bodies, not ten copies of the first.
  let text: string;
  let studied = 1;
  let truncated = false;
  if (threadKeys.length > 1) {
    const parts: string[] = [];
    for (const k of threadKeys) {
      const o = k === key ? obj : await c.env.ARCHIVE.get(k);
      if (!o) continue;
      let r2: Record<string, unknown>;
      try {
        r2 = JSON.parse(await o.text());
      } catch {
        continue;
      }
      const b = stripQuoted(readableBody(r2));
      if (b.length < 20) continue;
      const when = String(r2.timestamp || '').slice(0, 16).replace('T', ' ');
      const who = String(r2.from || '—');
      const dir = String(r2.direction || '') === 'sent' ? 'мы' : 'они';
      // Numbered so position can never be misread, whichever way it is skimmed.
      // The transcript itself stays oldest-first: the model has to follow who
      // asked what before who answered, and the LAST block sits nearest the
      // question it is answering — which is the block that should weigh most.
      const n = parts.length + 1;
      const mark = n === threadKeys.length ? ' · самое новое' : '';
      parts.push(`--- письмо ${n} из ${threadKeys.length}${mark} · ${when} · ${dir} · ${who}\n${b}`);
    }
    studied = parts.length;
    let joined = parts.join('\n\n');
    if (joined.length > THREAD_MAX_CHARS) {
      // Keep the RECENT turns: the tail of a negotiation is what binds us.
      joined = joined.slice(joined.length - THREAD_MAX_CHARS);
      truncated = true;
    }
    text = joined;
  } else {
    text = readableBody(rec);
  }
  if (text.length < 80) return fail(c, 422, [{ code: 'empty_source', message: `empty_source: nothing readable in this letter` }]);

  const from = String(rec.from || '');
  const ownerMail = isOwnerMail(from);
  const note = ownerMail
    ? 'Указание владельца — принадлежность решена, не переадресовывать. ' + String(body.note || '')
    : String(body.note || 'Учи из читалки Emailer');

  let r: Response;
  try {
    r = await fetch(`${BOARD}/api/agents/${seat.slug}/learn`, {
      method: 'POST',
      headers: { 'X-API-Key': orgKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        title:
          (studied > 1 ? `Переписка (${studied} писем): ` : '') +
          String(rec.subject || '(без темы)').slice(0, 260),
        source_type: ownerMail ? 'owner-letter' : studied > 1 ? 'thread' : 'letter',
        ref: key,
        note: note.trim().slice(0, 500),
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    return fail(c, 502, [{ code: 'board_unreachable', message: `board_unreachable: ${String(e).slice(0, 120)}` }]);
  }

  const raw = await r.text();
  let out: Record<string, unknown> = {};
  try {
    out = JSON.parse(raw);
  } catch {
    return fail(c, 502, [{ code: 'board_bad_response', message: `board_bad_response: ${raw.slice(0, 160)}` }]);
  }
  if (!r.ok) return fail(c, 502, [{ code: 'board_error_${r.status}', message: `board_error_${r.status}: ${JSON.stringify(out).slice(0, 200)}` }]);

  return ok(c, {
    agent: seat.slug,
    agentName: seat.label || seat.slug,
    mailbox: address,
    subject: rec.subject || '',
    from,
    ownerMail,
    studied,
    truncated,
    summary: out.summary || '',
    newIntel: out.new_intel || [],
    alreadyKnew: out.already_knew || [],
    lessons: out.lessons || [],
    nothingNew: !!out.nothing_new,
    report: out.report || '',
  });
});

export default route;
