// =============================================================================
// Bank statement parser — extract transactions from CSV/XLSX/PDF
// =============================================================================
//
// Used by:
//   1. /api/bank-statements/upload         — manual upload from /finance UI
//   2. runBankStatementIngestion (cron)    — auto-fetch from bank_statement_sources
//
// Pipeline:
//   1. Read file bytes (CSV/XLSX → text, PDF → DeepSeek vision/text)
//   2. Send to DeepSeek with a strict extraction prompt
//   3. Validate & insert into bank_transactions
//      Idempotent via UNIQUE (company_bank_account_id, external_id)
//
// =============================================================================

import type { Env } from '../types';

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';

const EXTRACTION_PROMPT = `You are a bank statement parser. Extract every transaction into JSON.
Source may be a multi-line statement OR a single payment confirmation (e.g. Wio Transfer copy, Swift copy, payment advice) — in that case the result has exactly one transaction.

Output ONLY valid JSON, no prose, no markdown fences:
{
  "account_number": string | null,
  "currency": "RUB" | "USD" | "EUR" | "AED" | "CNY" | "VND" | "AMD" | "GBP",
  "period_from": "YYYY-MM-DD" | null,
  "period_to": "YYYY-MM-DD" | null,
  "transactions": [
    {
      "executed_at": "YYYY-MM-DD",
      "direction": "incoming" | "outgoing",
      "amount": number,
      "currency": string,
      "contragent_name": string | null,
      "contragent_inn": string | null,
      "contragent_account": string | null,
      "contragent_bank_name": string | null,
      "contragent_bank_bic": string | null,
      "payment_purpose": string | null,
      "external_doc_number": string | null,
      "external_id": string
    }
  ]
}

Rules:
- amount in minor units (RUB kopecks = ×100). For VND, JPY, KRW use whole units (×1).
- direction "incoming" = money received (credit). "outgoing" = money sent (debit).
- external_id MUST be unique within the file (use docNumber, transaction id, or hash of date+amount+name+purpose).
- payment_purpose: full text "Назначение платежа" or "Description" field.
- For VTB/Sberbank/Modulbank CSV: detect "Дебет"/"Кредит", "Сумма списания"/"Сумма зачисления".
- For UAE/international: detect IBAN, SWIFT, debit/credit, balance columns.
- Skip header/footer/balance lines — only real transaction rows.
- If currency mixed in file, set top-level currency to null and per-tx currency.`;

export interface ParsedTx {
  executed_at: string;
  direction: 'incoming' | 'outgoing';
  amount: number;
  currency: string;
  contragent_name: string | null;
  contragent_inn: string | null;
  contragent_account: string | null;
  contragent_bank_name: string | null;
  contragent_bank_bic: string | null;
  payment_purpose: string | null;
  external_doc_number: string | null;
  external_id: string;
}

export interface ParsedStatement {
  account_number: string | null;
  currency: string | null;
  period_from: string | null;
  period_to: string | null;
  transactions: ParsedTx[];
}

// =============================================================================
// Parse statement — sends text content to DeepSeek
// =============================================================================
export async function parseStatement(
  env: Env,
  fileText: string,
  filename: string
): Promise<ParsedStatement> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY not configured');
  }

  // Trim very long inputs to ~80KB (DeepSeek-v3 context fits comfortably)
  const trimmed = fileText.length > 80_000 ? fileText.slice(0, 80_000) : fileText;

  const resp = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: `Filename: ${filename}\n\nContents:\n${trimmed}` },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DeepSeek HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const data = await resp.json<{ choices: Array<{ message: { content: string } }> }>();
  const content = data.choices?.[0]?.message?.content ?? '{}';

  try {
    const parsed = JSON.parse(content) as ParsedStatement;
    parsed.transactions = parsed.transactions ?? [];
    return parsed;
  } catch (e) {
    throw new Error(`DeepSeek returned invalid JSON: ${content.slice(0, 200)}`);
  }
}

// =============================================================================
// Insert parsed transactions into bank_transactions table
// =============================================================================
export interface InsertSummary {
  total: number;
  inserted: number;
  skipped: number;
  errors: number;
  account_id: string | null;
  account_match_method: 'exact' | 'currency_only' | 'none';
}

