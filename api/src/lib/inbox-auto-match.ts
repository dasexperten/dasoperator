// =============================================================================
// Inbox auto-matcher
// =============================================================================
// Given an invoice_inbox row, finds the most likely matching operation.
// Returns confidence in [0, 1] plus a reason string explaining the match.
//
// Strategies, in descending confidence order:
//
//   1.0  invoice_no exactly matches an existing document number (CI/PL/IS/UPD)
//        — we issued this; the incoming PDF is a counter-acknowledgment
//   0.95 our_invoice_ref (mentioned in extracted text) matches a document
//   0.85 vendor partner + amount + currency + date within ±14d  (single candidate)
//   0.75 vendor partner + amount + currency + date within ±30d  (single candidate)
//   0.65 vendor partner + amount + currency                     (single candidate)
//   0.50 vendor partner + currency + status='issued'            (single candidate)
//   0.40 vendor partner + currency                              (single candidate)
//   null no plausible match — leave for manual
//
// "Single candidate" means: query returns exactly 1 operation. Multiple
// candidates always drop confidence to 0.40 (suggest, never auto).
//
// Auto-attach thresholds vary by classification — see THRESHOLDS below.
// =============================================================================

import type { Env } from '../types';

export interface MatchResult {
  operation_id: string;
  operation_reference: string | null;
  confidence: number;
  reason: string;
  /** True if confidence ≥ threshold for this classification — caller may auto-attach. */
  auto_eligible: boolean;
}

/**
 * Per-classification auto-attach thresholds. Above this confidence we attach
 * without user click. Below → suggest only. Banking-critical and ambiguous
 * categories require higher confidence or manual review only.
 *
 * Keys are the inbox 'classification' values (DeepSeek output). 'kind' (the
 * downstream operation_attachments classification) is mapped separately in
 * the route handler.
 */
const THRESHOLDS: Record<string, number> = {
  service: 0.85,       // freight, storage, broker fees — auto if confident
  purchase: 0.85,      // commercial invoice from manufacturer — auto
  sale_payment: 1.01,  // banking critical — never auto, always manual
  not_invoice: 1.01,   // never
  error: 1.01,         // never
  pending: 1.01,       // not classified yet
};

export function thresholdFor(classification: string): number {
  return THRESHOLDS[classification] ?? 1.01;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface InboxRow {
  id: string;
  classification: string;
  extracted_vendor_name: string | null;
  extracted_vendor_inn: string | null;
  extracted_vendor_email: string | null;
  extracted_invoice_no: string | null;
  extracted_invoice_date: string | null;
  extracted_our_invoice_ref: string | null;
  extracted_currency: string | null;
  extracted_amount: number | null;
  extracted_buyer_entity: string | null;
  attachment_text_extracted: string | null;
  matched_partner_id: string | null;
  extracted_shipment_ref: string | null;
  extracted_service_subtype: string | null;
}

interface OpCandidate {
  id: string;
  reference: string | null;
  partner_id: string | null;
  manufacturer_id: string | null;
  our_company_id: string | null;
  operation_date: number;
  currency: string;
  total_amount: number;
  status: string;
}

function unixToDateString(t: number | null): string {
  if (!t) return '—';
  const iso = new Date(t * 1000).toISOString();
  return iso.split('T')[0] ?? iso;
}

function parseInboxDate(s: string | null): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  if (isNaN(t)) return null;
  return Math.floor(t / 1000);
}

/** Tight amount equality with rounding tolerance (1% of amount, capped at $1 / ¥10). */
function amountsMatch(a: number, b: number, currency: string): boolean {
  if (a <= 0 || b <= 0) return false;
  const cap = currency === 'CNY' || currency === 'RUB' || currency === 'JPY' ? 10 : 1;
  const tolerance = Math.min(Math.abs(a) * 0.01, cap);
  return Math.abs(a - b) <= tolerance;
}

// -----------------------------------------------------------------------------
// Main entry point
// -----------------------------------------------------------------------------

