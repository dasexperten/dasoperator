// =============================================================================
// Invoicer engine — data loader.
// Single function (loadInvoicerInput) that pulls every row the rest of the
// pipeline needs from D1 in a small, fixed number of queries.
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

const OPERATION_COLS = `
  id, operation_date, operation_type, partner_id, our_company_id,
  manufacturer_id, warehouse_from_id, warehouse_to_id, shipper_id,
  status, currency, total_amount, incoterms, hs_code,
  reference, contract_id, default_document_language
`;

const COMPANY_COLS = `
  id, abbreviation, legal_name, legal_name_ru, legal_name_local,
  trade_name, jurisdiction, registration_no, tax_id, kpp, ogrn,
  registered_address, base_currency,
  bank_name, bank_account, swift, iban, bank_address,
  bank_name_en, bik, correspondent_account,
  signing_authority_name, signing_authority_title_en, signing_authority_title_ru,
  default_invoice_language, preferred_incoterms_domestic,
  preferred_incoterms_international, last_verified
`;

const PARTNER_COLS = `
  id, trade_name, legal_name, legal_name_local, country, tax_id,
  kpp, inn, ogrn, registered_address_local,
  iban, swift_bic, bank_name, email,
  payment_terms, preferred_incoterms, preferred_invoice_language,
  last_verified, status
`;

const MANUFACTURER_COLS = `
  id, name, country, city, address,
  legal_name_en, legal_name_ru, legal_name_cn,
  registered_address_en, registered_address_ru,
  tax_id, has_dual_route_banking, last_verified
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
  p.description_en, p.description_ru, p.description_cn,
  p.invoice_label, p.hs_code,
  p.ctn_qty, p.ctn_weight_gross_kg, p.unit_net_weight_g, p.country_of_origin
`;

export async function loadInvoicerInput(
  db: D1Database, operationId: string
): Promise<InvoicerInput> {
  const operation = await db.prepare(
    `SELECT ${OPERATION_COLS} FROM operations WHERE id = ? AND deleted_at IS NULL`
  ).bind(operationId).first<OperationRow>();

  if (!operation) throw new OperationNotFoundError(operationId);

  // Parallelise everything else — none of these queries depend on each other.
  const [
    ourCompany, partner, manufacturer, contract,
    companyBankAccountsRes, manufacturerBankRoutesRes, lineItemsRes,
  ] = await Promise.all([
    db.prepare(
      `SELECT ${COMPANY_COLS} FROM companies WHERE id = ? AND deleted_at IS NULL`
    ).bind(operation.our_company_id).first<CompanyRow>(),

    operation.partner_id
      ? db.prepare(
          `SELECT ${PARTNER_COLS} FROM partners WHERE id = ? AND deleted_at IS NULL`
        ).bind(operation.partner_id).first<PartnerRow>()
      : Promise.resolve(null),

    operation.manufacturer_id
      ? db.prepare(
          `SELECT ${MANUFACTURER_COLS} FROM manufacturers WHERE id = ? AND deleted_at IS NULL`
        ).bind(operation.manufacturer_id).first<ManufacturerRow>()
      : Promise.resolve(null),

    operation.contract_id
      ? db.prepare(
          `SELECT ${CONTRACT_COLS} FROM contracts WHERE id = ? AND deleted_at IS NULL`
        ).bind(operation.contract_id).first<ContractRow>()
      : Promise.resolve(null),

    db.prepare(
      `SELECT ${CBA_COLS} FROM company_bank_accounts
        WHERE company_id = ? AND deleted_at IS NULL`
    ).bind(operation.our_company_id).all<CompanyBankAccountRow>(),

    operation.manufacturer_id
      ? db.prepare(
          `SELECT ${MBR_COLS} FROM manufacturer_bank_routes
            WHERE manufacturer_id = ? AND deleted_at IS NULL`
        ).bind(operation.manufacturer_id).all<ManufacturerBankRouteRow>()
      : Promise.resolve({ results: [] as ManufacturerBankRouteRow[] }),

    db.prepare(
      `SELECT ${LINE_ITEM_COLS}
         FROM line_items li
         LEFT JOIN products p ON p.id = li.product_id
        WHERE li.operation_id = ?
        ORDER BY li.created_at ASC`
    ).bind(operationId).all<LineItemRow>(),
  ]);

  if (!ourCompany) {
    throw new Error(`Issuer company ${operation.our_company_id} not found`);
  }

  return {
    operation,
    ourCompany,
    partner: partner ?? null,
    manufacturer: manufacturer ?? null,
    contract: contract ?? null,
    companyBankAccounts: companyBankAccountsRes.results ?? [],
    manufacturerBankRoutes: manufacturerBankRoutesRes.results ?? [],
    lineItems: lineItemsRes.results ?? [],
  };
}
