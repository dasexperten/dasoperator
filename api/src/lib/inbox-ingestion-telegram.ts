// =============================================================================
// Inbox ingestion — Telegram chat → R2 → DeepSeek → invoice_inbox pipeline
// =============================================================================
//
// Aram law (2026-05-15):
//   From the F4 Lyubertsy operations chat (-1002848395508) we extract ONLY:
//     • Счета на оплату (invoices) → classification='service' or 'purchase'
//     • Акты выполненных работ (acceptance) → classification='acceptance'
//   We DO NOT extract from this chat:
//     • F4-WH-R-XXXXXX transfer operations (come from Skladbot API)
//     • WH-R-XXXXXX intake requests
//     • Coordination chatter
//
// Workflow:
//   1. For each active operation_document_sources WHERE source_type='telegram_contact':
//      a. Compute high-water mark = MAX(telegram_msg_id) in invoice_inbox for this chat
//      b. Fetch new messages via telegramer-bridge /chat/{address}/media-history
//      c. For each new media message:
//         - download file via /get-file
//         - upload to R2 at telegram_inbox/{chat_id}/{msg_id}-{filename}
//         - extract text (rough PDF/image)
//         - skip operational garbage (regex: F4-WH-R-, WH-R-, etc.)
//         - DeepSeek classify
//         - insert into invoice_inbox with source_type='telegram'
//   2. Auto-match against existing operations (same logic as Gmail path)
//
// Cron: '*/15 * * * *' — every 15 minutes (telegram is high-frequency vs daily Gmail).
// =============================================================================

import type { Env } from '../types';
import { findMatchingOperation, applyMatchToInbox } from './inbox-auto-match';

const TELEGRAMER_BRIDGE = 'https://telegramer-bridge.dasexperten.workers.dev';
// Direct VPS endpoints (Worker→VPS via sslip.io DNS).
// Bridge proxies basic ops (/chat/{contact}/history) but not /chat/media-history or /get-file,
// so we hit the VPS directly using the same Bearer secret.
const VPS_BASE_URL = 'http://178-105-129-200.sslip.io:8000';
const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';

