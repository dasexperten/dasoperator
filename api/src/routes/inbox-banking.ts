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
import { findExistingPartnerByName, isBankProviderName, generateReadablePartnerId } from '../lib/partner-dedup';
import { autoMatchBankTransaction } from '../lib/bank-auto-match';

// =============================================================================
// generateServiceReference — issuer-based naming for service-track operations.
//   Format: {PARTNER_ABBR}-{YYYYMMDD}[-{doc_number}]
//   Examples: TSAR-20260507-1180, WIO-20260507, ATOL-20260512-12345
//
//   For goods-track ops, keep using sequential DEE-NNN format (handled by
//   the caller's existing logic — we only override when isService=true).
//
//   Collision handling: if a ref already exists, append -A/-B/-C/... suffix.
//   This matches how legacy 285 ops were migrated on 2026-05-15.
// =============================================================================
async function generateServiceReference(
  db: D1Database,
  args: {
    partnerId: string;
    operationDateSec: number;
    invoiceDocNumber?: string | null;
  }
): Promise<string> {
  const partner = await db.prepare(
    'SELECT abbreviation FROM partners WHERE id = ?'
  ).bind(args.partnerId).first<{ abbreviation: string | null }>();

  // Fall back to 4-letter slug from partner_id if no abbreviation (shouldn't happen
  // — we backfilled all 75 active partners — but safe-guard for any edge case)
  let abbr = partner?.abbreviation?.trim().toUpperCase() || '';
  if (!abbr) {
    abbr = (args.partnerId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4) || 'PART').toUpperCase();
  }

  const dt = new Date(args.operationDateSec * 1000);
  const yyyymmdd = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;

  const docTail = args.invoiceDocNumber ? `-${args.invoiceDocNumber}` : '';
  const baseRef = `${abbr}-${yyyymmdd}${docTail}`;

  // Collision check: try base, then -A, -B, -C, ... until unique
  for (let i = 0; i < 26; i++) {
    const candidate = i === 0 ? baseRef : `${baseRef}-${String.fromCharCode(65 + i - 1)}`;
    const exists = await db.prepare(
      'SELECT id FROM operations WHERE reference = ? AND deleted_at IS NULL'
    ).bind(candidate).first();
    if (!exists) return candidate;
  }
  // 26+ collisions on the same day — extremely unlikely, but fail loudly
  throw new Error(`Reference collision exhausted A-Z for ${baseRef}`);
}
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

// Silent auto-write of an INN → partner rule on each successful assign/attach.
// Bumps hit_count on existing match; inserts new row otherwise. No category
// is set here — these are partner-matching rules used by the auto-match Tier 1
// query; category-only rules continue to live alongside.
async function recordPartnerInnRule(
  db: D1Database,
  args: {
    partnerId: string;
    inn: string;
    direction: 'incoming' | 'outgoing';
    operationType: 'sale' | 'purchase';
    txId: string;
  },
): Promise<void> {
  if (!args.inn || !args.partnerId) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    // Look for an existing partner-bound rule with this (inn, partner, direction).
    const existing = await db.prepare(`
      SELECT id, hit_count FROM bank_match_rules
      WHERE contragent_inn = ?
        AND partner_id = ?
        AND (direction = ? OR direction = 'any')
        AND deleted_at IS NULL
      LIMIT 1
    `).bind(args.inn, args.partnerId, args.direction).first<{
      id: string; hit_count: number;
    }>();

    if (existing) {
      await db.prepare(`
        UPDATE bank_match_rules
        SET hit_count = hit_count + 1,
            last_hit_at = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(now, now, existing.id).run();
      return;
    }

    const id = `bmr_${crypto.randomUUID()}`;
    await db.prepare(`
      INSERT INTO bank_match_rules
        (id, partner_id, contragent_inn, direction,
         default_operation_type, hit_count, last_hit_at,
         created_at, updated_at, created_from_tx_id)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).bind(
      id, args.partnerId, args.inn, args.direction,
      args.operationType, now, now, now, args.txId,
    ).run();
  } catch (err) {
    console.error('[inbox-banking] recordPartnerInnRule failed:', err);
    // Non-fatal — rule remembering is best-effort.
  }
}

