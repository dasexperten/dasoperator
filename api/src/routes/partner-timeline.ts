// =============================================================================
// Partner timeline — one chronological stream per counterparty.
//
// Owner 2026-08-03: correspondence used to live in a different building from
// the business it was about. This route is the corridor: letters, shipments,
// documents and payments for one partner, sorted by time, in a single answer.
//
// Where each part comes from, and why:
//
//   letters    email_links (D1) gives the mail keys, the R2 mailbox index gives
//              subject and timestamp. Deliberately NOT denormalized into D1 —
//              the archive stays the single truth about a letter. A copy of the
//              subject in D1 would be one edit away from disagreeing with it.
//
//   the rest   operations, documents, payments — plain D1 reads.
//
// The index read costs one R2 GET per mailbox involved, not per letter, so a
// partner writing to three of our boxes costs three GETs regardless of whether
// the thread is four letters or four hundred.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession } from '../lib/auth';
import type { IndexEntry } from '../lib/inbox-archive';

const route = new Hono<{ Bindings: Env }>();

// Same session gate the archive routes use: this stream carries correspondence,
// and correspondence is not public. Copied rather than imported because the
// helper lives inline in email-archive.ts — worth extracting one day, not today.
async function requireSession(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  const header = c.req.header('Authorization');
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  const token = match?.[1]?.trim();
  if (!token) return false;
  return !!(await validateSession(c.env.DB, token));
}

export type TimelineKind = 'email' | 'operation' | 'document' | 'payment';

export interface TimelineEvent {
  kind: TimelineKind;
  at: number;               // epoch ms — one scale for every source
  title: string;
  subtitle?: string;
  /** email only */
  direction?: 'sent' | 'received';
  mailbox?: string;
  mailKey?: string;
  confidence?: number;
  locked?: boolean;
  /** business rows */
  id?: string;
  status?: string;
}

interface LinkRow {
  mail_key: string;
  mailbox: string;
  direction: 'sent' | 'received';
  confidence: number;
  locked: number;
}

/** One R2 GET per mailbox, then a key → entry map for the join. */
async function indexFor(env: Env, mailbox: string): Promise<Map<string, IndexEntry>> {
  const out = new Map<string, IndexEntry>();
  try {
    const obj = await env.ARCHIVE.get(`Inbox/${mailbox}.json`);
    if (!obj) return out;
    const parsed = JSON.parse(await obj.text());
    if (!Array.isArray(parsed)) return out;
    for (const entry of parsed as IndexEntry[]) {
      if (entry?.key) out.set(entry.key, entry);
    }
  } catch {
    // A missing or corrupt index costs us the letters of that one mailbox.
    // It must not cost the whole timeline.
  }
  return out;
}

