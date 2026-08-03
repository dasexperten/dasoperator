// =============================================================================
// email-context — everything the letter screen needs to know about who wrote.
//
// Owner 2026-08-03. The reading pane holds a letter and knows one thing about
// the sender: their address. This route turns that address into a counterparty
// — who they are, what we are shipping them, what the auto-linker decided and
// how sure it was.
//
//   GET /api/email/context?key=<R2 mail key>
//
// One call per opened letter. Deliberately NOT merged into the timeline route:
// this answers "who is this", the timeline answers "what happened". A panel
// that renders the header before the history feels twice as fast as one that
// waits for both, and the header is what the reader looks at first.
//
// Returns the link even when it resolved to nobody. An honest "не привязано"
// with a visible button is worth more than an empty panel that looks broken.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession } from '../lib/auth';

const route = new Hono<{ Bindings: Env }>();

async function requireSession(c: import('hono').Context<{ Bindings: Env }>): Promise<boolean> {
  const header = c.req.header('Authorization');
  const match = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  const token = match?.[1]?.trim();
  if (!token) return false;
  return !!(await validateSession(c.env.DB, token));
}

route.get('/context', async (c) => {
  if (!(await requireSession(c))) {
    return fail(c, 401, [{ code: 'unauthorized', message: 'valid session required' }]);
  }

  const key = (c.req.query('key') || '').trim();
  if (!key.startsWith('Inbox/')) {
    return fail(c, 422, [{ code: 'bad_key', message: 'key must be an archive mail key' }]);
  }

  try {
    const link = await c.env.DB.prepare(
      `SELECT id, mail_key, counterparty_email, partner_id, operation_id,
              crm_customer_id, source, confidence, matched_on, locked
         FROM email_links WHERE mail_key = ?1 LIMIT 1`
    ).bind(key).first<{
      id: string; mail_key: string; counterparty_email: string | null;
      partner_id: string | null; operation_id: string | null;
      crm_customer_id: string | null; source: string;
      confidence: number; matched_on: string | null; locked: number;
    }>();

    if (!link) {
      // No row means the letter predates the linker. Not an error — a state.
      return ok(c, { link: null, partner: null, operation: null, stats: null });
    }

    let partner: unknown = null;
    let stats: unknown = null;

    if (link.partner_id) {
      partner = await c.env.DB.prepare(
        `SELECT id, slug, trade_name, country, partner_type, status, email
           FROM partners WHERE id = ?1 LIMIT 1`
      ).bind(link.partner_id).first();

      const counts = await c.env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM email_links WHERE partner_id = ?1) AS letters,
           (SELECT COUNT(*) FROM operations WHERE partner_id = ?1 AND deleted_at IS NULL) AS operations,
           (SELECT MAX(timestamp) FROM (
              SELECT created_at AS timestamp FROM email_links WHERE partner_id = ?1
           )) AS last_letter_at`
      ).bind(link.partner_id).first();
      stats = counts;
    }

    let operation: unknown = null;
    if (link.operation_id) {
      operation = await c.env.DB.prepare(
        `SELECT id, reference, order_doc_ref, operation_type, status, operation_date
           FROM operations WHERE id = ?1 LIMIT 1`
      ).bind(link.operation_id).first();
    }

    return ok(c, {
      link: {
        id: link.id,
        counterpartyEmail: link.counterparty_email,
        source: link.source,
        confidence: link.confidence,
        matchedOn: link.matched_on,
        locked: link.locked === 1,
      },
      partner,
      operation,
      stats,
    });
  } catch (err) {
    return fail(c, 500, [{ code: 'context_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

export default route;
