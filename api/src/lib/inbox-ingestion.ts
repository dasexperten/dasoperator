// =============================================================================
// Inbox ingestion — daily Gmail → R2 → DeepSeek → invoice_inbox pipeline
// =============================================================================
//
// Called from scheduled cron (0 0 * * * = 03:00 МСК).
// Workflow:
//   1. Search Gmail for new invoices (via emailer-bridge `find` action)
//   2. For each PDF: download from R2, extract text, classify with DeepSeek
//   3. Apply auto-reject rules (sale_payment, not_invoice, tax_authority)
//   4. Insert remaining as needs_partner_link / needs_review
//   5. Send daily summary email via emailer-bridge
//
// Idempotent: re-running on the same day skips already-processed attachments
// (dedup by attachment_filename + gmail_thread_id).
// =============================================================================

import type { Env } from '../types';
import { findMatchingOperation, applyMatchToInbox } from './inbox-auto-match';
import { callAnthropicRaw } from './anthropic';
import { callGeminiPdf } from './gemini';
import { callPro } from './llm';
import { createDailySaleFromYandexCsv } from './yandex-pay-sale';

const EMAILER_BRIDGE = 'https://emailer-bridge.dasexperten.workers.dev/';
const R2_PUBLIC_BASE = 'https://pub-0e2fb2d28ea9408bbaa1bdd64b3bf256.r2.dev/';

// Search queries — multiple narrow batches beat one broad query (Apps Script
// timeout under load). Each batch limited to 4 results.
const SEARCH_QUERIES = [
  'invoice OR receipt',
  'УПД OR УКД OR акт',
  'payment OR оплата',
  'счёт OR счет OR требование',
  'tax OR VAT',
];

// Spreadsheet MIME types Yandex Pay / RetailCRM use for sales & payment reports.
const SHEET_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls
  'text/csv',                                                          // .csv
  'application/csv',
]);
const isSheetMime = (m: string | undefined) => SHEET_MIMES.has((m || '').toLowerCase());

// WATCHLIST: critical senders whose every message must enter the inbox,
// regardless of subject keywords or DeepSeek classifier verdict. Added
// 2026-05-23 per Aram's direct instruction. Extend this list as Aram names
// more senders. Behavior for watchlist:
//   - Search window widened to 14 days (vs 2 days for keyword queries).
//   - Both PDF and TXT attachments accepted (bkmsk often sends .txt outputs).
//   - Auto-reject rules are bypassed; everything lands as needs_review.
//   - Notes prefixed with [WATCHLIST: <sender>].
const WATCHLIST_SENDERS = ['253@bkmsk.ru', 'zukonar@mail.ru', 'buh2@inter-freight.ru', 'sales5@inter-vostok.ru', 'iampanchenko@mail.ru', 'finance@pay.yandex.ru'];
const WATCHLIST_WINDOW_DAYS = 30;

// Hard cap on how many PDFs Step 3 processes per ingestion run. Each Claude
// vision call takes 7-15s, and Workers have CPU/wall-clock budgets even when
// using waitUntil. With 8 candidates × 12s avg = 96s — within budget. Beyond
// that, leave remaining candidates for the next cron tick.
const MAX_PROCESS_PER_RUN = 10;
const SOFT_BUDGET_MS = 55_000; // bail out if processing exceeds this wall time (safe for waitUntil)


// Known watchlist vendor INNs → existing partner_id + buyer entity.
// For these vendors, the invoice IS the operation — no act expected.
// Cron auto-creates a service-purchase operation immediately upon ingestion.
// To enable auto-create for a new vendor: insert their INN here AFTER
// confirming partner row exists with the matching id.
const WATCHLIST_VENDOR_MAP: Record<string, { partnerId: string; buyer: string }> = {
  '7707838921': { partnerId: 'alfa_klass', buyer: 'dee' }, // ООО АЛЬФА КЛАСС — bkmsk accountants
  '1300012746': { partnerId: 'priz',       buyer: 'dee' }, // ООО ПРИЗ — zukonar landlord
};

