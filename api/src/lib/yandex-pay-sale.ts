// =============================================================================
// Yandex Pay daily-sale builder
// -----------------------------------------------------------------------------
// Each "Payment Report" email from finance@pay.yandex.ru carries a CSV
// (dasexperten-payment-YYYY-MM-DD.csv) = the per-order site sales register for
// dasexperten.ru via Яндекс Сплит/Пэй. This is INCOMING site revenue, not a
// supplier invoice.
//
// Business rule (Option A, locked by Aram 2026-05-29):
//   Each CSV file => ONE daily Sale operation.
//   reference   = DASR-YYYYMMDD (one per calendar day / per file; 8 digits)
//   total_amount= sum of "Сумма транзакции" (gross buyer-paid revenue, RUB)
//   commissions = sum of "Комиссия за сервис" + "Комиссия за обслуживание"
//   net payout  = total + commissions (commissions are negative in the file)
//
// This EMAIL path fully replaces the old monthly bank aggregator
// rebuildPriorMonthSite — the monthly cron is now disabled.
// =============================================================================

import type { Env } from '../types';

const SITE_PARTNER_ID = 'яндекс_пей_продажи_с_нашего_сайта';
const SITE_OUR_COMPANY = 'dee';
const SITE_CONTRACT_ID = 'yandex_kit_dasexperten_ru';
const SITE_CURRENCY = 'RUB';
const YANDEX_PAY_INN = '9705212635';
const PAYMENT_MATCH_TOLERANCE = 0.02; // ±2% — amount is the key, inflows are unique

export interface YandexDailySaleResult {
  operationId: string;
  reference: string;
  saleDate: string;            // YYYY-MM-DD
  orderCount: number;
  grossRevenue: number;        // sum of Сумма транзакции
  totalCommission: number;     // negative
  netPayout: number;           // gross + commission
  currency: string;
  replaced: boolean;           // true if an existing DASR-DAY op was updated
}

