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

const EMAILER_BRIDGE = 'https://emailer-bridge.dasexperten.workers.dev/';
const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';
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

const DEEPSEEK_PROMPT = `You are an invoice classifier for Das Experten (multi-entity company).
Entities: DEE (Russia), DEI (UAE), DEASEAN (Vietnam), DEC (Seychelles).

Classify into one of:
  - "service" — vendor billing for service (accounting, hosting, ads, banking, certification, gov tax)
  - "purchase" — supplier billing for goods/products
  - "sale_payment" — settlement/agent report from marketplace selling OUR goods (Магнит/WB/Ozon УПД/УКД/Отчёт агента)
  - "not_invoice" — newsletter, marketing, info letter, presentation, КП
  - "unclear"

Service category (if service): "Accounting & Bookkeeping" / "Legal & Compliance" / "Hosting & Cloud" / "Software / SaaS" / "Banking & Financial Services" / "Advertising & Marketing" / "Logistics / Customs" / "Telecommunications" / "Office / Utilities" / "Government / Tax" / "Certification" / "Other"

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
  duplicates: number;
  errors: number;
  invoices_added: Array<{ vendor: string | null; amount: number | null; currency: string | null }>;
}

export async function runInboxIngestion(env: Env): Promise<IngestionStats> {
  const stats: IngestionStats = {
    threads_found: 0,
    pdfs_processed: 0,
    inserted: 0,
    auto_rejected: 0,
    duplicates: 0,
    errors: 0,
    invoices_added: [],
  };

  console.log('[inbox-cron] starting daily invoice ingestion');

  // Step 1: Collect candidates from emailer-bridge
  const allThreads = new Map<string, any>();
  for (const queryTerm of SEARCH_QUERIES) {
    try {
      const findResult = await callEmailer(env, {
        action: 'find',
        query: `has:attachment newer_than:2d (${queryTerm})`,
        max_results: 4,
      });
      const threads = findResult?.threads || [];
      for (const t of threads) {
        if (t.thread_id) allThreads.set(t.thread_id, t);
      }
    } catch (e) {
      console.error(`[inbox-cron] find failed for query "${queryTerm}":`, e);
      stats.errors++;
    }
  }

  stats.threads_found = allThreads.size;
  console.log(`[inbox-cron] ${allThreads.size} unique threads collected`);

  // Step 2: Build PDF candidate list
  const candidates: Array<{
    thread_id: string;
    subject: string;
    from: string;
    snippet: string;
    filename: string;
    r2_url: string;
    r2_key: string;
  }> = [];

  for (const t of allThreads.values()) {
    for (const a of t.attachments_resolved || []) {
      if (a.r2_url && a.mime_type === 'application/pdf') {
        const r2Key = a.r2_url.includes('.r2.dev/') ? a.r2_url.split('.r2.dev/')[1] : a.r2_url;
        candidates.push({
          thread_id: t.thread_id,
          subject: t.subject || '',
          from: t.last_message_from || '',
          snippet: (t.last_message_snippet || '').slice(0, 500),
          filename: a.filename,
          r2_url: a.r2_url,
          r2_key: r2Key,
        });
      }
    }
  }

  console.log(`[inbox-cron] ${candidates.length} PDF candidates`);

  // Step 3: Process each
  for (const c of candidates) {
    try {
      // Dedup: skip if filename + thread already in DB
      const exists = await env.DB.prepare(
        'SELECT id FROM invoice_inbox WHERE attachment_filename = ? AND gmail_thread_id = ?'
      ).bind(c.filename, c.thread_id).first<any>();

      if (exists) {
        stats.duplicates++;
        continue;
      }

      stats.pdfs_processed++;

      // Download PDF from R2
      const pdfBuf = await fetchPdf(c.r2_url);
      if (!pdfBuf) {
        console.error(`[inbox-cron] failed to download ${c.filename}`);
        stats.errors++;
        continue;
      }

      // Extract text — note: Workers can't run pdftotext. We'll send the
      // first 30KB of base64 to DeepSeek along with email metadata, and let
      // it work from snippet + filename + subject. Crude but works for
      // text-bearing PDFs since DeepSeek-chat handles long strings.
      // Better approach: a side-Worker that runs unpdf or pdf-parse.
      // For now: rely on email subject + snippet + filename for classification,
      // and fall back to text extraction via a simple regex strip.
      const text = await extractPdfText(pdfBuf);

      // Classify with DeepSeek
      const extracted = await deepseekClassify(env, text, c);
      if (!extracted) {
        stats.errors++;
        continue;
      }

      // Apply auto-reject rules
      const isAutoReject =
        extracted.classification === 'sale_payment' ||
        extracted.classification === 'not_invoice' ||
        (extracted.classification === 'service' &&
          extracted.service_category === 'Government / Tax' &&
          !extracted.amount_total);

      const status = isAutoReject ? 'manual_rejected' : 'needs_partner_link';
      const notes = isAutoReject
        ? `Auto-rejected by cron: ${extracted.classification} (${extracted.notes || 'no amount or sale_payment'})`
        : extracted.notes || '';

      // Map LLM classification to schema CHECK values
      let cls = extracted.classification;
      if (cls === 'unclear') cls = 'pending';

      // Insert
      await insertInbox(env, c, extracted, text, cls, status, notes);

      if (isAutoReject) {
        stats.auto_rejected++;
      } else {
        stats.inserted++;
        stats.invoices_added.push({
          vendor: extracted.vendor_name,
          amount: extracted.amount_total,
          currency: extracted.currency,
        });
      }
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
  const r = await fetch(EMAILER_BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(100_000),
  });
  return r.json();
}

async function fetchPdf(url: string): Promise<ArrayBuffer | null> {
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

async function deepseekClassify(env: Env, text: string, c: any): Promise<any> {
  const userMsg = `Email metadata:
