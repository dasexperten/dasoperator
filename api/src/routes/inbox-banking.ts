// =============================================================================
// /api/inbox/banking — manual resolution of bank-tx auto-match leftovers
// =============================================================================
// Companion to /api/inbox (which handles Gmail-ingested invoices). This route
// surfaces bank_transactions that auto-match could not fully resolve:
//
//   partner_not_found    → INN not in partners. User must pick or create.
//   partner_auto_created → draft partner was created from contragent_name.
//                          User must verify category and confirm/edit.
//   ambiguous            → 2+ candidate operations. User must pick one.
//   auto_created_draft   → draft operation was created. User must promote or merge.
//
// Plus a fifth bucket — fully unmatched legacy rows (match_method IS NULL)
// from before the cascade existed.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { suggestRuleFromAssignment } from '../lib/bank-match-rules';

const inboxBanking = new Hono<{ Bindings: Env }>();

const UNRESOLVED_METHODS = [
  'partner_not_found',
  'partner_auto_created',
  'ambiguous',
  'auto_created_draft',
] as const;

// =============================================================================
// GET /api/inbox/banking — list unresolved bank_transactions
// =============================================================================
// Query params:
//   filter — one of:
//     'all'                  (default) → every unresolved row
//     'partner_not_found'
//     'partner_auto_created'
//     'ambiguous'
//     'auto_created_draft'
//     'legacy_unmatched'     → match_method IS NULL (pre-cascade rows)
//   limit  — default 50, max 200
// =============================================================================
inboxBanking.get('/', async (c) => {
  const filter = c.req.query('filter') ?? 'all';
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));

  let where = '1=1';
  const params: (string | number)[] = [];

  if (filter === 'all') {
    where += ` AND match_method IN (${UNRESOLVED_METHODS.map(() => '?').join(',')})`;
    params.push(...UNRESOLVED_METHODS);
  } else if (filter === 'legacy_unmatched') {
    where += ' AND match_method IS NULL';
  } else if ((UNRESOLVED_METHODS as readonly string[]).includes(filter)) {
    where += ' AND match_method = ?';
    params.push(filter);
  } else {
    return fail(c, 400, [{ code: 'invalid_filter', message: `Unknown filter: ${filter}` }]);
  }

  try {
    const rows = await c.env.DB.prepare(`
      SELECT bt.id, bt.direction, bt.amount, bt.currency, bt.executed_at,
             bt.contragent_name, bt.contragent_inn, bt.payment_purpose,
             bt.matched_payment_id AS matched_operation_id,
             bt.match_method, bt.matched_at,
             o.reference AS matched_operation_ref,
             o.status AS matched_operation_status,
             o.notes AS matched_operation_notes,
             p.id AS guess_partner_id, p.trade_name AS guess_partner_name,
             p.kind AS guess_partner_kind
      FROM bank_transactions bt
      LEFT JOIN operations o ON o.id = bt.matched_payment_id
      LEFT JOIN partners   p ON (p.tax_id = bt.contragent_inn OR p.inn = bt.contragent_inn)
                             AND (p.deleted_at IS NULL OR p.deleted_at = 0)
      WHERE ${where}
      ORDER BY bt.executed_at DESC
      LIMIT ?
    `).bind(...params, limit).all();

    return ok(c, {
      filter,
      count: (rows.results || []).length,
      items: rows.results || [],
    });
  } catch (e) {
    return fail(c, 500, [{
      code: 'list_failed',
      message: e instanceof Error ? e.message : String(e),
    }]);
  }
});

// =============================================================================
// GET /api/inbox/banking/counts — bucket counts for sidebar badges
// =============================================================================
inboxBanking.get('/counts', async (c) => {
  try {
    const rows = await c.env.DB.prepare(`
      SELECT COALESCE(match_method, 'legacy_unmatched') AS bucket,
             COUNT(*) AS cnt
      FROM bank_transactions
      WHERE match_method IS NULL
         OR match_method IN ('partner_not_found','partner_auto_created','ambiguous','auto_created_draft')
      GROUP BY bucket
    `).all<{ bucket: string; cnt: number }>();

    const result: Record<string, number> = {
      partner_not_found: 0,
      partner_auto_created: 0,
      ambiguous: 0,
      auto_created_draft: 0,
      legacy_unmatched: 0,
    };
    (rows.results || []).forEach((r) => { result[r.bucket] = r.cnt; });
    const total = Object.values(result).reduce((a, b) => a + b, 0);

    return ok(c, { total, buckets: result });
  } catch (e) {
    return fail(c, 500, [{
      code: 'counts_failed',
      message: e instanceof Error ? e.message : String(e),
    }]);
  }
});