const DEEPSEEK_PROMPT = `You are an invoice classifier for Das Experten (multi-entity company).
Entities: DEE (Russia), DEI (UAE), DEASEAN (Vietnam), DEC (Seychelles).

Classify into one of:
  - "service" — vendor billing for service (accounting, hosting, ads, banking, certification, gov tax)
  - "purchase" — supplier billing for goods/products
  - "sale_payment" — settlement/agent report from marketplace selling OUR goods (Магнит/WB/Ozon УПД/УКД/Отчёт агента)
  - "not_invoice" — newsletter, marketing, info letter, presentation, КП
  - "unclear"

Service category (if service): "Accounting & Bookkeeping" / "Legal & Compliance" / "Hosting & Cloud" / "Software / SaaS" / "Banking & Financial Services" / "Advertising & Marketing" / "Logistics / Customs" / "Telecommunications" / "Office / Utilities" / "Government / Tax" / "Certification" / "Other"

For logistics/freight services (Inter-Freight, Inter-Vostok, Панченко) also extract:
  - shipment_ref: forwarder reference like "INF50363", "INF51023", "TR5093". Look in subject AND body. Pattern: INF\\d{4,6} or TR\\d{3,5}. Null if absent.
  - service_subtype: one of "freight" (international transport, EXW->RU), "customs" (Таможенное оформление, ГТД), "storage" (Хранение), "handling" (ПРР, погрузо-разгрузка), "demurrage" (Простой), "delivery_local" (last-mile within RU, e.g. Москва-Люберцы), "insurance", "other". Pick by line item description.

CRITICAL — distinguish invoices from supporting documents:
  - ГТД / Таможенная декларация / Customs declaration / Декларация на товары / Decl. на товары: classification = "not_invoice". ALWAYS set amount_total = null AND line_items = []. The "общая таможенная стоимость" (e.g. 1290227.87) is the declared value in RUB (after the FX rate in field 23), NOT a payable amount. Even if you see "USD" or "CNY" labels, the only payable items in ГТД are tiny customs fees (e.g. 13541 RUB sbor + ~6.5% duty), and these are paid via tax authorities, not the forwarder — so still not_invoice for our pipeline.
  - Коносамент / B/L / Bill of Lading / Морская накладная (RZZU*, MAEU*, etc.): classification = "not_invoice", amount_total = null, line_items = []. These are scanned/multi-page transport documents; any numbers you see are container weights, ports, dates — never invoice amounts.
  - Договор страхования / Insurance policy / Полис: classification = "service" with subtype="insurance" ONLY if it explicitly contains a payable премия figure. The policy contract itself without a separate invoice is "not_invoice".
  - ТД / Транзитная декларация (transit declaration): classification = "not_invoice", amount_total = null. The "общая сумма по счету" field references the underlying invoice — DO NOT extract it as amount_total.
  - СМР / CMR / Накладная на перевозку: classification = "not_invoice".
  - УПД / Счёт-фактура / Счет на оплату: these ARE invoices. Use the total payable amount from "Итого к оплате" / "Всего к оплате" / "К ОПЛАТЕ". Ignore "Таможенная стоимость" if present in a freight invoice.
  - INVOICE-SPECIFICATION (вендорский счёт-спецификация от Honghui/Jinxia с перечнем SKU): classification = "purchase", currency = the one in column header (typically CNY). Use the row totaling sum, not customs value.

SANITY RULES for amount_total:
  - If amount_total > 10,000,000 in any currency, double-check — service invoices rarely exceed this. If unsure, set amount_total = null and add to notes: "Amount sanity check failed: extracted figure XX appears to be ledger total or customs value, not invoice amount".
  - If line description mentions "таможенная стоимость", "статистическая стоимость", "общая стоимость партии", "declared value", "customs value" — that number is NOT the invoice amount. Look elsewhere.
  - Numbers next to the words "оплате", "к оплате", "amount due", "total payable", "итого" are the real amount.

Output ONLY valid JSON:
{
  "classification": "service" | "purchase" | "sale_payment" | "not_invoice" | "unclear",
  "confidence": 0.0-1.0,
  "buyer_entity": "DEE" | "DEI" | "DEASEAN" | "DEC" | null,
  "vendor_name": string | null,
  "vendor_tax_id": string | null,
  "vendor_country": string | null,
  "vendor_address": string | null,
  "vendor_email": string | null,
  "service_category": string | null,
  "shipment_ref": string | null,
  "service_subtype": string | null,
  "invoice_no": string | null,
  "invoice_date": "YYYY-MM-DD" | null,
  "period": string | null,
  "currency": string | null,
  "amount_total": number | null,
  "amount_excl_vat": number | null,
  "vat_amount": number | null,
  "bank_name": string | null,
  "bank_account": string | null,
  "iban": string | null,
  "swift": string | null,
  "line_items": [{"description": string, "line_total": number}],
  "notes": string
}`;

interface IngestionStats {
  threads_found: number;
  pdfs_processed: number;
  inserted: number;
  auto_rejected: number;
  auto_attached: number;       // matched at high confidence, attached to existing operation
  suggested: number;           // matched at low confidence, awaits user click
  duplicates: number;
  errors: number;
  invoices_added: Array<{
    vendor: string | null;
    amount: number | null;
    currency: string | null;
    auto_attached_to?: string | null;       // operation reference, e.g. "DEE-547"
    suggested_match?: string | null;        // operation reference + % e.g. "DEE-547 (75%)"
  }>;
}

