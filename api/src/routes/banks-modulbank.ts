import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { autoMatchBankTransaction } from '../lib/bank-auto-match';

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
// GET /api/banks/modulbank/health — webhook ingestion health
//
// Reports when the last bank_transaction was received (= last successful
// webhook) and a traffic-light status based on time elapsed:
//   green   — last seen ≤ 12h ago             (normal during business days)
//   yellow  — last seen 12h to 48h ago        (long weekend, holiday, or stall)
//   red     — last seen > 48h ago             (likely subscription dropped)
//   unknown — no transactions ever recorded
//
// Thresholds err on the side of forgiveness — Modulbank doesn't push on
// weekends. Friday EOB → Monday morning is naturally ~60h of silence.
// We still flag red after 48h because most working days have multiple txs.
// =============================================================================
banksModulbank.get('/health', async (c) => {
  const lastTx = await c.env.DB.prepare(
    `SELECT created_at, executed_at, contragent_name, currency, amount, direction
     FROM bank_transactions
     ORDER BY created_at DESC
     LIMIT 1`,
  ).first<{
    created_at: number;
    executed_at: number;
    contragent_name: string | null;
    currency: string;
    amount: number;
    direction: string;
  }>();

  const nowUnix = Math.floor(Date.now() / 1000);

  if (!lastTx) {
    return ok(c, {
      status: 'unknown',
      hours_since_last_webhook: null,
      last_webhook_at: null,
      last_transaction: null,
      message: 'No bank transactions ever received',
    });
  }

  const hoursSince = (nowUnix - lastTx.created_at) / 3600;

  let status: 'green' | 'yellow' | 'red';
  let message: string;
  if (hoursSince <= 12) {
    status = 'green';
    message = `Last webhook ${hoursSince.toFixed(1)}h ago — normal`;
  } else if (hoursSince <= 48) {
    status = 'yellow';
    message = `Last webhook ${hoursSince.toFixed(1)}h ago — possibly normal weekend gap, monitor`;
  } else {
    status = 'red';
    message = `Last webhook ${hoursSince.toFixed(1)}h ago — likely subscription dropped, check Modulbank LK`;
  }

  return ok(c, {
    status,
    hours_since_last_webhook: Math.round(hoursSince * 10) / 10,
    last_webhook_at: lastTx.created_at,
    last_transaction: {
      executed_at: lastTx.executed_at,
      direction: lastTx.direction,
      amount: lastTx.amount / 100,
      currency: lastTx.currency,
      contragent: lastTx.contragent_name,
    },
    thresholds: { green_hours: 12, yellow_hours: 48 },
    message,
  });
});

