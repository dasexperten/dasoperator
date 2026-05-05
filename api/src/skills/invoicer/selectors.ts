// =============================================================================
// Invoicer engine — pure selector functions.
// In-memory only; no I/O. Each selector encodes one rule from the invoicer
// skill so behaviour is testable in isolation.
// =============================================================================

import type {
  BankAccountSelection, BankRouteSelection, CompanyBankAccountRow, CompanyRow,
  ContractRow, DocumentLanguage, DocumentSpec, InvoicerInput, LineItemRow,
  ManufacturerBankRouteRow, ManufacturerRow, PartnerRow,
} from './types';

const RU_LIKE_JURISDICTIONS = new Set(['Russia', 'Russian Federation', 'RU']);

function isRussiaSide(s: string | null | undefined): boolean {
  if (!s) return false;
  return RU_LIKE_JURISDICTIONS.has(s);
}

function pickIsVariant(lineItems: LineItemRow[]): 'V1' | 'V2' {
  // V2 (Honghui) — any toothpaste in the load.
  const hasToothpaste = lineItems.some(
    (li) => li.category === 'Toothpaste' || (li.hs_code ?? '').startsWith('3306')
  );
  return hasToothpaste ? 'V2' : 'V1';
}

// =============================================================================
// selectDocumentsToIssue — returns the full ordered list of documents the
// engine must produce for this operation. The entry point feeds each spec
// into the matching renderer.
// =============================================================================

export function selectDocumentsToIssue(input: InvoicerInput): DocumentSpec[] {
  const { operation, ourCompany, partner, lineItems, legalSellerManufacturer } = input;

  const isVariant = pickIsVariant(lineItems);
  const isFormat: 'IS-V1' | 'IS-V2' = isVariant === 'V2' ? 'IS-V2' : 'IS-V1';

  // CASE 1 — sale to Russia
  if (operation.operation_type === 'sale' && isRussiaSide(partner?.country)) {
    if (operation.dei_layer === 0) {
      // Factory → DEE direct → emit a single IS for Russian customs
      if (!legalSellerManufacturer) {
        throw new Error(
          'CASE 1 (sale to Russia, no DEI layer) requires a resolved legal seller; ' +
          'set operation.legal_seller_id or operation.manufacturer_id, ' +
          'or ensure all line items share the same products.manufacturer_id.'
        );
      }
      return [{
        type: 'IS', variant: isVariant, format: isFormat,
        sellerKind: 'manufacturer', sellerId: legalSellerManufacturer.id,
        buyerKind: 'partner', buyerId: partner!.id,
      }];
    }

    // dei_layer = true → Factory→DEI (CI+PL international) + DEI→DEE (IS for customs)
    if (!legalSellerManufacturer) {
      throw new Error(
        'CASE 1 dei_layer requires a resolved legal seller (the Factory leg).'
      );
    }
    return [
      { type: 'CI', variant: null, format: 'CI',
        sellerKind: 'manufacturer', sellerId: legalSellerManufacturer.id,
        buyerKind: 'company', buyerId: 'cmp_dei' },
      { type: 'PL', variant: null, format: 'PL',
        sellerKind: 'manufacturer', sellerId: legalSellerManufacturer.id,
        buyerKind: 'company', buyerId: 'cmp_dei' },
      { type: 'IS', variant: isVariant, format: isFormat,
        sellerKind: 'company', sellerId: 'cmp_dei',
        buyerKind: 'partner', buyerId: partner!.id },
    ];
  }

  // CASE 2 — sale to non-Russia partner → CI + PL from our_company
  if (operation.operation_type === 'sale') {
    if (!partner) {
      throw new Error('Sale operation has no partner_id');
    }
    return [
      { type: 'CI', variant: null, format: 'CI',
        sellerKind: 'company', sellerId: ourCompany.id,
        buyerKind: 'partner', buyerId: partner.id },
      { type: 'PL', variant: null, format: 'PL',
        sellerKind: 'company', sellerId: ourCompany.id,
        buyerKind: 'partner', buyerId: partner.id },
    ];
  }

  // CASE 3 — purchase from a manufacturer.
  // Buyer = our_company (DEE / DEI / DEASEAN / DEC). When DEE buys → IS
  // (CIS customs); otherwise CI + PL (international).
  if (operation.operation_type === 'purchase') {
    if (!legalSellerManufacturer) {
      throw new Error(
        'Purchase operation needs a manufacturer; set operation.manufacturer_id ' +
        'or operation.legal_seller_id.'
      );
    }
    if (ourCompany.abbreviation === 'DEE') {
      return [{
        type: 'IS', variant: isVariant, format: isFormat,
        sellerKind: 'manufacturer', sellerId: legalSellerManufacturer.id,
        buyerKind: 'company', buyerId: ourCompany.id,
      }];
    }
    return [
      { type: 'CI', variant: null, format: 'CI',
        sellerKind: 'manufacturer', sellerId: legalSellerManufacturer.id,
        buyerKind: 'company', buyerId: ourCompany.id },
      { type: 'PL', variant: null, format: 'PL',
        sellerKind: 'manufacturer', sellerId: legalSellerManufacturer.id,
        buyerKind: 'company', buyerId: ourCompany.id },
    ];
  }

  // Transfers don't currently produce customer-facing documents.
  throw new Error(`operation_type=${operation.operation_type} is not supported by the invoicer engine`);
}