export async function runInboxIngestion(env: Env): Promise<IngestionStats> {
  const stats: IngestionStats = {
    threads_found: 0,
    pdfs_processed: 0,
    inserted: 0,
    auto_rejected: 0,
    auto_attached: 0,
    suggested: 0,
    duplicates: 0,
    errors: 0,
    invoices_added: [],
  };

  console.log('[inbox-cron] starting daily invoice ingestion');

  // Step 1: Collect candidates from emailer-bridge (keyword queries).
  // skip_attachments=true means we get only metadata — actual PDF downloads happen
  // per-attachment in Step 2 below, after dedup. Avoids the 100s bridge timeout
  // when keyword queries match threads with many embedded inline images.
  const allThreads = new Map<string, any>();
  for (const queryTerm of SEARCH_QUERIES) {
    try {
      const findResult = await callEmailer(env, {
        action: 'find',
        query: `has:attachment newer_than:2d (${queryTerm})`,
        max_results: 4,
        skip_attachments: true,
      });
      const threads = findResult?.threads || [];
      for (const t of threads) {
        if (!t.thread_id) continue;
        // Treat keyword-matched threads the same way as watchlist threads:
        // store metadata for per-PDF download in Step 2 (uniform code path).
        allThreads.set(t.thread_id, {
          ...t,
          is_watchlist: false,
          attachments_meta: t.attachments_meta || [],
        });
      }
    } catch (e) {
      console.error(`[inbox-cron] find failed for query "${queryTerm}":`, e);
      stats.errors++;
    }
  }

  stats.threads_found = allThreads.size;
  console.log(`[inbox-cron] ${allThreads.size} unique threads collected from keyword queries`);

  // Step 1b: WATCHLIST scan — metadata-only find then per-attachment download.
  // skip_attachments=true makes find return in ~5s instead of timing out on
  // bridge after 100s when many threads/files match. Pass 2 (in Step 2 below)
  // downloads each fresh attachment individually via the `download_attachment`
  // action. Dedup check happens before download to avoid re-uploading R2 keys.
  for (const sender of WATCHLIST_SENDERS) {
    try {
      const findResult = await callEmailer(env, {
        action: 'find',
        query: `from:${sender} has:attachment newer_than:${WATCHLIST_WINDOW_DAYS}d`,
        max_results: 20,
        skip_attachments: true,
      });
      const threads = findResult?.threads || [];
      for (const t of threads) {
        if (!t.thread_id) continue;
        const existing = allThreads.get(t.thread_id);
        // attachments_meta (from skip_attachments mode) replaces attachments_resolved.
        // Downstream code below normalizes this in Step 2.
        allThreads.set(t.thread_id, {
          ...(existing || t),
          is_watchlist: true,
          watchlist_sender: sender,
          attachments_meta: t.attachments_meta || [],
        });
      }
    } catch (e) {
      console.error(`[inbox-cron] watchlist find failed for ${sender}:`, e);
      stats.errors++;
    }
  }

  const watchlistCount = Array.from(allThreads.values()).filter((t: any) => t.is_watchlist).length;
  console.log(`[inbox-cron] total ${allThreads.size} threads (${watchlistCount} from watchlist)`);

  // Step 2: Build PDF candidate list
  const candidates: Array<{
    thread_id: string;
    subject: string;
    from: string;
    snippet: string;
    filename: string;
    r2_url: string;
    r2_key: string;
    mime_type: string;
    is_watchlist: boolean;
    watchlist_sender?: string;
  }> = [];

  for (const t of allThreads.values()) {
    const isWatchlistThread = !!t.is_watchlist;

    // Pre-resolved attachments (non-watchlist keyword path) come through `attachments_resolved`.
    for (const a of t.attachments_resolved || []) {
      if (!a.r2_url) continue;
      const isPdf = a.mime_type === 'application/pdf';
      const isTxt = a.mime_type === 'text/plain';
      const isSheet = isSheetMime(a.mime_type);
      const accept = isPdf || (isWatchlistThread && (isTxt || isSheet));
      if (!accept) continue;
      const r2Key = a.r2_url.includes('.r2.dev/') ? a.r2_url.split('.r2.dev/')[1] : a.r2_url;
      candidates.push({
        thread_id: t.thread_id,
        subject: t.subject || '',
        from: t.last_message_from || '',
        snippet: (t.last_message_snippet || '').slice(0, 500),
        filename: a.filename,
        r2_url: a.r2_url,
        r2_key: r2Key,
        mime_type: a.mime_type || 'application/octet-stream',
        is_watchlist: isWatchlistThread,
        watchlist_sender: t.watchlist_sender,
      });
    }

    // Metadata-only attachments (watchlist path with skip_attachments) — download each
    // fresh PDF/TXT individually. Skip if attachment_filename + thread_id already in DB.
    for (const meta of t.attachments_meta || []) {
      const isPdf = (meta.mime_type || '').startsWith('application/pdf');
      const isTxt = meta.mime_type === 'text/plain';
      const isSheet = isSheetMime(meta.mime_type);
      const accept = isPdf || (isWatchlistThread && (isTxt || isSheet));
      if (!accept) continue;

      // Skip if the (filename, thread_id) pair is already in invoice_inbox — dedup
      // before hitting Apps Script. Massively reduces wasted download_attachment calls.
      const exists = await env.DB.prepare(
        'SELECT 1 FROM invoice_inbox WHERE attachment_filename = ? AND gmail_thread_id = ? LIMIT 1'
      ).bind(meta.filename, t.thread_id).first<any>();
      if (exists) {
        stats.duplicates++;
        continue;
      }

      // Resolve via download_attachment — this uploads to R2 and returns the URL.
      let dl: any = null;
      try {
        dl = await callEmailer(env, {
          action: 'download_attachment',
          message_id: meta.message_id,
          attachment_name: meta.filename,
        });
      } catch (e) {
        console.error(`[inbox-cron] download failed for ${meta.filename}:`, e);
        stats.errors++;
        continue;
      }
      if (!dl || !dl.success || !dl.r2_url) {
        console.error(`[inbox-cron] download skipped/failed for ${meta.filename}: ${dl?.skipped_reason || dl?.error || 'unknown'}`);
        stats.errors++;
        continue;
      }
      const r2Key = dl.r2_url.includes('.r2.dev/') ? dl.r2_url.split('.r2.dev/')[1] : dl.r2_url;
      candidates.push({
        thread_id: t.thread_id,
        subject: t.subject || '',
        from: meta.message_from || t.last_message_from || '',
        snippet: (t.last_message_snippet || '').slice(0, 500),
        filename: meta.filename,
        r2_url: dl.r2_url,
        r2_key: r2Key,
        mime_type: meta.mime_type || 'application/octet-stream',
        is_watchlist: isWatchlistThread,
        watchlist_sender: t.watchlist_sender,
      });
    }
  }

  // Watchlist candidates (Yandex Pay reports, accountants, landlord) jump the
  // queue — they must never be starved by the keyword-matched flood.
  candidates.sort((a, b) => Number(b.is_watchlist) - Number(a.is_watchlist));

  console.log(`[inbox-cron] ${candidates.length} candidates (max ${MAX_PROCESS_PER_RUN} per run)`);

  // Step 3: Process each — bounded by MAX_PROCESS_PER_RUN and SOFT_BUDGET_MS
  const startMs = Date.now();
  let processedThisRun = 0;
  for (const c of candidates) {
    if (processedThisRun >= MAX_PROCESS_PER_RUN) {
      console.log(`[inbox-cron] hit MAX_PROCESS_PER_RUN=${MAX_PROCESS_PER_RUN}; deferring rest to next run`);
      break;
    }
    if (Date.now() - startMs > SOFT_BUDGET_MS) {
      console.log(`[inbox-cron] hit SOFT_BUDGET_MS=${SOFT_BUDGET_MS}ms after ${processedThisRun} PDFs; deferring`);
      break;
    }
    try {
      // Dedup: skip if filename + thread already in DB
      const exists = await env.DB.prepare(
        'SELECT id FROM invoice_inbox WHERE attachment_filename = ? AND gmail_thread_id = ?'
      ).bind(c.filename, c.thread_id).first<any>();

      if (exists) {
        stats.duplicates++;
        continue;
      }
      processedThisRun++;

      stats.pdfs_processed++;

      // Download attachment from R2
      const buf = await fetchPdf(c.r2_url);
      if (!buf) {
        console.error(`[inbox-cron] failed to download ${c.filename}`);
        stats.errors++;
        continue;
      }

      // Extract text: pdf via regex strip; txt / csv / plain reports via UTF-8 decode.
      // Yandex Pay & RetailCRM sales/payment reports arrive as .csv — they are
      // just delimited text, so we read them straight and hand to DeepSeek.
      const mt = (c.mime_type || '').toLowerCase();
      const isCsvLike = mt === 'text/csv' || mt === 'application/csv' || (c.filename || '').toLowerCase().endsWith('.csv');
      let text = '';
      if (mt === 'application/pdf') {
        text = await extractPdfText(buf);
      } else if (mt === 'text/plain' || isCsvLike) {
        text = new TextDecoder('utf-8', { fatal: false }).decode(buf).slice(0, 50000);
      }

      // Classify: for PDFs use Claude vision first (reads tabular invoice
      // amounts natively); on failure fall back to DeepSeek with extracted text.
      let extracted: any = null;
      if (c.mime_type === 'application/pdf') {
        try {
          extracted = await classifyViaClaude(env, buf, c);
        } catch (claudeErr) {
          console.error(`[inbox-cron] Claude classify threw for ${c.filename}:`, claudeErr);
        }
      }
      if (!extracted) {
        extracted = await deepseekClassify(env, text, c);
      }
      if (!extracted) {
        stats.errors++;
        continue;
      }

      // Watchlist bypass: critical senders never auto-reject; everything lands
      // as needs_review for Aram to triage manually.
      const isAutoReject = c.is_watchlist
        ? false
        : (
          extracted.classification === 'sale_payment' ||
          extracted.classification === 'not_invoice' ||
          (extracted.classification === 'service' &&
            extracted.service_category === 'Government / Tax' &&
            !extracted.amount_total)
        );

      const status = c.is_watchlist
        ? 'needs_review'
        : (isAutoReject ? 'manual_rejected' : 'needs_partner_link');

      let notes = isAutoReject
        ? `Auto-rejected by cron: ${extracted.classification} (${extracted.notes || 'no amount or sale_payment'})`
        : (extracted.notes || '');

      if (c.is_watchlist) {
        notes = `[WATCHLIST: ${c.watchlist_sender || c.from}] ${notes}`.slice(0, 1000);
      }

      // Map LLM classification to schema CHECK values
      let cls = extracted.classification;
      if (cls === 'unclear') cls = 'pending';

      // Insert
      const invId = await insertInbox(env, c, extracted, text, cls, status, notes);

      if (isAutoReject) {
        stats.auto_rejected++;
        continue;
      }

      stats.inserted++;
      const item = {
        vendor: extracted.vendor_name,
        amount: extracted.amount_total,
        currency: extracted.currency,
        auto_attached_to: null as string | null,
        suggested_match: null as string | null,
      };

      // -------------------------------------------------------------------
      // Watchlist auto-operation: for 253@bkmsk.ru (ALFA KLASS) and
      // zukonar@mail.ru (PRIZ) the invoice IS the operation — they don't
      // issue acts. If we can identify a known partner from vendor INN,
      // spawn a service-purchase operation right now. Pass-through invoices
      // (НДС/взносы/dividends from third parties) won't match the INN map
      // and stay as needs_review for manual handling.
      // -------------------------------------------------------------------
      // Yandex Pay site sales: the CSV report IS a daily Sale operation.
      // finance@pay.yandex.ru → DASR-DAY-YYYYMMDD (Option A, one op per file/day).
      const fromAddr = String(c.from || '').toLowerCase();
      const isYandexPay = fromAddr.includes('finance@pay.yandex.ru')
        || (c.watchlist_sender || '').toLowerCase() === 'finance@pay.yandex.ru';
      if (isYandexPay && text) {
        try {
          const saleOp = await createDailySaleFromYandexCsv(env, invId, text, c.filename);
          if (saleOp) {
            item.auto_attached_to = saleOp.reference;
            item.amount = saleOp.grossRevenue;
            item.currency = saleOp.currency;
            console.log(`[inbox-cron] yandex daily sale ${saleOp.reference} (${saleOp.orderCount} orders, ${saleOp.grossRevenue} RUB) for ${invId}`);
            stats.auto_attached++;
            stats.invoices_added.push(item);
            continue;
          }
        } catch (ySaleErr) {
          console.error(`[inbox-cron] yandex daily-sale failed for ${invId}:`, ySaleErr);
        }
      }

      if (c.is_watchlist) {
        try {
          const autoOp = await tryAutoCreateWatchlistOperation(env, invId, extracted, text);
          if (autoOp) {
            item.auto_attached_to = autoOp.reference;
            item.amount = autoOp.amount;
            item.currency = autoOp.currency;
            console.log(`[inbox-cron] watchlist auto-created op ${autoOp.operationId} (#${autoOp.reference}, ${autoOp.amount} ${autoOp.currency}) for ${invId}`);
            stats.auto_attached++;
            stats.invoices_added.push(item);
            continue; // skip generic auto-match — operation already wired
          }
        } catch (autoErr) {
          console.error(`[inbox-cron] watchlist auto-create failed for ${invId}:`, autoErr);
        }
      }

      // -------------------------------------------------------------------
      // Auto-match step. Try to find a matching operation. If confidence
      // is high enough for this classification, auto-attach right now.
      // Otherwise store the suggestion so the UI can show a 1-click button.
      // Failures here are non-fatal — the row stays in needs_partner_link.
      // -------------------------------------------------------------------
      try {
        const inboxRow = await env.DB.prepare(
          `SELECT id, classification, extracted_vendor_name, extracted_vendor_inn,
                  extracted_vendor_email, extracted_invoice_no, extracted_invoice_date,
                  extracted_our_invoice_ref, extracted_currency, extracted_amount,
                  extracted_buyer_entity, attachment_text_extracted, matched_partner_id,
                  extracted_shipment_ref, extracted_service_subtype,
                  attachment_r2_key, attachment_filename, email_subject, email_from
             FROM invoice_inbox WHERE id = ?`
        ).bind(invId).first<any>();

        if (inboxRow) {
          const match = await findMatchingOperation(inboxRow, env);
          const outcome = await applyMatchToInbox(inboxRow, match, env);

          if (outcome.kind === 'auto_attached') {
            stats.auto_attached++;
            item.auto_attached_to = outcome.match.operation_reference;
            console.log(`[inbox-cron] auto-attached ${invId} → ${outcome.match.operation_reference} (${(outcome.match.confidence * 100).toFixed(0)}%)`);
          } else if (outcome.kind === 'suggested') {
            stats.suggested++;
            item.suggested_match = `${outcome.match.operation_reference} (${(outcome.match.confidence * 100).toFixed(0)}%)`;
          }
        }
      } catch (matchErr) {
        console.error(`[inbox-cron] auto-match failed for ${invId}:`, matchErr);
      }

      stats.invoices_added.push(item);
    } catch (e) {
      console.error(`[inbox-cron] processing failed for ${c.filename}:`, e);
      stats.errors++;
    }
  }

  console.log(`[inbox-cron] done: inserted=${stats.inserted}, auto_rejected=${stats.auto_rejected}, dupes=${stats.duplicates}, errors=${stats.errors}`);

  // Step 4: Send daily summary email if anything new
  if (stats.inserted > 0 || stats.auto_rejected > 0) {
    try {
      await sendDailySummary(env, stats);
    } catch (e) {
      console.error('[inbox-cron] failed to send summary email:', e);
    }
  }

  return stats;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function callEmailer(env: Env, body: any): Promise<any> {
  // Use service binding — direct Worker-to-Worker call inside Cloudflare,
  // no HTTP round-trip, no 1042 loop error. The path doesn't matter; the
  // emailer-bridge Worker has a single root handler.
  const r = await env.EMAILER.fetch('https://emailer/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(100_000),
  });
  return r.json();
}

