// =============================================================================
// invoice-amount-reconcile.ts — RAIL 2 (2026-05-27)
// =============================================================================
//
// Bank transaction amount is the SOURCE OF TRUTH for invoice reconciliation.
//
// Why: vision parsers (Claude, DeepSeek) can mis-read scan PDFs — they
// sometimes return per-unit price instead of total, or miss decimal
// separators on stamped numerics. Example seen 2026-05-27: F4 invoice 1218
// — Claude Vision returned 756 RUB for three PDFs (per-box fee read as
// total) and 49896 RUB for three other PDFs (correct total). Bank tx showed
// 49896 RUB, which is the actual money that moved. Bank wins.
//
// Reconciliation runs both directions:
//
//   1. Bank → Inbox: when a bank_transactions row is created and its
//      payment_purpose carries exactly ONE invoice number, find matching
//      invoice_inbox rows (same partner + same invoice_no) and rewrite
//      their extracted_amount if it diverges from bank tx by >1%.
//
//   2. Inbox → Bank: when an invoice_inbox row gets a fresh extracted_amount
//      (e.g. after reclassify), look back for a bank tx with that
//      invoice_no in its purpose. If found, same reconciliation.
//
// Bank txs whose purpose lists multiple invoice numbers (split payments) are
// excluded — they need manual review.
// =============================================================================

import type { Env } from '../types';
import { parseInvoiceFromPurpose } from './bank-auto-match';

const TOLERANCE = 0.01; // 1% — anything inside this is kopeck-level noise

