// =============================================================================
// Admin migrations — temporary endpoints for one-shot schema changes that
// can't be applied through D1 REST (which runs each statement in its own tx
// and blocks DROP/ALTER on tables with FK references).
//
// These endpoints are protected by a simple shared secret in the Authorization
// header. Each endpoint is idempotent and self-checking — running twice is safe.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const admin = new Hono<{ Bindings: Env }>();

// Shared secret — matches one of the CF tokens since they're project-wide
// and already in our trust boundary. Not a security boundary, just a guard
// against accidental hits.
const ADMIN_SECRET = 'das-admin-2026-migrations';

admin.use('*', async (c, next) => {
  const auth = c.req.header('Authorization');
  if (auth !== `Bearer ${ADMIN_SECRET}`) {
    return fail(c, 403, [{ code: 'forbidden', message: 'admin secret required' }]);
  }
  await next();
  return;
});

// ---------------------------------------------------------------------------
// POST /admin/migrate/partners-status
// Recreates partners table with new CHECK (lead/potential/active/sleeping).
// Maps existing values: pending→potential, inactive/blocked→sleeping,
// active→active, anything else→lead.
// Idempotent — checks if migration already applied by inspecting CHECK.
// ---------------------------------------------------------------------------
admin.post('/migrate/partners-status', async (c) => {
  // Check if already migrated
  const schema = await c.env.DB.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='partners'`
  ).first<{ sql: string }>();

  if (schema?.sql.includes("'lead'")) {
    return ok(c, { skipped: true, reason: 'already migrated' });
  }

  // Run the recreate as a single batch — D1 batch runs all statements in a
  // single implicit transaction with FK deferrals working correctly.
  const stmts = [
    c.env.DB.prepare('DROP TABLE IF EXISTS partners_new'),
    c.env.DB.prepare(`CREATE TABLE partners_new (
      id TEXT PRIMARY KEY,
      trade_name TEXT NOT NULL,
      legal_name TEXT,
      country TEXT,
      tax_id TEXT,
      iban TEXT,
      swift_bic TEXT,
      bank_name TEXT,
      linked_entity_id TEXT,
      price_type_id TEXT,
      currency TEXT,
      contract_no TEXT,
      contract_date INTEGER,
      email TEXT,
      status TEXT NOT NULL CHECK (status IN ('lead', 'potential', 'active', 'sleeping')),
      partner_type TEXT NOT NULL CHECK (partner_type IN ('buyer', 'supplier', 'shipper', 'other')),
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      legal_name_local TEXT,
      registered_address_local TEXT,
      kpp TEXT,
      inn TEXT,
      ogrn TEXT,
      payment_terms TEXT,
      preferred_incoterms TEXT,
      preferred_invoice_language TEXT CHECK (preferred_invoice_language IS NULL OR preferred_invoice_language IN ('EN', 'RU', 'BILINGUAL')),
      last_verified INTEGER
    )`),
    c.env.DB.prepare(`INSERT INTO partners_new
      SELECT
        id, trade_name, legal_name, country, tax_id, iban, swift_bic, bank_name,
        linked_entity_id, price_type_id, currency, contract_no, contract_date, email,
        CASE status
          WHEN 'pending' THEN 'potential'
          WHEN 'inactive' THEN 'sleeping'
          WHEN 'blocked' THEN 'sleeping'
          WHEN 'active' THEN 'active'
          ELSE 'lead'
        END,
        partner_type, notes, created_at, updated_at, deleted_at,
        legal_name_local, registered_address_local, kpp, inn, ogrn, payment_terms,
        preferred_incoterms, preferred_invoice_language, last_verified
      FROM partners`),
    c.env.DB.prepare('DROP TABLE partners'),
    c.env.DB.prepare('ALTER TABLE partners_new RENAME TO partners'),
  ];

  try {
    await c.env.DB.batch(stmts);
    const after = await c.env.DB.prepare('SELECT id, status FROM partners WHERE deleted_at IS NULL').all();
    return ok(c, { applied: true, partners: after.results });
  } catch (err) {
    return fail(c, 500, [{
      code: 'migration_failed',
      message: 'Could not apply partners status migration',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/migrate/partner-agreements
// Creates partner_agreements table for NDA/MOU/LOI/Contract tracking.
// Trigger for status auto-promotion (Lead → Potential on first signed agreement).
// ---------------------------------------------------------------------------
admin.post('/migrate/partner-agreements', async (c) => {
  // Check existence
  const exists = await c.env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='partner_agreements'`
  ).first();

  if (exists) {
    return ok(c, { skipped: true, reason: 'already exists' });
  }

  await c.env.DB.prepare(`CREATE TABLE partner_agreements (
    id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    agreement_type TEXT NOT NULL CHECK (agreement_type IN ('nda', 'mou', 'loi', 'contract', 'amendment', 'other')),
    title TEXT,
    signed_date INTEGER,
    expiry_date INTEGER,
    file_r2_key TEXT,
    status TEXT NOT NULL DEFAULT 'signed' CHECK (status IN ('draft', 'signed', 'expired', 'cancelled')),
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`).run();

  await c.env.DB.prepare(
    `CREATE INDEX idx_partner_agreements_partner ON partner_agreements(partner_id, status, deleted_at)`
  ).run();

  return ok(c, { applied: true, table: 'partner_agreements created' });
});

export default admin;
