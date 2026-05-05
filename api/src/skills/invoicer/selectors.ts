// =============================================================================
// Invoicer engine — pure selector functions.
// All input is in-memory; no I/O. Each selector encodes one rule from the
// invoicer skill (Steps 1-3) so behaviour is testable in isolation.
// =============================================================================

import type {
  BankAccountSelection, BankRouteSelection, CompanyBankAccountRow, CompanyRow,
  ContractRow, DocumentFormat, DocumentLanguage, InvoicerInput,
  ManufacturerBankRouteRow, ManufacturerRow, PartnerRow,
} from './types';

const RU_LIKE_JURISDICTIONS = new Set(['Russia', 'Russian Federation', 'RU']);

function isRussiaSide(jurisdiction: string | null | undefined): boolean {
  if (!jurisdiction) return false;
  return RU_LIKE_JURISDICTIONS.has(jurisdiction);
}

// =============================================================================
// selectFormat — Step 3 of the skill.
// Returns one format. For the 'auto' case the entry point calls this once
// and either issues a single IS-V1/V2 doc or falls through to issuing CI+PL.
// =============================================================================

export function selectFormat(input: InvoicerInput): DocumentFormat {
  const { ourCompany, partner, manufacturer, lineItems } = input;

  const buyerIsRussia = isRussiaSide(partner?.country) ||
    isRussiaSide(partner?.legal_name_local ? 'Russia' : null);
  const sellerIsDee = ourCompany.abbreviation === 'DEE';

  // China-origin shipments routed to Russia → IS variant.
  const manufacturerIsChina = manufacturer?.country?.toLowerCase() === 'china';
  if (manufacturerIsChina && (sellerIsDee || buyerIsRussia)) {
    const anyToothpaste = lineItems.some(
      (li) => (li.hs_code ?? '').startsWith('3306')
    );
    return anyToothpaste ? 'IS-V2' : 'IS-V1';
  }

  // Default: separate CI + PL — caller decides the order.
  return 'CI';
}

// =============================================================================
// selectLanguage — explicit override hierarchy.
// IS variants are always BILINGUAL regardless of contract / partner prefs.
// =============================================================================

export function selectLanguage(
  format: DocumentFormat,
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

// =============================================================================
// selectCurrency — Step 1 currency logic.
// =============================================================================

export function selectCurrency(
  ourCompany: CompanyRow,
  partner: PartnerRow | null,
  contract: ContractRow | null
): string {
  if (contract?.currency) return contract.currency;

  const sellerIsDee = ourCompany.abbreviation === 'DEE';
  const buyerIsRussia = isRussiaSide(partner?.country);

  if (sellerIsDee && buyerIsRussia) return 'RUB';
  if (sellerIsDee && !buyerIsRussia) return 'USD';
  // DEI / DEASEAN / DEC default to USD; otherwise fall back to base currency.
  if (['DEI', 'DEASEAN', 'DEC'].includes(ourCompany.abbreviation)) return 'USD';
  return ourCompany.base_currency;
}

// =============================================================================
// selectBankAccount — multi-account aware. DEE has rub + cny_usd; everyone
// else has primary. Falls back to legacy company columns only if the new
// table is empty.
// =============================================================================

export function selectBankAccount(
  ourCompany: CompanyRow,
  documentCurrency: string,
  bankAccounts: CompanyBankAccountRow[]
): BankAccountSelection | null {
  if (bankAccounts.length > 0) {
    let chosen: CompanyBankAccountRow | undefined;

    if (ourCompany.abbreviation === 'DEE') {
      // DEE-specific routing: RUB → rub account; everything else → cny_usd.
      if (documentCurrency === 'RUB') {
        chosen = bankAccounts.find((a) => a.account_purpose === 'rub');
      } else {
        chosen = bankAccounts.find((a) => a.account_purpose === 'cny_usd');
      }
    }
    if (!chosen) {
      chosen = bankAccounts.find((a) => a.is_default === 1);
    }
    if (!chosen) chosen = bankAccounts[0];

    if (chosen) {
      return {
        source: 'company_bank_accounts',
        account_number: chosen.account_number,
        bank_name: ourCompany.bank_name ?? '',
        swift: ourCompany.swift,
        iban: ourCompany.iban,
        bank_address: ourCompany.bank_address,
        bik: ourCompany.bik,
        correspondent_account: ourCompany.correspondent_account,
        currency: chosen.currency,
        account_holder: ourCompany.legal_name,
      };
    }
  }

  // Legacy single-account fallback (used by DEI when the table is empty).
  if (ourCompany.bank_name && (ourCompany.bank_account || ourCompany.iban)) {
    return {
      source: 'company_legacy_columns',
      account_number: ourCompany.bank_account ?? ourCompany.iban ?? '',
      bank_name: ourCompany.bank_name,
      swift: ourCompany.swift,
      iban: ourCompany.iban,
      bank_address: ourCompany.bank_address,
      bik: ourCompany.bik,
      correspondent_account: ourCompany.correspondent_account,
      currency: documentCurrency,
      account_holder: ourCompany.legal_name,
    };
  }

  return null;
}

// =============================================================================
// selectBankRoute — only relevant for IS variants where the document carries
// the manufacturer's banking. Single-route manufacturers use the optional
// 'default' row; if none exists they're skipped without erroring (the IS
// renderer just leaves the banking block empty). Dual-route manufacturers
// (Honghui / Jinxia) MUST resolve a route per payer or the engine returns
// route_required, which the entry point converts to a 422 HARD STOP.
// =============================================================================

export function selectBankRoute(
  manufacturer: ManufacturerRow,
  payerCompany: CompanyRow,
  routes: ManufacturerBankRouteRow[]
): BankRouteSelection {
  if (manufacturer.has_dual_route_banking !== 1) {
    const defaultRoute = routes.find((r) => r.route_code === 'default');
    return defaultRoute
      ? { kind: 'route', route: defaultRoute }
      : { kind: 'no_routing_required' };
  }

  // DEE pays from Russia → Route A; anyone else → Route B.
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

// =============================================================================
// selectIncoterms — contract → partner pref → company pref → fallback.
// =============================================================================

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

// =============================================================================
// Helper exposed for renderers — true when the deal crosses a border.
// =============================================================================

export function isInternationalDeal(
  ourCompany: CompanyRow,
  partner: PartnerRow | null
): boolean {
  if (!partner?.country) return false;
  return ourCompany.jurisdiction !== partner.country;
}