- from: ${c.from}
- subject: ${c.subject}
- filename: ${c.filename}
- snippet: ${c.snippet.slice(0, 300)}

PDF text (extracted):
${text || '(empty — PDF text extraction failed, classify based on metadata only)'}`;

  const r = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: DEEPSEEK_PROMPT },
        { role: 'user', content: userMsg },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!r.ok) return null;
  const data: any = await r.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return null;
  }
}

async function insertInbox(env: Env, c: any, e: any, text: string, cls: string, status: string, notes: string) {
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
      extracted_service_category, extracted_buyer_entity,
      status, notes, created_at, processed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    invId, msgId, c.thread_id, c.from.slice(0, 255), (c.subject || '').slice(0, 255),
    now, c.snippet.slice(0, 500),
    c.filename.slice(0, 255), c.r2_key.slice(0, 500), 'application/pdf', text.slice(0, 50000),
    cls, e.confidence ?? null,
    e.vendor_name || null, e.vendor_tax_id || null,
    e.invoice_no || null, e.invoice_date || null, e.period || null,
    e.currency || null, e.amount_total ?? null, lineItemsJson,
    e.vendor_email || null, e.vendor_country || null, e.vendor_address || null,
    e.bank_name || null, e.bank_account || null, e.iban || null, e.swift || null,
    e.service_category || null, e.buyer_entity || null,
    status, notes, now, now,
  ).run();
}

async function sendDailySummary(env: Env, stats: IngestionStats) {
  const lines = [
    `Daily Inbox ingestion complete (${new Date().toISOString().slice(0, 10)})`,
    '',
    `Threads scanned: ${stats.threads_found}`,
    `PDFs processed: ${stats.pdfs_processed}`,
    `New invoices in queue: ${stats.inserted}`,
    `Auto-rejected (settlement reports / informational / no amount): ${stats.auto_rejected}`,
    `Already known (skipped): ${stats.duplicates}`,
    `Errors: ${stats.errors}`,
    '',
  ];

  if (stats.invoices_added.length > 0) {
    lines.push('New invoices waiting for Yes/No:');
    for (const inv of stats.invoices_added) {
      const amt = inv.amount !== null ? `${inv.amount} ${inv.currency || ''}` : '—';
      lines.push(`  • ${inv.vendor || '?'}: ${amt}`);
    }
    lines.push('');
    lines.push('Open: https://dasoperator.pages.dev/inbox');
  } else {
    lines.push('No new invoices today.');
  }

  await callEmailer(env, {
    action: 'send',
    to: 'dasexperten@gmail.com',
    subject: `Inbox: ${stats.inserted} new, ${stats.auto_rejected} auto-rejected (${new Date().toISOString().slice(0, 10)})`,
    body: lines.join('\n'),
  });
}
