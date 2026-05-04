import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { issueNextSequence } from '../lib/sequence-format';
import { renderCommercialInvoice, renderPackingList } from '../pdf/templates';
import type { InvoiceData, LineItemRow, PackingListData, PartyBlock } from '../pdf/types';

const documents = new Hono<{ Bindings: Env }>();

// =============================================================================
// Schema mapping notes
// =============================================================================
// documents (D1):
//   id              ← doc_<uuid>
//   document_number ← reference (CI-202605-0001 / PL-202605-0001)
//   document_type   ← 'CI' | 'PL'
//   operation_id    ← operations.id
//   issuer_id       ← operations.our_company_id
//   partner_id      ← operations.partner_id
//   document_date   ← unix seconds (now)
//   currency        ← operations.currency
//   total_amount    ← operations.total_amount (CI only; PL leaves null)
//   pdf_r2_url      ← R2 key (documents/{year}/{type}/{reference}.pdf)
//   status          ← 'issued'
//
// operations.status CHECK constraint allows: draft, order_fulfilment,
// production, shipped, delivered, cancelled. The user spec asks for 'issued'
// after both CI+PL exist, but that violates CHECK. We move to
// 'order_fulfilment' as the closest valid post-draft state. Re-issue is
// already prevented by uniqueness check on (operation_id, document_type).
// =============================================================================

const SEQUENCE_BY_TYPE = { CI: 'seq_ci', PL: 'seq_pl' } as const;
const MINOR_FACTOR_BY_CURRENCY: Record<string, number> = {
  USD: 100, EUR: 100, RUB: 100, CNY: 100, VND: 1,
};

const issueSchema = z.object({
  operation_id: z.string().min(1),
  document_type: z.enum(['CI', 'PL']),
});

interface OperationRow {
  id: string;
  operation_type: string;
  operation_date: number;
  partner_id: string | null;
  our_company_id: string;
  status: string;
  currency: string;
  total_amount: number | null;
  incoterms: string | null;
  hs_code: string | null;
}

interface CompanyRow {
  id: string;
  legal_name: string;
  trade_name: string | null;
  registered_address: string | null;
  tax_id: string | null;
  jurisdiction: string | null;
}

interface PartnerRow {
  id: string;
  trade_name: string;
  legal_name: string | null;
  country: string | null;
  tax_id: string | null;
  iban: string | null;
  swift_bic: string | null;
  bank_name: string | null;
  email: string | null;
}

interface LineItemDbRow {
  id: string;
  product_id: string;
  item_description: string | null;
  qty: number;
  cartons: number;
  unit_price_after_disc: number;
  line_amount: number;
  invoice_label: string | null;
  weight_kg: number | null;        // grams (per schema comment)
  volume_m3_micro: number | null;  // microlitres × 1000
}

function genDocId(): string {
  return `doc_${crypto.randomUUID()}`;
}

function companyToParty(c: CompanyRow): PartyBlock {
  return {
    legalName: c.legal_name,
    tradeName: c.trade_name,
    address: c.registered_address,
    taxId: c.tax_id,
    bankName: null,
    bankAccount: null,
    swift: null,
    iban: null,
    email: null,
  };
}

function partnerToParty(p: PartnerRow): PartyBlock {
  return {
    legalName: p.legal_name || p.trade_name,
    tradeName: p.trade_name,
    address: p.country,
    taxId: p.tax_id,
    bankName: p.bank_name,
    bankAccount: null,
    swift: p.swift_bic,
    iban: p.iban,
    email: p.email,
  };
}

function dbLinesToRows(rows: LineItemDbRow[], hsCode: string | null): LineItemRow[] {
  return rows.map((r) => ({
    sku: r.product_id,
    description: r.item_description || r.invoice_label || r.product_id,
    hsCode,
    qty: r.qty,
    unitPriceMinor: r.unit_price_after_disc,
    lineTotalMinor: r.line_amount,
    netWeightGrams: r.weight_kg,
    volumeMicroL: r.volume_m3_micro,
    cartons: r.cartons,
  }));
}

// =============================================================================
// POST /api/documents/issue
// =============================================================================

