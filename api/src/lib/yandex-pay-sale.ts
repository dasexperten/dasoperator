// =============================================================================
// Yandex Pay report → sale operation builder
// -----------------------------------------------------------------------------
// Each "Payment Report" email from finance@pay.yandex.ru carries a CSV
// (dasexperten-payment-YYYY-MM-DD.csv) = the per-order site sales register for
// dasexperten.ru via Яндекс Сплит/Пэй. INCOMING site revenue, not a supplier
// invoice.
//
// Business rules (locked by Aram 2026-05-29):
//   • Each report file => ONE sale operation, reference DASR-YYYYMMDD.
//   • operation_date = the REPORT date (from filename), NOT the creation date.
//   • total_amount   = NET payout (what actually hit the bank). This is what the
//     bank reconciles against. CSV layout: rows WITH an order number are the
//     sales; a separate row WITHOUT an order number is the commission line.
//        gross = Σ "Сумма транзакции" over order rows
//        commission = the fee line (negative)
//        net = gross + commission   ← total_amount
//   • Payment match key = AMOUNT (Yandex inflows INN 9705212635 are unique). The
//     bank transfers NET, so we match against net (±2%).
//   • Line items: pull each order from RetailCRM by order number, aggregate by
//     SKU using the ACTUAL paid price (after discount = prices[0].price), so the
//     operation shows what was sold per SKU (the "virtual invoice").
//
// Replaces the old monthly bank aggregator (rebuildPriorMonthSite, disabled).
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
  grossRevenue: number;        // Σ order rows
  totalCommission: number;     // negative
  netPayout: number;           // gross + commission  (== total_amount)
  currency: string;
  replaced: boolean;
  lineItemsAdded: number;
  ordersMatchedInCrm: number;
}