// =============================================================================
// Language / currency / banking / incoterms
// =============================================================================

export function selectLanguage(
  format: 'CI' | 'PL' | 'IS-V1' | 'IS-V2',
  ourCompany: CompanyRow,
  partner: PartnerRow | null,
  contract: ContractRow | null
): DocumentLanguage {
  if (format === 'IS-V1' || format === 'IS-V2') return 'BILINGUAL';
  if (contract?.invoice_language) return contract.invoice_language;
  if (partner?.preferred_invoice_language) return partner.preferred_invoice_language;
  if (ourCompany.default_invoice_language) return ourCompany.default_invoice_language;
  return 'EN';
}

export function selectCurrency(
  ourCompany: CompanyRow,
  partner: PartnerRow | null,
  contract: ContractRow | null,
  sellerKind: 'company' | 'manufacturer'
): string {
  if (contract?.currency) return contract.currency;

  const sellerIsDee = ourCompany.abbreviation === 'DEE';
  const buyerIsRussia = isRussiaSide(partner?.country);

  if (sellerKind === 'manufacturer') return 'USD';
  if (sellerIsDee && buyerIsRussia) return 'RUB';
  if (sellerIsDee && !buyerIsRussia) return 'USD';
  if (['DEI', 'DEASEAN', 'DEC'].includes(ourCompany.abbreviation)) return 'USD';
  return ourCompany.base_currency;
}

export function selectBankAccount(
  company: CompanyRow,
  documentCurrency: string,
  bankAccounts: CompanyBankAccountRow[]
): BankAccountSelection | null {
  if (bankAccounts.length > 0) {
    let chosen: CompanyBankAccountRow | undefined;
    if (company.abbreviation === 'DEE') {
      if (documentCurrency === 'RUB') {
        chosen = bankAccounts.find((a) => a.account_purpose === 'rub');
      } else {
        chosen = bankAccounts.find((a) => a.account_purpose === 'cny_usd');
      }
    }
    if (!chosen) chosen = bankAccounts.find((a) => a.is_default === 1);
    if (!chosen) chosen = bankAccounts[0];
    if (chosen) {
      return {
        source: 'company_bank_accounts',
        account_number: chosen.account_number,
        bank_name: company.bank_name ?? '',
        swift: company.swift,
        iban: company.iban,
        bank_address: company.bank_address,
        bik: company.bik,
        correspondent_account: company.correspondent_account,
        currency: chosen.currency,
        account_holder: company.legal_name,
      };
    }
  }

  // Legacy single-account fallback (used by DEI when company_bank_accounts is empty).
  if (company.bank_name && (company.bank_account || company.iban)) {
    return {
      source: 'company_legacy_columns',
      account_number: company.bank_account ?? company.iban ?? '',
      bank_name: company.bank_name,
      swift: company.swift,
      iban: company.iban,
      bank_address: company.bank_address,
      bik: company.bik,
      correspondent_account: company.correspondent_account,
      currency: documentCurrency,
      account_holder: company.legal_name,
    };
  }

  return null;
}

// =============================================================================
// selectManufacturerBankRoute — returns a route or a HARD-STOP signal.
// "default" is used by single-route manufacturers (WDAA). dual-route
// manufacturers (Honghui / Jinxia) MUST resolve a route per payer; missing
// row returns route_required (entry point converts to 422).
// =============================================================================

export function selectManufacturerBankRoute(
  manufacturer: ManufacturerRow,
  payerCompany: CompanyRow,
  routes: ManufacturerBankRouteRow[]
): BankRouteSelection {
  const defaultRoute = routes.find((r) => r.route_code === 'default');
  if (manufacturer.has_dual_route_banking !== 1) {
    if (defaultRoute) return { kind: 'route', route: defaultRoute };
    if (routes.length === 0) {
      return {
        kind: 'route_required',
        details: {
          manufacturer_id: manufacturer.id,
          payer_company_id: payerCompany.id,
          expected_route: 'default',
        },
      };
    }
    // No 'default' but other routes exist — pick the first one as a single-route fallback.
    return { kind: 'route', route: routes[0]! };
  }

  const expected: 'A' | 'B' = payerCompany.abbreviation === 'DEE' ? 'A' : 'B';
  const route = routes.find((r) => r.route_code === expected);
  if (route) return { kind: 'route', route };
  return {
    kind: 'route_required',
    details: {
      manufacturer_id: manufacturer.id,
      payer_company_id: payerCompany.id,
      expected_route: expected,
    },
  };
}

export function selectIncoterms(
  ourCompany: CompanyRow,
  partner: PartnerRow | null,
  contract: ContractRow | null,
  isInternational: boolean
): string {
  if (contract?.incoterms) return contract.incoterms;
  if (partner?.preferred_incoterms) return partner.preferred_incoterms;
  if (isInternational && ourCompany.preferred_incoterms_international) {
    return ourCompany.preferred_incoterms_international;
  }
  if (!isInternational && ourCompany.preferred_incoterms_domestic) {
    return ourCompany.preferred_incoterms_domestic;
  }
  return `EXW ${ourCompany.jurisdiction ?? ''}`.trim();
}

export function isInternationalDeal(
  ourCompany: CompanyRow,
  partner: PartnerRow | null
): boolean {
  if (!partner?.country) return false;
  return ourCompany.jurisdiction !== partner.country;
}