export async function fetchPdf(url: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    return await r.arrayBuffer();
  } catch {
    return null;
  }
}

// Crude PDF text extraction for Worker environment (no native pdftotext).
// Strategy: scan for printable text patterns in the binary stream. Works for
// uncompressed text PDFs (most invoices). For image-only / encrypted PDFs,
// returns empty and DeepSeek falls back on email metadata.
async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const raw = decoder.decode(bytes);

  // Look for text inside (...) which is the PDF text-showing operator
  const matches: string[] = [];
  const regex = /\((.*?)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    matches.push(m[1]);
  }

  // Also try BT/ET text blocks (block text)
  const btRegex = /BT\s+([\s\S]*?)\s+ET/g;
  while ((m = btRegex.exec(raw)) !== null) {
    const block = m[1];
    const inner = /\((.*?)\)/g;
    let mm: RegExpExecArray | null;
    while ((mm = inner.exec(block)) !== null) {
      matches.push(mm[1]);
    }
  }

  return matches.join(' ').slice(0, 8000);
}

export async function deepseekClassify(env: Env, text: string, c: any): Promise<any> {
  const userMsg = `Email metadata:
- from: ${c.from}
- subject: ${c.subject}
- filename: ${c.filename}
- snippet: ${c.snippet.slice(0, 300)}

PDF text (extracted):
${text || '(empty — PDF text extraction failed, classify based on metadata only)'}`;

  try {
    const res = await callPro(
      [
        { role: 'system', content: DEEPSEEK_PROMPT },
        { role: 'user', content: userMsg },
      ],
      { env, temperature: 0 },
    );
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

// =============================================================================
// classifyViaClaude — sends the raw PDF binary to Anthropic's Claude API as a
// `document` content block. Claude reads PDFs natively (text + tabular layout),
// so it succeeds at amount extraction where regex-based PDF text stripping
// fails. Used for watchlist invoices first; falls back to DeepSeek on any
// error (HTTP failure, parse failure, quota).
// =============================================================================
export async function classifyViaClaude(env: Env, pdfBuf: ArrayBuffer, c: any): Promise<any> {
  // Base64-encode PDF (shared by Gemini + Claude paths)
  const bytes = new Uint8Array(pdfBuf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);

  const sizeMb = bytes.byteLength / (1024 * 1024);
  if (sizeMb > 28) {
    console.log(`[inbox-cron] PDF too large (${sizeMb.toFixed(1)} MB), skipping`);
    return null;
  }

  const userMsg = `Email metadata:
- from: ${c.from}
- subject: ${c.subject}
- filename: ${c.filename}
- snippet: ${(c.snippet || '').slice(0, 300)}

The attached PDF is an invoice/УПД/счёт. Extract all fields per the schema.`;

  const stripFences = (t: string): string =>
    t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // PRIMARY: Gemini 3.5 Flash multimodal — email/inbox task model (per Aram 2026-06-10).
  if (env.GEMINI_API_KEY) {
    try {
      const g = await callGeminiPdf(DEEPSEEK_PROMPT, userMsg, b64, {
        apiKey: env.GEMINI_API_KEY,
        maxTokens: 2500,
        temperature: 0.2,
      });
      return JSON.parse(stripFences(g.text));
    } catch (ge) {
      console.warn('[inbox-cron:gemini] failed, falling back to Claude:', ge);
    }
  }

  // FALLBACK: Claude Sonnet (OAuth) multimodal — only if Gemini unavailable/failed.
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    console.log('[inbox-cron] no Gemini result and CLAUDE_CODE_OAUTH_TOKEN not set; skipping');
    return null;
  }
  try {
    const data: any = await callAnthropicRaw({
      oauthToken: token,
      model: 'claude-sonnet-4-6',
      maxTokens: 2500,
      system: DEEPSEEK_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
            { type: 'text', text: userMsg },
          ],
        },
      ],
    });
    const textBlock = (data.content || []).find((b: any) => b.type === 'text');
    if (!textBlock) return null;
    return JSON.parse(stripFences(String(textBlock.text || '').trim()));
  } catch (e) {
    console.error('[inbox-cron:claude] error:', e);
    return null;
  }
}