// Parse a Russian-formatted decimal: "1 273", "-2,52", "296" -> number
function parseRuNumber(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw
    .replace(/\u00A0/g, '')   // nbsp thousands sep
    .replace(/\s/g, '')       // plain space sep
    .replace(',', '.')        // decimal comma -> dot
    .trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// Derive YYYY-MM-DD from the filename (dasexperten-payment-2026-05-28.csv).
// Falls back to the first transaction date in the file if filename has none.
function deriveSaleDate(filename: string, firstTxIso: string | null): string {
  const m = (filename || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (firstTxIso) {
    const t = new Date(firstTxIso);
    if (!isNaN(t.getTime())) return t.toISOString().slice(0, 10);
  }
  // last resort: today
  return new Date().toISOString().slice(0, 10);
}

interface ParsedCsv {
  saleDate: string;
  orderCount: number;
  grossRevenue: number;
  totalCommission: number;
  netPayout: number;
  firstTxIso: string | null;
}

// Parse the semicolon-delimited Yandex Pay CSV text.
// Header columns (by index):
//   0 Дата транзакции; 1 merchant_id; 2 Код магазина; 3 Код продавца;
//   4 ID транзакции; 5 Источник транзакции; 6 Номер заказа;
//   7 Сумма транзакции; 8 в т.ч. Сплит; 9 в т.ч. не-Сплит;
//   10 Комиссия за сервис; 11 Комиссия за обслуживание;
//   12 Сумма к перечислению; ...
export function parseYandexPayCsv(text: string, filename: string): ParsedCsv {
  // Strip BOM, split lines, drop header + blanks.
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = lines.slice(1); // drop header

  let gross = 0;
  let commission = 0;
  let orderCount = 0;
  let firstTxIso: string | null = null;

  for (const line of rows) {
    const cols = line.split(';');
    if (cols.length < 12) continue;
    // Only count actual payment rows (Источник транзакции = "payment").
    // Refunds/chargebacks would carry a different source and negative amounts;
    // they still belong in the day's net, so we include any row with an amount.
    const txAmount = parseRuNumber(cols[7]);
    if (txAmount === 0 && parseRuNumber(cols[12]) === 0) continue;

    if (!firstTxIso && cols[0]) firstTxIso = cols[0].trim();
    gross += txAmount;
    commission += parseRuNumber(cols[10]) + parseRuNumber(cols[11]);
    orderCount += 1;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  gross = round2(gross);
  commission = round2(commission);
  const netPayout = round2(gross + commission); // commission is negative

  return {
    saleDate: deriveSaleDate(filename, firstTxIso),
    orderCount,
    grossRevenue: gross,
    totalCommission: commission,
    netPayout,
    firstTxIso,
  };
}

// Download CSV text. Inbox attachments live behind a public r2.dev URL (a
// different bucket than DOCS), so fetch by URL first; fall back to DOCS.get
// for the off-chance the key is in the docs bucket.
async function fetchCsvText(env: Env, r2KeyOrUrl: string): Promise<string | null> {
  // URL path (preferred — matches how the keyword inbox reads attachments).
  if (r2KeyOrUrl.startsWith('http')) {
    try {
      const r = await fetch(r2KeyOrUrl, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) return await r.text();
    } catch (e) {
      console.error(`[yandex-sale] URL fetch failed for ${r2KeyOrUrl}:`, e);
    }
    return null;
  }
  // Key path fallback.
  try {
    const obj = await env.DOCS.get(r2KeyOrUrl);
    if (obj) return await obj.text();
  } catch (e) {
    console.error(`[yandex-sale] R2 get failed for key ${r2KeyOrUrl}:`, e);
  }
  return null;
}

// Attach the matching Yandex inflow to this report's operation, BY AMOUNT.
// Yandex inflow amounts are unique, so amount (±2%) is a safe key. Bank stores
// RUB in minor cents; operations/payments store RUB major. The bank transfer is
// gross (== report gross), so we match against grossRevenue, not net.
async function attachYandexPayment(
  env: Env,
  operationId: string,
  grossRevenue: number,
): Promise<{ matched: boolean; bankTxId?: string; amount?: number }> {
  const grossCents = Math.round(grossRevenue * 100);
  const lo = Math.floor(grossCents * (1 - PAYMENT_MATCH_TOLERANCE));
  const hi = Math.ceil(grossCents * (1 + PAYMENT_MATCH_TOLERANCE));

  // Find an unmatched Yandex inflow whose amount is within tolerance.
  // Prefer the closest amount to the report gross.
  const tx = await env.DB.prepare(
    `SELECT id, amount, currency, executed_at
       FROM bank_transactions
      WHERE contragent_inn = ? AND direction = 'incoming'
        AND deleted_at IS NULL
        AND matched_operation_id IS NULL
        AND amount BETWEEN ? AND ?
      ORDER BY ABS(amount - ?) ASC
      LIMIT 1`
  ).bind(YANDEX_PAY_INN, lo, hi, grossCents).first<{
    id: string; amount: number; currency: string; executed_at: number;
  }>();

  if (!tx) return { matched: false };

  const now = Math.floor(Date.now() / 1000);
  const amtMajor = tx.currency.toUpperCase() === 'RUB' ? tx.amount / 100 : tx.amount;
  const paymentId = `pay_${crypto.randomUUID()}`;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payments (id, partner_id, contract_id, operation_id, amount, currency,
                             payment_date, type, direction, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'partial', 'incoming', ?, ?, ?)`
    ).bind(
      paymentId, SITE_PARTNER_ID, SITE_CONTRACT_ID, operationId,
      amtMajor, tx.currency, tx.executed_at,
      `[AUTO-MATCH yandex-pay-report by amount] bank_tx ${tx.id}`,
      now, now
    ),
    env.DB.prepare(
      `UPDATE bank_transactions
         SET matched_operation_id = ?, matched_payment_id = ?, matched_at = ?,
             match_method = 'matched_by_yandex_pay_report', matched_by = 'system_auto', updated_at = ?
       WHERE id = ?`
    ).bind(operationId, paymentId, now, now, tx.id),
  ]);

  return { matched: true, bankTxId: tx.id, amount: amtMajor };
}

// Main entry: given an inbox row id + the already-extracted CSV text, build the
// daily DASR-DAY sale operation. Idempotent — re-running for the same day
// updates the existing operation instead of duplicating revenue.
export async function createDailySaleFromYandexCsv(
  env: Env,
  invId: string,
  csvText: string,
  filename: string,
): Promise<YandexDailySaleResult | null> {
  const parsed = parseYandexPayCsv(csvText, filename);
  if (parsed.orderCount === 0) {
    console.log(`[yandex-sale] no order rows parsed from ${filename} (inbox ${invId})`);
    return null;
  }

  const ymd = parsed.saleDate.replace(/-/g, '');           // YYYYMMDD
  const reference = `DASR-${ymd}`;  // DASR-YYYYMMDD (daily; 8 digits, distinct from old 6-digit monthly)
  const opDateTs = Math.floor(new Date(parsed.saleDate + 'T00:00:00Z').getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);

  // Discover operations columns dynamically (schema evolves).
  const cols = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('operations')"
  ).all<{ name: string }>();
  const colSet = new Set((cols.results ?? []).map((r) => r.name));

  // Does a DASR-DAY op for this date already exist?
  const existing = await env.DB.prepare(
    `SELECT id FROM operations WHERE reference = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(reference).first<{ id: string }>();

  const note = `[YANDEX-PAY DAILY] ${parsed.orderCount} orders · gross ${parsed.grossRevenue} RUB · commission ${parsed.totalCommission} · net ${parsed.netPayout} · file ${filename} · inbox ${invId}`.slice(0, 500);

  let operationId: string;
  let replaced = false;

  if (existing) {
    operationId = existing.id;
    replaced = true;
    const sets: string[] = ['total_amount = ?', 'updated_at = ?'];
    const vals: any[] = [parsed.grossRevenue, now];
    if (colSet.has('notes')) { sets.push('notes = ?'); vals.push(note); }
    vals.push(operationId);
    await env.DB.prepare(
      `UPDATE operations SET ${sets.join(', ')} WHERE id = ?`
    ).bind(...vals).run();
  } else {
    operationId = `op_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const fields: string[] = ['id', 'partner_id', 'operation_type', 'our_company_id',
      'operation_date', 'status', 'currency', 'total_amount', 'created_at', 'updated_at'];
    const values: any[] = [operationId, SITE_PARTNER_ID, 'sale', SITE_OUR_COMPANY,
      opDateTs, 'issued', SITE_CURRENCY, parsed.grossRevenue, now, now];

    if (colSet.has('reference')) { fields.push('reference'); values.push(reference); }
    if (colSet.has('contract_id')) { fields.push('contract_id'); values.push(SITE_CONTRACT_ID); }
    if (colSet.has('operation_track')) { fields.push('operation_track'); values.push('goods'); }
    if (colSet.has('notes')) { fields.push('notes'); values.push(note); }

    const placeholders = fields.map(() => '?').join(',');
    await env.DB.prepare(
      `INSERT INTO operations (${fields.join(',')}) VALUES (${placeholders})`
    ).bind(...values).run();
  }

  // Attach the matching bank inflow (by amount) so the operation shows paid.
  let paymentMatched = false;
  try {
    const pm = await attachYandexPayment(env, operationId, parsed.grossRevenue);
    paymentMatched = pm.matched;
    if (pm.matched) {
      console.log(`[yandex-sale] payment matched: bank_tx ${pm.bankTxId} (${pm.amount} RUB) → ${reference}`);
    }
  } catch (payErr) {
    console.error(`[yandex-sale] payment match failed for ${reference}:`, payErr);
  }

  // Mark the inbox row resolved and link the operation.
  await env.DB.prepare(
    `UPDATE invoice_inbox SET
       status = 'auto_created',
       classification = 'sale_payment',
       matched_partner_id = ?,
       created_operation_id = ?,
       extracted_amount = COALESCE(extracted_amount, ?),
       extracted_currency = COALESCE(extracted_currency, ?),
       resolved_at = ?
     WHERE id = ?`
  ).bind(SITE_PARTNER_ID, operationId, parsed.grossRevenue, SITE_CURRENCY, now, invId).run();

  console.log(`[yandex-sale] ${replaced ? 'updated' : 'created'} ${reference} (${operationId}) — ${parsed.orderCount} orders, gross ${parsed.grossRevenue} RUB`);

  return {
    operationId,
    reference,
    saleDate: parsed.saleDate,
    orderCount: parsed.orderCount,
    grossRevenue: parsed.grossRevenue,
    totalCommission: parsed.totalCommission,
    netPayout: parsed.netPayout,
    currency: SITE_CURRENCY,
    replaced,
  };
}

export { fetchCsvText };


// =============================================================================
// Backfill — pull ALL finance@pay.yandex.ru reports from Gmail and build an
// operation (+ payment match) per report. Synchronous, self-contained, narrow:
// it does not touch the keyword inbox flow at all. Idempotent — re-runnable.
// =============================================================================
const EMAILER_BRIDGE_YP = 'https://emailer-bridge.dasexperten.workers.dev/';

async function callEmailerYP(env: Env, body: any): Promise<any> {
  const r = await (env as any).EMAILER.fetch('https://emailer/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return r.json();
}

export interface YandexBackfillResult {
  reports_found: number;
  ops_built: number;
  payments_matched: number;
  details: Array<{ reference: string; gross: number; paymentMatched: boolean; replaced: boolean }>;
}

export async function backfillYandexReports(env: Env, days: number = 60): Promise<YandexBackfillResult> {
  const find = await callEmailerYP(env, {
    action: 'find',
    query: `from:finance@pay.yandex.ru has:attachment newer_than:${days}d`,
    max_results: 50,
    skip_attachments: true,
  });
  const threads: any[] = find?.threads || [];

  const result: YandexBackfillResult = {
    reports_found: 0, ops_built: 0, payments_matched: 0, details: [],
  };

  for (const t of threads) {
    const metas: any[] = t.attachments_meta || [];
    for (const meta of metas) {
      const fn = String(meta.filename || '');
      const isCsv = (meta.mime_type || '').toLowerCase().includes('csv') || fn.toLowerCase().endsWith('.csv');
      if (!isCsv) continue;
      result.reports_found++;

      // download attachment → R2 → fetch text
      let dl: any = null;
      try {
        dl = await callEmailerYP(env, {
          action: 'download_attachment',
          message_id: meta.message_id,
          attachment_name: fn,
        });
      } catch { continue; }
      if (!dl || !dl.success || !dl.r2_url) continue;

      const r2Key = dl.r2_url.includes('.r2.dev/') ? dl.r2_url.split('.r2.dev/')[1] : dl.r2_url;
      const csvText = await fetchCsvText(env, dl.r2_url);
      if (!csvText) continue;

      // synthesize a lightweight inbox row id so the op note has a trace
      const invId = `ypbackfill_${meta.message_id}`;
      // ensure an inbox row exists (so created_operation_id link has a home)
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO invoice_inbox
             (id, source_type, gmail_message_id, gmail_thread_id, email_from, email_subject,
              attachment_filename, attachment_r2_key, attachment_content_type,
              classification, status, created_at)
           VALUES (?, 'gmail', ?, ?, 'finance@pay.yandex.ru', 'Payment Report',
              ?, ?, 'text/csv', 'sale_payment', 'queued', ?)`
        ).bind(invId, meta.message_id, t.thread_id || meta.message_id, fn, r2Key,
               Math.floor(Date.now() / 1000)).run();
      } catch { /* row may exist */ }

      const sale = await createDailySaleFromYandexCsv(env, invId, csvText, fn);
      if (!sale) continue;
      result.ops_built++;
      if (sale.replaced) { /* already counted as op */ }

      // did a payment attach? check
      const pay = await env.DB.prepare(
        `SELECT COUNT(*) n FROM payments WHERE operation_id = ? AND deleted_at IS NULL`
      ).bind(sale.operationId).first<{ n: number }>();
      const paymentMatched = !!(pay && pay.n > 0);
      if (paymentMatched) result.payments_matched++;

      result.details.push({
        reference: sale.reference, gross: sale.grossRevenue, paymentMatched, replaced: sale.replaced,
      });
    }
  }

  return result;
}
