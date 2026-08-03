// =============================================================================
// email-link — attaches an archived letter to the business it belongs to.
//
// Runs once per letter, from inbox-archive.archiveEmail, so both directions go
// through the same door: a sent letter is as much a part of a counterparty's
// history as a received one.
//
// Ladder, strongest evidence first. It stops at the first rung that holds:
//
//   1.0  the counterparty address equals partners.email exactly
//   0.95 a reference found in the subject or body matches an operation
//        (operations.reference / order_doc_ref) — this also yields the partner
//   0.9  the counterparty address equals crm_customers.email (website buyer)
//   0.6  only the domain matches a partner — a candidate, not a verdict
//
// Nothing below that is written. A guess dressed as a link is worse than an
// empty field, because the empty field is visibly empty and the guess is not.
//
// LAW OF THE LOCK: a row with locked = 1 was decided by a person. This module
// reads it, sees the lock, and leaves. No exceptions, no "but the new match is
// better" — the whole point of a lock is that the machine does not get a vote.
//
// Best-effort by construction: every failure is swallowed and logged. Losing a
// link is an inconvenience; losing the letter it was attached to is not.
// =============================================================================

import type { Env } from '../types';

export type LinkDirection = 'sent' | 'received';

export interface LinkEmailInput {
  mailKey: string;
  mailbox: string;
  direction: LinkDirection;
  from?: string | undefined;
  to?: string | string[] | undefined;
  subject?: string | undefined;
  text?: string | undefined;
}

interface Resolution {
  partnerId?: string;
  operationId?: string;
  crmCustomerId?: string;
  confidence: number;
  matchedOn: string;
}

function emailAddr(raw: string | undefined): string {
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  return (angle ? angle[1]! : raw).trim().toLowerCase();
}

/** The other side of the conversation: who wrote to us, or who we wrote to. */
function counterpartyOf(input: LinkEmailInput): string {
  if (input.direction === 'received') return emailAddr(input.from);
  const to = Array.isArray(input.to) ? input.to[0] : input.to;
  return emailAddr(to);
}

/**
 * Reference-shaped tokens: at least one letter, at least one digit, joined by
 * dashes or slashes — SO-2026-118, DE/2026/07, INV2026118. Bare words and bare
 * numbers are excluded on purpose: matching "2026" against a reference column
 * would attach half the archive to one operation.
 */
function referenceCandidates(subject: string | undefined, text: string | undefined): string[] {
  const haystack = `${subject || ''}\n${(text || '').slice(0, 4000)}`;
  const found = haystack.match(/\b[A-Za-z0-9]+(?:[-/][A-Za-z0-9]+){1,4}\b/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    const token = raw.trim();
    if (token.length < 5 || token.length > 40) continue;
    if (!/[A-Za-z]/.test(token) || !/[0-9]/.test(token)) continue;
    const upper = token.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    out.push(token);
    if (out.length >= 20) break;
  }
  return out;
}

async function resolve(env: Env, input: LinkEmailInput, party: string): Promise<Resolution | null> {
  // 1 — exact partner address.
  if (party) {
    const exact = await env.DB.prepare(
      `SELECT id FROM partners WHERE lower(email) = ?1 AND deleted_at IS NULL LIMIT 1`
    ).bind(party).first<{ id: string }>();
    if (exact?.id) {
      const op = await operationByReference(env, input, exact.id);
      return {
        partnerId: exact.id,
        ...(op ? { operationId: op } : {}),
        confidence: 1,
        matchedOn: op ? 'partner_email+reference' : 'partner_email',
      };
    }
  }

  // 2 — a reference in the letter identifies the operation, and with it the partner.
  const byRef = await operationByReference(env, input, null);
  if (byRef) {
    const op = await env.DB.prepare(
      `SELECT id, partner_id FROM operations WHERE id = ?1 LIMIT 1`
    ).bind(byRef).first<{ id: string; partner_id: string | null }>();
    if (op?.id) {
      return {
        operationId: op.id,
        ...(op.partner_id ? { partnerId: op.partner_id } : {}),
        confidence: 0.95,
        matchedOn: 'reference',
      };
    }
  }

  // 3 — website buyer.
  if (party) {
    const cust = await env.DB.prepare(
      `SELECT id FROM crm_customers WHERE lower(email) = ?1 LIMIT 1`
    ).bind(party).first<{ id: string }>();
    if (cust?.id) {
      return { crmCustomerId: cust.id, confidence: 0.9, matchedOn: 'crm_email' };
    }
  }

  // 4 — same domain as a known partner. A hint for a human, nothing more.
  const domain = party.includes('@') ? party.slice(party.lastIndexOf('@') + 1) : '';
  if (domain && domain.length > 3) {
    const byDomain = await env.DB.prepare(
      `SELECT id FROM partners WHERE lower(email) LIKE ?1 AND deleted_at IS NULL LIMIT 2`
    ).bind(`%@${domain}`).all<{ id: string }>();
    const rows = byDomain.results || [];
    // Two partners on one domain means the domain proves nothing.
    if (rows.length === 1) {
      return { partnerId: rows[0]!.id, confidence: 0.6, matchedOn: 'domain' };
    }
  }

  return null;
}

