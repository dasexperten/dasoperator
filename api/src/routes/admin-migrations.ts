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
// POST /admin/migrate/partner-agreements — DEPRECATED (migration 0025)
// All NDA/MOU/LOI/other documents now live in `contracts` with
// agreement_type IN ('nda','mou','loi','other').
// This endpoint is kept as a no-op to prevent accidental recreation
// of the obsolete partner_agreements table.
// ---------------------------------------------------------------------------
admin.post('/migrate/partner-agreements', async (c) => {
  return ok(c, {
    skipped: true,
    reason: 'partner_agreements deprecated — agreements now live in contracts (migration 0025)',
  });
});


// ---------------------------------------------------------------------------
// POST /admin/run-perf-create
// Manually trigger the Performance API report-creation cron handler.
// Useful after deploys to verify the v3 product/list path works without
// waiting for the next "5 */6 * * *" tick.
// ---------------------------------------------------------------------------
admin.post('/run-perf-create', async (c) => {
  const env = c.env;
  if (!env.OZON_PERF_CLIENT_ID || !env.OZON_PERF_CLIENT_SECRET) {
    return fail(c, 500, [{ code: 'no_creds', message: 'Performance API credentials missing' }]);
  }

  try {
    // Step 1: get token
    const tokenResp = await fetch('https://api-performance.ozon.ru/api/client/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.OZON_PERF_CLIENT_ID,
        client_secret: env.OZON_PERF_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    });
    if (!tokenResp.ok) {
      return fail(c, 500, [{ code: 'token_fail', message: `token HTTP ${tokenResp.status}` }]);
    }
    const tokenData = await tokenResp.json<{ access_token: string }>();
    const token = tokenData.access_token;

    // Step 2: Probe v3 product/list (this is what was failing before fix)
    const probeResp = await fetch('https://api-seller.ozon.ru/v3/product/list', {
      method: 'POST',
      headers: {
        'Client-Id': '374116',
        'Api-Key': '4ac8181b-4cd8-4b4a-964d-905e39cc9b42',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filter: { visibility: 'ALL' }, last_id: '', limit: 1000 }),
    });
    const probeStatus = probeResp.status;
    const probeData: any = probeResp.ok ? await probeResp.json() : null;
    const skuCount = probeData?.result?.items?.length ?? 0;

    // Step 3: Get campaigns
    const campResp = await fetch('https://api-performance.ozon.ru/api/client/campaign', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!campResp.ok) {
      return fail(c, 500, [{ code: 'camp_fail', message: `campaigns HTTP ${campResp.status}` }]);
    }
    const campData = await campResp.json<{ list: any[] }>();
    const skuTypes = new Set(['SKU', 'SEARCH_PROMO', 'BRAND_SHELF', 'ACTION']);
    const campaigns = (campData.list || [])
      .filter((cmp) => cmp.state === 'CAMPAIGN_STATE_RUNNING' && skuTypes.has(cmp.advObjectType))
      .map((cmp) => cmp.id);

    // Step 4: Create report
    const today = new Date();
    const dateTo = today.toISOString().split('T')[0];
    const from = new Date(today.getTime() - 7 * 24 * 3600_000);
    const dateFrom = from.toISOString().split('T')[0];

    const createResp = await fetch('https://api-performance.ozon.ru/api/client/statistics/json', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaigns, dateFrom, dateTo, groupBy: 'NO_GROUP_BY' }),
    });

    let reportUuid: string | null = null;
    if (createResp.ok) {
      const createData = await createResp.json<{ UUID: string }>();
      reportUuid = createData.UUID;
      if (reportUuid) {
        await env.DB.prepare(
          'INSERT INTO perf_reports (uuid, created_at, status) VALUES (?, ?, ?)'
        ).bind(reportUuid, Math.floor(Date.now() / 1000), 'pending').run();
      }
    }

    return ok(c, {
      probe_v3_status: probeStatus,
      probe_v3_sku_count: skuCount,
      campaigns_total: campData.list?.length ?? 0,
      campaigns_running_sku: campaigns.length,
      report_create_status: createResp.status,
      report_uuid: reportUuid,
      next_step: reportUuid
        ? 'Wait 5-30 min, then GET /admin/check-perf or wait for */2 * * * * poll cron'
        : 'Report not created — check logs',
    });
  } catch (e: any) {
    return fail(c, 500, [{ code: 'exception', message: e?.message || String(e) }]);
  }
});

export default admin;
