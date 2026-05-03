import { Hono } from 'hono';
import type { Env } from '../types';
import { ok } from '../lib/responses';
import { queryAll } from '../lib/db';

// =============================================================================
// GET /api/partners
// Returns all active partners with linked entity and price_type info
// =============================================================================

const partners = new Hono<{ Bindings: Env }>();

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
  const results = await queryAll(c.env.DB, sql);

  return ok(c, {
    count: results.length,
    partners: results,
  });
});

export default partners;
