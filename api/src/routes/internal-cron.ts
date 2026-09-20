// =============================================================================
// POST /internal/cron/:worker — an erp-* timer worker starts its one ERP job.
//
// Jobs whose keys live only on this Worker keep running here, on those keys;
// the timer, the name and the run log belong to the erp-* worker. The door
// sits outside /api (no user session exists on a timer) and opens only with
// ERP_RUN_SECRET, only for the model-free jobs listed below.
// =============================================================================

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { handleScheduled } from '../scheduled';
import { STEPS } from '../cron-steps';

const MOVED: Record<string, string> = {
  'erp-skladbot-sync': '30 */6 * * *',
  'erp-modulbank-sync': '0 4,13 * * *',
  'erp-daily-digest': '0 3 * * *',
  'erp-pulse-warm': '0 1 * * *',
  'erp-web-analytics': '30 2 * * *',
  'erp-wb-weekly-report': '0 4 * * 4',
  'erp-ozon-monthly-report': '0 3 5 * *',
  'erp-site-sales-rebuild': '0 4 1-7 * 3',
  'erp-site-orders': '7 * * * *',
  'erp-auto-delivery': '0 */4 * * *',
  'erp-watchdog': '*/10 * * * *',
  'erp-orders-drop-watch': '0 4 * * *',
  'erp-mail-retention': '0 3 1 * *',
  'erp-ozon-ads-reports': '5 */6 * * *',
};

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const route = new Hono<{ Bindings: Env }>();

const modulbankOperationSchema = z.object({
  id: z.string(),
  status: z.string(),
  category: z.enum(['Debet', 'Credit']),
  contragentName: z.string().optional().default(''),
  contragentInn: z.string().optional().default(''),
  contragentKpp: z.string().optional().default(''),
  contragentBankAccountNumber: z.string().optional().default(''),
  contragentBankName: z.string().optional().default(''),
  contragentBankBic: z.string().optional().default(''),
  currency: z.string(),
  amount: z.number(),
  bankAccountNumber: z.string(),
  paymentPurpose: z.string().optional().default(''),
  executed: z.string().optional(),
  created: z.string().optional(),
  docNumber: z.string().optional().default(''),
  absId: z.string().optional().default(''),
});

function authorized(c: { env: Env; req: { header(name: string): string | undefined } }): boolean {
  const secret = (c.env as unknown as { ERP_RUN_SECRET?: string }).ERP_RUN_SECRET ?? '';
  const given = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '');
  return Boolean(secret && sameSecret(given, secret));
}

// The dedicated erp-modulbank-sync timer owns the outbound bank connection.
// These service-binding-only doors expose the minimum account cursor and accept
// validated bank operations; neither route is mounted below /api.
route.get('/modulbank/accounts', async (c) => {
  if (!authorized(c)) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const rows = await c.env.DB.prepare(`
    SELECT cba.id, cba.account_number, cba.external_account_id,
           MAX(bt.executed_at) AS last_transaction_at
    FROM company_bank_accounts cba
    LEFT JOIN bank_transactions bt ON bt.company_bank_account_id = cba.id
    WHERE cba.deleted_at IS NULL
      AND cba.bank_provider_id = 'bp_modulbank'
      AND cba.api_enabled = 1
      AND cba.external_account_id IS NOT NULL
    GROUP BY cba.id, cba.account_number, cba.external_account_id
    ORDER BY cba.id
  `).all();
  return c.json({ ok: true, accounts: rows.results });
});

route.post('/modulbank/import', async (c) => {
  if (!authorized(c)) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const input = z.object({
    account_id: z.string(),
    operations: z.array(modulbankOperationSchema).max(50),
  }).parse(await c.req.json());
  const account = await c.env.DB.prepare(`
    SELECT id, account_number FROM company_bank_accounts
    WHERE id = ? AND deleted_at IS NULL AND bank_provider_id = 'bp_modulbank'
      AND api_enabled = 1
  `).bind(input.account_id).first<{ id: string; account_number: string }>();
  if (!account) return c.json({ ok: false, error: 'account_not_found' }, 404);

  let stored = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const op of input.operations) {
    if (op.bankAccountNumber !== account.account_number) {
      return c.json({ ok: false, error: 'account_mismatch' }, 400);
    }
    const executedAt = op.executed && Number.isFinite(Date.parse(op.executed))
      ? Math.floor(Date.parse(op.executed) / 1000) : now;
    const createdAtBank = op.created && Number.isFinite(Date.parse(op.created))
      ? Math.floor(Date.parse(op.created) / 1000) : now;
    await c.env.DB.prepare(`
      INSERT INTO bank_transactions (
        id, company_bank_account_id, external_id, external_abs_id, external_doc_number,
        direction, status, amount, currency, executed_at, created_at_bank,
        contragent_name, contragent_inn, contragent_kpp, contragent_account,
        contragent_bank_name, contragent_bank_bic, payment_purpose,
        webhook_signature, raw_payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_bank_account_id, external_id) DO UPDATE SET
        status = excluded.status, updated_at = excluded.updated_at
    `).bind(
      `btx_${crypto.randomUUID()}`, account.id, op.id, op.absId, op.docNumber,
      op.category === 'Debet' ? 'incoming' : 'outgoing', op.status,
      Math.round(op.amount * 100), op.currency === 'RUR' ? 'RUB' : op.currency.toUpperCase(),
      executedAt, createdAtBank, op.contragentName, op.contragentInn, op.contragentKpp,
      op.contragentBankAccountNumber, op.contragentBankName, op.contragentBankBic,
      op.paymentPurpose, null, JSON.stringify(op), now, now,
    ).run();
    stored++;
  }
  await c.env.DB.prepare(`
    UPDATE company_bank_accounts SET last_sync_at = ?, updated_at = ? WHERE id = ?
  `).bind(now, now, account.id).run();
  await c.env.CACHE.delete('modulbank:health');
  return c.json({ ok: true, stored });
});

route.post('/:worker', async (c) => {
  if (!authorized(c)) return c.json({ ok: false, error: 'unauthorized' }, 401);

  const worker = c.req.param('worker');
  const started = Date.now();
  // erp-inventory hands over one letter (JSON body) instead of starting a timer job.
  if (worker === 'erp-inventory') {
    try {
      const { receiveInventoryMail } = await import('../lib/inventory-mail');
      const r = await receiveInventoryMail(c.env, await c.req.json());
      return c.json({ ok: r.status !== 'failed', cron: 'mail', note: `${r.status}: ${r.note}`, ms: Date.now() - started });
    } catch (e) {
      return c.json({ ok: false, cron: 'mail', error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
  const step = STEPS[worker];
  if (step) {
    try {
      const note = await step(c.env);
      return c.json({ ok: true, cron: 'step', note, ms: Date.now() - started });
    } catch (e) {
      return c.json({ ok: false, cron: 'step', error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }
  const cron = MOVED[worker];
  if (!cron) return c.json({ ok: false, error: `no ERP job for ${worker}` }, 404);

  const event = { cron, scheduledTime: started, type: 'scheduled', noRetry() {} } as unknown as ScheduledEvent;
  try {
    await handleScheduled(event, c.env, c.executionCtx as ExecutionContext);
    return c.json({ ok: true, cron, ms: Date.now() - started });
  } catch (e) {
    return c.json({ ok: false, cron, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

export default route;
