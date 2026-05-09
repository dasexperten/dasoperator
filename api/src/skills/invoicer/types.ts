// =============================================================================
// Invoicer engine — type contracts shared by data-loader, selectors,
// validators, renderers, and the entry point.
// =============================================================================
// Money values are MINOR units (kopecks/cents). Rendering converts via
// formatMoney() — ×100 for USD/EUR/RUB/CNY, ×1 for VND.
//
// HARD-STOP rule (from invoicer skill): if contacts is missing a required
// field, the document does not exist yet. Never fabricate, never substitute
// a placeholder, never fall back to the skill .md "memory". See validators.ts.
// =============================================================================

export type DocumentLanguage = 'EN' | 'RU' | 'BILINGUAL';
export type DocumentFormat = 'CI' | 'PL' | 'IS-V1' | 'IS-V2' | 'UPD' | 'TN';

// =============================================================================
// D1 row shapes
// =============================================================================

export interface OperationRow {
  id: string;
  operation_date: number;
  operation_type: 'sale' | 'purchase' | 'transfer';
  partner_id: string | null;
  our_company_id: string;
  manufacturer_id: string | null;
  warehouse_from_id: string | null;
  warehouse_to_id: string | null;
  shipper_id: string | null;
  status: string;
  currency: string | null;
  total_amount: number | null;
  incoterms: string | null;
  hs_code: string | null;
  reference: string | null;
  contract_id: string | null;
  default_document_language: DocumentLanguage | null;
  // Added by 0009
  dei_layer: number;
  legal_seller_id: string | null;
}

export interface CompanyRow {
  id: string;
  abbreviation: string;
  legal_name: string;
  legal_name_ru: string | null;
  legal_name_local: string | null;
  trade_name: string | null;
  jurisdiction: string | null;
  registration_no: string | null;
  tax_id: string | null;
  kpp: string | null;
  ogrn: string | null;
  registered_address: string | null;
  base_currency: string;
  bank_name: string | null;
  bank_account: string | null;
  swift: string | null;
  iban: string | null;
  bank_address: string | null;
  bank_name_en: string | null;
  bik: string | null;
  correspondent_account: string | null;
  signing_authority_name: string | null;
  signing_authority_title_en: string | null;
  signing_authority_title_ru: string | null;
  default_invoice_language: DocumentLanguage | null;
  preferred_incoterms_domestic: string | null;
  preferred_incoterms_international: string | null;
  last_verified: number | null;
}

export interface PartnerRow {
  id: string;
  trade_name: string;
  legal_name: string | null;
  legal_name_local: string | null;
  country: string | null;
  tax_id: string | null;
  kpp: string | null;
  inn: string | null;
  ogrn: string | null;
  registered_address_local: string | null;
  iban: string | null;
  swift_bic: string | null;
  bank_name: string | null;
  email: string | null;
  payment_terms: string | null;
  preferred_incoterms: string | null;
  preferred_invoice_language: DocumentLanguage | null;
  last_verified: number | null;
  status: string;
}

export interface ManufacturerRow {
  id: string;
  name: string;
  country: string | null;
  city: string | null;
  address: string | null;
  legal_name_en: string | null;
  legal_name_ru: string | null;
  legal_name_cn: string | null;
  registered_address_en: string | null;
  registered_address_ru: string | null;
  tax_id: string | null;
  has_dual_route_banking: number;
  last_verified: number | null;
  // Added by 0009
  slug: string | null;
  is_packaging_manufacturer: number;
  is_legal_seller: number;
}

export interface ContractRow {
  id: string;
  contract_no: string;
  partner_id: string;
  our_company_id: string;
  currency: string;
  signed_date: number | null;
  expiry_date: number | null;
  incoterms: string | null;
  unk_reference: string | null;
  unk_valid_until: number | null;
  invoice_language: DocumentLanguage | null;
}

export interface CompanyBankAccountRow {
  id: string;
  company_id: string;
  account_purpose: 'primary' | 'rub' | 'cny_usd' | 'usd' | 'eur' | 'reserved_tax';
  account_number: string;
  currency: string;
  is_default: number;
  notes: string | null;
}

