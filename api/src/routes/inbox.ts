import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const inbox = new Hono<{ Bindings: Env }>();

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
    where += " AND status IN ('auto_created','manual_confirmed','manual_rejected')";
  } else if (statusFilter && statusFilter !== 'all') {
    where += ' AND status = ?';
    params.push(statusFilter);
  }

  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, gmail_message_id, email_from, email_subject, email_received_at,
              email_snippet, attachment_filename, attachment_r2_key,
              classification, classification_confidence,
              extracted_vendor_name, extracted_vendor_inn, extracted_invoice_no,
              extracted_invoice_date, extracted_period, extracted_currency,
              extracted_amount, extracted_line_items_json,
              status, matched_partner_id, created_operation_id, created_payment_id, notes,
              created_at, processed_at, resolved_at
       FROM invoice_inbox
       ${where}
       ORDER BY email_received_at DESC, created_at DESC
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

    if (!partnerId) {
      // Need to create a service vendor partner
      const legalName = String(body.partner_legal_name ?? row.extracted_vendor_name ?? 'Unknown vendor');
      const country = String(body.partner_country ?? '').trim();
      const taxId = String(body.partner_tax_id ?? row.extracted_vendor_inn ?? '').trim();

      // Slug from name: lowercase alphanumeric + dashes, max 60 chars
      const slug = legalName
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || `vendor-${now}`;

      partnerId = `prt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

      await c.env.DB.prepare(
        `INSERT INTO partners (
          id, legal_name, country, tax_id, slug,
          partner_type, role, status, kind,
          currency, modes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'service_vendor', 'vendor', 'active', 'service',
                  ?, '["service"]', ?, ?)`
      ).bind(
        partnerId, legalName, country || null, taxId || null, slug,
        row.extracted_currency || null,
        now, now,
      ).run();
      partnerCreated = true;
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

    // Build minimal valid INSERT — only columns we know exist
    const fields: string[] = ['id', 'partner_id', 'operation_type', 'status', 'currency', 'total_amount', 'created_at', 'updated_at'];
    const values: any[] = [operationId, partnerId, 'service', 'issued', currency, amount, now, now];

    if (colSet.has('reference'))         { fields.push('reference');         values.push(reference); }
    if (colSet.has('operation_date'))    { fields.push('operation_date');    values.push(opDate); }
    if (colSet.has('issue_date'))        { fields.push('issue_date');        values.push(opDate); }
    if (colSet.has('paid_amount'))       { fields.push('paid_amount');       values.push(0); }
    if (colSet.has('notes'))             { fields.push('notes');             values.push(`Auto-created from invoice_inbox ${id}: ${row.email_subject || ''}`.slice(0, 500)); }

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

export default inbox;