// Parse a Russian-formatted decimal: "1 273", "-2,52", "296" -> number
function parseRuNumber(raw: string): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/\u00A0/g, '').replace(/\s/g, '').replace(',', '.').trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function deriveSaleDate(filename: string, firstTxIso: string | null): string {
  const m = (filename || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (firstTxIso) {
    const t = new Date(firstTxIso);
    if (!isNaN(t.getTime())) return t.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

interface ParsedCsv {
  saleDate: string;
  orderCount: number;
  grossRevenue: number;
  totalCommission: number;
  netPayout: number;
  orderNumbers: string[];      // order numbers (part before "_")
}

// Columns (semicolon, by index):
//  0 Дата транзакции; 6 Номер заказа; 7 Сумма транзакции;
//  10 Комиссия за сервис; 11 Комиссия за обслуживание; 12 Сумма к перечислению
export function parseYandexPayCsv(text: string, filename: string): ParsedCsv {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows = lines.slice(1); // drop header

  let gross = 0;
  let commission = 0;
  let orderCount = 0;
  let firstTxIso: string | null = null;
  const orderNumbers: string[] = [];

  for (const line of rows) {
    const cols = line.split(';');
    if (cols.length < 8) continue;
    const orderRaw = (cols[6] || '').trim();
    const txAmount = parseRuNumber(cols[7]);

    if (orderRaw) {
      // Sales row.
      gross += txAmount;
      orderCount += 1;
      orderNumbers.push(orderRaw.split('_')[0]);
      if (!firstTxIso && cols[0]) firstTxIso = cols[0].trim();
    } else {
      // Commission / fee line (no order number) — adds to commission (negative).
      commission += txAmount;
    }
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;
  gross = round2(gross);
  commission = round2(commission);
  const netPayout = round2(gross + commission);

  return {
    saleDate: deriveSaleDate(filename, firstTxIso),
    orderCount,
    grossRevenue: gross,
    totalCommission: commission,
    netPayout,
    orderNumbers,
  };
}

// Download CSV text. Inbox attachments live behind a public r2.dev URL.
async function fetchCsvText(env: Env, r2KeyOrUrl: string): Promise<string | null> {
  if (r2KeyOrUrl.startsWith('http')) {
    try {
      const r = await fetch(r2KeyOrUrl, { signal: AbortSignal.timeout(30_000) });
      if (r.ok) return await r.text();
    } catch (e) {
      console.error(`[yandex-sale] URL fetch failed for ${r2KeyOrUrl}:`, e);
    }
    return null;
  }
  try {
    const obj = await env.DOCS.get(r2KeyOrUrl);
    if (obj) return await obj.text();
  } catch (e) {
    console.error(`[yandex-sale] R2 get failed for key ${r2KeyOrUrl}:`, e);
  }
  return null;
}

// ---- RetailCRM ----
interface CrmSkuAgg { qty: number; revenue: number; name: string; }

async function retailGet(env: Env, path: string, params: Record<string, string | number>): Promise<any> {
  const domain = env.RETAIL_CRM_DOMAIN;
  const token = env.RETAIL_CRM_TOKEN;
  if (!domain || !token) return null;
  const url = new URL(`https://${domain}.retailcrm.ru/api/v5${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url.toString(), {
    headers: { 'X-API-KEY': token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) return null;
  return r.json();
}

// Pull each order from RetailCRM by number, aggregate items by SKU using the
// actual paid price (after discount). Returns SKU map + matched-order count.
async function buildLineItemsFromCrm(
  env: Env,
  orderNumbers: string[],
): Promise<{ skus: Map<string, CrmSkuAgg>; matched: number }> {
  const skus = new Map<string, CrmSkuAgg>();
  let matched = 0;

  // RetailCRM allows filtering by multiple order numbers per call (filter[numbers][]).
  // Batch in groups to keep URLs sane.
  const BATCH = 25;
  for (let i = 0; i < orderNumbers.length; i += BATCH) {
    const batch = orderNumbers.slice(i, i + BATCH);
    // Build filter[numbers][]=... repeated — URLSearchParams set() can't repeat,
    // so construct manually.
    const domain = env.RETAIL_CRM_DOMAIN;
    const token = env.RETAIL_CRM_TOKEN;
    if (!domain || !token) break;
    const qs = batch.map((n) => `filter[numbers][]=${encodeURIComponent(n)}`).join('&');
    const url = `https://${domain}.retailcrm.ru/api/v5/orders?${qs}&limit=100`;
    let data: any = null;
    try {
      const r = await fetch(url, {
        headers: { 'X-API-KEY': token, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.ok) data = await r.json();
    } catch (e) {
      console.error('[yandex-sale] RetailCRM batch fetch failed:', e);
    }
    if (!data || !data.success) continue;

    for (const o of data.orders || []) {
      matched += 1;
      for (const it of o.items || []) {
        const off = it.offer || {};
        const art = String(off.article || off.name || 'UNKNOWN').toLowerCase();
        const qty = Number(it.quantity || 0);
        const prices = it.prices || [];
        const paid = prices.length > 0
          ? Number(prices[0].price || 0)
          : (Number(it.initialPrice || 0) - Number(it.discountTotal || 0));
        const rev = qty * paid;
        const cur = skus.get(art) || { qty: 0, revenue: 0, name: String(off.name || art) };
        cur.qty += qty;
        cur.revenue += rev;
        skus.set(art, cur);
      }
    }
  }
  return { skus, matched };
}

// Match the Yandex inflow to this operation BY AMOUNT (net == bank transfer).
async function attachYandexPayment(
  env: Env,
  operationId: string,
  netAmount: number,
): Promise<{ matched: boolean; bankTxId?: string; amount?: number }> {
  const netCents = Math.round(netAmount * 100);
  const lo = Math.floor(netCents * (1 - PAYMENT_MATCH_TOLERANCE));
  const hi = Math.ceil(netCents * (1 + PAYMENT_MATCH_TOLERANCE));

  const tx = await env.DB.prepare(
    `SELECT id, amount, currency, executed_at
       FROM bank_transactions
      WHERE contragent_inn = ? AND direction = 'incoming'
        AND deleted_at IS NULL AND matched_operation_id IS NULL
        AND amount BETWEEN ? AND ?
      ORDER BY ABS(amount - ?) ASC LIMIT 1`
  ).bind(YANDEX_PAY_INN, lo, hi, netCents).first<{
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
      `[AUTO-MATCH yandex-pay-report by amount] bank_tx ${tx.id}`, now, now
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

// Replace line items for an operation with the SKU aggregation.
async function writeLineItems(
  env: Env,
  operationId: string,
  skus: Map<string, CrmSkuAgg>,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  // Clear any existing line items for this op (idempotent rebuild).
  await env.DB.prepare(`DELETE FROM line_items WHERE operation_id = ?`).bind(operationId).run();

  let count = 0;
  for (const [art, agg] of skus) {
    if (agg.qty <= 0) continue;
    const unit = agg.qty > 0 ? Math.round((agg.revenue / agg.qty) * 100) / 100 : 0;
    const id = `li_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO line_items
         (id, operation_id, product_id, item_description, qty, cartons, inner_boxes,
          unit_price, discount_pct, unit_price_after_disc, line_amount, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?)`
    ).bind(
      id, operationId, art, agg.name.slice(0, 200), agg.qty,
      unit, unit, Math.round(agg.revenue * 100) / 100, SITE_CURRENCY, now, now
    ).run();
    count++;
  }
  return count;
}

// Main entry: build the DASR-YYYYMMDD sale operation from one report CSV.
// Idempotent — re-running for the same report date rebuilds cleanly.
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

  const ymd = parsed.saleDate.replace(/-/g, '');
  const reference = `DASR-${ymd}`;
  const opDateTs = Math.floor(new Date(parsed.saleDate + 'T00:00:00Z').getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);

  const cols = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('operations')"
  ).all<{ name: string }>();
  const colSet = new Set((cols.results ?? []).map((r) => r.name));

  const existing = await env.DB.prepare(
    `SELECT id FROM operations WHERE reference = ? AND deleted_at IS NULL LIMIT 1`
  ).bind(reference).first<{ id: string }>();

  // total_amount = NET payout (what hit the bank).
  const totalAmount = parsed.netPayout;
  const note = `[YANDEX-PAY REPORT] ${parsed.orderCount} orders · gross ${parsed.grossRevenue} · commission ${parsed.totalCommission} · NET ${parsed.netPayout} RUB · file ${filename}`.slice(0, 500);

  let operationId: string;
  let replaced = false;

  if (existing) {
    operationId = existing.id;
    replaced = true;
    const sets: string[] = ['total_amount = ?', 'updated_at = ?'];
    const vals: any[] = [totalAmount, now];
    if (colSet.has('notes')) { sets.push('notes = ?'); vals.push(note); }
    vals.push(operationId);
    await env.DB.prepare(`UPDATE operations SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  } else {
    operationId = `op_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const fields: string[] = ['id', 'partner_id', 'operation_type', 'our_company_id',
      'operation_date', 'status', 'currency', 'total_amount', 'created_at', 'updated_at'];
    const values: any[] = [operationId, SITE_PARTNER_ID, 'sale', SITE_OUR_COMPANY,
      opDateTs, 'issued', SITE_CURRENCY, totalAmount, now, now];
    if (colSet.has('reference')) { fields.push('reference'); values.push(reference); }
    if (colSet.has('contract_id')) { fields.push('contract_id'); values.push(SITE_CONTRACT_ID); }
    if (colSet.has('operation_track')) { fields.push('operation_track'); values.push('goods'); }
    if (colSet.has('notes')) { fields.push('notes'); values.push(note); }
    const placeholders = fields.map(() => '?').join(',');
    await env.DB.prepare(
      `INSERT INTO operations (${fields.join(',')}) VALUES (${placeholders})`
    ).bind(...values).run();
  }

  // Build line items from RetailCRM (the "virtual invoice" — SKU breakdown).
  let lineItemsAdded = 0;
  let ordersMatchedInCrm = 0;
  try {
    const { skus, matched } = await buildLineItemsFromCrm(env, parsed.orderNumbers);
    ordersMatchedInCrm = matched;
    if (skus.size > 0) lineItemsAdded = await writeLineItems(env, operationId, skus);
  } catch (crmErr) {
    console.error(`[yandex-sale] RetailCRM line-item build failed for ${reference}:`, crmErr);
  }

  // Attach the matching bank inflow (by NET amount).
  try {
    const pm = await attachYandexPayment(env, operationId, parsed.netPayout);
    if (pm.matched) {
      console.log(`[yandex-sale] payment matched: bank_tx ${pm.bankTxId} (${pm.amount} RUB) → ${reference}`);
    }
  } catch (payErr) {
    console.error(`[yandex-sale] payment match failed for ${reference}:`, payErr);
  }

  // Mark the inbox row resolved.
  await env.DB.prepare(
    `UPDATE invoice_inbox SET
       status = 'auto_created', classification = 'sale_payment',
       matched_partner_id = ?, created_operation_id = ?,
       extracted_amount = COALESCE(extracted_amount, ?),
       extracted_currency = COALESCE(extracted_currency, ?), resolved_at = ?
     WHERE id = ?`
  ).bind(SITE_PARTNER_ID, operationId, totalAmount, SITE_CURRENCY, now, invId).run();

  console.log(`[yandex-sale] ${replaced ? 'updated' : 'created'} ${reference} — ${parsed.orderCount} orders, net ${parsed.netPayout} RUB, ${lineItemsAdded} SKU lines (${ordersMatchedInCrm} orders in CRM)`);

  return {
    operationId, reference, saleDate: parsed.saleDate,
    orderCount: parsed.orderCount, grossRevenue: parsed.grossRevenue,
    totalCommission: parsed.totalCommission, netPayout: parsed.netPayout,
    currency: SITE_CURRENCY, replaced, lineItemsAdded, ordersMatchedInCrm,
  };
}

// =============================================================================
// Backfill — pull ALL finance@pay.yandex.ru reports from Gmail and build an
// operation (+ line items + payment) per report. Synchronous, self-contained.
// =============================================================================
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
  line_items_total: number;
  details: Array<{ reference: string; net: number; lineItems: number; crmOrders: number; orders: number }>;
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
    reports_found: 0, ops_built: 0, payments_matched: 0, line_items_total: 0, details: [],
  };

  for (const t of threads) {
    for (const meta of (t.attachments_meta || [])) {
      const fn = String(meta.filename || '');
      const isCsv = (meta.mime_type || '').toLowerCase().includes('csv') || fn.toLowerCase().endsWith('.csv');
      if (!isCsv) continue;
      result.reports_found++;

      let dl: any = null;
      try {
        dl = await callEmailerYP(env, { action: 'download_attachment', message_id: meta.message_id, attachment_name: fn });
      } catch { continue; }
      if (!dl || !dl.success || !dl.r2_url) continue;

      const csvText = await fetchCsvText(env, dl.r2_url);
      if (!csvText) continue;

      const invId = `ypbackfill_${meta.message_id}`;
      try {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO invoice_inbox
             (id, source_type, gmail_message_id, gmail_thread_id, email_from, email_subject,
              attachment_filename, attachment_r2_key, attachment_content_type,
              classification, status, created_at)
           VALUES (?, 'gmail', ?, ?, 'finance@pay.yandex.ru', 'Payment Report',
              ?, ?, 'text/csv', 'sale_payment', 'queued', ?)`
        ).bind(invId, meta.message_id, t.thread_id || meta.message_id, fn,
               (dl.r2_url.includes('.r2.dev/') ? dl.r2_url.split('.r2.dev/')[1] : dl.r2_url),
               Math.floor(Date.now() / 1000)).run();
      } catch { /* exists */ }

      const sale = await createDailySaleFromYandexCsv(env, invId, csvText, fn);
      if (!sale) continue;
      result.ops_built++;
      result.line_items_total += sale.lineItemsAdded;

      const pay = await env.DB.prepare(
        `SELECT COUNT(*) n FROM payments WHERE operation_id = ? AND deleted_at IS NULL`
      ).bind(sale.operationId).first<{ n: number }>();
      if (pay && pay.n > 0) result.payments_matched++;

      result.details.push({
        reference: sale.reference, net: sale.netPayout,
        lineItems: sale.lineItemsAdded, crmOrders: sale.ordersMatchedInCrm, orders: sale.orderCount,
      });
    }
  }
  return result;
}

export { fetchCsvText };
