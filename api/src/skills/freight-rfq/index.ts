// =============================================================================
// Freight RFQ skill — orchestrator.
//
// Single entry: issueRfq(operationId, shipperId, env, reqUrl, extras).
// Returns the document_id, R2 key, download URL, and shipper info so the
// caller can immediately wire the secondary "Send by email" action.
//
// No re-issue dedupe: each press creates a fresh RFQ. Old ones stay
// visible in the operation's document list (status='issued', deleted_at NULL)
// until the user soft-deletes them through the standard documents UI.
// =============================================================================

import type { Env } from '../../types';
import { issueNextSequence } from '../../lib/sequence-format';
import { renderRfq } from './renderer';
import type {
  RfqDestinationLocation, RfqIssueResult, RfqIssuerCompany, RfqLineItem,
  RfqOperation, RfqOriginLocation, RfqShipper,
} from './types';

export interface IssueRfqOptions {
  requestedPickupDate?: number | null;
  notes?: string | null;
}

export interface IssueRfqOk {
  success: true;
  result: RfqIssueResult;
}

export interface IssueRfqFail {
  success: false;
  errors: Array<{ code: string; message: string }>;
}

function genDocId(): string {
  const rand = crypto.randomUUID().replace(/-/g, '');
  return `doc_${rand.slice(0, 16)}`;
}

function originFromManufacturer(m: {
  registered_address_en: string | null;
  registered_address_ru: string | null;
  country: string | null;
  city: string | null;
  legal_name_en: string | null;
  name: string | null;
}): RfqOriginLocation {
  return {
    name: m.legal_name_en ?? m.name ?? null,
    address: m.registered_address_en ?? m.registered_address_ru ?? null,
    city: m.city ?? null,
    country: m.country ?? null,
  };
}

function destinationFromWarehouse(w: {
  name: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
} | null): RfqDestinationLocation {
  if (!w) return { name: null, address: null, city: null, country: null };
  return {
    name: w.name ?? null,
    address: w.address ?? null,
    city: w.city ?? null,
    country: w.country ?? null,
  };
}