// =============================================================================
// sweepUnmatchedByInn — retroactive application of a partner-INN binding.
// When user manually assigns a partner to one bank_tx (and a rule is recorded),
// we also sweep ALL other unmatched bank_tx rows with the same INN and process
// them through the same logic: create operation + payment attachment + link.
// This is what was missing — without this, every recurring payment from the
// same counterparty required a new manual click. Now: assign once → all caught up.
//
// Returns { processed, errors } so the caller can include it in the response.
// =============================================================================
async function sweepUnmatchedByInn(
  db: D1Database,
  args: {
    inn: string;
    partnerId: string;
    partnerKind: string;
    excludeTxId: string;  // already processed by caller
    nowSec: number;
  },
): Promise<{ processed: number; refs: string[]; errors: string[] }> {
  const out = { processed: 0, refs: [] as string[], errors: [] as string[] };

  const candidates = await db.prepare(`
    SELECT id, direction, amount, currency, executed_at,
           contragent_name, payment_purpose, external_doc_number
    FROM bank_transactions
    WHERE contragent_inn = ?
      AND id != ?
      AND matched_operation_id IS NULL
      AND matched_payment_id IS NULL
    ORDER BY executed_at ASC
  `).bind(args.inn, args.excludeTxId).all<{
    id: string; direction: string; amount: number; currency: string;
    executed_at: number; contragent_name: string;
    payment_purpose: string; external_doc_number: string;
  }>();

  if (!candidates.results.length) return out;

  const SERVICE_KINDS = new Set(['service_provider', '3pl', 'shipper']);

  for (const tx of candidates.results) {
    try {
      const isService = tx.direction === 'outgoing' && SERVICE_KINDS.has(args.partnerKind);
      const operationType = tx.direction === 'incoming' ? 'sale' : 'purchase';

      // Generate reference — issuer-based for service, DEE-NNN for goods
      let reference: string;
      if (isService) {
        reference = await generateServiceReference(db, {
          partnerId: args.partnerId,
          operationDateSec: tx.executed_at,
          invoiceDocNumber: tx.external_doc_number || null,
        });
      } else {
        const yy = new Date(tx.executed_at * 1000).getFullYear() % 100;
        const prefix = `DEE-${String(yy).padStart(2, '0')}`;
        const cntRow = await db.prepare(
          `SELECT COUNT(*) AS cnt FROM operations WHERE reference LIKE ?`
        ).bind(`${prefix}%`).first<{ cnt: number }>();
        const seq = ((cntRow?.cnt ?? 0) + 1).toString().padStart(4, '0');
        reference = `${prefix}${seq}`;
      }

      const opId = `op_${crypto.randomUUID()}`;
      const notes = isService
        ? `[SERVICE EXPENSE — auto-cascaded via INN rule] ${tx.contragent_name}. ${(tx.payment_purpose || '').slice(0, 400)}`
        : `[GOODS OPERATION — auto-cascaded via INN rule] ${tx.contragent_name}. ${(tx.payment_purpose || '').slice(0, 400)}`;

      await db.prepare(`
        INSERT INTO operations (
          id, operation_date, operation_type, partner_id,
          our_company_id, status, currency, total_amount,
          notes, reference, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'dee', 'issued', ?, ?, ?, ?, ?, ?)
      `).bind(
        opId, tx.executed_at, operationType, args.partnerId,
        tx.currency, tx.amount / 100, notes, reference, args.nowSec, args.nowSec,
      ).run();

      const pmtId = `att_${crypto.randomUUID()}`;
      await db.prepare(`
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
        `[auto-cascaded via INN rule] ${(tx.payment_purpose || '').slice(0, 400)}`,
        args.nowSec, args.nowSec,
      ).run();

      await db.prepare(`
        UPDATE bank_transactions
        SET matched_operation_id = ?,
            match_method = 'auto_inn_rule',
            matched_at = ?,
            updated_at = ?
        WHERE id = ?
      `).bind(opId, args.nowSec, args.nowSec, tx.id).run();

      out.processed += 1;
      out.refs.push(reference);
    } catch (err) {
      out.errors.push(`tx ${tx.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return out;
}

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
             bt.suggested_category_id,
             bt.suggested_confidence,
             bt.suggested_reason,
             o.reference AS matched_operation_ref,
             o.status AS matched_operation_status,
             o.notes AS matched_operation_notes,
             p.id AS guess_partner_id, p.trade_name AS guess_partner_name,
             p.kind AS guess_partner_kind,
             fc.label AS suggested_category_label,
             fc.color AS suggested_category_color,
             fc.always_confirm AS suggested_category_always_confirm,
             fc.default_operation_type AS suggested_category_op_type
      FROM bank_transactions bt
      LEFT JOIN operations o ON o.id = bt.matched_payment_id
      LEFT JOIN partners   p ON (p.tax_id = bt.contragent_inn OR p.inn = bt.contragent_inn)
                             AND (p.deleted_at IS NULL OR p.deleted_at = 0)
      LEFT JOIN finance_categories fc ON fc.id = bt.suggested_category_id
      WHERE ${where}
        -- Exclude internal self-transfers (DEE → DEE etc.). 2026-05-16.
        AND (
          bt.contragent_inn IS NULL
          OR bt.contragent_inn NOT IN (
            SELECT tax_id FROM companies
            WHERE tax_id IS NOT NULL AND tax_id != ''
              AND (deleted_at IS NULL OR deleted_at = 0)
          )
        )
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
      WHERE (match_method IS NULL
         OR match_method IN ('partner_not_found','partner_auto_created','ambiguous','auto_created_draft'))
         -- Exclude internal self-transfers. 2026-05-16.
         AND (
           contragent_inn IS NULL
           OR contragent_inn NOT IN (
             SELECT tax_id FROM companies
             WHERE tax_id IS NOT NULL AND tax_id != ''
               AND (deleted_at IS NULL OR deleted_at = 0)
           )
         )
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

    // Find partner by INN (may be null) — or use ?partner_id=X override from wizard Step 2
    const partnerIdOverride = c.req.query('partner_id');
    let partner: { id: string } | null = null;
    if (partnerIdOverride) {
      partner = await c.env.DB.prepare(
        `SELECT id FROM partners WHERE id = ? AND (deleted_at IS NULL OR deleted_at = 0) LIMIT 1`
      ).bind(partnerIdOverride).first<{ id: string }>();
    } else if (tx.contragent_inn) {
      partner = await c.env.DB.prepare(`
        SELECT id FROM partners
        WHERE (tax_id = ? OR inn = ?) AND (deleted_at IS NULL OR deleted_at = 0)
        LIMIT 1
      `).bind(tx.contragent_inn, tx.contragent_inn).first<{ id: string }>();
    }

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
// GET /api/inbox/banking/:tx_id/auto-match
// Returns ranked partner suggestions for the AssignWizard (Step 1).
// Tiers (best first, deduped by partner_id):
//   1. bank_match_rules — INN exact, sorted by hit_count desc          (high)
//   2. partners.tax_id / partners.inn — INN exact                       (high)
//   3. partners.iban — IBAN exact (for non-Russian source like Wio)     (high)
//   4. findExistingPartnerByName — normalised fuzzy on contragent_name (medium)
//
// Returns up to 3 distinct partners with confidence + provenance.
// =============================================================================
inboxBanking.get('/:tx_id/auto-match', async (c) => {
  const txId = c.req.param('tx_id');

  const tx = await c.env.DB.prepare(`
    SELECT id, direction, amount, currency, executed_at,
           contragent_name, contragent_inn, contragent_account,
           payment_purpose, source_type
    FROM bank_transactions WHERE id = ?
  `).bind(txId).first<{
    id: string; direction: 'incoming' | 'outgoing';
    amount: number; currency: string; executed_at: number;
    contragent_name: string | null; contragent_inn: string | null;
    contragent_account: string | null; payment_purpose: string | null;
    source_type: string;
  }>();

  if (!tx) {
    return fail(c, 404, [{ code: 'tx_not_found', message: `bank_tx ${txId} not found` }]);
  }

  type Suggestion = {
    partner_id: string;
    trade_name: string;
    kind: string | null;
    confidence: 'high' | 'medium' | 'low';
    via: 'rule' | 'inn' | 'iban' | 'name';
    matched_field: string;
    hit_count?: number;
    rule_id?: string;
  };

  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const inn = (tx.contragent_inn || '').trim();

  // Tier 1 — bank_match_rules by INN, ordered by hit_count desc
  if (inn) {
    const rules = await c.env.DB.prepare(`
      SELECT bmr.id AS rule_id, bmr.partner_id, bmr.hit_count,
             p.trade_name, p.kind
      FROM bank_match_rules bmr
      JOIN partners p ON p.id = bmr.partner_id
      WHERE bmr.contragent_inn = ?
        AND (bmr.direction = ? OR bmr.direction = 'any')
        AND bmr.deleted_at IS NULL
        AND (p.deleted_at IS NULL OR p.deleted_at = 0)
      ORDER BY bmr.hit_count DESC, bmr.last_hit_at DESC
      LIMIT 5
    `).bind(inn, tx.direction).all<{
      rule_id: string; partner_id: string; hit_count: number;
      trade_name: string; kind: string | null;
    }>();
    for (const r of rules.results ?? []) {
      if (seen.has(r.partner_id)) continue;
      seen.add(r.partner_id);
      out.push({
        partner_id: r.partner_id,
        trade_name: r.trade_name,
        kind: r.kind,
        confidence: 'high',
        via: 'rule',
        matched_field: `ИНН ${inn} · ${r.hit_count} prior match${r.hit_count === 1 ? '' : 'es'}`,
        hit_count: r.hit_count,
        rule_id: r.rule_id,
      });
    }
  }

  // Tier 2 — partners by INN exact
  if (inn) {
    const byInn = await c.env.DB.prepare(`
      SELECT id, trade_name, kind
      FROM partners
      WHERE (tax_id = ? OR inn = ?)
        AND (deleted_at IS NULL OR deleted_at = 0)
      ORDER BY CASE WHEN crm_status='active' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 3
    `).bind(inn, inn).all<{ id: string; trade_name: string; kind: string | null }>();
    for (const p of byInn.results ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({
        partner_id: p.id,
        trade_name: p.trade_name,
        kind: p.kind,
        confidence: 'high',
        via: 'inn',
        matched_field: `ИНН ${inn}`,
      });
    }
  }

  // Tier 3 — partners by IBAN exact (for non-Russian transactions)
  const iban = (tx.contragent_account || '').trim();
  if (iban && iban.length >= 10) {
    const byIban = await c.env.DB.prepare(`
      SELECT id, trade_name, kind
      FROM partners
      WHERE iban = ?
        AND (deleted_at IS NULL OR deleted_at = 0)
      LIMIT 3
    `).bind(iban).all<{ id: string; trade_name: string; kind: string | null }>();
    for (const p of byIban.results ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({
        partner_id: p.id,
        trade_name: p.trade_name,
        kind: p.kind,
        confidence: 'high',
        via: 'iban',
        matched_field: `IBAN ${iban}`,
      });
    }
  }

  // Tier 4 — fuzzy partner name match
  const name = (tx.contragent_name || '').trim();
  if (name.length >= 3 && out.length < 3) {
    const fuzzy = await findExistingPartnerByName(c.env.DB, name);
    if (fuzzy && !seen.has(fuzzy.id)) {
      const p = await c.env.DB.prepare(
        `SELECT id, trade_name, kind FROM partners WHERE id = ?`
      ).bind(fuzzy.id).first<{ id: string; trade_name: string; kind: string | null }>();
      if (p) {
        seen.add(p.id);
        out.push({
          partner_id: p.id,
          trade_name: p.trade_name,
          kind: p.kind,
          confidence: 'medium',
          via: 'name',
          matched_field: `name match: ${name.slice(0, 40)}`,
        });
      }
    }
  }

  return ok(c, {
    tx: {
      id: tx.id,
      direction: tx.direction,
      amount_minor: tx.amount,
      amount: tx.amount / 100,
      currency: tx.currency,
      executed_at: tx.executed_at,
      contragent_name: tx.contragent_name,
      contragent_inn: tx.contragent_inn,
      contragent_account: tx.contragent_account,
      payment_purpose: tx.payment_purpose,
      source_type: tx.source_type,
    },
    suggestions: out.slice(0, 3),
  });
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
             matched_operation_id AS prev_op_id
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
      SET matched_operation_id = ?, match_method = 'manual',
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

    // Auto-remember partner ↔ INN binding so the same counterparty
    // is recognised instantly next time (auto-match Tier 1).
    try {
      const opPartner = await c.env.DB.prepare(
        `SELECT partner_id, operation_type FROM operations WHERE id = ?`
      ).bind(op.id).first<{ partner_id: string | null; operation_type: string }>();
      if (opPartner?.partner_id && tx.contragent_inn) {
        await recordPartnerInnRule(c.env.DB, {
          partnerId: opPartner.partner_id,
          inn: tx.contragent_inn,
          direction: tx.direction as 'incoming' | 'outgoing',
          operationType: opPartner.operation_type === 'sale' ? 'sale' : 'purchase',
          txId: tx.id,
        });
      }
    } catch (memErr) {
      console.error('[inbox-banking attach] rule-remember failed:', memErr);
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
      // Pre-check 1: reject bank-provider names (payment-routing artefact).
      if (await isBankProviderName(c.env.DB, body.trade_name)) {
        return fail(c, 422, [{
          code: 'trade_name_is_bank',
          message: `"${body.trade_name}" matches a registered bank provider. Banks belong in bank_providers, not partners.`,
        }]);
      }
      // Pre-check 2: dedup by name — reuse existing partner if found.
      const existing = await findExistingPartnerByName(c.env.DB, body.trade_name);
      if (existing) {
        partnerId = existing.id;
        partnerKind = existing.kind || body.kind;
      } else {
      // Brand new partner — readable id.
      const newId = await generateReadablePartnerId(c.env.DB, body.trade_name);
      const slug = newId;
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
      }
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

    // Generate reference — issuer-based for service, DEE-NNN for goods
    let reference: string;
    if (isService) {
      reference = await generateServiceReference(c.env.DB, {
        partnerId,
        operationDateSec: tx.executed_at,
        invoiceDocNumber: tx.external_doc_number || null,
      });
    } else {
      const yy = new Date(tx.executed_at * 1000).getFullYear() % 100;
      const prefix = `DEE-${String(yy).padStart(2, '0')}`;
      const cntRow = await c.env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM operations WHERE reference LIKE ?`
      ).bind(`${prefix}%`).first<{ cnt: number }>();
      const seq = ((cntRow?.cnt ?? 0) + 1).toString().padStart(4, '0');
      reference = `${prefix}${seq}`;
    }

    const opId = `op_${crypto.randomUUID()}`;
    const notes = isService
      ? `[SERVICE EXPENSE — closed via inbox] ${tx.contragent_name}. ${(tx.payment_purpose || '').slice(0, 400)}`
      : `[GOODS OPERATION — created via inbox] ${tx.contragent_name}. ${(tx.payment_purpose || '').slice(0, 400)}`;

    await c.env.DB.prepare(`
      INSERT INTO operations (
        id, operation_date, operation_type, partner_id,
        our_company_id, status, currency, total_amount,
        notes, reference, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'dee', 'issued', ?, ?, ?, ?, ?, ?)
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
      SET matched_operation_id = ?,
          match_method = 'manual',
          matched_at = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(
      opId,
      now, now, tx.id,
    ).run();

    // Auto-remember partner ↔ INN binding for next time.
    let sweepResult = { processed: 0, refs: [] as string[], errors: [] as string[] };
    try {
      if (tx.contragent_inn) {
        await recordPartnerInnRule(c.env.DB, {
          partnerId,
          inn: tx.contragent_inn,
          direction: tx.direction as 'incoming' | 'outgoing',
          operationType,
          txId: tx.id,
        });

        // Retroactive sweep: apply this newly-confirmed partner↔INN binding to
        // every other unmatched bank_tx with the same INN. Without this, manual
        // assign affects only one transaction even if 30 identical ones are
        // queued from the same counterparty.
        sweepResult = await sweepUnmatchedByInn(c.env.DB, {
          inn: tx.contragent_inn,
          partnerId,
          partnerKind,
          excludeTxId: tx.id,
          nowSec: now,
        });
      }
    } catch (memErr) {
      console.error('[inbox-banking assign-partner] rule-remember/sweep failed:', memErr);
    }

    return ok(c, {
      tx_id: tx.id,
      partner_id: partnerId,
      operation_id: opId,
      operation_ref: reference,
      classified_as: isService ? 'service_closed' : 'goods_draft',
      attachment_id: pmtId,
      retroactive_sweep: {
        processed: sweepResult.processed,
        operations_created: sweepResult.refs,
        errors: sweepResult.errors,
      },
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
// =============================================================================
// POST /api/inbox/banking/backfill-narration
//
// One-off / admin: re-runs the auto-matcher on bank_transactions where
// payment_purpose mentions a contract number ("CONTRACT 080824", "ДОГОВОР 080824")
// but no partner has been resolved yet. Used after enabling narration-based
// matching (2026-05-16). Safe to call multiple times — idempotent: only
// touches unmatched rows.
//
// Returns the list of references created/linked for audit.
// =============================================================================
inboxBanking.post('/backfill-narration', async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT id
      FROM bank_transactions
     WHERE matched_operation_id IS NULL
       AND matched_payment_id IS NULL
       AND (deleted_at IS NULL OR deleted_at = 0)
       AND (
         payment_purpose LIKE '%CONTRACT %'
         OR payment_purpose LIKE '%CONTRACT.%'
         OR payment_purpose LIKE '%CONTRACT:%'
         OR payment_purpose LIKE '%CONTRACT/%'
         OR payment_purpose LIKE '%ДОГОВОР %'
         OR payment_purpose LIKE '%ДОГОВОР№%'
       )
       AND (
         match_method IS NULL
         OR match_method IN (
           'bank_self_reference_skipped',
           'partner_not_found',
           'partner_not_found_service',
           'ambiguous'
         )
       )
     ORDER BY executed_at DESC
     LIMIT 500
  `).all<{ id: string }>();

  const summary = {
    checked: 0,
    matched: 0,
    auto_created: 0,
    partner_found_no_op: 0,
    still_unmatched: 0,
    errors: 0,
    details: [] as Array<{ tx_id: string; outcome: string; partner_id?: string | null; operation_id?: string | null }>,
  };

  for (const row of rows.results ?? []) {
    summary.checked += 1;
    try {
      const result = await autoMatchBankTransaction(c.env, row.id);
      summary.details.push({
        tx_id: row.id,
        outcome: result.outcome,
        partner_id: result.partner_id ?? null,
        operation_id: result.operation_id ?? null,
      });
      if (result.outcome === 'auto_matched' || result.outcome === 'rule_matched') {
        summary.matched += 1;
      } else if (result.outcome === 'partner_auto_created' || result.outcome === 'auto_created_draft') {
        summary.auto_created += 1;
      } else if (result.partner_id) {
        summary.partner_found_no_op += 1;
      } else {
        summary.still_unmatched += 1;
      }
    } catch (e) {
      summary.errors += 1;
      summary.details.push({
        tx_id: row.id,
        outcome: 'error: ' + (e instanceof Error ? e.message : String(e)),
      });
    }
  }

  return ok(c, summary);
});

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