// =============================================================================
// GET /api/banks/modulbank/_diag — pull operations directly from Modulbank API
// Temporary diagnostic endpoint to compare what's in the bank vs what we received
// via webhook. Remove after webhook issue resolved.
// =============================================================================
banksModulbank.get('/_diag', async (c) => {
  const token = c.env.MODULBANK_TOKEN_DEE;
  if (!token) {
    return c.json({ error: 'MODULBANK_TOKEN_DEE not bound' }, 500);
  }

  // 1) Pull account list
  const accountsResp = await fetch('https://api.modulbank.ru/v1/account-info', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  const accountsText = await accountsResp.text();
  let accounts: any;
  try { accounts = JSON.parse(accountsText); } catch { accounts = accountsText; }

  if (!accountsResp.ok) {
    return c.json({
      step: 'list_accounts',
      status: accountsResp.status,
      body: accounts,
    }, 502);
  }

  // 2) For each company, take all bank accounts and pull operations since 2026-05-13
  const results: any[] = [];
  const companies = Array.isArray(accounts) ? accounts : [];

  for (const company of companies) {
    const bankAccounts = company.bankAccounts || [];
    for (const acct of bankAccounts) {
      const opsResp = await fetch(`https://api.modulbank.ru/v1/operation-history/${acct.id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: '2026-05-13',
          till: '2026-05-15',
          records: 50,
          skip: 0,
        }),
      });
      const opsText = await opsResp.text();
      let ops: any;
      try { ops = JSON.parse(opsText); } catch { ops = opsText; }
      results.push({
        company_name: company.companyName,
        company_inn: company.inn,
        account_id: acct.id,
        account_number: acct.number,
        account_category: acct.category,
        currency: acct.currency,
        balance: acct.balance,
        status_code: opsResp.status,
        ops_count: Array.isArray(ops) ? ops.length : null,
        ops_sample: Array.isArray(ops) ? ops.slice(0, 10).map((o: any) => ({
          id: o.id,
          docNumber: o.docNumber,
          category: o.category,
          status: o.status,
          executed: o.executed,
          created: o.created,
          amount: o.amount,
          currency: o.currency,
          contragentName: o.contragentName,
          paymentPurpose: (o.paymentPurpose || '').slice(0, 80),
        })) : ops,
      });
    }
  }

  return c.json({
    now_utc: new Date().toISOString(),
    accounts_total: companies.length,
    results,
  });
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
  // 4. Auto-match attempt — try to attach this bank_tx to an existing operation
  //    by INN + amount + date window. If no candidate, creates a draft operation
  //    automatically. If multiple candidates, creates an orphan attachment for
  //    the Inbox tab. Best-effort: never throws, webhook always returns 200.
  // -----------------------------------------------------------------------------
  let matchResult: Awaited<ReturnType<typeof autoMatchBankTransaction>> | null = null;
  try {
    matchResult = await autoMatchBankTransaction(c.env, txId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'match error';
    console.error(`[autoMatch] tx=${txId} failed: ${msg}`);
    // Swallow — tx is already stored, webhook must return 200.
  }

  return ok(c, {
    received: true,
    transaction_id: txId,
    external_id: op.id,
    direction,
    amount: amountMinor,
    currency,
    match: matchResult
      ? {
          outcome: matchResult.outcome,
          operation_id: matchResult.operation_id,
          attachment_ids: matchResult.attachment_ids,
        }
      : null,
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
// GET /api/banks/modulbank/accounts — list all bank accounts (Modulbank + Wio + future)
// Despite the route prefix, this endpoint returns accounts across ALL providers
// so the unified Bank Reference UI can show every entity. Bank-specific filtering
// happens client-side based on bank_provider_id / auth_method.
// =============================================================================
banksModulbank.get('/accounts', async (c) => {
  const result = await c.env.DB.prepare(`
    SELECT
      cba.id, cba.company_id, cba.account_number, cba.account_purpose,
      cba.currency, cba.is_default, cba.bank_provider_id,
      cba.external_account_id, cba.external_company_id, cba.api_enabled,
      cba.last_sync_at, cba.notes,
      co.abbreviation as company_abbreviation, co.legal_name as company_legal_name,
      co.tax_id as company_tax_id, co.kpp as company_kpp, co.ogrn as company_ogrn,
      co.registered_address as company_registered_address,
      bp.name as bank_name,
      bp.bank_legal_name, bp.bank_legal_name_ru,
      bp.bic as bank_bic, bp.swift as bank_swift,
      bp.correspondent_account as bank_correspondent_account,
      bp.country as bank_country,
      bp.auth_method as bank_auth_method
    FROM company_bank_accounts cba
    JOIN companies co ON cba.company_id = co.id
    LEFT JOIN bank_providers bp ON cba.bank_provider_id = bp.id
    WHERE cba.deleted_at IS NULL
      AND cba.bank_provider_id IS NOT NULL
    ORDER BY co.abbreviation, cba.account_purpose
  `).all();

  return ok(c, {
    count: result.results.length,
    accounts: result.results,
  });
});

// =============================================================================
// POST /api/banks/modulbank/sync-history
// Pulls historical operations from Modulbank for one or all linked accounts and
// stores them in bank_transactions. Idempotent — UNIQUE(account_id, external_id)
// prevents duplicates on re-run.
//
// Body (all optional):
//   account_id: string  — sync only this account; default: all api_enabled DEE accounts
//   from: string        — yyyy-MM-dd; default: 90 days ago
//   till: string        — yyyy-MM-dd; default: today
//   page_size: number   — Modulbank max 50; default: 50
//   max_pages: number   — safety cap; default: 50 (= up to 2500 ops per account)
//
// Response: per-account summary { account_id, fetched, inserted, updated, errors }.
// =============================================================================
const syncHistorySchema = z.object({
  account_id: z.string().optional(),
  from: z.string().optional(),
  till: z.string().optional(),
  page_size: z.number().int().min(1).max(50).optional(),
  max_pages: z.number().int().min(1).max(200).optional(),
});

banksModulbank.post('/sync-history', async (c) => {
  if (!c.env.MODULBANK_TOKEN_DEE) {
    return fail(c, 'no_token', 'MODULBANK_TOKEN_DEE secret not configured', 503);
  }

  let body: z.infer<typeof syncHistorySchema>;
  try {
    const json = await c.req.json().catch(() => ({}));
    body = syncHistorySchema.parse(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'parse error';
    return fail(c, 'invalid_body', `Invalid sync request: ${msg}`, 400);
  }

  const pageSize = body.page_size ?? 50;
  const maxPages = body.max_pages ?? 50;

  // Default date range: last 90 days
  const today = new Date();
  const ninetyDaysAgo = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
  const from = body.from ?? ninetyDaysAgo.toISOString().slice(0, 10);
  const till = body.till ?? today.toISOString().slice(0, 10);

  // Pick accounts to sync
  let accountsSql = `
    SELECT id, account_number, external_account_id, webhook_signature_prefix
    FROM company_bank_accounts
    WHERE deleted_at IS NULL
      AND bank_provider_id = 'bp_modulbank'
      AND api_enabled = 1
      AND external_account_id IS NOT NULL
  `;
  const accountsBinds: unknown[] = [];
  if (body.account_id) {
    accountsSql += ` AND id = ?`;
    accountsBinds.push(body.account_id);
  }

  const accountsResult = accountsBinds.length
    ? await c.env.DB.prepare(accountsSql).bind(...accountsBinds).all<{
        id: string; account_number: string; external_account_id: string;
        webhook_signature_prefix: string | null;
      }>()
    : await c.env.DB.prepare(accountsSql).all<{
        id: string; account_number: string; external_account_id: string;
        webhook_signature_prefix: string | null;
      }>();

  const accounts = accountsResult.results ?? [];
  if (accounts.length === 0) {
    return fail(c, 'no_accounts', 'No Modulbank-linked accounts found to sync', 404);
  }

  const summary: Array<{
    account_id: string;
    account_number: string;
    fetched: number;
    inserted: number;
    updated: number;
    pages: number;
    error?: string;
  }> = [];

  for (const acc of accounts) {
    let fetched = 0;
    let inserted = 0;
    let updated = 0;
    let pages = 0;
    let errorMsg: string | undefined;

    try {
      // Paginate through Modulbank operation history
      for (let page = 0; page < maxPages; page++) {
        const skip = page * pageSize;
        const url = `https://api.modulbank.ru/v1/operation-history/${acc.external_account_id}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${c.env.MODULBANK_TOKEN_DEE}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${from}T00:00:00`,
            till: `${till}T23:59:59`,
            skip,
            records: pageSize,
          }),
        });

        if (!resp.ok) {
          errorMsg = `Modulbank HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
          break;
        }

        const ops = await resp.json() as Array<z.infer<typeof operationSchema>>;
        if (!Array.isArray(ops) || ops.length === 0) break;

        pages++;
        fetched += ops.length;

        // Insert each operation. ON CONFLICT counts as update.
        for (const opRaw of ops) {
          let op: z.infer<typeof operationSchema>;
          try {
            op = operationSchema.parse(opRaw);
          } catch {
            continue; // skip malformed rows, keep going
          }

          const direction = op.category === 'Debet' ? 'incoming' : 'outgoing';
          const currency = normaliseCurrency(op.currency);
          const amountMinor = Math.round(op.amount * 100);
          const executedAt = isoToUnix(op.executed);
          const createdAtBank = isoToUnix(op.created);
          const now = Math.floor(Date.now() / 1000);
          const txId = `btx_${crypto.randomUUID()}`;

          const result = await c.env.DB.prepare(`
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
            txId, acc.id,
            op.id, op.absId, op.docNumber,
            direction, op.status, amountMinor, currency,
            executedAt, createdAtBank,
            op.contragentName, op.contragentInn, op.contragentKpp,
            op.contragentBankAccountNumber, op.contragentBankName, op.contragentBankBic,
            op.paymentPurpose,
            null, JSON.stringify(opRaw),
            now, now,
          ).run();

          // D1 reports `meta.changes`. If row was new it's 1 (insert), if it conflicted-updated also 1.
          // We can't easily distinguish; treat last_row_id presence as a hint.
          if (result.meta?.last_row_id && result.meta.last_row_id > 0) {
            inserted++;
          } else {
            updated++;
          }
        }

        // If page returned less than page_size, no more data.
        if (ops.length < pageSize) break;
      }

      // Update last_sync_at on the account row
      await c.env.DB.prepare(`
        UPDATE company_bank_accounts SET last_sync_at = ?, updated_at = ? WHERE id = ?
      `).bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), acc.id).run();
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
    }

    summary.push({
      account_id: acc.id,
      account_number: acc.account_number,
      fetched,
      inserted,
      updated,
      pages,
      ...(errorMsg ? { error: errorMsg } : {}),
    });
  }

  const totalFetched = summary.reduce((s, x) => s + x.fetched, 0);
  const totalInserted = summary.reduce((s, x) => s + x.inserted, 0);
  const totalUpdated = summary.reduce((s, x) => s + x.updated, 0);

  return ok(c, {
    range: { from, till },
    accounts_synced: summary.length,
    total_fetched: totalFetched,
    total_inserted: totalInserted,
    total_updated: totalUpdated,
    summary,
  });
});


