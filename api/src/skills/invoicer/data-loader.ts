// =============================================================================
// Invoicer engine — data loader.
// One function (loadInvoicerInput) that pulls every row the rest of the
// pipeline needs from D1 and resolves the "legal seller" cascade.
//
// Legal seller resolution (used by selectDocumentsToIssue):
//   1. operation.legal_seller_id wins if set.
//   2. operation.manufacturer_id wins if set.
//   3. else: derive from products.manufacturer_id — every line must agree.
//      mixed → throw MixedManufacturerError (limitation #3 in PR description).
// =============================================================================

import type {
  CompanyBankAccountRow, CompanyRow, ContractRow, InvoicerInput,
  LineItemRow, ManufacturerBankRouteRow, ManufacturerRow, OperationRow,
  PartnerRow,
} from './types';

export class OperationNotFoundError extends Error {
  constructor(public operationId: string) {
    super(`Operation ${operationId} not found`);
    this.name = 'OperationNotFoundError';
  }
}

export class MixedManufacturerError extends Error {
  constructor(
    public manufacturerIds: string[],
    /** Mapping manufacturer_id → product_ids that resolve to it. Used by the
     *  entry point to render a friendly "WDAA (DE201, DE206) + Jinxia (DE119)"
     *  message after enriching IDs with manufacturer slugs. */
    public productGrouping: Record<string, string[]> = {}
  ) {
    super(
      `Operation has line items from multiple legal sellers ` +
      `(${manufacturerIds.join(', ')}). Split into separate operations.`
    );
    this.name = 'MixedManufacturerError';
  }
}

const OPERATION_COLS = `
  id, operation_date, operation_type, partner_id, our_company_id,
  manufacturer_id, warehouse_from_id, warehouse_to_id, shipper_id,
  status, currency, total_amount, incoterms, hs_code,
  reference, contract_id, default_document_language,
  dei_layer, legal_seller_id
`;

const COMPANY_COLS = `
  id, abbreviation, legal_name, legal_name_ru, legal_name_local,
  trade_name, jurisdiction, registration_no, tax_id, kpp, ogrn,
  registered_address, base_currency,
  bank_name, bank_account, swift, iban, bank_address,
  bank_name_en, bik, correspondent_account,
  signing_authority_name, signing_authority_title_en, signing_authority_title_ru,
  default_invoice_language, default_document_language, preferred_incoterms_domestic,
  preferred_incoterms_international, last_verified
`;

const PARTNER_COLS = `
  id, trade_name, legal_name, legal_name_local, country, tax_id,
  kpp, inn, ogrn, registered_address_local,
  iban, swift_bic, bank_name, email,
  payment_terms, preferred_incoterms, preferred_invoice_language,
  partner_local_language, last_verified, status
`;

const MANUFACTURER_COLS = `
  id, name, country, city, address,
  legal_name_en, legal_name_ru, legal_name_cn,
  registered_address_en, registered_address_ru,
  tax_id, has_dual_route_banking, last_verified,
  slug, is_packaging_manufacturer, is_legal_seller
`;

const CONTRACT_COLS = `
  id, contract_no, partner_id, our_company_id, currency,
  signed_date, expiry_date, incoterms,
  unk_reference, unk_valid_until, invoice_language
`;

const CBA_COLS = `
  id, company_id, account_purpose, account_number, currency, is_default, notes
`;

const MBR_COLS = `
  id, manufacturer_id, route_code, payer_jurisdiction_filter,
  bank_name, bank_address, account_number, iban, swift, account_holder, currency
`;

const LINE_ITEM_COLS = `
  li.id, li.product_id, li.item_description, li.qty, li.cartons,
  li.unit_price, li.unit_price_after_disc, li.line_amount, li.currency,
  p.manufacturer_id   AS product_manufacturer_id,
  p.packaging_manufacturer_id,
  p.description_en, p.description_ru, p.description_cn,
  p.invoice_label,
  p.invoice_label_ru, p.invoice_label_en, p.invoice_label_cn,
  p.hs_code,
  p.ctn_qty, p.ctn_weight_gross_kg, p.unit_net_weight_g, p.country_of_origin,
  p.category, p.subcategory
`;

// =============================================================================
// Cascade: resolve which manufacturer is the legal seller for this operation.
// Returns null when no factory entity is involved (pure DEE / DEI distribution
// sale where no manufacturer is on the documents at all).
// =============================================================================

function resolveLegalSellerId(
  op: OperationRow, lineItems: LineItemRow[]
): string | null {
  if (op.legal_seller_id) return op.legal_seller_id;
  if (op.manufacturer_id) return op.manufacturer_id;

  // Sales: seller is always our_company (DEE for Russia UPD/TN, DEI for international CI/PL).
  // Manufacturers (Honghui/Jinxia/Meizhiyuan/WDAA) never sell to third parties — they
  // only sell to our companies. So for sale operations the factory behind each line
  // item is irrelevant; multi-factory sales (pastes + brushes in one shipment) are fine.
  if (op.operation_type === 'sale') {
    return null;
  }

  // Purchase / transfer with neither override → caller decides if this is a problem.
  return null;
}

// =============================================================================
// Resolve a packaging manufacturer when distinct from the legal seller.
// We only treat the packaging_manufacturer as "distinct" if every line has
// the same packaging_manufacturer_id AND it differs from the legal seller.
// =============================================================================

