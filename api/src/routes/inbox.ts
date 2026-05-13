import { Hono } from 'hono';
import { findExistingPartnerByName, isBankProviderName, generateReadablePartnerId } from '../lib/partner-dedup';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { runInboxIngestion } from '../lib/inbox-ingestion';
import { findMatchingOperation, thresholdFor } from '../lib/inbox-auto-match';

const inbox = new Hono<{ Bindings: Env }>();

// =============================================================================
// GET /api/inbox/_diag — diagnostic: test if Worker can reach emailer-bridge
// =============================================================================
inbox.get('/_diag', async (c) => {
  const start = Date.now();
  const result: any = { steps: [] };
  try {
    const r = await c.env.EMAILER.fetch('https://emailer/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'find', query: 'has:attachment newer_than:1d invoice', max_results: 1 }),
    });
    result.steps.push({ stage: 'fetch_emailer', ok: r.ok, status: r.status, ms: Date.now() - start });
    const data: any = await r.json();
    result.steps.push({ stage: 'parse_json', success: data?.success, total: data?.total_found, error: data?.error });
  } catch (e: any) {
    result.steps.push({ stage: 'exception', message: String(e?.message || e), name: e?.name });
  }
  result.total_ms = Date.now() - start;
  result.has_deepseek_key = !!c.env.DEEPSEEK_API_KEY;
  result.has_emailer_binding = !!c.env.EMAILER;
  return ok(c, result);
});

// =============================================================================
// POST /api/inbox/run-ingestion — manually trigger the daily cron ingestion
// =============================================================================
// Same code path the cron uses (03:00 МСК daily). Useful for:
//   - Testing pipeline changes without waiting for next cron tick
//   - Forcing a fresh check after a known invoice arrived in Gmail
//   - End-to-end smoke test from /inbox UI "Refresh from Gmail" button
inbox.post('/run-ingestion', async (c) => {
  try {
    const stats = await runInboxIngestion(c.env);
    return ok(c, stats);
  } catch (e) {
    return fail(c, 500, [{ code: 'ingestion_error', message: e instanceof Error ? e.message : String(e) }]);
  }
});

