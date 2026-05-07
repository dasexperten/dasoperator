import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const banksModulbank = new Hono<{ Bindings: Env }>();

// =============================================================================
// Modulbank webhook payload shape (per official docs)
// =============================================================================
const operationSchema = z.object({
  id: z.string(),
  companyId: z.string().optional(),
  status: z.string(),
  category: z.enum(['Debet', 'Credit']),
  contragentName: z.string().optional().default(''),
  contragentInn: z.string().optional().default(''),
  contragentKpp: z.string().optional().default(''),
  contragentBankAccountNumber: z.string().optional().default(''),
  contragentBankCorrAccount: z.string().optional().default(''),
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
  ibsoId: z.string().optional().default(''),
});

const webhookSchema = z.object({
  companyInn: z.string(),
  companyKpp: z.string().optional().default(''),
  operation: operationSchema,
  SHA1Hash: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

function isoToUnix(iso: string | undefined): number {
  if (!iso) return Math.floor(Date.now() / 1000);
  const parsed = Date.parse(iso);
  if (isNaN(parsed)) return Math.floor(Date.now() / 1000);
  return Math.floor(parsed / 1000);
}

// Modulbank currency codes are 3-letter but use RUR instead of ISO RUB.
function normaliseCurrency(code: string): string {
  if (code === 'RUR') return 'RUB';
  return code.toUpperCase();
}

// SHA-1 hex digest of a UTF-8 string (no external deps; uses SubtleCrypto in Workers).
async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  const bytes = new Uint8Array(hashBuffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// =============================================================================
// GET /api/banks/modulbank/webhook — health-check stub
// Modulbank may probe the webhook URL with GET to verify reachability before
// accepting it in LK. Real notifications arrive as POST.
// =============================================================================
banksModulbank.get('/webhook', (c) => {
  return c.text(
    'Modulbank webhook receiver. Send POST with JSON payload per Modulbank API spec.',
    200,
    { 'Content-Type': 'text/plain; charset=utf-8' },
  );
});

// =============================================================================
// POST /api/banks/modulbank/webhook — Modulbank pushes transaction notifications here
// =============================================================================
banksModulbank.post('/webhook', async (c) => {
  // Read raw body once so we can store it for audit + parse it.
  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return fail(c, 'invalid_body', 'Could not read request body', 400);
  }

  let parsed: z.infer<typeof webhookSchema>;
  try {
    const json = JSON.parse(rawBody);
    parsed = webhookSchema.parse(json);
  } catch (e) {
    // Modulbank retries failed webhooks — but we still want a clean 400 for bad shape.
    const msg = e instanceof Error ? e.message : 'parse error';
    return fail(c, 'invalid_payload', `Webhook payload invalid: ${msg}`, 400);
  }

  const op = parsed.operation;

  // -----------------------------------------------------------------------------
  // 1. Find the company_bank_account that matches this incoming webhook.
  //    Two-tier match:
  //    a) by external company_id (what we registered when we activated API)
  //    b) by company INN from the payload (for accounts not yet API-linked)
  // -----------------------------------------------------------------------------
  const accountRow = await c.env.DB.prepare(`
    SELECT cba.id, cba.account_number, cba.webhook_signature_prefix,
           cba.bank_provider_id, cba.api_enabled, cba.company_id,
           co.tax_id as company_tax_id
    FROM company_bank_accounts cba
    LEFT JOIN companies co ON cba.company_id = co.id
    WHERE cba.deleted_at IS NULL
      AND cba.bank_provider_id = 'bp_modulbank'
      AND cba.account_number = ?
    LIMIT 1
  `).bind(op.bankAccountNumber).first<{
    id: string;
    account_number: string;
    webhook_signature_prefix: string | null;
    bank_provider_id: string | null;
    api_enabled: number;
    company_id: string;
    company_tax_id: string | null;
  }>();

  if (!accountRow) {
    // We received a webhook for an account we don't track. Log and 200 — Modulbank
    // sees success and stops retrying. We still store nothing.
    return ok(c, { ignored: true, reason: 'account_not_registered', account_number: op.bankAccountNumber });
  }

  // -----------------------------------------------------------------------------
  // 2. Verify SHA1Hash signature.
  //    Algorithm (LK-token): sha1(<first 10 chars of token>&<operationId>) → hex
  //    We store the prefix on the account row, never the full token.
  // -----------------------------------------------------------------------------
  if (accountRow.webhook_signature_prefix) {
    const expected = await sha1Hex(`${accountRow.webhook_signature_prefix}&${op.id}`);
    if (expected.toLowerCase() !== parsed.SHA1Hash.toLowerCase()) {
      return fail(c, 'signature_mismatch', 'Webhook signature did not match', 401);
    }
  }
  // If no prefix configured yet (account exists but API not fully linked), accept
  // the webhook ungated — useful during initial setup.

  // -----------------------------------------------------------------------------
  // 3. Insert transaction (idempotent via UNIQUE(account_id, external_id)).
  // -----------------------------------------------------------------------------
  const direction = op.category === 'Debet' ? 'incoming' : 'outgoing';
  const currency = normaliseCurrency(op.currency);
  const amountMinor = Math.round(op.amount * 100); // store in minor units (kopeks)
  const executedAt = isoToUnix(op.executed);
  const createdAtBank = isoToUnix(op.created);
  const now = Math.floor(Date.now() / 1000);
  const txId = `btx_${crypto.randomUUID()}`;

  try {
    await c.env.DB.prepare(`
      INSERT INTO bank_transactions (
        id, company_bank_account_id,
        external_id, external_abs_id, external_doc_number,
        direction, status, amount, currency,
        executed_at, created_at_bank,
        contragent_name, contragent_inn, contragent_kpp,
        contragent_account, contragent_bank_name, contragent_bank_bic,
        payment_purpose,
        webhook_signature, raw_payload,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(company_bank_account_id, external_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
    `).bind(
      txId, accountRow.id,
      op.id, op.absId, op.docNumber,
      direction, op.status, amountMinor, currency,
      executedAt, createdAtBank,
      op.contragentName, op.contragentInn, op.contragentKpp,
      op.contragentBankAccountNumber, op.contragentBankName, op.contragentBankBic,
      op.paymentPurpose,
      parsed.SHA1Hash, rawBody,
      now, now,
    ).run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'db error';
    return fail(c, 'db_insert_failed', `Could not store transaction: ${msg}`, 500);
  }

  // -----------------------------------------------------------------------------
  // 4. Auto-match attempt — look for an unmatched payment whose reference appears
  //    in the payment purpose. Reference pattern in our system: DEE-007, DEI-001 etc.
  //    This is best-effort; if no match, the transaction stays unmatched and shows
  //    in the Reconciliation list for manual handling later.
  // -----------------------------------------------------------------------------
  // Note: matching logic itself we extend later. For now we just save the row.

  return ok(c, {
    received: true,
    transaction_id: txId,
    external_id: op.id,
    direction,
    amount: amountMinor,
    currency,
  });
});

// =============================================================================
// GET /api/banks/modulbank/transactions — list with optional filters
// =============================================================================
banksModulbank.get('/transactions', async (c) => {
  const accountId = c.req.query('account_id');
  const direction = c.req.query('direction'); // 'incoming' | 'outgoing'
  const matchedRaw = c.req.query('matched');  // 'true' | 'false'
  const limitRaw = c.req.query('limit');
  const limit = Math.min(Math.max(parseInt(limitRaw ?? '50', 10) || 50, 1), 200);

  let sql = `
    SELECT
      bt.id, bt.company_bank_account_id, bt.external_id, bt.external_doc_number,
      bt.direction, bt.status, bt.amount, bt.currency,
      bt.executed_at, bt.created_at_bank,
      bt.contragent_name, bt.contragent_inn, bt.contragent_account,
      bt.contragent_bank_name, bt.contragent_bank_bic,
      bt.payment_purpose,
      bt.matched_payment_id, bt.match_method, bt.matched_at,
      cba.account_number, cba.account_purpose,
      co.abbreviation as company_abbreviation, co.legal_name as company_legal_name
    FROM bank_transactions bt
    JOIN company_bank_accounts cba ON bt.company_bank_account_id = cba.id
    JOIN companies co ON cba.company_id = co.id
    WHERE bt.deleted_at IS NULL
  `;
  const binds: unknown[] = [];

  if (accountId) { sql += ` AND bt.company_bank_account_id = ?`; binds.push(accountId); }
  if (direction === 'incoming' || direction === 'outgoing') {
    sql += ` AND bt.direction = ?`; binds.push(direction);
  }
  if (matchedRaw === 'true')  sql += ` AND bt.matched_payment_id IS NOT NULL`;
  if (matchedRaw === 'false') sql += ` AND bt.matched_payment_id IS NULL`;

  sql += ` ORDER BY bt.executed_at DESC LIMIT ?`;
  binds.push(limit);

  const stmt = c.env.DB.prepare(sql);
  const result = await stmt.bind(...binds).all();

  return ok(c, {
    count: result.results.length,
    transactions: result.results,
  });
});

// =============================================================================
// GET /api/banks/modulbank/transactions/:id
// =============================================================================
banksModulbank.get('/transactions/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`
    SELECT bt.*, cba.account_number, cba.account_purpose,
           co.abbreviation as company_abbreviation, co.legal_name as company_legal_name
    FROM bank_transactions bt
    JOIN company_bank_accounts cba ON bt.company_bank_account_id = cba.id
    JOIN companies co ON cba.company_id = co.id
    WHERE bt.id = ? AND bt.deleted_at IS NULL
  `).bind(id).first();

  if (!row) return fail(c, 'not_found', `Transaction ${id} not found`, 404);
  return ok(c, { transaction: row });
});

// =============================================================================
// GET /api/banks/modulbank/accounts — list company bank accounts linked to Modulbank
// =============================================================================
banksModulbank.get('/accounts', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT
      cba.id, cba.company_id, cba.account_number, cba.account_purpose,
      cba.currency, cba.is_default, cba.bank_provider_id,
      cba.external_account_id, cba.external_company_id, cba.api_enabled,
      cba.last_sync_at,
      co.abbreviation as company_abbreviation, co.legal_name as company_legal_name,
      co.tax_id as company_tax_id
    FROM company_bank_accounts cba
    JOIN companies co ON cba.company_id = co.id
    WHERE cba.deleted_at IS NULL
      AND cba.bank_provider_id = 'bp_modulbank'
    ORDER BY co.abbreviation, cba.account_purpose
  `).all();

  return ok(c, {
    count: result.results.length,
    accounts: result.results,
  });
});

export default banksModulbank;