function resolvePackagingManufacturerId(
  legalSellerId: string | null, lineItems: LineItemRow[]
): string | null {
  const ids = Array.from(new Set(
    lineItems
      .map((li) => li.packaging_manufacturer_id)
      .filter((x): x is string => !!x)
  ));
  if (ids.length === 0) return null;
  if (ids.length > 1) return null;       // mixed packaging → fall back to legal seller
  const id = ids[0]!;
  if (id === legalSellerId) return null; // same as legal seller → don't double-render
  return id;
}

// =============================================================================
// Public loader
// =============================================================================

export async function loadInvoicerInput(
  db: D1Database, operationId: string
): Promise<InvoicerInput> {
  const operation = await db.prepare(
    `SELECT ${OPERATION_COLS} FROM operations WHERE id = ? AND deleted_at IS NULL`
  ).bind(operationId).first<OperationRow>();

  if (!operation) throw new OperationNotFoundError(operationId);

  const [
    ourCompany, partner, contract, lineItemsRes, companyBankAccountsRes,
  ] = await Promise.all([
    db.prepare(
      `SELECT ${COMPANY_COLS} FROM companies WHERE id = ? AND deleted_at IS NULL`
    ).bind(operation.our_company_id).first<CompanyRow>(),

    operation.partner_id
      ? db.prepare(
          `SELECT ${PARTNER_COLS} FROM partners WHERE id = ? AND deleted_at IS NULL`
        ).bind(operation.partner_id).first<PartnerRow>()
      : Promise.resolve(null),

    operation.contract_id
      ? db.prepare(
          `SELECT ${CONTRACT_COLS} FROM contracts WHERE id = ? AND deleted_at IS NULL`
        ).bind(operation.contract_id).first<ContractRow>()
      : Promise.resolve(null),

    db.prepare(
      `SELECT ${LINE_ITEM_COLS}
         FROM line_items li
         LEFT JOIN products p ON p.id = li.product_id
        WHERE li.operation_id = ?
        ORDER BY li.created_at ASC`
    ).bind(operationId).all<LineItemRow>(),

    db.prepare(
      `SELECT ${CBA_COLS} FROM company_bank_accounts
        WHERE company_id = ? AND deleted_at IS NULL`
    ).bind(operation.our_company_id).all<CompanyBankAccountRow>(),
  ]);

  if (!ourCompany) {
    throw new Error(`Issuer company ${operation.our_company_id} not found`);
  }

  const lineItems = lineItemsRes.results ?? [];

  const legalSellerId = resolveLegalSellerId(operation, lineItems);
  const packagingManufacturerId = resolvePackagingManufacturerId(legalSellerId, lineItems);

  // Pull manufacturer rows + their bank routes (only when one is involved).
  const manufacturerIdsToLoad = Array.from(new Set(
    [legalSellerId, packagingManufacturerId].filter((x): x is string => !!x)
  ));

  let legalSellerManufacturer: ManufacturerRow | null = null;
  let packagingManufacturer: ManufacturerRow | null = null;
  let manufacturerBankRoutes: ManufacturerBankRouteRow[] = [];

  if (manufacturerIdsToLoad.length > 0) {
    const placeholders = manufacturerIdsToLoad.map(() => '?').join(',');
    const [mfrRowsRes, routesRes] = await Promise.all([
      db.prepare(
        `SELECT ${MANUFACTURER_COLS} FROM manufacturers
          WHERE id IN (${placeholders}) AND deleted_at IS NULL`
      ).bind(...manufacturerIdsToLoad).all<ManufacturerRow>(),
      // Load routes for every manufacturer in scope. Earlier the query was
      // gated on legal_seller_id only, which silently returned an empty set
      // when an operation listed manufacturer_id but left legal_seller_id
      // null — causing the renderer to crash on a null bank.
      db.prepare(
        `SELECT ${MBR_COLS} FROM manufacturer_bank_routes
          WHERE manufacturer_id IN (${placeholders}) AND deleted_at IS NULL`
      ).bind(...manufacturerIdsToLoad).all<ManufacturerBankRouteRow>(),
    ]);
    const byId = new Map((mfrRowsRes.results ?? []).map((m) => [m.id, m]));
    legalSellerManufacturer = legalSellerId ? byId.get(legalSellerId) ?? null : null;
    packagingManufacturer = packagingManufacturerId ? byId.get(packagingManufacturerId) ?? null : null;
    manufacturerBankRoutes = routesRes.results ?? [];
  }

  // For dei_layer flows the entry point also needs DEE + DEI on hand.
  // Cheap to fetch: pull the small set of well-known company ids in one shot.
  const extraCompanyIds = Array.from(new Set(
    ['dee', 'dei', operation.our_company_id]
  ));
  const placeholders = extraCompanyIds.map(() => '?').join(',');
  const extraCompaniesRes = await db.prepare(
    `SELECT ${COMPANY_COLS} FROM companies
      WHERE id IN (${placeholders}) AND deleted_at IS NULL`
  ).bind(...extraCompanyIds).all<CompanyRow>();
  const companiesById: Record<string, CompanyRow> = {};
  for (const c of extraCompaniesRes.results ?? []) companiesById[c.id] = c;
  companiesById[ourCompany.id] = ourCompany;

  return {
    operation,
    ourCompany,
    partner: partner ?? null,
    legalSellerManufacturer,
    packagingManufacturer,
    contract: contract ?? null,
    companyBankAccounts: companyBankAccountsRes.results ?? [],
    manufacturerBankRoutes,
    lineItems,
    companiesById,
  };
}