export async function insertTransactions(
  env: Env,
  parsed: ParsedStatement,
  options: { company_id?: string }
): Promise<InsertSummary> {
  const summary: InsertSummary = {
    total: parsed.transactions.length,
    inserted: 0,
    skipped: 0,
    errors: 0,
    account_id: null,
    account_match_method: 'none',
  };

  if (parsed.transactions.length === 0) return summary;

  // Find matching company_bank_account
  const accountId = await findMatchingAccount(env, parsed, options.company_id);
  if (!accountId) {
    summary.errors = parsed.transactions.length;
    summary.account_match_method = 'none';
    return summary;
  }

  summary.account_id = accountId.id;
  summary.account_match_method = accountId.method;

  const now = Math.floor(Date.now() / 1000);

  for (const tx of parsed.transactions) {
    try {
      const txId = `bt_${crypto.randomUUID()}`;
      const executedAt = Math.floor(new Date(tx.executed_at + 'T12:00:00Z').getTime() / 1000);

      // Insert with INSERT OR IGNORE — UNIQUE constraint handles dedup
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO bank_transactions
           (id, company_bank_account_id, external_id, external_doc_number,
            direction, status, amount, currency,
            executed_at, created_at_bank,
            contragent_name, contragent_inn, contragent_account,
            contragent_bank_name, contragent_bank_bic,
            payment_purpose, raw_payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        txId,
        accountId.id,
        tx.external_id,
        tx.external_doc_number ?? null,
        tx.direction,
        tx.direction === 'incoming' ? 'Received' : 'Executed',
        tx.amount,
        tx.currency,
        executedAt,
        executedAt,
        tx.contragent_name ?? null,
        tx.contragent_inn ?? null,
        tx.contragent_account ?? null,
        tx.contragent_bank_name ?? null,
        tx.contragent_bank_bic ?? null,
        tx.payment_purpose ?? null,
        JSON.stringify(tx),
        now,
        now
      ).run();

      if (result.meta.changes > 0) {
        summary.inserted++;
      } else {
        summary.skipped++;
      }
    } catch (e) {
      console.error('[bank-statement-parser] insert error:', e);
      summary.errors++;
    }
  }

  return summary;
}

// =============================================================================
// Match statement account_number → company_bank_accounts row
// =============================================================================
async function findMatchingAccount(
  env: Env,
  parsed: ParsedStatement,
  companyId: string | undefined
): Promise<{ id: string; method: 'exact' | 'currency_only' } | null> {
  // Strategy 1: exact account_number match
  if (parsed.account_number) {
    const normalized = parsed.account_number.replace(/\s+/g, '');
    const row = await env.DB.prepare(
      `SELECT id FROM company_bank_accounts
         WHERE REPLACE(account_number, ' ', '') = ?
           AND deleted_at IS NULL
         LIMIT 1`
    ).bind(normalized).first<{ id: string }>();
    if (row) return { id: row.id, method: 'exact' };
  }

  // Strategy 2: company_id + currency (less precise — first match wins)
  const txCurrency = parsed.currency ?? parsed.transactions[0]?.currency;
  if (companyId && txCurrency) {
    const row = await env.DB.prepare(
      `SELECT id FROM company_bank_accounts
         WHERE company_id = ? AND currency = ? AND deleted_at IS NULL
         ORDER BY is_default DESC, created_at ASC
         LIMIT 1`
    ).bind(companyId, txCurrency).first<{ id: string }>();
    if (row) return { id: row.id, method: 'currency_only' };
  }

  return null;
}

// =============================================================================
// Extract text from binary file (CSV passes through, XLSX/PDF best-effort)
// =============================================================================
export async function extractTextFromFile(
  bytes: Uint8Array,
  mimeType: string,
  filename: string
): Promise<string> {
  const lower = filename.toLowerCase();

  // CSV / TSV / plain text — decode directly
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt') ||
      mimeType.startsWith('text/')) {
    return decodeWithFallback(bytes);
  }

  // PDF — use unpdf (PDF.js wrapper) for proper text extraction
  if (lower.endsWith('.pdf') || mimeType === 'application/pdf') {
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(bytes);
      const { text } = await extractText(pdf, { mergePages: true });
      if (text && text.length > 50) {
        return text.slice(0, 100_000);
      }
    } catch (e) {
      console.error('[bank-parser] unpdf failed, falling back to strings:', e);
    }
    return extractPdfText(bytes);
  }

  // XLSX/XLS — use SheetJS to convert all sheets to CSV-like text
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') ||
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel') {
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(bytes, { type: 'array' });
      const parts: string[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        if (!sheet) continue;
        parts.push(`=== Sheet: ${sheetName} ===`);
        parts.push(XLSX.utils.sheet_to_csv(sheet, { FS: ';', RS: '\n', blankrows: false }));
      }
      const text = parts.join('\n');
      if (text.length > 50) return text.slice(0, 100_000);
    } catch (e) {
      console.error('[bank-parser] xlsx parse failed, falling back to strings:', e);
    }
    return extractPdfText(bytes);
  }

  return decodeWithFallback(bytes);
}

function decodeWithFallback(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

function extractPdfText(bytes: Uint8Array): string {
  // Naive: grab any printable runs of ≥2 chars (UTF-8 latin/cyrillic)
  const decoded = decodeWithFallback(bytes);
  const chunks = decoded.match(/[\x20-\x7E\u0400-\u04FF\u00A0-\u00FF\n\r\t]{2,}/g) ?? [];
  return chunks.join('\n').slice(0, 100_000);
}
