// =============================================================================
// /api/agent-settlements — triangle settlement CRUD + suggest endpoint
// =============================================================================
//
// Models the triangle settlement pattern (DEE pays agent A, agent B pays DEI,
// internal debt cleared). See db/migrations/0041_agent_settlements.sql for
// the full schema rationale.
//
// Endpoints:
//   GET    /api/agent-settlements                     — list with filters
//   GET    /api/agent-settlements/:id                 — single with all joined data
//   POST   /api/agent-settlements                     — create from picked bank_txs + op
//   PATCH  /api/agent-settlements/:id                 — update status/notes/missing legs
//   POST   /api/agent-settlements/:id/cancel          — soft-cancel
//   POST   /api/agent-settlements/suggest             — find candidate pairs from
//                                                       unsettled inbound + outbound
//                                                       bank_transactions
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail, fromError } from '../lib/responses';

const agentSettlements = new Hono<{ Bindings: Env }>();

// =============================================================================
// Helpers
// =============================================================================

function generateReference(date: Date): string {
  // AS-YYYY-NNNN style. The actual counter is derived at insert-time via a
  // count query so we don't need a sequences entry.
  const y = date.getUTCFullYear();
  return `AS-${y}-PENDING`; // filled in after count
}

async function nextReference(env: Env, year: number): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM agent_settlements
     WHERE reference LIKE ? AND deleted_at IS NULL`
  ).bind(`AS-${year}-%`).first<{ c: number }>();
  const n = ((row?.c ?? 0) + 1).toString().padStart(4, '0');
  return `AS-${year}-${n}`;
}

// =============================================================================
// GET /api/agent-settlements — list
// =============================================================================
agentSettlements.get('/', async (c) => {
  try {
    const status = c.req.query('status');
    const company = c.req.query('company_id');

    const where: string[] = ['s.deleted_at IS NULL'];
    const params: (string | number)[] = [];
    if (status) {
      where.push('s.status = ?');
      params.push(status);
    }
    if (company) {
      where.push('(s.outbound_company_id = ? OR s.inbound_company_id = ?)');
      params.push(company, company);
    }

    const rows = await c.env.DB.prepare(
      `SELECT
         s.id, s.reference, s.settlement_date, s.status, s.notes,
         s.outbound_amount, s.outbound_currency,
         s.inbound_amount,  s.inbound_currency,
         s.variance_amount, s.variance_currency, s.exchange_rate,
         s.clearance_operation_id,
         co.abbreviation AS outbound_company,
         ci.abbreviation AS inbound_company,
         po.trade_name AS outbound_agent_name,
         pi.trade_name AS inbound_agent_name,
         op.reference AS clearance_op_reference,
         s.outbound_bank_tx_id, s.inbound_bank_tx_id
       FROM agent_settlements s
       LEFT JOIN companies co ON co.id = s.outbound_company_id
       LEFT JOIN companies ci ON ci.id = s.inbound_company_id
       LEFT JOIN partners  po ON po.id = s.outbound_agent_partner_id
       LEFT JOIN partners  pi ON pi.id = s.inbound_agent_partner_id
       LEFT JOIN operations op ON op.id = s.clearance_operation_id
       WHERE ${where.join(' AND ')}
       ORDER BY s.settlement_date DESC, s.created_at DESC`
    ).bind(...params).all();

    return ok(c, { settlements: rows.results ?? [] });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// GET /api/agent-settlements/available-bank-txs?direction=outgoing|incoming
// Static path — MUST be declared before the parameterized /:id route below,
// because Hono matches routes in order and /:id would capture this path.
// Returns recent bank_transactions that look like agent payments (by contragent
// name pattern), useful for picking legs when creating a settlement manually.
// =============================================================================
agentSettlements.get('/available-bank-txs', async (c) => {
  try {
    const direction = c.req.query('direction');
    if (direction !== 'incoming' && direction !== 'outgoing') {
      return fail(c, 422, [{ code: 'invalid', message: 'direction must be incoming|outgoing' }]);
    }

    const patterns = ['%BRIGHT IDEAS%', '%CENTUNO%', '%Bright Ideas%', '%Centuno%'];
    const pipe = patterns.map(() => 'upper(bt.contragent_name) LIKE upper(?)').join(' OR ');

    const rows = await c.env.DB.prepare(
      `SELECT bt.id, bt.executed_at, bt.amount, bt.currency, bt.direction,
              bt.contragent_name, bt.payment_purpose, bt.matched_operation_id,
              cba.company_id, co.abbreviation AS company_abbr,
              bt.match_method
         FROM bank_transactions bt
         JOIN company_bank_accounts cba ON cba.id = bt.company_bank_account_id
         JOIN companies co ON co.id = cba.company_id
        WHERE bt.direction = ?
          AND (${pipe})
          AND bt.id NOT IN (
            SELECT ${direction === 'outgoing' ? 'outbound_bank_tx_id' : 'inbound_bank_tx_id'}
              FROM agent_settlements
             WHERE ${direction === 'outgoing' ? 'outbound_bank_tx_id' : 'inbound_bank_tx_id'} IS NOT NULL
               AND deleted_at IS NULL
          )
        ORDER BY bt.executed_at DESC
        LIMIT 60`
    ).bind(direction, ...patterns).all();

    return ok(c, { transactions: rows.results ?? [] });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// GET /api/agent-settlements/:id — single
// =============================================================================
agentSettlements.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      `SELECT s.*,
         co.abbreviation AS outbound_company,
         ci.abbreviation AS inbound_company,
         cc.abbreviation AS clearance_creditor_company,
         cd.abbreviation AS clearance_debtor_company,
         po.trade_name AS outbound_agent_name,
         pi.trade_name AS inbound_agent_name,
         op.reference AS clearance_op_reference,
         op.total_amount AS clearance_op_total,
         op.currency AS clearance_op_currency,
         op.status AS clearance_op_status,
         opp.trade_name AS clearance_op_partner_name,
         obt.payment_purpose AS outbound_purpose,
         obt.contragent_name AS outbound_contragent,
         obt.executed_at AS outbound_executed_at,
         ibt.payment_purpose AS inbound_purpose,
         ibt.contragent_name AS inbound_contragent,
         ibt.executed_at AS inbound_executed_at
       FROM agent_settlements s
       LEFT JOIN companies co  ON co.id = s.outbound_company_id
       LEFT JOIN companies ci  ON ci.id = s.inbound_company_id
       LEFT JOIN companies cc  ON cc.id = s.clearance_creditor_company_id
       LEFT JOIN companies cd  ON cd.id = s.clearance_debtor_company_id
       LEFT JOIN partners  po  ON po.id = s.outbound_agent_partner_id
       LEFT JOIN partners  pi  ON pi.id = s.inbound_agent_partner_id
       LEFT JOIN operations op ON op.id = s.clearance_operation_id
       LEFT JOIN partners opp  ON opp.id = op.partner_id
       LEFT JOIN bank_transactions obt ON obt.id = s.outbound_bank_tx_id
       LEFT JOIN bank_transactions ibt ON ibt.id = s.inbound_bank_tx_id
       WHERE s.id = ? AND s.deleted_at IS NULL`
    ).bind(id).first();

    if (!row) return fail(c, 404, [{ code: 'not_found', message: 'Settlement not found' }]);
    return ok(c, row);
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/agent-settlements — create
// =============================================================================
agentSettlements.post('/', async (c) => {
  try {
    const body = await c.req.json<{
      outbound_bank_tx_id?: string | null;
      inbound_bank_tx_id?: string | null;
      outbound_company_id: string;
      inbound_company_id: string;
      outbound_agent_partner_id: string;
      inbound_agent_partner_id: string;
      outbound_amount: number;
      outbound_currency: string;
      inbound_amount: number;
      inbound_currency: string;
      settlement_date?: string; // YYYY-MM-DD; defaults to today
      clearance_operation_id?: string | null;
      clearance_creditor_company_id?: string | null;
      clearance_debtor_company_id?: string | null;
      paper_invoice_document_id?: string | null;
      exchange_rate?: number | null;
      variance_amount?: number | null;
      variance_currency?: string | null;
      notes?: string | null;
    }>();

    // Validation
    const errors: { code: string; message: string }[] = [];
    if (!body.outbound_company_id) errors.push({ code: 'missing', message: 'outbound_company_id required' });
    if (!body.inbound_company_id) errors.push({ code: 'missing', message: 'inbound_company_id required' });
    if (!body.outbound_agent_partner_id) errors.push({ code: 'missing', message: 'outbound_agent_partner_id required' });
    if (!body.inbound_agent_partner_id) errors.push({ code: 'missing', message: 'inbound_agent_partner_id required' });
    if (!Number.isFinite(body.outbound_amount) || body.outbound_amount <= 0) errors.push({ code: 'invalid', message: 'outbound_amount must be positive' });
    if (!Number.isFinite(body.inbound_amount) || body.inbound_amount <= 0) errors.push({ code: 'invalid', message: 'inbound_amount must be positive' });
    if (!body.outbound_currency) errors.push({ code: 'missing', message: 'outbound_currency required' });
    if (!body.inbound_currency) errors.push({ code: 'missing', message: 'inbound_currency required' });
    if (errors.length) return fail(c, 422, errors);

    const now = Math.floor(Date.now() / 1000);
    const settleDate = body.settlement_date
      ? Math.floor(new Date(body.settlement_date + 'T12:00:00Z').getTime() / 1000)
      : now;
    const year = new Date(settleDate * 1000).getUTCFullYear();
    const reference = await nextReference(c.env, year);
    const id = `sett_${crypto.randomUUID()}`;

    const status =
      body.outbound_bank_tx_id && body.inbound_bank_tx_id
        ? 'settled'
        : 'pending_match';

    await c.env.DB.prepare(
      `INSERT INTO agent_settlements (
        id, reference, settlement_date,
        outbound_bank_tx_id, outbound_amount, outbound_currency,
        outbound_company_id, outbound_agent_partner_id,
        inbound_bank_tx_id, inbound_amount, inbound_currency,
        inbound_company_id, inbound_agent_partner_id,
        clearance_operation_id, clearance_creditor_company_id, clearance_debtor_company_id,
        paper_invoice_document_id,
        exchange_rate, variance_amount, variance_currency,
        status, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?,  ?, ?, ?,  ?, ?,  ?, ?, ?,  ?, ?,  ?, ?, ?,  ?,  ?, ?, ?,  ?, ?,  ?, ?)`
    ).bind(
      id, reference, settleDate,
      body.outbound_bank_tx_id ?? null, body.outbound_amount, body.outbound_currency,
      body.outbound_company_id, body.outbound_agent_partner_id,
      body.inbound_bank_tx_id ?? null, body.inbound_amount, body.inbound_currency,
      body.inbound_company_id, body.inbound_agent_partner_id,
      body.clearance_operation_id ?? null,
      body.clearance_creditor_company_id ?? null,
      body.clearance_debtor_company_id ?? null,
      body.paper_invoice_document_id ?? null,
      body.exchange_rate ?? null,
      body.variance_amount ?? null,
      body.variance_currency ?? null,
      status,
      body.notes ?? null,
      now, now
    ).run();

    return ok(c, { id, reference, status });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// PATCH /api/agent-settlements/:id — update fields
// =============================================================================
agentSettlements.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<Record<string, unknown>>();

    const allowed = [
      'outbound_bank_tx_id', 'inbound_bank_tx_id',
      'clearance_operation_id', 'clearance_creditor_company_id', 'clearance_debtor_company_id',
      'paper_invoice_document_id',
      'exchange_rate', 'variance_amount', 'variance_currency',
      'status', 'notes', 'settlement_date',
    ];
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const key of allowed) {
      if (key in body) {
        if (key === 'settlement_date' && typeof body[key] === 'string') {
          sets.push('settlement_date = ?');
          params.push(Math.floor(new Date((body[key] as string) + 'T12:00:00Z').getTime() / 1000));
        } else {
          sets.push(`${key} = ?`);
          params.push(body[key] as string | number | null);
        }
      }
    }
    if (sets.length === 0) return fail(c, 422, [{ code: 'no_fields', message: 'No fields to update' }]);

    const now = Math.floor(Date.now() / 1000);
    sets.push('updated_at = ?');
    params.push(now);
    params.push(id);

    const res = await c.env.DB.prepare(
      `UPDATE agent_settlements SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`
    ).bind(...params).run();

    if (res.meta.changes === 0) return fail(c, 404, [{ code: 'not_found', message: 'Settlement not found' }]);

    // Auto-promote to 'settled' if both legs present and status was pending_match
    await c.env.DB.prepare(
      `UPDATE agent_settlements
       SET status = 'settled', updated_at = ?
       WHERE id = ?
         AND status = 'pending_match'
         AND outbound_bank_tx_id IS NOT NULL
         AND inbound_bank_tx_id IS NOT NULL`
    ).bind(now, id).run();

    return ok(c, { id, updated: res.meta.changes });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/agent-settlements/:id/cancel — soft cancel
// =============================================================================
agentSettlements.post('/:id/cancel', async (c) => {
  try {
    const id = c.req.param('id');
    const now = Math.floor(Date.now() / 1000);
    const res = await c.env.DB.prepare(
      `UPDATE agent_settlements
       SET status = 'cancelled', updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`
    ).bind(now, id).run();
    if (res.meta.changes === 0) return fail(c, 404, [{ code: 'not_found', message: 'Settlement not found' }]);
    return ok(c, { id, status: 'cancelled' });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

// =============================================================================
// POST /api/agent-settlements/suggest — find candidate pairs
// Body: { window_days?: number, min_amount?: number }
// Returns: candidate pairs of (outbound_tx, inbound_tx) that fit triangle pattern
// =============================================================================
agentSettlements.post('/suggest', async (c) => {
  try {
    const body = await c.req.json<{ window_days?: number; min_amount?: number }>().catch(() => ({}));
    const windowDays = body.window_days ?? 60;
    const minAmount = body.min_amount ?? 5000;

    // Find OUTBOUND txs already pointing to bright_ideas-style agent partners
    // (heuristic: partner_subtype='agent' OR explicit list, but for v1 use partner_id)
    // PLUS unsettled (not already in agent_settlements)
    const agents = await c.env.DB.prepare(
      `SELECT id, trade_name FROM partners
       WHERE id IN ('bright_ideas','centuno')
         AND deleted_at IS NULL`
    ).all<{ id: string; trade_name: string }>();
    const agentIds = (agents.results ?? []).map(r => r.id);
    if (agentIds.length === 0) return ok(c, { suggestions: [] });

    const placeholders = agentIds.map(() => '?').join(',');

    // Outbound candidates: bank_tx direction=outgoing, matched to op with partner_id in agentIds,
    // NOT already in agent_settlements.outbound_bank_tx_id
    const outboundQuery = `
      SELECT bt.id AS bank_tx_id, bt.executed_at, bt.amount, bt.currency,
             bt.contragent_name, bt.payment_purpose,
             o.id AS op_id, o.reference AS op_reference, o.partner_id, p.trade_name AS partner_name,
             cba.company_id, c.abbreviation AS company_abbr
      FROM bank_transactions bt
      JOIN operations o ON o.id = bt.matched_operation_id
      JOIN partners p ON p.id = o.partner_id
      JOIN company_bank_accounts cba ON cba.id = bt.company_bank_account_id
      JOIN companies c ON c.id = cba.company_id
      WHERE bt.direction = 'outgoing'
        AND p.id IN (${placeholders})
        AND bt.amount >= ?
        AND bt.id NOT IN (
          SELECT outbound_bank_tx_id FROM agent_settlements
          WHERE outbound_bank_tx_id IS NOT NULL AND deleted_at IS NULL
        )
      ORDER BY bt.executed_at DESC
      LIMIT 50
    `;
    const outbound = await c.env.DB.prepare(outboundQuery)
      .bind(...agentIds, minAmount)
      .all<any>();

    // Inbound candidates: same partners, direction=incoming, NOT already in settlements
    const inboundQuery = `
      SELECT bt.id AS bank_tx_id, bt.executed_at, bt.amount, bt.currency,
             bt.contragent_name, bt.payment_purpose,
             o.id AS op_id, o.reference AS op_reference, o.partner_id, p.trade_name AS partner_name,
             cba.company_id, c.abbreviation AS company_abbr
      FROM bank_transactions bt
      JOIN operations o ON o.id = bt.matched_operation_id
      JOIN partners p ON p.id = o.partner_id
      JOIN company_bank_accounts cba ON cba.id = bt.company_bank_account_id
      JOIN companies c ON c.id = cba.company_id
      WHERE bt.direction = 'incoming'
        AND p.id IN (${placeholders})
        AND bt.amount >= ?
        AND bt.id NOT IN (
          SELECT inbound_bank_tx_id FROM agent_settlements
          WHERE inbound_bank_tx_id IS NOT NULL AND deleted_at IS NULL
        )
      ORDER BY bt.executed_at DESC
      LIMIT 50
    `;
    const inbound = await c.env.DB.prepare(inboundQuery)
      .bind(...agentIds, minAmount)
      .all<any>();

    // Pair them up: for each outbound, find inbound within window_days
    const windowSec = windowDays * 86400;
    const suggestions: any[] = [];
    for (const out of outbound.results ?? []) {
      for (const inb of inbound.results ?? []) {
        const dt = Math.abs(out.executed_at - inb.executed_at);
        if (dt > windowSec) continue;
        // Cross-currency comparison: assume CNY/USD ratio ~7.2 ±10%
        // For now just record both amounts and compute variance later
        const ratio = out.amount / inb.amount;
        const isCrossCcy = out.currency !== inb.currency;
        // Heuristic: outbound CNY vs inbound USD with ratio in [6.0, 8.0] OR same-currency within ±5%
        let plausible = false;
        if (isCrossCcy) {
          if ((out.currency === 'CNY' && inb.currency === 'USD' && ratio >= 6.0 && ratio <= 8.5) ||
              (out.currency === 'USD' && inb.currency === 'CNY' && ratio >= 0.12 && ratio <= 0.17)) {
            plausible = true;
          }
        } else if (Math.abs(out.amount - inb.amount) / Math.max(out.amount, inb.amount) <= 0.05) {
          plausible = true;
        }
        if (!plausible) continue;
        suggestions.push({
          outbound: out,
          inbound: inb,
          days_apart: Math.round(dt / 86400),
          implied_rate: isCrossCcy ? ratio : null,
        });
      }
    }
    // Sort by days_apart asc
    suggestions.sort((a, b) => a.days_apart - b.days_apart);

    return ok(c, {
      suggestions: suggestions.slice(0, 20),
      candidates: { outbound: outbound.results?.length ?? 0, inbound: inbound.results?.length ?? 0 },
    });
  } catch (err) {
    return fail(c, 500, [fromError(err)]);
  }
});

export default agentSettlements;