export async function findMatchingOperation(
  inboxRow: InboxRow,
  env: Env,
): Promise<MatchResult | null> {
  const threshold = thresholdFor(inboxRow.classification);

  // ---- Strategy 1 & 2: document_number match (our issued CI/PL/IS appears in
  // their counter-document text). Look for any document_number we issued that
  // appears verbatim in the extracted text or the extracted_our_invoice_ref. --
  const candidateRefs: string[] = [];
  if (inboxRow.extracted_our_invoice_ref) candidateRefs.push(inboxRow.extracted_our_invoice_ref);
  if (inboxRow.extracted_invoice_no) candidateRefs.push(inboxRow.extracted_invoice_no);

  // Also scan the OCR text for anything looking like our doc numbers
  // (CI-XXX-YYZZZZ, PL-XXX-YYZZZZ, IS-XXX-YYZZZZ, UPD-XXX-YYZZZZ, TN-XXX-YYZZZZ).
  if (inboxRow.attachment_text_extracted) {
    const matches = inboxRow.attachment_text_extracted.match(
      /\b(?:CI|PL|IS|UPD|TN)-[A-Z]{2,6}-\d{6}\b/g
    );
    if (matches) candidateRefs.push(...matches);
  }

  for (const ref of candidateRefs) {
    if (!ref) continue;
    const doc = await env.DB.prepare(
      `SELECT d.operation_id, o.reference
         FROM documents d
         JOIN operations o ON o.id = d.operation_id
        WHERE d.document_number = ?
          AND d.deleted_at IS NULL
          AND d.status = 'issued'
          AND o.deleted_at IS NULL
        LIMIT 1`
    ).bind(ref.trim()).first<{ operation_id: string; reference: string | null }>();

    if (doc) {
      return {
        operation_id: doc.operation_id,
        operation_reference: doc.reference,
        confidence: 0.95,
        reason: `Document ${ref} matches our issued ${ref.split('-')[0]} on operation ${doc.reference ?? doc.operation_id.slice(0, 12)}`,
        auto_eligible: 0.95 >= threshold,
      };
    }
  }

  // ---- Strategy 3-7: partner-based matching ----
  // We need a partner to anchor by. Use matched_partner_id if already set
  // (e.g. ingestion did fuzzy match), else find a partner by vendor email
  // or vendor name.
  let partnerId: string | null = inboxRow.matched_partner_id;
  let partnerSource = 'matched_partner_id';

  if (!partnerId && inboxRow.extracted_vendor_email) {
    const r = await env.DB.prepare(
      `SELECT id FROM partners WHERE LOWER(email) = LOWER(?) AND deleted_at IS NULL LIMIT 1`
    ).bind(inboxRow.extracted_vendor_email.trim()).first<{ id: string }>();
    if (r) {
      partnerId = r.id;
      partnerSource = 'email';
    }
  }

  if (!partnerId && inboxRow.extracted_vendor_inn) {
    const r = await env.DB.prepare(
      `SELECT id FROM partners WHERE tax_id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(inboxRow.extracted_vendor_inn.trim()).first<{ id: string }>();
    if (r) {
      partnerId = r.id;
      partnerSource = 'tax_id';
    }
  }

  if (!partnerId && inboxRow.extracted_vendor_name) {
    // Loose name match: lowercase + first 12 chars
    const needle = inboxRow.extracted_vendor_name.trim().toLowerCase().slice(0, 12);
    if (needle.length >= 4) {
      const r = await env.DB.prepare(
        `SELECT id FROM partners
          WHERE LOWER(legal_name) LIKE ? OR LOWER(trade_name) LIKE ?
          AND deleted_at IS NULL
          LIMIT 1`
      ).bind(`${needle}%`, `${needle}%`).first<{ id: string }>();
      if (r) {
        partnerId = r.id;
        partnerSource = 'name_prefix';
      }
    }
  }

  // If we still have no partner anchor, the only path left was document_no
  // and that already failed. No match.
  if (!partnerId) return null;

  // Also check if vendor is a manufacturer (for purchase-from-factory flows
  // where partner_id is NULL but manufacturer_id is set).
  let manufacturerId: string | null = null;
  if (inboxRow.extracted_vendor_name) {
    const needle = inboxRow.extracted_vendor_name.trim().toLowerCase().slice(0, 8);
    if (needle.length >= 4) {
      const m = await env.DB.prepare(
        `SELECT id FROM manufacturers WHERE LOWER(name) LIKE ? LIMIT 1`
      ).bind(`${needle}%`).first<{ id: string }>();
      if (m) manufacturerId = m.id;
    }
  }

  // Build candidate operations: matches partner OR manufacturer + currency
  const currency = inboxRow.extracted_currency;
  const candidates: OpCandidate[] = [];
  {
    const sql = `
      SELECT id, reference, partner_id, manufacturer_id, our_company_id,
             operation_date, currency, total_amount, status
        FROM operations
       WHERE deleted_at IS NULL
         AND status != 'cancelled'
         AND (partner_id = ? OR (manufacturer_id IS NOT NULL AND manufacturer_id = ?))
         ${currency ? 'AND currency = ?' : ''}
       ORDER BY operation_date DESC
       LIMIT 50`;
    const binds: unknown[] = [partnerId, manufacturerId ?? '__none__'];
    if (currency) binds.push(currency);
    const r = await env.DB.prepare(sql).bind(...binds).all<OpCandidate>();
    candidates.push(...(r.results ?? []));
  }

  if (candidates.length === 0) return null;

  // ---- Filter by amount ----
  const amount = inboxRow.extracted_amount;
  const amountMatches: OpCandidate[] = amount
    ? candidates.filter((c) => amountsMatch(c.total_amount, amount, c.currency))
    : [];

  // ---- Filter by date window ----
  const invoiceDate = parseInboxDate(inboxRow.extracted_invoice_date);
  const within = (days: number) => (c: OpCandidate) => {
    if (!invoiceDate) return false;
    const diffSec = Math.abs(c.operation_date - invoiceDate);
    return diffSec <= days * 86400;
  };

  // Strategy 3: vendor + amount + currency + date ±14d
  if (amountMatches.length > 0) {
    const tight = amountMatches.filter(within(14));
    if (tight.length === 1) {
      const c = tight[0]!;
      return {
        operation_id: c.id,
        operation_reference: c.reference,
        confidence: 0.85,
        reason: `Vendor + amount ${c.total_amount} ${c.currency} + date within 14d of ${unixToDateString(invoiceDate)} (partner via ${partnerSource})`,
        auto_eligible: 0.85 >= threshold,
      };
    }

    // Strategy 4: ±30d
    const medium = amountMatches.filter(within(30));
    if (medium.length === 1) {
      const c = medium[0]!;
      return {
        operation_id: c.id,
        operation_reference: c.reference,
        confidence: 0.75,
        reason: `Vendor + amount ${c.total_amount} ${c.currency} + date within 30d (partner via ${partnerSource})`,
        auto_eligible: 0.75 >= threshold,
      };
    }

    // Strategy 5: amount match, no date filter, single candidate
    if (amountMatches.length === 1) {
      const c = amountMatches[0]!;
      return {
        operation_id: c.id,
        operation_reference: c.reference,
        confidence: 0.65,
        reason: `Vendor + amount ${c.total_amount} ${c.currency} (single match, partner via ${partnerSource})`,
        auto_eligible: 0.65 >= threshold,
      };
    }

    // Multiple amount matches → ambiguous, drop confidence to 0.40
    const c = amountMatches[0]!;
    return {
      operation_id: c.id,
      operation_reference: c.reference,
      confidence: 0.40,
      reason: `Vendor + amount match, but ${amountMatches.length} candidates — pick manually`,
      auto_eligible: false,
    };
  }

  // ---- No amount match. Fall back to partner-only signals. ----
  // Prefer most-recent issued operation when there's only one.
  const issuedCandidates = candidates.filter((c) => c.status === 'issued');
  if (issuedCandidates.length === 1) {
    const c = issuedCandidates[0]!;
    return {
      operation_id: c.id,
      operation_reference: c.reference,
      confidence: 0.50,
      reason: `Vendor + currency, single issued operation (partner via ${partnerSource})`,
      auto_eligible: false,
    };
  }

  if (candidates.length === 1) {
    const c = candidates[0]!;
    return {
      operation_id: c.id,
      operation_reference: c.reference,
      confidence: 0.40,
      reason: `Vendor + currency, single candidate (partner via ${partnerSource})`,
      auto_eligible: false,
    };
  }

  // Multiple candidates — return the most recent as a suggestion but with
  // low confidence; user must confirm.
  const top = candidates[0]!;
  return {
    operation_id: top.id,
    operation_reference: top.reference,
    confidence: 0.40,
    reason: `Vendor + currency, ${candidates.length} candidates — pick manually`,
    auto_eligible: false,
  };
}

// -----------------------------------------------------------------------------
// applyMatchToInbox
// -----------------------------------------------------------------------------
// Side-effect helper. Given an inbox row and a match result:
//   • If match is null → nothing happens, returns 'no_match'.
//   • If match.auto_eligible → creates operation_attachments row, flips
//     inbox status to 'auto_attached', sets created_operation_id.
//     Returns 'auto_attached'.
//   • Otherwise → stores match in suggested_* columns, leaves status alone.
//     Returns 'suggested'.
//
// Called from runInboxIngestion right after a new invoice_inbox row is
// inserted, and can also be called manually via a future re-match endpoint.
// -----------------------------------------------------------------------------

/** Map inbox.classification → operation_attachments.kind. Mirrors route handler. */
const CLASSIFICATION_TO_KIND: Record<string, string> = {
  service: 'service_invoice',
  purchase: 'commercial_invoice',
  sale_payment: 'payment_proof',
};

interface InboxRowForApply extends InboxRow {
  attachment_r2_key: string | null;
  attachment_filename: string | null;
  email_subject: string | null;
  email_from: string | null;
}

export type ApplyOutcome =
  | { kind: 'no_match' }
  | { kind: 'suggested'; match: MatchResult }
  | { kind: 'auto_attached'; match: MatchResult; attachment_id: string };

export async function applyMatchToInbox(
  row: InboxRowForApply,
  match: MatchResult | null,
  env: Env,
): Promise<ApplyOutcome> {
  const now = Math.floor(Date.now() / 1000);

  if (!match) {
    return { kind: 'no_match' };
  }

  // Either way, record the suggestion so the UI can show it.
  await env.DB.prepare(
    `UPDATE invoice_inbox
        SET suggested_operation_id = ?,
            suggested_match_confidence = ?,
            suggested_match_reason = ?
      WHERE id = ?`
  ).bind(
    match.operation_id, match.confidence, match.reason, row.id
  ).run();

  if (!match.auto_eligible) {
    return { kind: 'suggested', match };
  }

  // Auto-attach path. Build operation_attachments row.
  const R2_PUBLIC_BASE = 'https://pub-0e2fb2d28ea9408bbaa1bdd64b3bf256.r2.dev/';
  const fileUrl = row.attachment_r2_key ? `${R2_PUBLIC_BASE}${row.attachment_r2_key}` : null;
  const docDate = (() => {
    const d = row.extracted_invoice_date ? new Date(row.extracted_invoice_date).getTime() : NaN;
    return isNaN(d) ? null : Math.floor(d / 1000);
  })();
  const kind = CLASSIFICATION_TO_KIND[row.classification] ?? 'other';
  const attachmentId = `att_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const notes =
    `Auto-attached (${(match.confidence * 100).toFixed(0)}% match): ${match.reason}. ` +
    `Source email: ${row.email_subject || '(no subject)'} · ${row.email_from || ''}`;

  await env.DB.prepare(
    `INSERT INTO operation_attachments (
       id, operation_id, direction, kind,
       doc_number, doc_date, amount, currency, issuer,
       file_url, parsed_from, source_ref_id, notes,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    attachmentId,
    match.operation_id,
    'incoming',
    kind,
    row.extracted_invoice_no || null,
    docDate,
    row.extracted_amount || null,
    row.extracted_currency || null,
    row.extracted_vendor_name || null,
    fileUrl,
    'email_ingestion_auto',
    row.id,
    notes.slice(0, 500),
    now,
    now,
  ).run();

  // Propagate shipment context to the matched operation: forwarder_ref +
  // service_subtype + related_purchase_id. Only fill empty fields — never
  // overwrite values that already exist (could be from manual entry).
  if (row.extracted_shipment_ref || row.extracted_service_subtype) {
    try {
      // Look up the purchase op whose forwarder_ref matches the inbox shipment_ref
      let relatedPurchaseId: string | null = null;
      if (row.extracted_shipment_ref) {
        const purchase = await env.DB.prepare(
          `SELECT id FROM operations
            WHERE forwarder_ref = ? AND operation_type='purchase'
              AND deleted_at IS NULL
            ORDER BY operation_date DESC LIMIT 1`
        ).bind(row.extracted_shipment_ref).first<{ id: string }>();
        relatedPurchaseId = purchase?.id ?? null;
      }

      // Conditional UPDATE — only fill columns that are currently NULL.
      await env.DB.prepare(
        `UPDATE operations
            SET forwarder_ref      = COALESCE(forwarder_ref, ?),
                service_subtype    = COALESCE(service_subtype, ?),
                related_purchase_id = COALESCE(related_purchase_id, ?),
                updated_at         = ?
          WHERE id = ?`
      ).bind(
        row.extracted_shipment_ref,
        row.extracted_service_subtype,
        relatedPurchaseId,
        now,
        match.operation_id,
      ).run();
    } catch (propErr) {
      console.error('[inbox-auto-match] field propagation failed:', propErr);
      // Non-fatal — attach already succeeded.
    }
  }

  // Flip inbox status.
  await env.DB.prepare(
    `UPDATE invoice_inbox
        SET status = 'auto_attached',
            created_operation_id = ?,
            resolved_at = ?
      WHERE id = ?`
  ).bind(match.operation_id, now, row.id).run();

  return { kind: 'auto_attached', match, attachment_id: attachmentId };
}
