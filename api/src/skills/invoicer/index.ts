// =============================================================================
// Invoicer engine — entry point.
//
// One call: issueDocuments(operationId, env, reqUrl) → IssueOutcome.
// Engine decides everything (no document_type request param):
//   1. Load D1 rows
//   2. Plan via selectDocumentsToIssue → DocumentSpec[]
//   3. Run validators per spec (HARD STOP gates)
//   4. For each spec: issue sequence, render, R2 put, D1 insert
//   5. Atomic R2 rollback if any step fails
//   6. Set operation.status to 'issued' (or fall back to 'order_fulfilment'
//      when the CHECK constraint forbids 'issued')
// =============================================================================

import type { Env } from '../../types';
import { issueNextSequence } from '../../lib/sequence-format';
import {
  loadInvoicerInput, MixedManufacturerError, OperationNotFoundError,
} from './data-loader';
import {
  isInternationalDeal, selectBankAccount, selectCurrency,
  selectDocumentsToIssue, selectIncoterms, selectLanguage,
  selectManufacturerBankRoute,
} from './selectors';
import {
  validateContacts, validatePricer, validateProductDescriptions, validateStale,
  viewCompany, viewManufacturer, viewPartner,
} from './validators';
import { renderCommercialInvoice } from './renderers/ci';
import { renderPackingList } from './renderers/pl';
import { renderInvoiceSpecBrushes } from './renderers/is-variant1';
import { renderInvoiceSpecPastes } from './renderers/is-variant2';
import type {
  CompanyRow, DocumentSpec, IssueOutcome, IssuedDocument, ManufacturerRow,
  ManufacturerBankRouteRow, PartnerRow, ValidationStop,
} from './types';
import type {
  RenderBank, RenderParty, RenderSignature,
} from './renderers/shared';

const SEQUENCE_BY_TYPE: Record<'CI' | 'PL' | 'IS', string> = {
  CI: 'seq_ci', PL: 'seq_pl', IS: 'seq_is',
};

// =============================================================================
// Adapter helpers — turn typed rows into the renderer-facing shapes.
// =============================================================================

function partyFromCompany(c: CompanyRow): RenderParty {
  return {
    legalNameEn: c.legal_name,
    legalNameLocal: c.legal_name_ru ?? c.legal_name_local,
    legalNameCn: null,
    addressEn: c.registered_address,
    addressLocal: c.registered_address,  // companies store one address; reuse
    taxId: c.tax_id,
    inn: null,
    kpp: c.kpp,
    ogrn: c.ogrn,
    registrationNo: c.registration_no,
    email: null,
  };
}

function partyFromManufacturer(m: ManufacturerRow): RenderParty {
  return {
    legalNameEn: m.legal_name_en,
    legalNameLocal: m.legal_name_ru,
    legalNameCn: m.legal_name_cn,
    addressEn: m.registered_address_en,
    addressLocal: m.registered_address_ru,
    taxId: m.tax_id,
    inn: null,
    kpp: null,
    ogrn: null,
    registrationNo: null,
    email: null,
  };
}

function partyFromPartner(p: PartnerRow): RenderParty {
  return {
    legalNameEn: p.legal_name,
    legalNameLocal: p.legal_name_local,
    legalNameCn: null,
    addressEn: p.country,
    addressLocal: p.registered_address_local,
    taxId: p.tax_id,
    inn: p.inn,
    kpp: p.kpp,
    ogrn: p.ogrn,
    registrationNo: null,
    email: p.email,
  };
}

function bankFromSelection(b: import('./types').BankAccountSelection): RenderBank {
  return {
    bankName: b.bank_name,
    bankAddress: b.bank_address,
    accountNumber: b.account_number,
    iban: b.iban,
    swift: b.swift,
    bik: b.bik,
    correspondentAccount: b.correspondent_account,
    accountHolder: b.account_holder,
    currency: b.currency,
  };
}

function bankFromRoute(r: ManufacturerBankRouteRow): RenderBank {
  return {
    bankName: r.bank_name,
    bankAddress: r.bank_address,
    accountNumber: r.account_number ?? r.iban ?? '',
    iban: r.iban,
    swift: r.swift,
    bik: null,
    correspondentAccount: null,
    accountHolder: r.account_holder,
    currency: r.currency,
  };
}

