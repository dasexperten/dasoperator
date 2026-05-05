// =============================================================================
// Invoicer engine — entry point. Glues data-loader → selectors → validators
// → renderers → R2 → D1.
//
// Pipeline (one call, multi-document outcome):
//   1. Load all D1 rows for the operation
//   2. Resolve format (selectFormat) — IS-V*/CI/PL
//   3. Resolve language / currency / bank account / bank route / incoterms
//   4. Run HARD-STOP validators (contacts + pricer); collect stale warnings
//   5. For each document the format implies:
//        a. Issue next sequence number
//        b. Render .docx
//        c. Upload to R2
//        d. Insert documents row
//   6. Advance operation.status to 'order_fulfilment' if all OK
//      (operations CHECK does NOT include 'issued' — see comment in code)
// =============================================================================

import type { Env } from '../../types';
import { issueNextSequence } from '../../lib/sequence-format';
import { loadInvoicerInput, OperationNotFoundError } from './data-loader';
import {
  isInternationalDeal, selectBankAccount, selectBankRoute, selectCurrency,
  selectFormat, selectIncoterms, selectLanguage,
} from './selectors';
import {
  validateContacts, validatePricer, validateStale,
} from './validators';
import { renderCommercialInvoice } from './renderers/ci';
import { renderPackingList } from './renderers/pl';
import { renderInvoiceSpecBrushes } from './renderers/is-variant1';
import { renderInvoiceSpecPastes } from './renderers/is-variant2';
import type {
  BankAccountSelection, DocumentFormat, DocumentLanguage, DocumentTypeRequest,
  InvoicerInput, IssueOutcome, IssuedDocument, ValidationStop,
} from './types';

// Schema CHECK on operations.status does NOT include 'issued' — keep ops at
// 'order_fulfilment' after issue. Document status itself uses 'issued'.
const POST_ISSUE_OP_STATUS = 'order_fulfilment';

const SEQUENCE_BY_TYPE: Record<'CI' | 'PL' | 'IS', string> = {
  CI: 'seq_ci',
  PL: 'seq_pl',
  IS: 'seq_is',
};

interface PlannedDocument {
  type: 'CI' | 'PL' | 'IS';
  variant: 'V1' | 'V2' | null;
  format: DocumentFormat;
}

function planDocuments(
  request: DocumentTypeRequest, autoFormat: DocumentFormat
): PlannedDocument[] {
  if (request === 'IS') {
    if (autoFormat === 'IS-V1' || autoFormat === 'IS-V2') {
      return [{ type: 'IS', variant: autoFormat === 'IS-V1' ? 'V1' : 'V2', format: autoFormat }];
    }
    // Caller asked for IS but the rules say CI+PL — pick V1 as a safe default
    // (manufacturer + brushes); the validators will fail downstream if data
    // is missing.
    return [{ type: 'IS', variant: 'V1', format: 'IS-V1' }];
  }
  if (request === 'CI') return [{ type: 'CI', variant: null, format: 'CI' }];
  if (request === 'PL') return [{ type: 'PL', variant: null, format: 'CI' /* PL still needs party blocks */ }];

  // 'auto'
  if (autoFormat === 'IS-V1' || autoFormat === 'IS-V2') {
    return [{ type: 'IS', variant: autoFormat === 'IS-V1' ? 'V1' : 'V2', format: autoFormat }];
  }
  return [
    { type: 'CI', variant: null, format: 'CI' },
    { type: 'PL', variant: null, format: 'CI' },
  ];
}

function fail(stop: ValidationStop, status: 422 | 404 | 409 | 500, warnings: string[]): IssueOutcome {
  return { success: false, status, error: stop, warnings };
}

function genDocId(): string {
  return `doc_${crypto.randomUUID()}`;
}

function originFromRequest(reqUrl: string): string {
  return new URL(reqUrl).origin;
}

