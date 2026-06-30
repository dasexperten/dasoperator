// =============================================================================
// Inbox reconcile — nightly three-way deal builder (Aram spec, 2026-06-30)
// =============================================================================
//
// One deal, three doors: счёт (service invoice), акт/УПД (acceptance), оплата
// (bank payment). Whichever arrives first must result in ONE operation; the
// other two attach to it. This sweep covers the DOCUMENT doors (счёт + акт)
// for partner-bound Telegram sources (F4 Lyubertsy and any future 3PL chat).
// The PAYMENT door is handled live in bank-auto-match.ts (guarded create when
// the payment names a specific invoice number).
//
// Per source (must have default_partner_id — we never auto-create a deal for an
// unknown partner):
//
//   For each waiting invoice/act with a readable invoice number + amount
//   (status='needs_partner_link', no operation yet):
//
//     1. DEDUP — does an operation already exist for (partner, invoice_no)?
//        Match on reference  <ABBR>-<8 digits>-<invno>[-<suffix>]  OR any
//        operation of this partner that already carries an attachment with
//        doc_number = invno. If yes -> attach this doc to it (no duplicate).
//
//     2. CREATE — no operation yet -> POST .../confirm, which builds the
//        operation from the document, attaches the PDF, pulls sibling
//        акт/УПД (reverse-link), and allocates any parked bank payment.
//
// Anchor = invoice number, so the bank path and this sweep can never both
// create the same deal. Rows without a readable invoice number + amount
// (image-only scans the parser couldn't read) are left untouched for the
// one-click manual confirm — we never invent a phantom deal.
//
// Wired into the nightly '0 0 * * *' cron (03:00 MSK).
// =============================================================================

import type { Env } from '../types';

interface ReconcileSource {
  address: string;
  default_partner_id: string;
  abbreviation: string;
}

interface WaitingRow {
  id: string;
  classification: string;
  extracted_invoice_no: string | null;
  extracted_amount: number | null;
}

export interface ReconcileStats {
  sources_checked: number;
  candidates: number;
  created: number;
  attached_existing: number;
  skipped_unreadable: number;
  skipped_resolved: number;
  errors: number;
  details: Array<{
    inbox_id: string;
    invoice_no: string | null;
    action: string;
    reference?: string | null;
  }>;
}

export async function runInboxReconcile(env: Env): Promise<ReconcileStats> {
  const stats: ReconcileStats = {
    sources_checked: 0,
    candidates: 0,
    created: 0,
    attached_existing: 0,
    skipped_unreadable: 0,
    skipped_resolved: 0,
    errors: 0,
    details: [],
  };

  // Partner-bound Telegram sources only. abbreviation drives the reference
  // prefix (LBR for F4) used to detect an existing deal for the same invoice.
  const sources = await env.DB.prepare(
    `SELECT s.address, s.default_partner_id, UPPER(COALESCE(p.abbreviation, s.default_partner_id)) AS abbreviation
       FROM operation_document_sources s
       JOIN partners p ON p.id = s.default_partner_id
      WHERE s.source_type = 'telegram_contact'
        AND s.is_active = 1
        AND s.deleted_at IS NULL
        AND s.default_partner_id IS NOT NULL`
  ).all<ReconcileSource>();

  stats.sources_checked = sources.results.length;

  for (const src of sources.results) {
    // Waiting document doors for this chat: service invoice (счёт) or
    // acceptance (акт/УПД) that carries a readable invoice number AND a real
    // amount, with no operation yet. Acceptance is included because an акт can
    // legitimately be the first door — but only when it carries its own
    // amount, otherwise it has no anchor to create a deal from.
    const rows = await env.DB.prepare(
      `SELECT id, classification, extracted_invoice_no, extracted_amount
         FROM invoice_inbox
        WHERE source_type = 'telegram'
          AND telegram_chat_id = ?
          AND status = 'needs_partner_link'
          AND created_operation_id IS NULL
          AND deleted_at IS NULL
          AND classification IN ('service', 'acceptance')
          AND extracted_invoice_no IS NOT NULL
          AND TRIM(extracted_invoice_no) != ''
          AND extracted_amount IS NOT NULL
          AND extracted_amount > 0
        ORDER BY created_at ASC`
    ).bind(src.address).all<WaitingRow>();

    for (const row of rows.results) {
      stats.candidates++;
      const invno = String(row.extracted_invoice_no).trim();

      try {
        // A sibling счёт processed earlier in THIS run may have already swept
        // this row in via reverse-link (same invoice_no). Re-read its current
        // state and skip if it is no longer waiting — avoids a spurious 409.
        const fresh = await env.DB.prepare(
          `SELECT status, created_operation_id FROM invoice_inbox WHERE id = ?`
        ).bind(row.id).first<{ status: string; created_operation_id: string | null }>();
        if (!fresh || fresh.created_operation_id || fresh.status !== 'needs_partner_link') {
          stats.skipped_resolved++;
          continue;
        }

        // ---- DEDUP: existing operation for (partner, invoice_no)? ----
        const existing = await env.DB.prepare(
          `SELECT id, reference
             FROM operations
            WHERE partner_id = ?
              AND deleted_at IS NULL
              AND (
                    reference LIKE ?
                 OR reference LIKE ?
                 OR id IN (
                      SELECT operation_id FROM operation_attachments
                       WHERE doc_number = ? AND deleted_at IS NULL
                    )
              )
            ORDER BY created_at ASC
            LIMIT 1`
        )
          .bind(
            src.default_partner_id,
            `${src.abbreviation}-________-${invno}`,
            `${src.abbreviation}-________-${invno}-%`,
            invno,
          )
          .first<{ id: string; reference: string | null }>();

        if (existing?.id) {
          const r = await env.SELF.fetch(
            new Request(`https://internal/api/inbox/${row.id}/attach-to-operation`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ operation_id: existing.id }),
            }),
          );
          if (r.ok) {
            stats.attached_existing++;
            stats.details.push({ inbox_id: row.id, invoice_no: invno, action: 'attached_existing', reference: existing.reference });
          } else {
            stats.errors++;
            const t = await r.text().catch(() => '');
            stats.details.push({ inbox_id: row.id, invoice_no: invno, action: `attach_failed_${r.status}` });
            console.error(`[inbox-reconcile] attach failed ${row.id} -> ${existing.id}: HTTP ${r.status} ${t.slice(0, 200)}`);
          }
          continue;
        }

        // ---- CREATE: no operation yet -> confirm builds it from the document ----
        const r = await env.SELF.fetch(
          new Request(`https://internal/api/inbox/${row.id}/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }),
        );
        if (r.ok) {
          const out = await r.json<{ result?: { reference?: string } }>().catch(() => ({} as any));
          stats.created++;
          stats.details.push({ inbox_id: row.id, invoice_no: invno, action: 'created', reference: out?.result?.reference ?? null });
        } else {
          stats.errors++;
          const t = await r.text().catch(() => '');
          stats.details.push({ inbox_id: row.id, invoice_no: invno, action: `confirm_failed_${r.status}` });
          console.error(`[inbox-reconcile] confirm failed ${row.id}: HTTP ${r.status} ${t.slice(0, 200)}`);
        }
      } catch (e) {
        stats.errors++;
        console.error(`[inbox-reconcile] row ${row.id} threw:`, e);
      }
    }
  }

  console.log(
    `[inbox-reconcile] done: sources=${stats.sources_checked} candidates=${stats.candidates} ` +
    `created=${stats.created} attached=${stats.attached_existing} errors=${stats.errors}`,
  );
  return stats;
}