// -----------------------------------------------------------------------------
// GET /:slug/timeline — merged timeline, newest first.
//   ?limit=  events to return (default 60, max 200)
//   ?kinds=  comma list to narrow, e.g. kinds=email,payment
// -----------------------------------------------------------------------------
route.get('/:slug/timeline', async (c) => {
  if (!(await requireSession(c))) {
    return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  }

  const slug = c.req.param('slug');
  const limit = Math.min(Math.max(Number(c.req.query('limit') || 60) || 60, 1), 200);
  const kindsParam = (c.req.query('kinds') || '').trim();
  const wanted = kindsParam
    ? new Set(kindsParam.split(',').map((k) => k.trim()).filter(Boolean))
    : null;
  const want = (k: TimelineKind) => !wanted || wanted.has(k);

  try {
    const partner = await c.env.DB.prepare(
      `SELECT id, trade_name FROM partners WHERE slug = ?1 AND deleted_at IS NULL LIMIT 1`
    ).bind(slug).first<{ id: string; trade_name: string }>();

    if (!partner?.id) {
      return fail(c, 404, [{ code: 'not_found', message: `no partner with slug ${slug}` }]);
    }

    const events: TimelineEvent[] = [];

    // ---- letters -------------------------------------------------------------
    if (want('email')) {
      const links = await c.env.DB.prepare(
        `SELECT mail_key, mailbox, direction, confidence, locked
           FROM email_links
          WHERE partner_id = ?1
          ORDER BY created_at DESC
          LIMIT ?2`
      ).bind(partner.id, limit).all<LinkRow>();

      const rows = links.results || [];
      const mailboxes = [...new Set(rows.map((r) => r.mailbox))];
      const indexes = new Map<string, Map<string, IndexEntry>>();
      await Promise.all(
        mailboxes.map(async (mb) => { indexes.set(mb, await indexFor(c.env, mb)); })
      );

      for (const row of rows) {
        const entry = indexes.get(row.mailbox)?.get(row.mail_key);
        // No index entry means the archive and the link disagree. Skip it
        // rather than invent a date — a made-up timestamp would silently
        // reorder the whole timeline around a letter nobody can open.
        if (!entry?.timestamp) continue;
        events.push({
          kind: 'email',
          at: Date.parse(entry.timestamp),
          title: entry.subject || '(без темы)',
          subtitle: row.direction === 'sent' ? 'Мы написали' : 'Нам написали',
          direction: row.direction,
          mailbox: row.mailbox,
          mailKey: row.mail_key,
          confidence: row.confidence,
          locked: row.locked === 1,
        });
      }
    }

    // ---- operations ----------------------------------------------------------
    if (want('operation')) {
      const ops = await c.env.DB.prepare(
        `SELECT id, operation_date, operation_type, status, reference, order_doc_ref
           FROM operations
          WHERE partner_id = ?1 AND deleted_at IS NULL
          ORDER BY operation_date DESC
          LIMIT ?2`
      ).bind(partner.id, limit).all<{
        id: string; operation_date: number; operation_type: string;
        status: string; reference: string | null; order_doc_ref: string | null;
      }>();

      for (const op of ops.results || []) {
        events.push({
          kind: 'operation',
          at: op.operation_date,
          title: op.reference || op.order_doc_ref || op.id,
          subtitle: op.operation_type,
          id: op.id,
          status: op.status,
        });
      }
    }

    // ---- documents -----------------------------------------------------------
    if (want('document')) {
      const docs = await c.env.DB.prepare(
        `SELECT id, document_number, document_type, document_date, status
           FROM documents
          WHERE partner_id = ?1 AND deleted_at IS NULL
          ORDER BY document_date DESC
          LIMIT ?2`
      ).bind(partner.id, limit).all<{
        id: string; document_number: string; document_type: string;
        document_date: number; status: string;
      }>();

      for (const d of docs.results || []) {
        events.push({
          kind: 'document',
          at: d.document_date,
          title: d.document_number,
          subtitle: d.document_type,
          id: d.id,
          status: d.status,
        });
      }
    }

    // ---- payments ------------------------------------------------------------
    if (want('payment')) {
      const pays = await c.env.DB.prepare(
        `SELECT id, amount, currency, payment_date, type, direction
           FROM payments
          WHERE partner_id = ?1 AND deleted_at IS NULL
          ORDER BY payment_date DESC
          LIMIT ?2`
      ).bind(partner.id, limit).all<{
        id: string; amount: number; currency: string;
        payment_date: number; type: string; direction: string;
      }>();

      for (const p of pays.results || []) {
        events.push({
          kind: 'payment',
          at: p.payment_date,
          // Minor units everywhere in this database — presentation belongs to the UI.
          title: `${(p.amount / 100).toFixed(2)} ${p.currency}`,
          subtitle: p.direction === 'incoming' ? `Получено · ${p.type}` : `Оплачено · ${p.type}`,
          id: p.id,
          status: p.direction,
        });
      }
    }

    // Dates arrive on two scales: D1 business rows are seconds, the archive is
    // an ISO string parsed to ms. Normalize before sorting or every letter
    // lands in 1970 next to the shipments.
    for (const e of events) {
      if (e.at && e.at < 1e11) e.at *= 1000;
    }

    events.sort((a, b) => b.at - a.at);

    return ok(c, {
      partner: { id: partner.id, slug, tradeName: partner.trade_name },
      events: events.slice(0, limit),
      counts: {
        email: events.filter((e) => e.kind === 'email').length,
        operation: events.filter((e) => e.kind === 'operation').length,
        document: events.filter((e) => e.kind === 'document').length,
        payment: events.filter((e) => e.kind === 'payment').length,
      },
    });
  } catch (err) {
    return fail(c, 500, [{ code: 'timeline_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

export default route;