export async function issueRfq(
  operationId: string,
  shipperId: string,
  env: Env,
  reqUrl: string,
  options: IssueRfqOptions = {},
): Promise<IssueRfqOk | IssueRfqFail> {
  // 1. Load operation + line items.
  const operationRow = await env.DB.prepare(`
    SELECT id, reference, operation_type, operation_date, manufacturer_id,
           partner_id, warehouse_from_id, warehouse_to_id, incoterms,
           currency, total_amount, status, our_company_id
    FROM operations
    WHERE id = ? AND deleted_at IS NULL
  `).bind(operationId).first<RfqOperation & { our_company_id: string }>();

  if (!operationRow) {
    return {
      success: false,
      errors: [{ code: 'operation_not_found', message: `Operation ${operationId} not found` }],
    };
  }

  const lineItemsRes = await env.DB.prepare(`
    SELECT li.product_id,
           li.item_description AS invoice_label,
           li.qty,
           li.cartons,
           li.unit_price,
           p.product_name,
           p.ctn_qty,
           p.pieces_per_case,
           p.ctn_weight_gross_kg,
           p.ctn_volume_m3,
           p.ctn_dim_l_cm,
           p.ctn_dim_w_cm,
           p.ctn_dim_h_cm,
           p.unit_net_weight_g
    FROM line_items li
    LEFT JOIN products p ON p.id = li.product_id
    WHERE li.operation_id = ?
    ORDER BY li.created_at ASC, li.id ASC
  `).bind(operationId).all<RfqLineItem>();

  const lineItems = lineItemsRes.results ?? [];

  // 2. Load issuer company (from operations.our_company_id).
  const issuerRow = await env.DB.prepare(`
    SELECT id, legal_name, legal_name_ru, registered_address
    FROM companies
    WHERE id = ? AND deleted_at IS NULL
  `).bind(operationRow.our_company_id).first<Omit<RfqIssuerCompany, 'email'>>();

  if (!issuerRow) {
    return {
      success: false,
      errors: [{ code: 'issuer_not_found', message: `Issuer company ${operationRow.our_company_id} not found` }],
    };
  }

  // 3. Load shipper from partners table (kind='shipper').
  const shipperRow = await env.DB.prepare(`
    SELECT id, slug, trade_name, legal_name_en, email, country
    FROM partners
    WHERE id = ? AND kind = 'shipper' AND deleted_at IS NULL
  `).bind(shipperId).first<RfqShipper>();

  if (!shipperRow) {
    return {
      success: false,
      errors: [{ code: 'shipper_not_found', message: `Shipper ${shipperId} not found or not of kind 'shipper'` }],
    };
  }

  // 4. Build origin (from manufacturer if purchase, from warehouse_from otherwise).
  let origin: RfqOriginLocation = { name: null, address: null, city: null, country: null };

  if (operationRow.manufacturer_id) {
    const mRow = await env.DB.prepare(`
      SELECT name, legal_name_en, registered_address_en, registered_address_ru,
             country, city
      FROM manufacturers
      WHERE id = ? AND deleted_at IS NULL
    `).bind(operationRow.manufacturer_id).first<{
      name: string | null;
      legal_name_en: string | null;
      registered_address_en: string | null;
      registered_address_ru: string | null;
      country: string | null;
      city: string | null;
    }>();
    if (mRow) origin = originFromManufacturer(mRow);
  }

  // Fallback: warehouse_from.
  if (!origin.name && operationRow.warehouse_from_id) {
    const wRow = await env.DB.prepare(`
      SELECT name, city, country
      FROM warehouses
      WHERE id = ? AND deleted_at IS NULL
    `).bind(operationRow.warehouse_from_id).first<{
      name: string | null;
      city: string | null;
      country: string | null;
    }>();
    if (wRow) origin = destinationFromWarehouse({ ...wRow, address: null });
  }

  // 5. Destination from warehouse_to.
  let destination: RfqDestinationLocation = { name: null, address: null, city: null, country: null };
  if (operationRow.warehouse_to_id) {
    const wRow = await env.DB.prepare(`
      SELECT name, city, country
      FROM warehouses
      WHERE id = ? AND deleted_at IS NULL
    `).bind(operationRow.warehouse_to_id).first<{
      name: string | null;
      city: string | null;
      country: string | null;
    }>();
    if (wRow) destination = destinationFromWarehouse({ ...wRow, address: null });
  }

  // 6. Issue sequence number → RFQ-YYYYMM-NNNN.
  const seq = await issueNextSequence(env.DB, 'rfq');
  if (!seq) {
    return {
      success: false,
      errors: [{ code: 'sequence_failed', message: 'Failed to issue rfq sequence' }],
    };
  }
  const reference = seq.formatted;

  const nowSec = Math.floor(Date.now() / 1000);

  // 7. Render .docx.
  let bytes: Uint8Array;
  try {
    bytes = await renderRfq({
      reference,
      issuedAt: nowSec,
      issuer: issuerRow,
      shipper: shipperRow,
      operation: operationRow,
      lineItems,
      origin,
      destination,
      requestedPickupDate: options.requestedPickupDate ?? null,
      notes: options.notes ?? null,
    });
  } catch (err) {
    return {
      success: false,
      errors: [{
        code: 'render_failed',
        message: `RFQ renderer failed: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }

  // 8. R2 upload.
  const yearForKey = new Date(nowSec * 1000).getUTCFullYear();
  const r2Key = `documents/${yearForKey}/RFQ/${reference}.docx`;
  try {
    await env.DOCS.put(r2Key, bytes, {
      httpMetadata: {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      customMetadata: {
        operation_id: operationId,
        document_type: 'RFQ',
        reference,
        shipper_id: shipperRow.id,
        issued_at: String(nowSec),
      },
    });
  } catch (err) {
    return {
      success: false,
      errors: [{
        code: 'r2_upload_failed',
        message: `R2 upload failed for ${r2Key}: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }

  // 9. D1 insert.
  const docId = genDocId();
  try {
    await env.DB.prepare(`
      INSERT INTO documents (
        id, document_number, document_type, operation_id,
        issuer_id, partner_id, contract_ref, document_date,
        currency, total_amount, pdf_r2_url, owner_name,
        mandatory_level, when_ready, status, metadata,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, 'RFQ', ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, 'on_request', NULL, 'issued', ?, ?, ?, NULL)
    `).bind(
      docId,
      reference,
      operationId,
      operationRow.our_company_id,
      operationRow.partner_id,
      nowSec,
      r2Key,
      JSON.stringify({
        shipper_id: shipperRow.id,
        shipper_slug: shipperRow.slug,
        shipper_name: shipperRow.trade_name,
        requested_pickup_date: options.requestedPickupDate ?? null,
        notes: options.notes ?? null,
      }),
      nowSec,
      nowSec,
    ).run();
  } catch (err) {
    // Best-effort R2 cleanup.
    try { await env.DOCS.delete(r2Key); } catch { /* ignore */ }
    return {
      success: false,
      errors: [{
        code: 'd1_insert_failed',
        message: `Failed to insert document row: ${err instanceof Error ? err.message : String(err)}`,
      }],
    };
  }

  // 10. Build download URL.
  const origin_ = new URL(reqUrl).origin;
  const downloadUrl = `${origin_}/api/documents/${docId}/download`;

  return {
    success: true,
    result: {
      document_id: docId,
      document_number: reference,
      r2_key: r2Key,
      download_url: downloadUrl,
      shipper: {
        id: shipperRow.id,
        name: shipperRow.legal_name_en || shipperRow.trade_name,
        email: shipperRow.email,
      },
    },
  };
}