// =============================================================================
// GET /api/inbox/:id/match-preview
// Runs the auto-matcher on a single inbox row and returns the suggested
// operation + confidence WITHOUT attaching. Diagnostic/preview only.
// =============================================================================
inbox.get('/:id/match-preview', async (c) => {
  const id = c.req.param('id');
  try {
    const row = await c.env.DB.prepare(
      `SELECT id, classification, extracted_vendor_name, extracted_vendor_inn,
              extracted_vendor_email, extracted_invoice_no, extracted_invoice_date,
              extracted_our_invoice_ref, extracted_currency, extracted_amount,
              extracted_buyer_entity, attachment_text_extracted, matched_partner_id
         FROM invoice_inbox
        WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<any>();
    if (!row) return fail(c, 404, [{ code: 'inbox_not_found', message: `Inbox row ${id} not found` }]);

    const match = await findMatchingOperation(row, c.env);
    return ok(c, {
      inbox_id: id,
      classification: row.classification,
      threshold: thresholdFor(row.classification),
      match,
    });
  } catch (e) {
    return fail(c, 500, [{ code: 'match_preview_error', message: e instanceof Error ? e.message : String(e) }]);
  }
});

// =============================================================================
// GET /api/inbox — list invoice_inbox rows
// =============================================================================
// Query params:
//   status — filter by status (default: not_resolved → all except auto_created/manual_confirmed/manual_rejected)
//   limit  — default 50
inbox.get('/', async (c) => {
  const statusFilter = c.req.query('status') ?? 'open';
  const limit = Math.min(200, Number(c.req.query('limit') ?? 50));

  let where = 'WHERE deleted_at IS NULL';
  const params: (string | number)[] = [];

  if (statusFilter === 'open') {
    where += " AND status IN ('queued','processed','needs_partner_link','needs_review')";
  } else if (statusFilter === 'resolved') {
    where += " AND status IN ('auto_created','auto_attached','manual_confirmed','manual_rejected')";
  } else if (statusFilter && statusFilter !== 'all') {
    where += ' AND status = ?';
    params.push(statusFilter);
  }

  try {
    const rows = await c.env.DB.prepare(
      `SELECT i.id, i.gmail_message_id, i.email_from, i.email_subject, i.email_received_at,
              i.email_snippet, i.attachment_filename, i.attachment_r2_key,
              i.classification, i.classification_confidence,
              i.extracted_vendor_name, i.extracted_vendor_inn, i.extracted_invoice_no,
              i.extracted_invoice_date, i.extracted_period, i.extracted_currency,
              i.extracted_amount, i.extracted_line_items_json,
              i.extracted_vendor_email, i.extracted_vendor_country, i.extracted_vendor_address,
              i.extracted_bank_name, i.extracted_bank_account, i.extracted_iban, i.extracted_swift,
              i.extracted_service_category, i.extracted_buyer_entity,
              i.status, i.matched_partner_id, i.created_operation_id, i.created_payment_id, i.notes,
              i.suggested_operation_id, i.suggested_match_confidence, i.suggested_match_reason,
              i.created_at, i.processed_at, i.resolved_at,
              co.reference AS created_operation_reference,
              so.reference AS suggested_operation_reference
       FROM invoice_inbox i
       LEFT JOIN operations co ON co.id = i.created_operation_id
       LEFT JOIN operations so ON so.id = i.suggested_operation_id
       ${where.replace(/WHERE deleted_at/g, 'WHERE i.deleted_at').replace(/AND status/g, 'AND i.status')}
       ORDER BY i.email_received_at DESC, i.created_at DESC
       LIMIT ?`
    ).bind(...params, limit).all();

    return ok(c, {
      total_count: rows.results?.length ?? 0,
      filter: statusFilter,
      items: (rows.results ?? []).map((r: any) => ({
        ...r,
        line_items: (() => {
          try { return r.extracted_line_items_json ? JSON.parse(r.extracted_line_items_json) : null; }
          catch { return null; }
        })(),
      })),
    });
  } catch (e) {
    return fail(c, 500, [{ code: 'inbox_db_error', message: e instanceof Error ? e.message : 'Unknown error' }]);
  }
});

// =============================================================================
// POST /api/inbox/:id/confirm — Yes button: create partner (if needed) + operation
// =============================================================================
// Body (optional overrides):
//   { partner_legal_name?: string, partner_country?: string, partner_tax_id?: string,
//     amount?: number, currency?: string, vendor_entity?: 'DEE'|'DEI'|'DEASEAN'|'DEC' }
// Default values come from extracted_* fields.
inbox.post('/:id/confirm', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  try {
    const row = await c.env.DB.prepare(
      'SELECT * FROM invoice_inbox WHERE id = ? AND deleted_at IS NULL'
    ).bind(id).first<any>();

    if (!row) return fail(c, 404, [{ code: 'inbox_not_found', message: 'Inbox row not found' }]);
    if (row.status === 'manual_confirmed' || row.status === 'auto_created') {
      return fail(c, 400, [{ code: 'already_resolved', message: `Already resolved as ${row.status}` }]);
    }

    const now = Math.floor(Date.now() / 1000);

    // Resolve target partner — either matched, or create one
    let partnerId: string = row.matched_partner_id;
    let partnerCreated = false;
    let partnerKind: string = 'service_provider';

    if (!partnerId) {
      // Need to create a service vendor partner
      const legalName = String(body.partner_legal_name ?? row.extracted_vendor_name ?? 'Unknown vendor');
      const country = String(body.partner_country ?? row.extracted_vendor_country ?? '').trim();
      const taxId = String(body.partner_tax_id ?? row.extracted_vendor_inn ?? '').trim();
      const email = String(row.extracted_vendor_email ?? '').trim();
      const city = String(row.extracted_vendor_address ?? '').trim();
      const bankName = String(row.extracted_bank_name ?? '').trim();
      const iban = String(row.extracted_iban ?? '').trim();
      const swift = String(row.extracted_swift ?? '').trim();
      const bankAccount = String(row.extracted_bank_account ?? '').trim();
      const serviceCategory = String(row.extracted_service_category ?? '').trim();

      // Pre-check 1: reject bank names that leaked through as vendor names
      // (LLM parser sometimes pulls the receiving bank's name from the
      // payment-instructions block of an invoice). Banks belong in
      // bank_providers, never in partners.
      if (await isBankProviderName(c.env.DB, legalName)) {
        return fail(c, 422, [{
          code: 'extracted_vendor_is_bank',
          message: `Extracted vendor name "${legalName}" matches a registered bank provider. ` +
            `This is a payment-routing artefact from the invoice. ` +
            `Please re-check the parsed data and supply the actual vendor name or partner_id.`,
        }]);
      }

      // Pre-check 2: dedup by name. If a partner with this name already
      // exists (live, any kind), reuse it. Prevents 4-Accuvat-rows-in-2-min
      // incidents from repeated invoice confirms.
      const existing = await findExistingPartnerByName(c.env.DB, legalName);
      if (existing) {
        partnerId = existing.id;
        partnerKind = existing.kind || 'service_provider';
      } else {
        // Brand new vendor — readable id, never opaque prt_${uuid16}.
        const newId = await generateReadablePartnerId(c.env.DB, legalName);
        partnerId = newId;
        const slug = newId; // mirror id for consistency
        const tradeName = legalName.length > 60 ? legalName.slice(0, 60) : legalName;

        await c.env.DB.prepare(
          `INSERT INTO partners (
          id, trade_name, legal_name, country, city, tax_id, slug, email,
          partner_type, role, status, kind,
          currency, modes,
          bank_name, iban, swift_bic, bank_notes,
          notes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'other', 'vendor', 'active', 'service_provider',
                  ?, '["service"]',
                  ?, ?, ?, ?,
                  ?, ?, ?)`
      ).bind(
        partnerId, tradeName, legalName,
        country || null, city || null,
        taxId || null, slug,
        email || null,
        row.extracted_currency || null,
        bankName || null,
        iban || null,
        swift || null,
        bankAccount ? `A/C ${bankAccount}` : null,
        serviceCategory ? `Service category: ${serviceCategory}` : null,
        now, now,
      ).run();
        partnerCreated = true;
        partnerKind = 'service_provider';
      }
    }

    // Create service operation
    const operationId = `op_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const amount = Number(body.amount ?? row.extracted_amount);
    const currency = String(body.currency ?? row.extracted_currency ?? 'USD');
    const opDate = row.extracted_invoice_date
      ? Math.floor(new Date(row.extracted_invoice_date).getTime() / 1000)
      : now;
    const reference = row.extracted_invoice_no || `INBOX-${id.slice(-8)}`;

    // Discover operations columns dynamically — schema may have evolved
    const cols = await c.env.DB.prepare(
      "SELECT name FROM pragma_table_info('operations')"
    ).all<{name: string}>();
    const colSet = new Set((cols.results ?? []).map((c) => c.name));

    // Determine which entity (DEE/DEI/DEASEAN/DEC) is the buyer.
    // Priority: explicit body override > extracted_buyer_entity from LLM > 'dei' default.
    const buyerHint = (body.our_company_id ?? row.extracted_buyer_entity ?? 'DEI').toString().toLowerCase();
    const validEntities = ['dee', 'dei', 'dasean', 'dec'];
    const ourCompanyId = validEntities.includes(buyerHint) ? buyerHint : 'dei';

    // operation_type: existing CHECK only allows sale/purchase/transfer/bundling.
    // Service vendor invoices are recorded as 'purchase' (we're purchasing a service).
    // The vendor's partner.kind='service' distinguishes them from goods purchases.
    const opType = 'purchase';

    // Build minimal valid INSERT — only columns we know exist
    const fields: string[] = ['id', 'partner_id', 'operation_type', 'our_company_id', 'operation_date', 'status', 'currency', 'total_amount', 'created_at', 'updated_at'];
    const values: any[] = [operationId, partnerId, opType, ourCompanyId, opDate, 'issued', currency, amount, now, now];

    if (colSet.has('reference'))         { fields.push('reference');         values.push(reference); }
    if (colSet.has('notes'))             { fields.push('notes');             values.push(`Service vendor invoice from invoice_inbox ${id}: ${row.email_subject || ''}`.slice(0, 500)); }

    const placeholders = fields.map(() => '?').join(',');
    await c.env.DB.prepare(
      `INSERT INTO operations (${fields.join(',')}) VALUES (${placeholders})`
    ).bind(...values).run();

    // Update invoice_inbox row → manual_confirmed
    await c.env.DB.prepare(
      `UPDATE invoice_inbox
       SET status = 'manual_confirmed',
           matched_partner_id = ?,
           created_operation_id = ?,
           resolved_at = ?
       WHERE id = ?`
    ).bind(partnerId, operationId, now, id).run();

    return ok(c, {
      id,
      partner_id: partnerId,
      partner_created: partnerCreated,
      operation_id: operationId,
      reference,
      amount,
      currency,
    });
  } catch (e) {
    return fail(c, 500, [{ code: 'inbox_confirm_error', message: e instanceof Error ? e.message : String(e) }]);
  }
});

// =============================================================================
// POST /api/inbox/:id/reject — No button: mark as not relevant, no operation
// =============================================================================
inbox.post('/:id/reject', async (c) => {
  const id = c.req.param('id');
  const now = Math.floor(Date.now() / 1000);

  try {
    const row = await c.env.DB.prepare(
      'SELECT id, status FROM invoice_inbox WHERE id = ? AND deleted_at IS NULL'
    ).bind(id).first<any>();
    if (!row) return fail(c, 404, [{ code: 'inbox_not_found', message: 'Inbox row not found' }]);

    await c.env.DB.prepare(
      `UPDATE invoice_inbox
       SET status = 'manual_rejected', resolved_at = ?
       WHERE id = ?`
    ).bind(now, id).run();

    return ok(c, { id, status: 'manual_rejected' });
  } catch (e) {
    return fail(c, 500, [{ code: 'inbox_reject_error', message: e instanceof Error ? e.message : String(e) }]);
  }
});

// =============================================================================
// POST /api/inbox/:id/attach-to-operation
// Attaches the inbox attachment (PDF in R2) to an EXISTING operation as an
// operation_attachment row. Unlike /confirm, this does NOT create a new
// operation or partner — it just links the incoming document to an op the
// user already has.
//
// Body:
//   operation_id (required) — target operation
//   direction (optional, default 'incoming') — 'incoming' | 'outgoing'
//   kind (optional) — defaults to inbox classification (commercial_invoice,
//                     packing_list, certificate, contract, freight_invoice, other)
//   notes (optional) — free-text override
// =============================================================================
inbox.post('/:id/attach-to-operation', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const now = Math.floor(Date.now() / 1000);

  if (!body.operation_id || typeof body.operation_id !== 'string') {
    return fail(c, 400, [{ code: 'missing_operation_id', message: 'operation_id is required' }]);
  }

  try {
    // 1. Load the inbox row.
    const row = await c.env.DB.prepare(
      `SELECT id, status, attachment_filename, attachment_r2_key, attachment_content_type,
              email_subject, email_from, classification, extracted_vendor_name,
              extracted_invoice_no, extracted_invoice_date, extracted_amount,
              extracted_currency, matched_partner_id, created_operation_id
         FROM invoice_inbox
        WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<any>();

    if (!row) return fail(c, 404, [{ code: 'inbox_not_found', message: 'Inbox row not found' }]);
    if (row.status === 'manual_confirmed' || row.status === 'auto_created') {
      return fail(c, 409, [{
        code: 'already_resolved',
        message: `Inbox row already resolved as ${row.status} (operation ${row.created_operation_id ?? '—'})`,
      }]);
    }

    // 2. Verify the target operation exists and is not deleted.
    const op = await c.env.DB.prepare(
      'SELECT id, reference, status FROM operations WHERE id = ? AND deleted_at IS NULL'
    ).bind(body.operation_id).first<{ id: string; reference: string | null; status: string }>();
    if (!op) {
      return fail(c, 404, [{ code: 'operation_not_found', message: `Operation ${body.operation_id} not found` }]);
    }

    // 3. Map inbox classification → operation_attachments.kind.
    // Allowed kinds: commercial_invoice, packing_list, certificate, contract,
    // freight_invoice, service_invoice, customs_declaration, payment_proof, other.
    const KIND_MAP: Record<string, string> = {
      commercial_invoice: 'commercial_invoice',
      packing_list: 'packing_list',
      certificate: 'certificate',
      contract: 'contract',
      freight_invoice: 'freight_invoice',
      service_invoice: 'service_invoice',
      customs_declaration: 'customs_declaration',
      payment_proof: 'payment_proof',
    };
    const kind = (body.kind && typeof body.kind === 'string')
      ? body.kind
      : (KIND_MAP[row.classification] ?? 'other');
    const direction = (body.direction === 'outgoing') ? 'outgoing' : 'incoming';

    // 4. Build the public R2 URL for the file (R2 public bucket).
    const R2_PUBLIC_BASE = 'https://pub-0e2fb2d28ea9408bbaa1bdd64b3bf256.r2.dev/';
    const fileUrl = row.attachment_r2_key ? `${R2_PUBLIC_BASE}${row.attachment_r2_key}` : null;

    // 5. Insert the attachment row.
    const attachmentId = `att_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const docDate = row.extracted_invoice_date
      ? Math.floor(new Date(row.extracted_invoice_date).getTime() / 1000)
      : null;
    const notes = (typeof body.notes === 'string' && body.notes.trim())
      ? body.notes.trim()
      : `From email: ${row.email_subject || '(no subject)'} · ${row.email_from || ''}`.slice(0, 500);

    await c.env.DB.prepare(
      `INSERT INTO operation_attachments (
         id, operation_id, direction, kind,
         doc_number, doc_date, amount, currency, issuer,
         file_url, parsed_from, source_ref_id, notes,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      attachmentId,
      body.operation_id,
      direction,
      kind,
      row.extracted_invoice_no || null,
      docDate,
      row.extracted_amount || null,
      row.extracted_currency || null,
      row.extracted_vendor_name || null,
      fileUrl,
      'email_ingestion',
      id,
      notes,
      now,
      now,
    ).run();

    // 6. Mark inbox as resolved — link to the existing operation.
    await c.env.DB.prepare(
      `UPDATE invoice_inbox
         SET status = 'manual_confirmed',
             created_operation_id = ?,
             resolved_at = ?
       WHERE id = ?`
    ).bind(body.operation_id, now, id).run();

    return ok(c, {
      id,
      attachment_id: attachmentId,
      operation_id: body.operation_id,
      operation_reference: op.reference,
      kind,
      direction,
      file_url: fileUrl,
      status: 'manual_confirmed',
    });
  } catch (e) {
    return fail(c, 500, [{
      code: 'inbox_attach_error',
      message: e instanceof Error ? e.message : String(e),
    }]);
  }
});

export default inbox;