// Reuse Gmail prompt, but add 'acceptance' as a possible classification.
const DEEPSEEK_PROMPT_TG = `You are a document classifier for Das Experten (multi-entity company).
Entities: DEE (Russia), DEI (UAE), DEASEAN (Vietnam), DEC (Seychelles).

Input is a document attached in a Telegram chat with our logistics provider.
The chat is used for both operational coordination AND for sending us invoices/acceptance documents.

Classify into one of:
  - "service" — vendor billing for service (logistics, 3PL, fulfilment, accounting, hosting)
  - "purchase" — supplier billing for goods/products
  - "acceptance" — акт выполненных работ / acceptance certificate confirming a service was delivered
  - "sale_payment" — settlement/agent report from marketplace selling OUR goods
  - "not_invoice" — operational message, screenshot, photo, info letter, presentation
  - "unclear"

CRITICAL: any document that contains the words "F4-WH-R", "WH-R-", "приемка", "перечень работ",
"Согласование", "забор груза", "доставка на склад МП" without a numeric amount line and a recipient
banking line is OPERATIONAL — classify as "not_invoice".

Service category (if service): "Accounting & Bookkeeping" / "Legal & Compliance" / "Hosting & Cloud" / "Software / SaaS" / "Banking & Financial Services" / "Advertising & Marketing" / "Logistics / Customs" / "Telecommunications" / "Office / Utilities" / "Government / Tax" / "Certification" / "Other"

Output ONLY valid JSON:
{
  "classification": "service" | "purchase" | "acceptance" | "sale_payment" | "not_invoice" | "unclear",
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

interface TelegramSource {
  id: string;
  address: string;
  company_id: string;
  notes: string | null;
  default_partner_id: string | null;
}

interface TelegramMessage {
  tg_msg_id: number;
  topic_id: number | null;
  sender_id: number | null;
  sender_username: string | null;
  sender_name?: string | null;
  sent_at: string | null;
  text: string | null;
  has_media: boolean;
  // VPS media-history returns this lightweight shape; actual file
  // bytes are fetched separately by (chat_id, tg_msg_id) through /get-file.
  media: {
    filename: string | null;
    mime_type: string | null;
    size: number | null;
  } | null;
}

interface TelegramIngestionStats {
  sources_checked: number;
  new_messages: number;
  files_downloaded: number;
  classified: number;
  inserted: number;
  auto_rejected: number;
  auto_attached: number;
  suggested: number;
  duplicates: number;
  errors: number;
  per_source: Array<{ chat_id: string; new: number; inserted: number }>;
}

export interface TelegramIngestionOptions {
  offsetId?: number;
  ignoreHwm?: boolean;
}

export async function runInboxIngestionTelegram(
  env: Env,
  opts: TelegramIngestionOptions = {}
): Promise<TelegramIngestionStats> {
  const stats: TelegramIngestionStats = {
    sources_checked: 0,
    new_messages: 0,
    files_downloaded: 0,
    classified: 0,
    inserted: 0,
    auto_rejected: 0,
    auto_attached: 0,
    suggested: 0,
    duplicates: 0,
    errors: 0,
    per_source: [],
  };

  console.log('[tg-inbox] starting Telegram inbox ingestion');

  // Step 1: list active Telegram sources
  const sources = await env.DB.prepare(
    `SELECT id, address, company_id, notes, default_partner_id
       FROM operation_document_sources
      WHERE source_type = 'telegram_contact'
        AND is_active = 1
        AND deleted_at IS NULL`
  ).all<TelegramSource>();

  stats.sources_checked = sources.results.length;

  if (!stats.sources_checked) {
    console.log('[tg-inbox] no active telegram sources');
    return stats;
  }

  const bridgeSecret = env.TELEGRAMER_BRIDGE_SECRET;
  if (!bridgeSecret) {
    console.error('[tg-inbox] TELEGRAMER_BRIDGE_SECRET missing — skip run');
    return stats;
  }

  // Step 2: for each source, fetch new media messages and process
  for (const src of sources.results) {
    const perSourceStat = { chat_id: src.address, new: 0, inserted: 0 };

    try {
      // High-water mark — last tg_msg_id we've processed for this chat.
      // Skipped in backfill mode when ignoreHwm=true.
      const hwmRow = opts.ignoreHwm
        ? null
        : await env.DB.prepare(
            `SELECT MAX(telegram_msg_id) as hwm
               FROM invoice_inbox
              WHERE source_type = 'telegram'
                AND telegram_chat_id = ?
                AND deleted_at IS NULL`
          ).bind(src.address).first<{ hwm: number | null }>();
      const hwm = hwmRow?.hwm ?? 0;

      // Pull media-only history (latest 50 messages, or older window via offset_id)
      const histRes = await fetch(
        `${VPS_BASE_URL}/chat/media-history`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bridgeSecret}`,
          },
          body: JSON.stringify({
            contact: src.address,
            limit: 200,
            only_with_media: true,
            offset_id: opts.offsetId ?? 0,
          }),
          signal: AbortSignal.timeout(30_000),
        }
      );

      if (!histRes.ok) {
        console.error(`[tg-inbox] history fetch failed for ${src.address}: HTTP ${histRes.status}`);
        stats.errors++;
        continue;
      }
      const hist = (await histRes.json()) as { messages?: TelegramMessage[] };
      const messages = (hist.messages || []).filter(
        (m) => m.has_media && (opts.ignoreHwm || m.tg_msg_id > hwm)
      );
      perSourceStat.new = messages.length;
      stats.new_messages += messages.length;

      if (!messages.length) {
        stats.per_source.push(perSourceStat);
        continue;
      }

      console.log(`[tg-inbox] ${src.address}: ${messages.length} new media messages (hwm was ${hwm})`);

      for (const msg of messages) {
        try {
          // Step A — fast operational filter on text
          const textLower = (msg.text || '').toLowerCase();
          if (
            /\bf4-wh-r-/i.test(textLower) ||
            /\bwh-r-\d/i.test(textLower) ||
            /заявка\s+принята/i.test(textLower) ||
            /перечн[яеи]\s+работ/i.test(textLower)
          ) {
            // operational garbage — record as rejected to avoid re-fetching
            await insertTelegramInbox(env, src, msg, null, 'not_invoice',
              'manual_rejected', 'Auto-rejected: operational mp_delivery message');
            stats.auto_rejected++;
            continue;
          }

          // Step B — download file. VPS expects {chat_id, tg_msg_id} and
          // returns base64-encoded bytes in the 'data_base64' field.
          if (!msg.has_media || !msg.media) {
            console.log(`[tg-inbox] msg ${msg.tg_msg_id}: no media, skip`);
            continue;
          }
          // chat_id is negative for groups, must be int
          const chatId = parseInt(src.address, 10);
          if (Number.isNaN(chatId)) {
            console.error(`[tg-inbox] cannot parse chat_id ${src.address}`);
            stats.errors++;
            continue;
          }
          const fileRes = await fetch(`${VPS_BASE_URL}/get-file`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${bridgeSecret}`,
            },
            body: JSON.stringify({
              chat_id: chatId,
              tg_msg_id: msg.tg_msg_id,
            }),
            signal: AbortSignal.timeout(60_000),
          });

          if (!fileRes.ok) {
            console.error(`[tg-inbox] file fetch failed for msg ${msg.tg_msg_id}: HTTP ${fileRes.status}`);
            stats.errors++;
            continue;
          }
          const fileResp = (await fileRes.json()) as {
            data_base64: string;
            filename: string;
            mime_type: string;
            size: number;
          };
          if (!fileResp.data_base64) {
            console.error(`[tg-inbox] empty file for msg ${msg.tg_msg_id}`);
            stats.errors++;
            continue;
          }
          // Decode base64 → ArrayBuffer
          const binaryStr = atob(fileResp.data_base64);
          const fileBuf = new ArrayBuffer(binaryStr.length);
          const view = new Uint8Array(fileBuf);
          for (let i = 0; i < binaryStr.length; i++) {
            view[i] = binaryStr.charCodeAt(i);
          }

          stats.files_downloaded++;

          // Step C — upload to R2
          const filename = fileResp.filename || msg.media?.filename ||
            `tg-${msg.tg_msg_id}.${fileResp.mime_type?.includes('pdf') ? 'pdf' : 'bin'}`;
          const datePrefix = (msg.sent_at || '').slice(0, 10) || 'unknown';
          const r2Key = `telegram_inbox/${src.address}/${datePrefix}/${msg.tg_msg_id}_${sanitizeFilename(filename)}`;
          await env.DOCS.put(r2Key, fileBuf, {
            httpMetadata: {
              contentType: fileResp.mime_type || 'application/octet-stream',
            },
            customMetadata: {
              source: 'telegram',
              chat_id: src.address,
              msg_id: String(msg.tg_msg_id),
              sender: msg.sender_username || '',
            },
          });

          // Step D — extract text (PDF text shaft is best-effort)
          const isPdf = (fileResp.mime_type || '').includes('pdf') ||
                         filename.toLowerCase().endsWith('.pdf');
          const text = isPdf ? await extractPdfText(fileBuf) : '';

          // Step E — DeepSeek classify
          const extracted = await deepseekClassifyTelegram(env, text, msg, filename);
          if (!extracted) {
            stats.errors++;
            await insertTelegramInbox(env, src, msg, r2Key, 'error',
              'error', 'DeepSeek classification failed');
            continue;
          }
          stats.classified++;

          // Map LLM classification to schema CHECK values
          let cls = extracted.classification;
          if (cls === 'unclear') cls = 'pending';

          // Auto-reject ONLY when truly uninteresting. If chat is bound to a
          // known partner (default_partner_id set), keep the row — we'll group
          // it with related акт/счёт/УПД later by (invoice_no, invoice_date).
          // F4-like image-PDF invoices don't have amount extracted by DeepSeek
          // but they're still legit and need to be paired with их акт.
          const hasBoundPartner = !!src.default_partner_id;
          const isAutoReject =
            cls === 'not_invoice' ||
            cls === 'sale_payment' ||
            (cls === 'service' && !extracted.amount_total && !hasBoundPartner);

          const status = isAutoReject ? 'manual_rejected' : 'needs_partner_link';
          const notes = isAutoReject
            ? `Auto-rejected: ${cls} (${extracted.notes || 'low signal'})`
            : extracted.notes || '';

          const invId = await insertTelegramInbox(env, src, msg, r2Key, cls, status, notes, extracted, text);

          if (isAutoReject) {
            stats.auto_rejected++;
            continue;
          }

          stats.inserted++;
          perSourceStat.inserted++;

          // Step F — auto-match like Gmail path
          try {
            const inboxRow = await env.DB.prepare(
              `SELECT id, classification, extracted_vendor_name, extracted_vendor_inn,
                      extracted_vendor_email, extracted_invoice_no, extracted_invoice_date,
                      extracted_our_invoice_ref, extracted_currency, extracted_amount,
                      extracted_buyer_entity, attachment_text_extracted, matched_partner_id,
                      attachment_r2_key, attachment_filename,
                      email_subject, email_from
                 FROM invoice_inbox WHERE id = ?`
            ).bind(invId).first<any>();

            if (inboxRow) {
              const match = await findMatchingOperation(inboxRow, env);
              const outcome = await applyMatchToInbox(inboxRow, match, env);
              if (outcome.kind === 'auto_attached') {
                stats.auto_attached++;
                console.log(`[tg-inbox] auto-attached ${invId} → ${outcome.match.operation_reference}`);
              } else if (outcome.kind === 'suggested') {
                stats.suggested++;
              }
            }
          } catch (matchErr) {
            console.error(`[tg-inbox] auto-match failed for ${invId}:`, matchErr);
          }
        } catch (e) {
          console.error(`[tg-inbox] processing msg ${msg.tg_msg_id} failed:`, e);
          stats.errors++;
        }
      }

      stats.per_source.push(perSourceStat);
    } catch (e) {
      console.error(`[tg-inbox] source ${src.address} failed:`, e);
      stats.errors++;
    }
  }

  console.log(
    `[tg-inbox] done: sources=${stats.sources_checked} new=${stats.new_messages} ` +
    `inserted=${stats.inserted} auto_attached=${stats.auto_attached} ` +
    `suggested=${stats.suggested} rejected=${stats.auto_rejected} errors=${stats.errors}`
  );

  return stats;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const raw = decoder.decode(bytes);
  const matches: string[] = [];
  const regex = /\((.*?)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) matches.push(m[1]);
  const btRegex = /BT\s+([\s\S]*?)\s+ET/g;
  while ((m = btRegex.exec(raw)) !== null) {
    const block = m[1];
    const inner = /\((.*?)\)/g;
    let mm: RegExpExecArray | null;
    while ((mm = inner.exec(block)) !== null) matches.push(mm[1]);
  }
  return matches.join(' ').slice(0, 8000);
}

async function deepseekClassifyTelegram(
  env: Env,
  text: string,
  msg: TelegramMessage,
  filename: string
): Promise<any> {
  const userMsg = `Telegram message metadata:
- sender: ${msg.sender_username || '(unknown)'}
- sent_at: ${msg.sent_at || '(unknown)'}
- text: ${(msg.text || '').slice(0, 800)}
- filename: ${filename}
- mime: ${msg.media?.mime_type || '(unknown)'}

PDF text (extracted, may be empty for image-only docs):
${text || '(empty — non-PDF or unextractable; classify from filename + caption)'}`;

  const r = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: DEEPSEEK_PROMPT_TG },
        { role: 'user', content: userMsg },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!r.ok) {
    console.error(`[tg-inbox] DeepSeek HTTP ${r.status}`);
    return null;
  }
  const data: any = await r.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return null;
  }
}

async function insertTelegramInbox(
  env: Env,
  src: TelegramSource,
  msg: TelegramMessage,
  r2Key: string | null,
  classification: string,
  status: string,
  notes: string,
  extracted?: any,
  text?: string
): Promise<string> {
  const invId = `inv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Math.floor(Date.now() / 1000);
  const sentAt = msg.sent_at ? Math.floor(new Date(msg.sent_at).getTime() / 1000) : now;
  const lineItemsJson = extracted?.line_items ? JSON.stringify(extracted.line_items) : null;

  await env.DB.prepare(
    `INSERT INTO invoice_inbox (
      id, source_type,
      telegram_chat_id, telegram_msg_id, telegram_topic_id,
      telegram_sender_username, telegram_received_at, telegram_source_ref_id,
      attachment_filename, attachment_r2_key, attachment_content_type, attachment_text_extracted,
      classification, classification_confidence,
      extracted_vendor_name, extracted_vendor_inn,
      extracted_invoice_no, extracted_invoice_date, extracted_period,
      extracted_currency, extracted_amount, extracted_line_items_json,
      extracted_vendor_email, extracted_vendor_country, extracted_vendor_address,
      extracted_bank_name, extracted_bank_account, extracted_iban, extracted_swift,
      extracted_service_category, extracted_buyer_entity,
      matched_partner_id,
      status, notes, created_at, processed_at
    ) VALUES (?, 'telegram',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    invId,
    src.address,
    msg.tg_msg_id,
    msg.topic_id ?? null,
    msg.sender_username || null,
    sentAt,
    src.id,
    (msg.media?.filename || `tg-${msg.tg_msg_id}`).slice(0, 255),
    (r2Key || '').slice(0, 500),
    msg.media?.mime_type || null,
    (text || '').slice(0, 50000),
    classification,
    extracted?.confidence ?? null,
    extracted?.vendor_name || null,
    extracted?.vendor_tax_id || null,
    extracted?.invoice_no || null,
    extracted?.invoice_date || null,
    extracted?.period || null,
    extracted?.currency || null,
    extracted?.amount_total ?? null,
    lineItemsJson,
    extracted?.vendor_email || null,
    extracted?.vendor_country || null,
    extracted?.vendor_address || null,
    extracted?.bank_name || null,
    extracted?.bank_account || null,
    extracted?.iban || null,
    extracted?.swift || null,
    extracted?.service_category || null,
    extracted?.buyer_entity || null,
    src.default_partner_id || null,
    status,
    notes,
    now,
    now
  ).run();

  return invId;
}