export async function issueDocuments(
  operationId: string,
  request: DocumentTypeRequest,
  env: Env,
  reqUrl: string,
): Promise<IssueOutcome> {
  // 1. Load
  let input: InvoicerInput;
  try {
    input = await loadInvoicerInput(env.DB, operationId);
  } catch (err) {
    if (err instanceof OperationNotFoundError) {
      return fail({ code: 'operation_not_found', message: err.message }, 404, []);
    }
    return fail({
      code: 'load_failed',
      message: err instanceof Error ? err.message : String(err),
    }, 500, []);
  }

  if (input.operation.status !== 'draft') {
    return fail({
      code: 'operation_not_draft',
      message: `Operation status is ${input.operation.status}; documents can only be issued from draft.`,
    }, 409, []);
  }

  // 2. Plan
  const autoFormat = selectFormat(input);
  const plan = planDocuments(request, autoFormat);

  // 3. Resolve cross-document context (currency / language base)
  const baseCurrency = selectCurrency(input.ourCompany, input.partner, input.contract);
  const isInternational = isInternationalDeal(input.ourCompany, input.partner);
  const baseIncoterms = selectIncoterms(input.ourCompany, input.partner, input.contract, isInternational);
  const bankAccount: BankAccountSelection | null =
    selectBankAccount(input.ourCompany, baseCurrency, input.companyBankAccounts);

  // Stale warnings (non-blocking)
  const nowSec = Math.floor(Date.now() / 1000);
  const staleWarnings = validateStale(
    input.ourCompany, input.partner, input.manufacturer, nowSec
  );
  const warnings: string[] = staleWarnings.map(
    (w) => `stale_${w.entity}: ${w.entity_id} not verified for ${w.days_ago} days`
  );

  // 4. Validate per-document plan
  for (const doc of plan) {
    const language: DocumentLanguage = selectLanguage(
      doc.format, input.ourCompany, input.partner, input.contract,
    );
    const contactsCheck = validateContacts({
      format: doc.format,
      language,
      ourCompany: input.ourCompany,
      partner: input.partner,
      manufacturer: input.manufacturer,
      bankSelection: bankAccount,
    });
    if (!contactsCheck.ok) return fail(contactsCheck.stop, 422, warnings);

    const pricerCheck = validatePricer(doc.format, input.lineItems);
    if (!pricerCheck.ok) return fail(pricerCheck.stop, 422, warnings);

    if (doc.format === 'IS-V1' || doc.format === 'IS-V2') {
      if (!input.manufacturer) {
        return fail({
          code: 'manufacturer_required',
          message: 'IS format requires operation.manufacturer_id',
        }, 422, warnings);
      }
      const route = selectBankRoute(
        input.manufacturer, input.ourCompany, input.manufacturerBankRoutes,
      );
      if (route.kind === 'route_required') {
        return fail({
          code: 'ROUTE_REQUIRED',
          message: `Dual-route manufacturer ${input.manufacturer.id} has no row ` +
                   `for route ${route.details.expected_route} (payer ${route.details.payer_company_id}). ` +
                   'Seed manufacturer_bank_routes before re-trying.',
          details: route.details,
        }, 422, warnings);
      }
    }
  }

  // 5. Render + upload + insert
  const issued: IssuedDocument[] = [];
  const origin = originFromRequest(reqUrl);
  const yearForKey = new Date(nowSec * 1000).getUTCFullYear();
  let lastCiReference: string | null = null;

  for (const doc of plan) {
    const language: DocumentLanguage = selectLanguage(
      doc.format, input.ourCompany, input.partner, input.contract,
    );

    const seq = await issueNextSequence(env.DB, SEQUENCE_BY_TYPE[doc.type]);
    if (!seq) {
      return fail({
        code: 'sequence_missing',
        message: `Sequence ${SEQUENCE_BY_TYPE[doc.type]} not found in D1. ` +
                 (doc.type === 'IS' ? 'Apply migration 0009_seq_is.sql.' : ''),
      }, 500, warnings);
    }

    let bytes: Uint8Array;
    try {
      if (doc.type === 'CI') {
        bytes = await renderCommercialInvoice({
          reference: seq.formatted,
          issuedAt: nowSec,
          language,
          currency: baseCurrency,
          ourCompany: input.ourCompany,
          partner: input.partner!,
          contract: input.contract,
          bank: bankAccount!,
          incoterms: baseIncoterms,
          lineItems: input.lineItems,
          totalMinor: input.operation.total_amount ?? 0,
        });
        lastCiReference = seq.formatted;
      } else if (doc.type === 'PL') {
        bytes = await renderPackingList({
          reference: seq.formatted,
          issuedAt: nowSec,
          language,
          ourCompany: input.ourCompany,
          partner: input.partner!,
          ciReference: lastCiReference,
          lineItems: input.lineItems,
        });
      } else {
        // IS — V1 or V2
        const route = selectBankRoute(
          input.manufacturer!, input.ourCompany, input.manufacturerBankRoutes,
        );
        const routeRow = route.kind === 'route' ? route.route : null;

        if (doc.variant === 'V2') {
          bytes = await renderInvoiceSpecPastes({
            reference: seq.formatted,
            issuedAt: nowSec,
            currency: baseCurrency,
            manufacturer: input.manufacturer!,
            buyerCompany: input.ourCompany,  // DEE typically; engine uses our_company as buyer
            contract: input.contract,
            bankRoute: routeRow,
            incoterms: baseIncoterms || 'CNF Guangzhou',
            container: null,
            countryStation: null,
            lineItems: input.lineItems,
            totalMinor: input.operation.total_amount ?? 0,
          });
        } else {
          bytes = await renderInvoiceSpecBrushes({
            reference: seq.formatted,
            issuedAt: nowSec,
            currency: baseCurrency,
            manufacturer: input.manufacturer!,
            ourCompany: input.ourCompany,
            buyerCompany: null,
            partner: input.partner,
            contract: input.contract,
            bankRoute: routeRow,
            incoterms: baseIncoterms || 'FOB Shanghai',
            consigneeAtTerminal: null,
            lineItems: input.lineItems,
            totalMinor: input.operation.total_amount ?? 0,
          });
        }
      }
    } catch (err) {
      return fail({
        code: 'render_failed',
        message: `Renderer for ${doc.type} ${doc.variant ?? ''} failed: ` +
                 (err instanceof Error ? err.message : String(err)),
      }, 500, warnings);
    }

    const r2Key = `documents/${yearForKey}/${doc.type}/${seq.formatted}.docx`;
    try {
      await env.DOCS.put(r2Key, bytes, {
        httpMetadata: {
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        customMetadata: {
          operation_id: operationId,
          document_type: doc.type,
          variant: doc.variant ?? '',
          reference: seq.formatted,
          language,
          issued_at: String(nowSec),
        },
      });
    } catch (err) {
      return fail({
        code: 'r2_upload_failed',
        message: err instanceof Error ? err.message : String(err),
      }, 500, warnings);
    }

    const docId = genDocId();
    const totalForDoc = doc.type === 'PL' ? null : (input.operation.total_amount ?? 0);
    try {
      await env.DB.prepare(`
        INSERT INTO documents (
          id, document_number, document_type, operation_id,
          issuer_id, partner_id, contract_ref, document_date,
          currency, total_amount, pdf_r2_url, owner_name,
          mandatory_level, when_ready, status, metadata,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'mandatory', NULL, 'issued', ?, ?, ?, NULL)
      `).bind(
        docId, seq.formatted, doc.type, operationId,
        input.ourCompany.id, input.operation.partner_id,
        input.contract?.contract_no ?? null, nowSec,
        baseCurrency, totalForDoc, r2Key,
        JSON.stringify({ variant: doc.variant, language, format: doc.format }),
        nowSec, nowSec
      ).run();
    } catch (err) {
      try { await env.DOCS.delete(r2Key); } catch { /* best effort */ }
      return fail({
        code: 'document_insert_failed',
        message: err instanceof Error ? err.message : String(err),
      }, 500, warnings);
    }

    issued.push({
      document_id: docId,
      type: doc.type,
      variant: doc.variant,
      reference: seq.formatted,
      language,
      format: doc.format,
      r2_key: r2Key,
      download_url: `${origin}/api/documents/${docId}/download`,
    });
  }

  // 6. Advance operation status
  let operationStatusAfter = input.operation.status;
  try {
    await env.DB.prepare(
      `UPDATE operations SET status = ?, updated_at = ? WHERE id = ?`
    ).bind(POST_ISSUE_OP_STATUS, nowSec, operationId).run();
    operationStatusAfter = POST_ISSUE_OP_STATUS;
  } catch {
    // Non-fatal — documents are already issued; status advance is bookkeeping.
  }

  return {
    success: true,
    documents: issued,
    warnings,
    operation_status_after: operationStatusAfter,
  };
}