async function operationByReference(
  env: Env,
  input: LinkEmailInput,
  partnerId: string | null
): Promise<string | null> {
  const tokens = referenceCandidates(input.subject, input.text);
  if (!tokens.length) return null;

  const placeholders = tokens.map((_, i) => `?${i + 1}`).join(',');
  const partnerClause = partnerId ? ` AND partner_id = ?${tokens.length + 1}` : '';
  const sql =
    `SELECT id FROM operations
      WHERE (upper(reference) IN (${placeholders}) OR upper(order_doc_ref) IN (${placeholders}))
        AND deleted_at IS NULL${partnerClause}
      ORDER BY operation_date DESC LIMIT 2`;

  const binds: string[] = tokens.map((t) => t.toUpperCase());
  const row = await env.DB.prepare(sql)
    .bind(...binds, ...(partnerId ? [partnerId] : []))
    .all<{ id: string }>();
  const rows = row.results || [];
  // Two operations answering to the same reference is a data problem, not a match.
  return rows.length === 1 ? rows[0]!.id : null;
}

export async function linkEmail(env: Env, input: LinkEmailInput): Promise<void> {
  try {
    if (!env.DB || !input.mailKey) return;

    // The lock comes first: if a person already decided, we do not even look.
    const existing = await env.DB.prepare(
      `SELECT id, locked FROM email_links WHERE mail_key = ?1 LIMIT 1`
    ).bind(input.mailKey).first<{ id: string; locked: number }>();
    if (existing?.locked) return;

    const party = counterpartyOf(input);
    const hit = await resolve(env, input, party);
    const now = Date.now();

    if (!hit) {
      // Still worth a row: it records that we looked and found nobody, which is
      // exactly the queue Lena works from.
      if (existing) return;
      await env.DB.prepare(
        `INSERT INTO email_links
           (id, mail_key, mailbox, direction, counterparty_email, source, confidence, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'auto', 0, ?6, ?6)`
      ).bind(`elnk_${crypto.randomUUID()}`, input.mailKey, input.mailbox, input.direction, party || null, now).run();
      return;
    }

    if (existing) {
      await env.DB.prepare(
        `UPDATE email_links
            SET partner_id = ?1, operation_id = ?2, crm_customer_id = ?3,
                counterparty_email = ?4, confidence = ?5, matched_on = ?6,
                source = 'auto', updated_at = ?7
          WHERE mail_key = ?8 AND locked = 0`
      ).bind(
        hit.partnerId || null, hit.operationId || null, hit.crmCustomerId || null,
        party || null, hit.confidence, hit.matchedOn, now, input.mailKey
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO email_links
           (id, mail_key, mailbox, direction, counterparty_email,
            partner_id, operation_id, crm_customer_id,
            source, confidence, matched_on, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'auto', ?9, ?10, ?11, ?11)`
      ).bind(
        `elnk_${crypto.randomUUID()}`, input.mailKey, input.mailbox, input.direction, party || null,
        hit.partnerId || null, hit.operationId || null, hit.crmCustomerId || null,
        hit.confidence, hit.matchedOn, now
      ).run();
    }
  } catch (err) {
    console.log(JSON.stringify({
      scope: 'email-link',
      success: false,
      mailKey: input.mailKey,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}