export interface ManufacturerBankRouteRow {
  id: string;
  manufacturer_id: string;
  route_code: 'A' | 'B' | 'default';
  payer_jurisdiction_filter: string | null;
  bank_name: string;
  bank_address: string | null;
  account_number: string | null;
  iban: string | null;
  swift: string;
  account_holder: string;
  currency: string;
}

export interface LineItemRow {
  id: string;
  product_id: string;
  item_description: string | null;
  qty: number;
  cartons: number;
  unit_price: number;
  unit_price_after_disc: number;
  line_amount: number;
  currency: string;
  // Joined product columns
  product_manufacturer_id: string;     // products.manufacturer_id (legal seller candidate)
  packaging_manufacturer_id: string | null;  // 0009-added
  description_en: string | null;
  description_ru: string | null;
  description_cn: string | null;
  invoice_label: string | null;
  invoice_label_ru: string | null;
  invoice_label_en: string | null;
  invoice_label_cn: string | null;
  hs_code: string | null;
  ctn_qty: number | null;
  ctn_weight_gross_kg: number | null;
  unit_net_weight_g: number | null;
  country_of_origin: string | null;
  category: string;
  subcategory: string | null;
}

// =============================================================================
// Composite shape returned by the loader and consumed by selectors.
// =============================================================================

export interface InvoicerInput {
  operation: OperationRow;
  ourCompany: CompanyRow;
  partner: PartnerRow | null;
  // Resolved legal seller (the manufacturer that goes on the documents as
  // "seller of record"). May be null for sale operations that do not need a
  // factory entity (e.g. straight DEE→Russia distribution sale).
  legalSellerManufacturer: ManufacturerRow | null;
  // Optional packaging facility (when distinct from legal seller).
  packagingManufacturer: ManufacturerRow | null;
  contract: ContractRow | null;
  companyBankAccounts: CompanyBankAccountRow[];
  manufacturerBankRoutes: ManufacturerBankRouteRow[];
  lineItems: LineItemRow[];
  // Companies the engine may need beyond ourCompany (e.g. DEE/DEI lookups
  // for the dei_layer chain) — keyed by company id.
  companiesById: Record<string, CompanyRow>;
}

// =============================================================================
// Selector outputs
// =============================================================================

export type DocumentSpec = {
  type: 'CI' | 'PL' | 'IS' | 'UPD' | 'TN';
  variant: 'V1' | 'V2' | null;        // only set for IS
  format: DocumentFormat;
  sellerKind: 'company' | 'manufacturer';
  sellerId: string;
  buyerKind: 'company' | 'partner';
  buyerId: string;
};

export interface BankAccountSelection {
  source: 'company_bank_accounts' | 'company_legacy_columns';
  account_number: string;
  bank_name: string;
  swift: string | null;
  iban: string | null;
  bank_address: string | null;
  bik: string | null;
  correspondent_account: string | null;
  currency: string;
  account_holder: string;
}

export type BankRouteSelection =
  | { kind: 'route'; route: ManufacturerBankRouteRow; usedFallback?: boolean }
  | { kind: 'no_routing_required' }
  | { kind: 'route_required'; details: {
      manufacturer_id: string;
      payer_company_id: string;
      expected_route: 'A' | 'B' | 'default';
      routes_found: string[];
    } };

// =============================================================================
// Validator outputs
// =============================================================================

export interface ValidationStop {
  code: string;
  message: string;
  missing?: string[];
  details?: Record<string, unknown>;
}

export interface StaleWarning {
  entity: 'company' | 'partner' | 'manufacturer';
  entity_id: string;
  days_ago: number;
}

// =============================================================================
// Result of issueDocuments()
// =============================================================================

export interface IssuedDocument {
  document_id: string;
  type: 'CI' | 'PL' | 'IS' | 'UPD' | 'TN';
  variant: 'V1' | 'V2' | null;
  reference: string;
  language: DocumentLanguage;
  format: DocumentFormat;
  r2_key: string;
  download_url: string;
}

export interface IssueResult {
  success: true;
  operation_id: string;
  operation_status_after: string;
  documents: IssuedDocument[];
  warnings: string[];
}

export interface IssueError {
  success: false;
  status: 422 | 404 | 409 | 500;
  error: ValidationStop;
  warnings: string[];
}

export type IssueOutcome = IssueResult | IssueError;
