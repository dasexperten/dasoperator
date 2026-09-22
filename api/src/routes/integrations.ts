// =============================================================================
// /api/integrations
//   GET  /health        — live watchdog snapshot (read-only)
//   POST /watchdog/run  — run the watchdog now (detect + safe-fix + escalate)
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { computeIntegrationHealth } from '../lib/integration-health';
import { runWatchdog } from '../lib/watchdog';

const route = new Hono<{ Bindings: Env }>();

route.get('/health', async (c) => {
  const report = await computeIntegrationHealth(c.env);
  return c.json({ success: true, result: report });
});

route.post('/watchdog/run', async (c) => {
  const r = await runWatchdog(c.env);
  return c.json({ success: true, result: r });
});

// GET /api/integrations/vn-einvoice — ERP-visible state of the dedicated
// SwiftHub -> EasyInvoice Worker. The Worker and this screen share D1; no
// provider credential is copied into the main ERP Worker.
route.get('/vn-einvoice', async (c) => {
  try {
    const [lastRun, states, lastDocument] = await Promise.all([
      c.env.DB.prepare(
        `SELECT started_at, finished_at, ok, rows, note, error
           FROM erp_cron_runs
          WHERE worker = 'erp-vn-einvoice'
          ORDER BY id DESC LIMIT 1`,
      ).first<{
        started_at: string | null;
        finished_at: string | null;
        ok: number | null;
        rows: number | null;
        note: string | null;
        error: string | null;
      }>(),
      c.env.DB.prepare(
        `SELECT state, COUNT(*) AS count
           FROM vn_einvoice_documents
          GROUP BY state ORDER BY state`,
      ).all<{ state: string; count: number }>(),
      c.env.DB.prepare(
        `SELECT source_order_id, action, state, invoice_no, provider_error_code,
                provider_message, updated_at
           FROM vn_einvoice_documents
          ORDER BY updated_at DESC LIMIT 1`,
      ).first(),
    ]);

    const counts = Object.fromEntries((states.results ?? []).map((row) => [row.state, row.count]));
    const blocked = (counts.blocked_config ?? 0) + (counts.manual_review ?? 0) + (counts.failed_terminal ?? 0);
    const runBlocked = /\bblocked\b/i.test(lastRun?.note ?? '');
    const status = !lastRun
      ? 'yellow'
      : lastRun.ok === 0 || runBlocked || blocked > 0
        ? 'red'
        : 'green';
    const message = !lastRun
      ? 'Waiting for first worker run'
      : lastRun.ok === 0
        ? 'Worker run failed'
        : runBlocked
          ? 'Provider setup incomplete'
          : blocked > 0
            ? `${blocked} invoice(s) need attention`
            : `${counts.issued ?? 0} archived · ${counts.received ?? 0} queued`;

    return c.json({
      success: true,
      result: {
        status,
        message,
        detail: lastRun?.note ?? null,
        last_run: lastRun,
        states: counts,
        last_document: lastDocument,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const migrationMissing = /no such table/i.test(detail);
    return c.json({
      success: true,
      result: {
        status: migrationMissing ? 'yellow' : 'red',
        message: migrationMissing ? 'Schema not applied yet' : 'Health probe failed',
        detail: detail.slice(0, 300),
        states: {},
        last_run: null,
        last_document: null,
      },
    });
  }
});

export default route;
