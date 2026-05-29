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
//   reference   = DASR-DAY-YYYYMMDD (one per calendar day / per file)
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

// Download CSV bytes from R2 by key (key stored in invoice_inbox.attachment_r2_key).
async function fetchCsvText(env: Env, r2Key: string): Promise<string | null> {
  try {
    const obj = await env.DOCS.get(r2Key);
    if (obj) return await obj.text();
  } catch (e) {
    console.error(`[yandex-sale] R2 get failed for key ${r2Key}:`, e);
  }
  return null;
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
  const reference = `DASR-DAY-${ymd}`;
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