async function insertInbox(env: Env, c: any, e: any, text: string, cls: string, status: string, notes: string): Promise<string> {
  const invId = `inv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Math.floor(Date.now() / 1000);
  const lineItemsJson = JSON.stringify(e.line_items || []);
  const msgId = `gmail_${c.thread_id}_${c.filename.slice(0, 50)}`;

  await env.DB.prepare(
    `INSERT INTO invoice_inbox (
      id, gmail_message_id, gmail_thread_id, email_from, email_subject,
      email_received_at, email_snippet,
      attachment_filename, attachment_r2_key, attachment_content_type, attachment_text_extracted,
      classification, classification_confidence,
      extracted_vendor_name, extracted_vendor_inn,
      extracted_invoice_no, extracted_invoice_date, extracted_period,
      extracted_currency, extracted_amount, extracted_line_items_json,
      extracted_vendor_email, extracted_vendor_country, extracted_vendor_address,
      extracted_bank_name, extracted_bank_account, extracted_iban, extracted_swift,
      extracted_service_category, extracted_buyer_entity, extracted_shipment_ref, extracted_service_subtype,
      status, notes, created_at, processed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    invId, msgId, c.thread_id, c.from.slice(0, 255), (c.subject || '').slice(0, 255),
    now, c.snippet.slice(0, 500),
    c.filename.slice(0, 255), c.r2_key.slice(0, 500), c.mime_type || 'application/pdf', text.slice(0, 50000),
    cls, e.confidence ?? null,
    e.vendor_name || null, e.vendor_tax_id || null,
    e.invoice_no || null, e.invoice_date || null, e.period || null,
    e.currency || null, e.amount_total ?? null, lineItemsJson,
    e.vendor_email || null, e.vendor_country || null, e.vendor_address || null,
    e.bank_name || null, e.bank_account || null, e.iban || null, e.swift || null,
    e.service_category || null, e.buyer_entity || null, e.shipment_ref || null, e.service_subtype || null,
    status, notes, now, now,
  ).run();

  return invId;
}

