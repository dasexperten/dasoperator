import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const partners = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET /api/partners — list all
// =============================================================================
partners.get('/', async (c) => {
  const sql = `
    SELECT
      p.id, p.trade_name, p.legal_name, p.country,
      p.tax_id, p.iban, p.swift_bic, p.bank_name,
      p.linked_entity_id, c.abbreviation as entity_abbreviation,
      p.price_type_id, pt.code as price_type_code,
      p.currency, p.contract_no, p.contract_date,
      p.email, p.status, p.partner_type, p.notes,
      p.created_at, p.updated_at
    FROM partners p
    LEFT JOIN companies c ON p.linked_entity_id = c.id
    LEFT JOIN price_types pt ON p.price_type_id = pt.id
    WHERE p.deleted_at IS NULL
    ORDER BY p.trade_name
  `;
  const results = await c.env.DB.prepare(sql).all();
  return ok(c, {
    count: results.results.length,
    partners: results.results,
  });
});

// =============================================================================
// GET /api/partners/:slug/contracts — all contracts for a partner
// =============================================================================
partners.get('/:slug/contracts', async (c) => {
  const slug = c.req.param('slug');

  const partner = await c.env.DB.prepare(
    'SELECT id FROM partners WHERE id = ? AND deleted_at IS NULL'
  ).bind(slug).first();

  if (!partner) {
    return fail(c, 404, [{
      code: 'partner_not_found',
      message: `Partner ${slug} not found`,
    }]);
  }

  const result = await c.env.DB.prepare(`
    SELECT
      c.id, c.contract_no, c.our_company_id,
      co.abbreviation as entity_abbreviation,
      c.currency, c.signed_date, c.expiry_date, c.status
    FROM contracts c
    LEFT JOIN companies co ON c.our_company_id = co.id
    WHERE c.partner_id = ? AND c.deleted_at IS NULL
    ORDER BY c.contract_no
  `).bind(slug).all();

  return ok(c, {
    partner_id: slug,
    count: result.results.length,
    contracts: result.results,
  });
});

export default partners;