// "счёт", "счет", "счета", "счету" — count distinct doc number contexts.
// We're looking for situations like
//   "счета: № 836, № 942, № 947, ..."   (multi-invoice)
// vs
//   "Оплата по счёту № 1235 от 25.05.2026..."   (single)
function isMultiInvoicePurpose(purpose: string): boolean {
  if (!purpose) return false;
  // Count "№" or "#" occurrences inside the purpose — they delimit invoice refs.
  const hashCount = (purpose.match(/[№#]/g) || []).length;
  return hashCount > 1;
}

interface BankTxLite {
  id: string;
  amount: number;
  currency: string;
  contragent_inn: string | null;
  payment_purpose: string | null;
}

interface InboxLite {
  id: string;
  extracted_amount: number | null;
  extracted_currency: string | null;
  extracted_invoice_no: string | null;
  matched_partner_id: string | null;
  extracted_vendor_inn: string | null;
  notes: string | null;
}

const NO_SUBDIVISION = new Set(['VND', 'JPY', 'KRW']);

function bankAmountToMajor(amount: number, currency: string): number {
  const factor = NO_SUBDIVISION.has(currency) ? 1 : 100;
  return amount / factor;
}

// -----------------------------------------------------------------------------
// reconcileBankTxAmountIntoInbox
// -----------------------------------------------------------------------------
// Given a bank_transactions row id, find invoice_inbox rows that reference
// the same invoice_no (parsed from purpose) for the same partner (by INN)
// and overwrite their extracted_amount if it diverges from bank tx amount.
//
// Returns the list of updated inbox rows. Empty list means no action taken
// (no invoice_no, multi-invoice purpose, no matching inbox row, or amounts
// already agreed within tolerance).
// -----------------------------------------------------------------------------
export async function reconcileBankTxAmountIntoInbox(
  env: Env,
  bankTxId: string,
): Promise<Array<{ inbox_id: string; old: number | null; new: number }>> {
  const tx = await env.DB.prepare(
    `SELECT id, amount, currency, contragent_inn, payment_purpose
       FROM bank_transactions
      WHERE id = ? AND deleted_at IS NULL`
  ).bind(bankTxId).first<BankTxLite>();

  if (!tx || !tx.payment_purpose || !tx.contragent_inn) return [];
  if (isMultiInvoicePurpose(tx.payment_purpose)) return [];

  const parsed = parseInvoiceFromPurpose(tx.payment_purpose);
  if (!parsed?.doc_number) return [];
  const invoiceNo = parsed.doc_number;

  // Find inbox rows: same invoice_no AND same partner (by INN match).
  const rows = await env.DB.prepare(
    `SELECT i.id, i.extracted_amount, i.extracted_currency,
            i.extracted_invoice_no, i.matched_partner_id,
            i.extracted_vendor_inn, i.notes
       FROM invoice_inbox i
       LEFT JOIN partners p ON p.id = i.matched_partner_id
      WHERE i.extracted_invoice_no = ?
        AND i.deleted_at IS NULL
        AND (i.extracted_vendor_inn = ? OR p.tax_id = ? OR p.inn = ?)`
  ).bind(invoiceNo, tx.contragent_inn, tx.contragent_inn, tx.contragent_inn)
   .all<InboxLite>();

  const candidates = rows.results || [];
  if (candidates.length === 0) return [];

  const bankMajor = bankAmountToMajor(tx.amount, tx.currency);
  const now = Math.floor(Date.now() / 1000);
  const updates: Array<{ inbox_id: string; old: number | null; new: number }> = [];

  for (const row of candidates) {
    // Different currencies — out of scope, skip silently.
    if (row.extracted_currency && row.extracted_currency !== tx.currency) continue;

    const inboxAmt = row.extracted_amount;
    if (inboxAmt !== null && bankMajor > 0) {
      const diff = Math.abs(bankMajor - inboxAmt) / Math.max(bankMajor, inboxAmt);
      if (diff <= TOLERANCE) continue; // already agree
    }

    const note = `[rail2 ${new Date().toISOString().slice(0, 10)}] ` +
      `extracted_amount ${inboxAmt ?? 'NULL'} → ${bankMajor} (bank tx ${tx.id} wins; ` +
      `purpose: "${(tx.payment_purpose || '').slice(0, 80)}")`;
    const mergedNotes = row.notes ? `${row.notes}\n${note}` : note;

    await env.DB.prepare(
      `UPDATE invoice_inbox
          SET extracted_amount = ?,
              extracted_currency = COALESCE(extracted_currency, ?),
              notes = ?,
              processed_at = ?
        WHERE id = ?`
    ).bind(bankMajor, tx.currency, mergedNotes.slice(0, 2000), now, row.id).run();

    console.log(
      `[rail2] reconciled inbox ${row.id} invoice_no=${invoiceNo}: ` +
      `${inboxAmt ?? 'NULL'} → ${bankMajor} ${tx.currency} (bank tx ${tx.id})`
    );
    updates.push({ inbox_id: row.id, old: inboxAmt, new: bankMajor });
  }

  return updates;
}

// -----------------------------------------------------------------------------
// reconcileInboxRowAgainstBankTx
// -----------------------------------------------------------------------------
// Inverse direction: given an invoice_inbox row id, look for a matching bank
// tx (same INN + invoice_no in purpose) and reconcile inbox amount with it.
// Used after reclassify and after telegram ingestion when amounts come from
// vision LLMs that can miss totals.
// -----------------------------------------------------------------------------
export async function reconcileInboxRowAgainstBankTx(
  env: Env,
  inboxId: string,
): Promise<{ bank_tx_id: string; old: number | null; new: number } | null> {
  const row = await env.DB.prepare(
    `SELECT i.id, i.extracted_amount, i.extracted_currency,
            i.extracted_invoice_no, i.matched_partner_id,
            i.extracted_vendor_inn, i.notes,
            p.tax_id AS partner_inn, p.inn AS partner_inn2
       FROM invoice_inbox i
       LEFT JOIN partners p ON p.id = i.matched_partner_id
      WHERE i.id = ? AND i.deleted_at IS NULL`
  ).bind(inboxId).first<InboxLite & { partner_inn: string | null; partner_inn2: string | null }>();

  if (!row?.extracted_invoice_no) return null;
  const inn = row.extracted_vendor_inn || row.partner_inn || row.partner_inn2;
  if (!inn) return null;

  // Find bank tx whose purpose contains this invoice_no, same INN, not deleted.
  // We cast a wide net then verify via parseInvoiceFromPurpose to avoid false
  // positives where the digits appear inside a longer number.
  const candidates = await env.DB.prepare(
    `SELECT id, amount, currency, contragent_inn, payment_purpose
       FROM bank_transactions
      WHERE deleted_at IS NULL
        AND contragent_inn = ?
        AND payment_purpose LIKE ?`
  ).bind(inn, `%${row.extracted_invoice_no}%`).all<BankTxLite>();

  for (const tx of candidates.results || []) {
    if (!tx.payment_purpose) continue;
    if (isMultiInvoicePurpose(tx.payment_purpose)) continue;
    const parsed = parseInvoiceFromPurpose(tx.payment_purpose);
    if (parsed?.doc_number !== row.extracted_invoice_no) continue;

    const bankMajor = bankAmountToMajor(tx.amount, tx.currency);
    const inboxAmt = row.extracted_amount;
    if (inboxAmt !== null && bankMajor > 0) {
      const diff = Math.abs(bankMajor - inboxAmt) / Math.max(bankMajor, inboxAmt);
      if (diff <= TOLERANCE) return null; // agree
    }

    const note = `[rail2 ${new Date().toISOString().slice(0, 10)}] ` +
      `extracted_amount ${inboxAmt ?? 'NULL'} → ${bankMajor} (bank tx ${tx.id} wins)`;
    const mergedNotes = row.notes ? `${row.notes}\n${note}` : note;
    const now = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
      `UPDATE invoice_inbox
          SET extracted_amount = ?,
              extracted_currency = COALESCE(extracted_currency, ?),
              notes = ?,
              processed_at = ?
        WHERE id = ?`
    ).bind(bankMajor, tx.currency, mergedNotes.slice(0, 2000), now, row.id).run();

    console.log(
      `[rail2] reconciled inbox ${row.id} invoice_no=${row.extracted_invoice_no}: ` +
      `${inboxAmt ?? 'NULL'} → ${bankMajor} ${tx.currency} (bank tx ${tx.id})`
    );
    return { bank_tx_id: tx.id, old: inboxAmt, new: bankMajor };
  }

  return null;
}