function signatureFromCompany(c: CompanyRow): RenderSignature {
  return {
    name: c.signing_authority_name,
    titleEn: c.signing_authority_title_en,
    titleRu: c.signing_authority_title_ru,
  };
}

function signatureFallback(): RenderSignature {
  return { name: 'Aram Badalyan', titleEn: 'General Manager', titleRu: 'Генеральный директор' };
}

// =============================================================================
// Helper: does operations.status CHECK include 'issued'?
// We probe sqlite_master once per call. Cheap — D1 caches it.
// =============================================================================

async function operationsStatusAllowsIssued(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='operations'`
  ).first<{ sql: string | null }>();
  if (!row?.sql) return false;
  return /CHECK\s*\(\s*status\s+IN\s*\([^)]*'issued'[^)]*\)\s*\)/i.test(row.sql);
}

// =============================================================================
// Main entry point
// =============================================================================

function fail(stop: ValidationStop, status: 422 | 404 | 409 | 500, warnings: string[]): IssueOutcome {
  return { success: false, status, error: stop, warnings };
}

function genDocId(): string { return `doc_${crypto.randomUUID()}`; }
function originFromRequest(reqUrl: string): string { return new URL(reqUrl).origin; }

export async function issueDocuments(
  operationId: string, env: Env, reqUrl: string
): Promise<IssueOutcome> {
  // 1. Load
  let input: Awaited<ReturnType<typeof loadInvoicerInput>>;
  try {
    input = await loadInvoicerInput(env.DB, operationId);
  } catch (err) {
    if (err instanceof OperationNotFoundError) {
      return fail({ code: 'operation_not_found', message: err.message }, 404, []);
    }
    if (err instanceof MixedManufacturerError) {
      // Enrich the error with manufacturer slugs/names so the message reads
      // "WDAA (DE201, DE206) + Jinxia (DE119)" instead of bare mfr_* IDs.
      let friendly: string | null = null;
      try {
        const placeholders = err.manufacturerIds.map(() => '?').join(',');
        const rows = await env.DB.prepare(
          `SELECT id, slug, name, legal_name_en FROM manufacturers
            WHERE id IN (${placeholders}) AND deleted_at IS NULL`
        ).bind(...err.manufacturerIds).all<{
          id: string; slug: string | null; name: string | null;
          legal_name_en: string | null;
        }>();
        const labelById = new Map<string, string>();
        for (const m of rows.results ?? []) {
          labelById.set(m.id, m.slug ?? m.legal_name_en ?? m.name ?? m.id);
        }
        const parts = err.manufacturerIds.map((mid) => {
          const label = labelById.get(mid) ?? mid;
          const skus = (err.productGrouping[mid] ?? []).map((s) => s.toUpperCase()).join(', ');
          return skus ? `${label} (${skus})` : label;
        });
        friendly = `Operation has products from multiple legal sellers: ${parts.join(' + ')}. ` +
                   'Split into separate operations.';
      } catch { /* fall back to raw IDs */ }
      return fail({
        code: 'MIXED_MANUFACTURER',
        message: friendly ?? err.message,
        details: {
          manufacturer_ids: err.manufacturerIds,
          product_grouping: err.productGrouping,
        },
      }, 422, []);
    }
    return fail({
      code: 'load_failed', message: err instanceof Error ? err.message : String(err),
    }, 500, []);
  }

  // Re-issue prevention.
  if (input.operation.status === 'issued') {
    return fail({
      code: 'documents_already_issued',
      message: `Operation ${operationId} already has status 'issued'. Re-issue is not supported.`,
    }, 409, []);
  }
  if (input.operation.status !== 'draft') {
    return fail({
      code: 'operation_not_draft',
      message: `Operation status is ${input.operation.status}; documents can only be issued from draft.`,
    }, 409, []);
  }

  // 2. Plan
  let plan: DocumentSpec[];
  try {
    plan = selectDocumentsToIssue(input);
  } catch (err) {
    return fail({
      code: 'plan_failed', message: err instanceof Error ? err.message : String(err),
    }, 422, []);
  }

  // Stale warnings (non-blocking)
  const nowSec = Math.floor(Date.now() / 1000);
  const staleWarnings = validateStale(
    input.ourCompany, input.partner, input.legalSellerManufacturer, nowSec,
  );
  const warnings: string[] = staleWarnings.map(
    (w) => `stale_${w.entity}: ${w.entity_id} not verified for ${w.days_ago} days`
  );

  // ---------------------------------------------------------------------------
  // 3. Per-spec validation pass — every doc must pass before any are emitted.
  // ---------------------------------------------------------------------------
  function partyForSpec(kind: 'company' | 'manufacturer' | 'partner', id: string) {
    if (kind === 'company') {
      const c = input.companiesById[id];
      if (!c) throw new Error(`Company ${id} required by plan but not loaded`);
      return { row: c, view: viewCompany(c), party: partyFromCompany(c) };
    }
    if (kind === 'manufacturer') {
      const m = input.legalSellerManufacturer;
      if (!m || m.id !== id) throw new Error(`Manufacturer ${id} required but not loaded`);
      return { row: m, view: viewManufacturer(m), party: partyFromManufacturer(m) };
    }
    const p = input.partner;
    if (!p || p.id !== id) throw new Error(`Partner ${id} required but not loaded`);
    return { row: p, view: viewPartner(p), party: partyFromPartner(p) };
  }

  // Pre-resolve a bank for each spec so validation can reject early.
  type Resolved = {
    spec: DocumentSpec;
    seller: ReturnType<typeof partyForSpec>;
    buyer: ReturnType<typeof partyForSpec>;
    language: 'EN' | 'RU' | 'BILINGUAL';
    currency: string;
    needsBank: boolean;
    bankSelection: import('./types').BankAccountSelection | null;
    manufacturerRoute: ManufacturerBankRouteRow | null;
  };

  const resolved: Resolved[] = [];

  for (const spec of plan) {
    let seller: ReturnType<typeof partyForSpec>;
    let buyer: ReturnType<typeof partyForSpec>;
    try {
      seller = partyForSpec(spec.sellerKind, spec.sellerId);
      buyer = partyForSpec(spec.buyerKind, spec.buyerId);
    } catch (err) {
      return fail({
        code: 'plan_party_resolution_failed',
        message: err instanceof Error ? err.message : String(err),
      }, 500, warnings);
    }

    const language = selectLanguage(spec.format, input.ourCompany, input.partner, input.contract);
    const currency = selectCurrency(input.ourCompany, input.partner, input.contract, spec.sellerKind);
    const needsBank = spec.type !== 'PL';

    let bankSelection: import('./types').BankAccountSelection | null = null;
    let manufacturerRoute: ManufacturerBankRouteRow | null = null;

    if (needsBank) {
      if (spec.sellerKind === 'company') {
        bankSelection = selectBankAccount(seller.row as CompanyRow, currency, input.companyBankAccounts);
      } else {
        // Manufacturer-led document — pick a bank route. Payer is the buyer
        // when buyer is a company; when buyer is a partner the payer is
        // typically our_company (the operating entity that pays the factory).
        const payer = spec.buyerKind === 'company'
          ? (input.companiesById[spec.buyerId] ?? input.ourCompany)
          : input.ourCompany;
        const result = selectManufacturerBankRoute(
          seller.row as ManufacturerRow, payer, input.manufacturerBankRoutes,
        );
        if (result.kind === 'route_required') {
          // Resolve human-readable identifiers (slug / abbreviation) so the
          // message points at "guangzhou-honghui" / "DEI" instead of raw IDs.
          const mfr = seller.row as ManufacturerRow;
          const mfrLabel = mfr.slug ?? mfr.legal_name_en ?? mfr.name ?? mfr.id;
          const payerLabel = payer.abbreviation ?? payer.id;
          const found = result.details.routes_found.length
            ? `[${result.details.routes_found.join(', ')}]`
            : '[]';
          return fail({
            code: 'ROUTE_REQUIRED',
            message: `Manufacturer '${mfrLabel}' has no bank route for payer '${payerLabel}'. ` +
                     `Routes found: ${found}. ` +
                     `Required: ${result.details.expected_route}. ` +
                     'Add the missing row to manufacturer_bank_routes.',
            details: result.details,
          }, 422, warnings);
        }
        if (result.kind === 'route') manufacturerRoute = result.route;
        // 'no_routing_required' → leave both null
      }
    }

    const contactsCheck = validateContacts({
      format: spec.format, language,
      seller: seller.view, buyer: buyer.view,
      bankSelection: spec.sellerKind === 'company' ? bankSelection : (manufacturerRoute ? {
        source: 'company_bank_accounts',
        account_number: manufacturerRoute.account_number ?? manufacturerRoute.iban ?? '',
        bank_name: manufacturerRoute.bank_name,
        swift: manufacturerRoute.swift,
        iban: manufacturerRoute.iban,
        bank_address: manufacturerRoute.bank_address,
        bik: null,
        correspondent_account: null,
        currency: manufacturerRoute.currency,
        account_holder: manufacturerRoute.account_holder,
      } : null),
      needsBank,
    });
    if (!contactsCheck.ok) return fail(contactsCheck.stop, 422, warnings);

    const pricerCheck = validatePricer(spec.format, input.lineItems);
    if (!pricerCheck.ok) return fail(pricerCheck.stop, 422, warnings);

    const descCheck = validateProductDescriptions(spec.format, input.lineItems);
    if (!descCheck.ok) return fail(descCheck.stop, 422, warnings);

    resolved.push({ spec, seller, buyer, language, currency, needsBank, bankSelection, manufacturerRoute });
  }

  // ---------------------------------------------------------------------------
  // 4. Render + R2 upload + D1 insert (atomic — rollback R2 on any failure).
  // ---------------------------------------------------------------------------
  const issued: IssuedDocument[] = [];
  const uploadedR2Keys: string[] = [];
  const yearForKey = new Date(nowSec * 1000).getUTCFullYear();
  const origin = originFromRequest(reqUrl);
  const isInternational = isInternationalDeal(input.ourCompany, input.partner);
  let lastCiReference: string | null = null;

  async function rollback(reason: string): Promise<IssueOutcome> {
    for (const key of uploadedR2Keys) {
      try { await env.DOCS.delete(key); } catch { /* best effort */ }
    }
    return fail({ code: 'pipeline_failed', message: reason }, 500, warnings);
  }

  for (const r of resolved) {
    const seq = await issueNextSequence(env.DB, SEQUENCE_BY_TYPE[r.spec.type]);
    if (!seq) {
      return rollback(
        `Sequence ${SEQUENCE_BY_TYPE[r.spec.type]} not found in D1.` +
        (r.spec.type === 'IS' ? ' Apply migration 0009_invoicer_roles_and_routes.sql.' : '')
      );
    }
    const reference = seq.formatted;

    let bytes: Uint8Array;
    try {
      if (r.spec.type === 'CI') {
        bytes = await renderCommercialInvoice({
          reference, issuedAt: nowSec, language: r.language, currency: r.currency,
          seller: r.seller.party,
          buyer: r.buyer.party,
          bank: bankFromSelection(r.bankSelection!),
          signature: r.spec.sellerKind === 'company'
            ? signatureFromCompany(r.seller.row as CompanyRow)
            : signatureFallback(),
          contract: input.contract,
          incoterms: selectIncoterms(input.ourCompany, input.partner, input.contract, isInternational),
          paymentTerms: input.partner?.payment_terms ?? null,
          lineItems: input.lineItems,
          totalMinor: input.operation.total_amount ?? 0,
        });
        lastCiReference = reference;
      } else if (r.spec.type === 'PL') {
        bytes = await renderPackingList({
          reference, issuedAt: nowSec, language: r.language,
          shipper: r.seller.party,
          consignee: r.buyer.party,
          ciReference: lastCiReference,
          lineItems: input.lineItems,
        });
      } else {
        // IS-V1 or IS-V2
        const bank = r.manufacturerRoute ? bankFromRoute(r.manufacturerRoute)
          : (r.bankSelection ? bankFromSelection(r.bankSelection) : null);
        const signature = r.spec.sellerKind === 'company'
          ? signatureFromCompany(r.seller.row as CompanyRow)
          : signatureFallback();
        if (r.spec.variant === 'V2') {
          bytes = await renderInvoiceSpecPastes({
            reference, issuedAt: nowSec, currency: r.currency,
            shipperSeller: r.seller.party,
            consigneeBuyer: r.buyer.party,
            bank, signature, contract: input.contract,
            incoterms: selectIncoterms(input.ourCompany, input.partner, input.contract, isInternational) || 'CNF Guangzhou',
            container: null, countryStation: null,
            lineItems: input.lineItems,
            totalMinor: input.operation.total_amount ?? 0,
          });
        } else {
          // For V1 the third "Seller" party block defaults to the seller (mfr)
          // when no separate selling-side company is in play; for the
          // dei_layer chain it's DEI as the selling-side company. Use the
          // operation's own legal_seller chain to decide.
          const sellerSideParty = r.spec.sellerKind === 'manufacturer'
            ? r.seller.party
            : partyFromCompany(input.ourCompany);
          bytes = await renderInvoiceSpecBrushes({
            reference, issuedAt: nowSec, currency: r.currency,
            shipper: r.spec.sellerKind === 'manufacturer'
              ? r.seller.party
              : (input.legalSellerManufacturer
                   ? partyFromManufacturer(input.legalSellerManufacturer)
                   : r.seller.party),
            buyer: r.buyer.party,
            seller: sellerSideParty,
            // Seller is distinct from shipper iff the spec routes through a
            // company seller (dei_layer Factory→DEI→DEE) — in the direct
            // Factory→buyer case shipper and seller are the same row.
            sellerDistinctFromShipper: r.spec.sellerKind === 'company',
            bank, signature, contract: input.contract,
            incoterms: selectIncoterms(input.ourCompany, input.partner, input.contract, isInternational) || 'FOB Shanghai',
            consigneeAtTerminal: null,
            lineItems: input.lineItems,
            totalMinor: input.operation.total_amount ?? 0,
          });
        }
      }
    } catch (err) {
      return rollback(`Renderer for ${r.spec.type} ${r.spec.variant ?? ''} failed: ` +
        (err instanceof Error ? err.message : String(err)));
    }

    const r2Key = `documents/${yearForKey}/${r.spec.type}/${reference}.docx`;
    try {
      await env.DOCS.put(r2Key, bytes, {
        httpMetadata: {
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        customMetadata: {
          operation_id: operationId,
          document_type: r.spec.type,
          variant: r.spec.variant ?? '',
          reference,
          language: r.language,
          issued_at: String(nowSec),
        },
      });
      uploadedR2Keys.push(r2Key);
    } catch (err) {
      return rollback(`R2 upload failed for ${r2Key}: ` +
        (err instanceof Error ? err.message : String(err)));
    }

    const docId = genDocId();
    const totalForDoc = r.spec.type === 'PL' ? null : (input.operation.total_amount ?? 0);
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
        docId, reference, r.spec.type, operationId,
        input.ourCompany.id, input.operation.partner_id,
        input.contract?.contract_no ?? null, nowSec,
        r.currency, totalForDoc, r2Key,
        JSON.stringify({
          variant: r.spec.variant, language: r.language, format: r.spec.format,
          seller_kind: r.spec.sellerKind, seller_id: r.spec.sellerId,
          buyer_kind: r.spec.buyerKind, buyer_id: r.spec.buyerId,
        }),
        nowSec, nowSec
      ).run();
    } catch (err) {
      return rollback(`D1 insert failed for ${docId}: ` +
        (err instanceof Error ? err.message : String(err)));
    }

    issued.push({
      document_id: docId, type: r.spec.type, variant: r.spec.variant,
      reference, language: r.language, format: r.spec.format,
      r2_key: r2Key, download_url: `${origin}/api/documents/${docId}/download`,
    });
  }

  // 5. Operation status transition.
  const allowsIssued = await operationsStatusAllowsIssued(env.DB);
  const targetStatus = allowsIssued ? 'issued' : 'order_fulfilment';
  let operationStatusAfter = input.operation.status;
  try {
    await env.DB.prepare(
      `UPDATE operations SET status = ?, updated_at = ? WHERE id = ?`
    ).bind(targetStatus, nowSec, operationId).run();
    operationStatusAfter = targetStatus;
  } catch {
    // Non-fatal — documents are already issued.
  }

  return {
    success: true,
    operation_id: operationId,
    operation_status_after: operationStatusAfter,
    documents: issued,
    warnings,
  };
}