// =============================================================================
// POST /api/banks/modulbank/rematch-unassigned
//   Re-runs the auto-match cascade on every bank_transaction without a
//   matched_payment_id. Useful after rules change or after a backfill of
//   transactions that bypassed the cascade (e.g. early Wio uploads).
//
// Body (optional):
//   { limit?: number }   default: 200
// =============================================================================
banksModulbank.post('/rematch-unassigned', async (c) => {
  let body: { limit?: number } = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }
  const limit = Math.min(500, Math.max(1, body.limit ?? 200));

  try {
    const rows = await c.env.DB.prepare(
      `SELECT id FROM bank_transactions
        WHERE matched_payment_id IS NULL
          AND (deleted_at IS NULL OR deleted_at = 0)
        ORDER BY executed_at DESC
        LIMIT ?`
    ).bind(limit).all<{ id: string }>();

    const ids = (rows.results ?? []).map((r) => r.id);
    let succeeded = 0, failed = 0, matched = 0;
    const errors: Array<{ tx_id: string; message: string }> = [];

    for (const txId of ids) {
      try {
        const result = await autoMatchBankTransaction(c.env, txId);
        succeeded++;
        if (result && (result as any).operation_id) matched++;
      } catch (e) {
        failed++;
        errors.push({ tx_id: txId, message: e instanceof Error ? e.message : String(e) });
      }
    }

    return ok(c, {
      processed: ids.length,
      succeeded,
      failed,
      matched_operations: matched,
      errors: errors.slice(0, 10),
    });
  } catch (err) {
    return fail(c, 500, [{ code: 'rematch_error', message: err instanceof Error ? err.message : String(err) }]);
  }
});

export default banksModulbank;