// =============================================================================
// GET /api/inbox/banking/:tx_id/suggestions — candidate operations for ambiguous
// =============================================================================
inboxBanking.get('/:tx_id/suggestions', async (c) => {
  const txId = c.req.param('tx_id');
  if (!txId) {
    return fail(c, 400, [{ code: 'missing_tx_id', message: 'tx_id required' }]);
  }

  try {
    const tx = await c.env.DB.prepare(`
      SELECT id, amount, currency, executed_at, contragent_inn, direction
      FROM bank_transactions WHERE id = ?
    `).bind(txId).first<{
      id: string; amount: number; currency: string; executed_at: number;
      contragent_inn: string; direction: string;
    }>();

    if (!tx) {
      return fail(c, 404, [{ code: 'tx_not_found', message: `bank_transaction ${txId} not found` }]);
    }

    const txMajor = tx.amount / 100;
    const windowSec = 90 * 86400; // wider window for manual suggestions
    const minDate = tx.executed_at - windowSec;
    const maxDate = tx.executed_at + windowSec;

    // Find partner by INN (may be null)
    const partner = await c.env.DB.prepare(`
      SELECT id FROM partners
      WHERE (tax_id = ? OR inn = ?) AND (deleted_at IS NULL OR deleted_at = 0)
      LIMIT 1
    `).bind(tx.contragent_inn, tx.contragent_inn).first<{ id: string }>();

    // Candidates: same partner OR (no partner found) any partner with matching amount.
    const candidatesSql = partner
      ? `SELECT o.id, o.reference, o.total_amount, o.currency, o.operation_date, o.status,
                p.trade_name AS partner_name
         FROM operations o
         JOIN partners p ON p.id = o.partner_id
         WHERE o.partner_id = ?
           AND o.status NOT IN ('cancelled','delivered')
           AND (o.deleted_at IS NULL OR o.deleted_at = 0)
           AND o.operation_date BETWEEN ? AND ?
           AND o.currency = ?
           AND ABS(o.total_amount - ?) < o.total_amount * 0.05
         ORDER BY ABS(o.operation_date - ?) ASC
         LIMIT 10`
      : `SELECT o.id, o.reference, o.total_amount, o.currency, o.operation_date, o.status,
                p.trade_name AS partner_name
         FROM operations o
         JOIN partners p ON p.id = o.partner_id
         WHERE o.status NOT IN ('cancelled','delivered')
           AND (o.deleted_at IS NULL OR o.deleted_at = 0)
           AND o.operation_date BETWEEN ? AND ?
           AND o.currency = ?
           AND ABS(o.total_amount - ?) < o.total_amount * 0.05
         ORDER BY ABS(o.operation_date - ?) ASC
         LIMIT 10`;

    const candidates = partner
      ? await c.env.DB.prepare(candidatesSql)
          .bind(partner.id, minDate, maxDate, tx.currency, txMajor, tx.executed_at)
          .all()
      : await c.env.DB.prepare(candidatesSql)
          .bind(minDate, maxDate, tx.currency, txMajor, tx.executed_at)
          .all();

    return ok(c, {
      tx_id: txId,
      tx_amount: txMajor,
      tx_currency: tx.currency,
      partner_id: partner?.id || null,
      candidates: candidates.results || [],
    });
  } catch (e) {
    return fail(c, 500, [{
      code: 'suggestions_failed',
      message: e instanceof Error ? e.message : String(e),
    }]);
  }
});