async function sendDailySummary(env: Env, stats: IngestionStats) {
  const lines = [
    `Daily Inbox ingestion complete (${new Date().toISOString().slice(0, 10)})`,
    '',
    `Threads scanned: ${stats.threads_found}`,
    `PDFs processed: ${stats.pdfs_processed}`,
    `New invoices in queue: ${stats.inserted}`,
    `  · auto-attached to existing op: ${stats.auto_attached}`,
    `  · with suggested match (1-click): ${stats.suggested}`,
    `  · need manual selection: ${stats.inserted - stats.auto_attached - stats.suggested}`,
    `Auto-rejected (settlement / informational / no amount): ${stats.auto_rejected}`,
    `Already known (skipped): ${stats.duplicates}`,
    `Errors: ${stats.errors}`,
    '',
  ];

  if (stats.invoices_added.length > 0) {
    const autoAttached = stats.invoices_added.filter(i => i.auto_attached_to);
    const suggested = stats.invoices_added.filter(i => !i.auto_attached_to && i.suggested_match);
    const orphans = stats.invoices_added.filter(i => !i.auto_attached_to && !i.suggested_match);

    if (autoAttached.length > 0) {
      lines.push('Auto-attached (already linked):');
      for (const inv of autoAttached) {
        const amt = inv.amount !== null ? `${inv.amount} ${inv.currency || ''}` : '—';
        lines.push(`  ✓ ${inv.vendor || '?'}: ${amt} → ${inv.auto_attached_to}`);
      }
      lines.push('');
    }

    if (suggested.length > 0) {
      lines.push('Suggested matches (1-click in /inbox):');
      for (const inv of suggested) {
        const amt = inv.amount !== null ? `${inv.amount} ${inv.currency || ''}` : '—';
        lines.push(`  ? ${inv.vendor || '?'}: ${amt} → ${inv.suggested_match}`);
      }
      lines.push('');
    }

    if (orphans.length > 0) {
      lines.push('Need manual selection:');
      for (const inv of orphans) {
        const amt = inv.amount !== null ? `${inv.amount} ${inv.currency || ''}` : '—';
        lines.push(`  • ${inv.vendor || '?'}: ${amt}`);
      }
      lines.push('');
    }

    lines.push('Open: https://dasoperator.pages.dev/inbox');
  } else {
    lines.push('No new invoices today.');
  }

  await callEmailer(env, {
    action: 'send',
    to: 'dasexperten@gmail.com',
    subject: `Inbox: ${stats.inserted} new (${stats.auto_attached} auto-attached, ${stats.suggested} suggested) · ${new Date().toISOString().slice(0, 10)}`,
    body: lines.join('\n'),
  });
}