documents.post('/issue', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const { operation_id, document_type } = parsed.data;
  const db = c.env.DB;

  // Load operation
  const operation = await db.prepare(`
    SELECT id, operation_type, operation_date, partner_id, our_company_id,
           status, currency, total_amount, incoterms, hs_code
    FROM operations
    WHERE id = ? AND deleted_at IS NULL
  `).bind(operation_id).first<OperationRow>();

  if (!operation) {
    return fail(c, 404, [{
      code: 'operation_not_found',
      message: `Operation ${operation_id} not found`,
    }]);
  }

  if (operation.status !== 'draft') {
    return fail(c, 409, [{
      code: 'operation_not_draft',
      message: `Operation status is ${operation.status}; documents can only be issued from draft`,
    }]);
  }

  // Pre-existing document of same type? (idempotency / re-issue prevention)
  const existing = await db.prepare(`
    SELECT id, document_number, pdf_r2_url
    FROM documents
    WHERE operation_id = ? AND document_type = ? AND deleted_at IS NULL
  `).bind(operation_id, document_type).first<{
    id: string; document_number: string; pdf_r2_url: string;
  }>();

  if (existing) {
    return fail(c, 409, [{
      code: 'document_already_issued',
      message: `${document_type} ${existing.document_number} already issued for this operation`,
      details: {
        document_id: existing.id,
        reference: existing.document_number,
        r2_key: existing.pdf_r2_url,
      },
    }]);
  }

  // Load seller company + buyer partner
  const company = await db.prepare(`
    SELECT id, legal_name, trade_name, registered_address, tax_id, jurisdiction
    FROM companies WHERE id = ? AND deleted_at IS NULL
  `).bind(operation.our_company_id).first<CompanyRow>();

  if (!company) {
    return fail(c, 404, [{
      code: 'company_not_found',
      message: `Issuer company ${operation.our_company_id} not found`,
    }]);
  }

  let partner: PartnerRow | null = null;
  if (operation.partner_id) {
    partner = await db.prepare(`
      SELECT id, trade_name, legal_name, country, tax_id,
             iban, swift_bic, bank_name, email
      FROM partners WHERE id = ? AND deleted_at IS NULL
    `).bind(operation.partner_id).first<PartnerRow>();

    if (!partner) {
      return fail(c, 404, [{
        code: 'partner_not_found',
        message: `Partner ${operation.partner_id} not found`,
      }]);
    }
  }

  // Load line items joined with products
  const linesResult = await db.prepare(`
    SELECT li.id, li.product_id, li.item_description, li.qty, li.cartons,
           li.unit_price_after_disc, li.line_amount,
           p.invoice_label, p.weight_kg, p.volume_m3_micro
    FROM line_items li
    LEFT JOIN products p ON p.id = li.product_id
    WHERE li.operation_id = ?
    ORDER BY li.created_at ASC
  `).bind(operation_id).all<LineItemDbRow>();

  if (!linesResult.results || linesResult.results.length === 0) {
    return fail(c, 422, [{
      code: 'no_line_items',
      message: `Operation ${operation_id} has no line items`,
    }]);
  }

  // Issue sequence number
  const sequenceId = SEQUENCE_BY_TYPE[document_type];
  const seqResult = await issueNextSequence(db, sequenceId);
  if (!seqResult) {
    return fail(c, 500, [{
      code: 'sequence_failed',
      message: `Failed to issue from sequence ${sequenceId}`,
    }]);
  }
  const reference = seqResult.formatted;

  // Build PDF
  const minorFactor = MINOR_FACTOR_BY_CURRENCY[operation.currency] ?? 100;
  const lineRows = dbLinesToRows(linesResult.results, operation.hs_code);
  const seller = companyToParty(company);
  const buyer = partner
    ? partnerToParty(partner)
    : { legalName: 'TBD', tradeName: null, address: null, taxId: null,
        bankName: null, bankAccount: null, swift: null, iban: null, email: null };

  const issuedAt = Math.floor(Date.now() / 1000);
  let pdfBytes: Uint8Array;

  try {
    if (document_type === 'CI') {
      const data: InvoiceData = {
        reference,
        issuedAt,
        currency: operation.currency,
        minorFactor,
        seller,
        buyer,
        lines: lineRows,
        totalMinor: operation.total_amount ?? 0,
        incoterms: operation.incoterms,
        preparedByCountry: company.jurisdiction,
      };
      pdfBytes = await renderCommercialInvoice(data);
    } else {
      // Look up CI reference if already issued for cross-ref on PL
      const ciRow = await db.prepare(`
        SELECT document_number FROM documents
        WHERE operation_id = ? AND document_type = 'CI' AND deleted_at IS NULL
        LIMIT 1
      `).bind(operation_id).first<{ document_number: string }>();

      const data: PackingListData = {
        reference,
        issuedAt,
        seller,
        buyer,
        lines: lineRows,
        ciReference: ciRow?.document_number ?? null,
      };
      pdfBytes = await renderPackingList(data);
    }
  } catch (err) {
    return fail(c, 500, [{
      code: 'pdf_render_failed',
      message: 'PDF generation failed',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // Upload to R2
  const year = new Date(issuedAt * 1000).getUTCFullYear();
  const r2Key = `documents/${year}/${document_type}/${reference}.pdf`;

  try {
    await c.env.DOCS.put(r2Key, pdfBytes, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: {
        operation_id,
        document_type,
        reference,
        issued_at: String(issuedAt),
      },
    });
  } catch (err) {
    return fail(c, 500, [{
      code: 'r2_upload_failed',
      message: 'Failed to upload PDF to R2',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // Insert document row
  const docId = genDocId();
  const totalForDoc = document_type === 'CI' ? operation.total_amount : null;

  try {
    await db.prepare(`
      INSERT INTO documents (
        id, document_number, document_type, operation_id,
        issuer_id, partner_id, contract_ref, document_date,
        currency, total_amount, pdf_r2_url, owner_name,
        mandatory_level, when_ready, status, metadata,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'mandatory', NULL, 'issued', NULL, ?, ?, NULL)
    `).bind(
      docId, reference, document_type, operation_id,
      operation.our_company_id, operation.partner_id, issuedAt,
      operation.currency, totalForDoc, r2Key,
      issuedAt, issuedAt
    ).run();
  } catch (err) {
    // Best-effort R2 cleanup if D1 write failed (avoid orphan PDFs)
    try { await c.env.DOCS.delete(r2Key); } catch { /* ignore */ }
    return fail(c, 500, [{
      code: 'document_insert_failed',
      message: 'Failed to register document in D1',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // If both CI and PL now exist for this operation, advance status.
  // Schema CHECK does not allow 'issued' for operations — use 'order_fulfilment'.
  const docCount = await db.prepare(`
    SELECT COUNT(DISTINCT document_type) AS n
    FROM documents
    WHERE operation_id = ?
      AND document_type IN ('CI', 'PL')
      AND deleted_at IS NULL
  `).bind(operation_id).first<{ n: number }>();

  let operationStatusAfter = operation.status;
  if (docCount && docCount.n >= 2) {
    try {
      await db.prepare(`
        UPDATE operations
        SET status = 'order_fulfilment', updated_at = ?
        WHERE id = ?
      `).bind(issuedAt, operation_id).run();
      operationStatusAfter = 'order_fulfilment';
    } catch {
      // Non-fatal: document is issued, just status advance failed.
    }
  }

  const origin = new URL(c.req.url).origin;
  const downloadUrl = `${origin}/api/documents/${docId}/download`;

  return ok(c, {
    document_id: docId,
    reference,
    r2_key: r2Key,
    download_url: downloadUrl,
    operation_status: operationStatusAfter,
  }, [`${document_type} ${reference} issued`]);
});

// =============================================================================
// GET /api/documents/:id/download
// =============================================================================

documents.get('/:id/download', async (c) => {
  const docId = c.req.param('id');

  const doc = await c.env.DB.prepare(`
    SELECT id, document_number, document_type, pdf_r2_url
    FROM documents
    WHERE id = ? AND deleted_at IS NULL
  `).bind(docId).first<{
    id: string;
    document_number: string;
    document_type: string;
    pdf_r2_url: string | null;
  }>();

  if (!doc) {
    return fail(c, 404, [{
      code: 'document_not_found',
      message: `Document ${docId} not found`,
    }]);
  }

  if (!doc.pdf_r2_url) {
    return fail(c, 404, [{
      code: 'document_no_pdf',
      message: `Document ${docId} has no PDF in R2`,
    }]);
  }

  const obj = await c.env.DOCS.get(doc.pdf_r2_url);
  if (!obj) {
    return fail(c, 404, [{
      code: 'r2_object_missing',
      message: `R2 object ${doc.pdf_r2_url} not found`,
    }]);
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${doc.document_number}.pdf"`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  });
});

export default documents;