// =============================================================================
// POST /api/inbox/banking/:tx_id/attach
// Body: { operation_id: string }
// Attaches the bank_tx to an existing operation (overrides auto-match decision).
// =============================================================================
inboxBanking.post('/:tx_id/attach', async (c) => {
  const txId = c.req.param('tx_id');
  let body: { operation_id?: string } = {};
  try { body = await c.req.json(); } catch { /* empty body */ }
  if (!body.operation_id) {
    return fail(c, 400, [{ code: 'missing_operation_id', message: 'operation_id required in body' }]);
  }

  try {
    // Verify operation exists.
    const op = await c.env.DB.prepare(`
      SELECT id, reference FROM operations WHERE id = ?
        AND (deleted_at IS NULL OR deleted_at = 0)
    `).bind(body.operation_id).first<{ id: string; reference: string }>();
    if (!op) {
      return fail(c, 404, [{ code: 'operation_not_found', message: `Operation ${body.operation_id} not found` }]);
    }

    // Load tx to know what to attach.
    const tx = await c.env.DB.prepare(`
      SELECT id, direction, amount, currency, executed_at,
             contragent_name, contragent_inn, payment_purpose, external_doc_number,
             matched_payment_id AS prev_op_id
      FROM bank_transactions WHERE id = ?
    `).bind(txId).first<{
      id: string; direction: string; amount: number; currency: string;
      executed_at: number; contragent_name: string; contragent_inn: string | null;
      payment_purpose: string; external_doc_number: string; prev_op_id: string | null;
    }>();
    if (!tx) {
      return fail(c, 404, [{ code: 'tx_not_found', message: `bank_tx ${txId} not found` }]);
    }

    const now = Math.floor(Date.now() / 1000);

    // If previously attached to a different operation, detach old attachments.
    if (tx.prev_op_id && tx.prev_op_id !== op.id) {
      await c.env.DB.prepare(`
        UPDATE operation_attachments
        SET deleted_at = ?, updated_at = ?
        WHERE source_ref_id = ? AND operation_id = ?
      `).bind(now, now, tx.id, tx.prev_op_id).run();
    }

    // Create fresh PMT (and INV if parseable) attachments on the target operation.
    // Reuse the helpers indirectly via direct INSERTs to keep this route self-contained.
    const pmtId = `att_${crypto.randomUUID()}`;
    await c.env.DB.prepare(`
      INSERT INTO operation_attachments (
        id, operation_id, direction, kind, doc_number, doc_date,
        amount, currency, issuer, parsed_from, source_ref_id, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'payment', ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?)
    `).bind(
      pmtId, op.id, tx.direction,
      tx.external_doc_number || null, tx.executed_at,
      tx.amount / 100, tx.currency,
      tx.contragent_name || 'Modulbank', tx.id,
      `[manually attached via inbox] ${(tx.payment_purpose || '').slice(0, 400)}`,
      now, now,
    ).run();

    await c.env.DB.prepare(`
      UPDATE bank_transactions
      SET matched_payment_id = ?, match_method = 'manual_attached',
          matched_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(op.id, now, now, tx.id).run();

    // After attach, ask Claude if this assignment could become a reusable rule.
    // The suggestion is non-blocking and surfaces in the response so the UI
    // can show a "Create rule from this?" confirmation card.
    let ruleSuggestion: Awaited<ReturnType<typeof suggestRuleFromAssignment>> = null;
    try {
      // Reload partner_id from operation for context.
      const opPartner = await c.env.DB.prepare(`
        SELECT o.partner_id, o.operation_type, o.our_company_id,
               p.trade_name AS partner_trade_name, p.kind AS partner_kind
        FROM operations o
        LEFT JOIN partners p ON p.id = o.partner_id
        WHERE o.id = ?
      `).bind(op.id).first<{
        partner_id: string | null;
        operation_type: string;
        our_company_id: string;
        partner_trade_name: string | null;
        partner_kind: string | null;
      }>();

      if (opPartner) {
        ruleSuggestion = await suggestRuleFromAssignment(c.env, {
          tx: {
            direction: tx.direction as 'incoming' | 'outgoing',
            contragent_name: tx.contragent_name,
            contragent_inn: tx.contragent_inn,
            payment_purpose: tx.payment_purpose,
            amount: tx.amount,
            currency: tx.currency,
          },
          operation: {
            id: op.id,
            reference: op.reference,
            operation_type: opPartner.operation_type,
            partner_id: opPartner.partner_id,
            our_company_id: opPartner.our_company_id,
          },
          partner: opPartner.partner_id ? {
            id: opPartner.partner_id,
            trade_name: opPartner.partner_trade_name,
            kind: opPartner.partner_kind ?? 'unknown',
          } : null,
        });
      }
    } catch (suggestErr) {
      console.error('[inbox-banking attach] suggestRule failed:', suggestErr);
    }

    return ok(c, {
      tx_id: tx.id,
      operation_id: op.id,
      operation_ref: op.reference,
      attachment_id: pmtId,
      rule_suggestion: ruleSuggestion,
    });
  } catch (e) {
    return fail(c, 500, [{
      code: 'attach_failed',
      message: e instanceof Error ? e.message : String(e),
    }]);
  }
});

// =============================================================================
// POST /api/inbox/banking/:tx_id/assign-partner
// Body: { partner_id: string }   (existing) OR
//       { trade_name, kind, tax_id?, currency? }  (create new)
// Updates the bank_tx's perceived partner and re-routes through the cascade:
//   - If partner is service kind + outgoing → close as service expense
//   - Otherwise create a draft goods operation
// =============================================================================
inboxBanking.post('/:tx_id/assign-partner', async (c) => {
  const txId = c.req.param('tx_id');
  let body: {
    partner_id?: string;
    trade_name?: string;
    kind?: string;
    tax_id?: string;
    currency?: string;
  } = {};
  try { body = await c.req.json(); } catch { /* empty */ }

  const tx = await c.env.DB.prepare(`
    SELECT id, direction, amount, currency, executed_at,
           contragent_name, contragent_inn, payment_purpose, external_doc_number
    FROM bank_transactions WHERE id = ?
  `).bind(txId).first<{
    id: string; direction: string; amount: number; currency: string;
    executed_at: number; contragent_name: string; contragent_inn: string;
    payment_purpose: string; external_doc_number: string;
  }>();
  if (!tx) {
    return fail(c, 404, [{ code: 'tx_not_found', message: `bank_tx ${txId} not found` }]);
  }

  const now = Math.floor(Date.now() / 1000);
  let partnerId: string;
  let partnerKind: string;

  try {
    if (body.partner_id) {
      // Use existing partner.
      const existing = await c.env.DB.prepare(`
        SELECT id, kind FROM partners WHERE id = ?
          AND (deleted_at IS NULL OR deleted_at = 0)
      `).bind(body.partner_id).first<{ id: string; kind: string }>();
      if (!existing) {
        return fail(c, 404, [{ code: 'partner_not_found', message: `Partner ${body.partner_id} not found` }]);
      }
      partnerId = existing.id;
      partnerKind = existing.kind || 'other';
    } else if (body.trade_name && body.kind) {
      // Create new partner draft.
      const newId = `prt_inbox_${crypto.randomUUID().slice(0, 8)}`;
      const slug = body.trade_name.toLowerCase()
        .replace(/[^a-zа-я0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || newId.slice(-8);
      await c.env.DB.prepare(`
        INSERT INTO partners (
          id, trade_name, legal_name, tax_id, inn, currency, kind,
          partner_type, status, crm_status, partner_language,
          has_dual_route_banking, is_packaging_manufacturer, is_legal_seller,
          slug, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'other', 'active', 'lead', 'RU',
                  0, 0, 0, ?, ?, ?, ?)
      `).bind(
        newId, body.trade_name, body.trade_name,
        body.tax_id || tx.contragent_inn || '',
        body.tax_id || tx.contragent_inn || '',
        body.currency || tx.currency, body.kind, slug,
        '[CREATED via inbox banking from manual assign-partner]',
        now, now,
      ).run();
      partnerId = newId;
      partnerKind = body.kind;
    } else {
      return fail(c, 400, [{
        code: 'invalid_body',
        message: 'Provide either partner_id (existing) or trade_name + kind (new)',
      }]);
    }

    // Decide path based on kind × direction.
    const SERVICE_KINDS = new Set(['service_provider', '3pl', 'shipper']);
    const isService = tx.direction === 'outgoing' && SERVICE_KINDS.has(partnerKind);
    const operationType = tx.direction === 'incoming' ? 'sale' : 'purchase';

    // Generate reference
    const yy = new Date(tx.executed_at * 1000).getFullYear() % 100;
    const prefix = `DEE-${String(yy).padStart(2, '0')}`;
    const cntRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM operations WHERE reference LIKE ?`
    ).bind(`${prefix}%`).first<{ cnt: number }>();
    const seq = ((cntRow?.cnt ?? 0) + 1).toString().padStart(4, '0');
    const reference = `${prefix}${seq}`;

    const opId = `op_${crypto.randomUUID()}`;
    const notes = isService
      ? `[SERVICE EXPENSE — closed via inbox] ${tx.contragent_name}. ${(tx.payment_purpose || '').slice(0, 400)}`
      : `[GOODS OPERATION — created via inbox] ${tx.contragent_name}. ${(tx.payment_purpose || '').slice(0, 400)}`;

    await c.env.DB.prepare(`
      INSERT INTO operations (
        id, operation_date, operation_type, partner_id,
        our_company_id, status, currency, total_amount,
        notes, reference, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'co_dee', 'issued', ?, ?, ?, ?, ?, ?)
    `).bind(
      opId, tx.executed_at, operationType, partnerId,
      tx.currency, tx.amount / 100, notes, reference, now, now,
    ).run();

    // Attach PMT
    const pmtId = `att_${crypto.randomUUID()}`;
    await c.env.DB.prepare(`
      INSERT INTO operation_attachments (
        id, operation_id, direction, kind, doc_number, doc_date,
        amount, currency, issuer, parsed_from, source_ref_id, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'payment', ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, ?)
    `).bind(
      pmtId, opId, tx.direction,
      tx.external_doc_number || null, tx.executed_at,
      tx.amount / 100, tx.currency,
      tx.contragent_name || 'Modulbank', tx.id,
      `[manually assigned via inbox] ${(tx.payment_purpose || '').slice(0, 400)}`,
      now, now,
    ).run();

    // Update bank_tx
    await c.env.DB.prepare(`
      UPDATE bank_transactions
      SET matched_payment_id = ?,
          match_method = ?,
          matched_at = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(
      opId,
      isService ? 'manual_service_closed' : 'manual_partner_assigned',
      now, now, tx.id,
    ).run();

    return ok(c, {
      tx_id: tx.id,
      partner_id: partnerId,
      operation_id: opId,
      operation_ref: reference,
      classified_as: isService ? 'service_closed' : 'goods_draft',
      attachment_id: pmtId,
    });
  } catch (e) {
    return fail(c, 500, [{
      code: 'assign_failed',
      message: e instanceof Error ? e.message : String(e),
    }]);
  }
});

// =============================================================================
// POST /api/inbox/banking/:tx_id/promote-draft
// Body: { confirm: true }
// Confirms an auto_created_draft operation as final. Just flips match_method;
// the operation itself stays as 'issued'.
// =============================================================================
inboxBanking.post('/:tx_id/promote-draft', async (c) => {
  const txId = c.req.param('tx_id');
  try {
    const tx = await c.env.DB.prepare(`
      SELECT id, matched_payment_id, match_method
      FROM bank_transactions WHERE id = ?
    `).bind(txId).first<{
      id: string; matched_payment_id: string | null; match_method: string | null;
    }>();
    if (!tx) {
      return fail(c, 404, [{ code: 'tx_not_found', message: `bank_tx ${txId} not found` }]);
    }
    if (!tx.matched_payment_id) {
      return fail(c, 422, [{
        code: 'no_draft_to_promote',
        message: 'This tx has no attached operation to promote',
      }]);
    }

    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(`
      UPDATE bank_transactions
      SET match_method = 'manual_confirmed_draft',
          matched_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(now, now, txId).run();

    return ok(c, { tx_id: txId, operation_id: tx.matched_payment_id });
  } catch (e) {
    return fail(c, 500, [{
      code: 'promote_failed',
      message: e instanceof Error ? e.message : String(e),
    }]);
  }
});

// =============================================================================
// POST /api/inbox/banking/:tx_id/skip
// Body: { reason?: string }
// Marks the row as manually handled outside the inbox (e.g. paid in cash,
// known mistake, irrelevant). Removes it from Inbox queries.
// =============================================================================
inboxBanking.post('/:tx_id/skip', async (c) => {
  const txId = c.req.param('tx_id');
  let body: { reason?: string } = {};
  try { body = await c.req.json(); } catch { /* empty */ }

  try {
    const now = Math.floor(Date.now() / 1000);
    const r = await c.env.DB.prepare(`
      UPDATE bank_transactions
      SET match_method = 'manual_skipped',
          matched_at = ?, updated_at = ?
      WHERE id = ?
    `).bind(now, now, txId).run();
    if (r.meta.changes === 0) {
      return fail(c, 404, [{ code: 'tx_not_found', message: `bank_tx ${txId} not found` }]);
    }
    return ok(c, { tx_id: txId, reason: body.reason || null });
  } catch (e) {
    return fail(c, 500, [{
      code: 'skip_failed',
      message: e instanceof Error ? e.message : String(e),
    }]);
  }
});

export default inboxBanking;