// =============================================================================
// Watchlist auto-create: spawn a service-purchase operation directly from an
// invoice_inbox row when the vendor is a known watchlist counterparty whose
// invoices are not followed by separate acts (bkmsk accountants, zukonar
// landlord). Returns null when we can't safely auto-create — caller then
// leaves the row as needs_review for manual confirm.
// =============================================================================
async function tryAutoCreateWatchlistOperation(
  env: Env,
  invId: string,
  extracted: any,
  pdfText: string,
): Promise<{ operationId: string; reference: string; amount: number; currency: string } | null> {
  // 1. Resolve partner by extracted vendor INN.
  const inn = String(extracted?.vendor_tax_id || '').replace(/[^0-9]/g, '');
  const mapped = WATCHLIST_VENDOR_MAP[inn];
  if (!mapped) {
    console.log(`[inbox-cron] watchlist auto-create skipped: unknown vendor_inn="${inn}" for ${invId}`);
    return null;
  }

  // 2. Need amount. Use DeepSeek-extracted first; fall back to regex from PDF text.
  let amount: number | null = null;
  if (typeof extracted.amount_total === 'number' && extracted.amount_total > 0) {
    amount = extracted.amount_total;
  } else if (pdfText) {
    // Look for "Всего к оплате:  29 100,00" / "Итого:  5 830,00" style totals.
    const m = pdfText.match(/(?:Всего к оплате|Итого)[^0-9\-]{0,12}([\d\u00A0 .,]+)/i);
    if (m) {
      const cleaned = m[1].replace(/[\u00A0\s]/g, '').replace(',', '.');
      const num = parseFloat(cleaned);
      if (Number.isFinite(num) && num > 0) amount = num;
    }
  }
  if (amount === null) {
    console.log(`[inbox-cron] watchlist auto-create skipped: no amount extractable for ${invId}`);
    return null;
  }

  // 3. Invoice number — DeepSeek first, then regex fallback.
  let invoiceNo: string | null = extracted?.invoice_no ? String(extracted.invoice_no) : null;
  if (!invoiceNo && pdfText) {
    const m = pdfText.match(/Сч[её]т\s+на\s+оплату\s*№\s*([\w\-\/.]+)/i);
    if (m) invoiceNo = m[1].slice(0, 50);
  }
  const reference = (invoiceNo || `INBOX-${invId.slice(-8)}`).slice(0, 80);

  // 4. Currency, defaulting to RUB for these RU vendors.
  const currency = String(extracted?.currency || 'RUB').toUpperCase().slice(0, 3);

  // 5. Invoice date → operation_date.
  const now = Math.floor(Date.now() / 1000);
  let opDate = now;
  if (extracted?.invoice_date) {
    const t = new Date(String(extracted.invoice_date)).getTime();
    if (Number.isFinite(t) && t > 0) opDate = Math.floor(t / 1000);
  }

  // 6. Discover operations columns dynamically — schema may have evolved.
  const operationId = `op_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const cols = await env.DB.prepare(
    "SELECT name FROM pragma_table_info('operations')"
  ).all<{ name: string }>();
  const colSet = new Set((cols.results ?? []).map((r) => r.name));

  const fields: string[] = ['id', 'partner_id', 'operation_type', 'our_company_id',
    'operation_date', 'status', 'currency', 'total_amount', 'created_at', 'updated_at'];
  const values: any[] = [operationId, mapped.partnerId, 'service', mapped.buyer,
    opDate, 'issued', currency, amount, now, now];

  if (colSet.has('reference')) { fields.push('reference'); values.push(reference); }
  if (colSet.has('notes')) {
    fields.push('notes');
    values.push(`[WATCHLIST AUTO] Service invoice — inbox ${invId}`.slice(0, 500));
  }

  const placeholders = fields.map(() => '?').join(',');
  await env.DB.prepare(
    `INSERT INTO operations (${fields.join(',')}) VALUES (${placeholders})`
  ).bind(...values).run();

  // 7. Update inbox row: mark as auto_created, attach partner + operation,
  // fill in any extracted_* gaps we resolved via regex.
  await env.DB.prepare(
    `UPDATE invoice_inbox SET
       status = 'auto_created',
       matched_partner_id = ?,
       created_operation_id = ?,
       extracted_amount = COALESCE(extracted_amount, ?),
       extracted_invoice_no = COALESCE(extracted_invoice_no, ?),
       extracted_currency = COALESCE(extracted_currency, ?),
       resolved_at = ?
     WHERE id = ?`
  ).bind(mapped.partnerId, operationId, amount, invoiceNo, currency, now, invId).run();

  return { operationId, reference, amount, currency };
}
