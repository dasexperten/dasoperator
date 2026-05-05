// =============================================================================
// Invoicer engine — HARD STOP validators.
// "If contacts does not have it, the invoice does not exist yet. Period."
// Each validator returns either { ok: true } or a ValidationStop the entry
// point converts to a 422 response. No fabrication.
// =============================================================================

import type {
  BankAccountSelection, CompanyRow, DocumentFormat, DocumentLanguage,
  LineItemRow, ManufacturerRow, PartnerRow, StaleWarning, ValidationStop,
} from './types';

const STALE_THRESHOLD_DAYS = 365;
const SECONDS_PER_DAY = 86400;

// =============================================================================
// validateContacts — checks every party block the chosen format will print.
// =============================================================================

export interface ContactsValidationArgs {
  format: DocumentFormat;
  language: DocumentLanguage;
  ourCompany: CompanyRow;
  partner: PartnerRow | null;
  manufacturer: ManufacturerRow | null;
  bankSelection: BankAccountSelection | null;
}

export function validateContacts(
  args: ContactsValidationArgs
): { ok: true } | { ok: false; stop: ValidationStop } {
  const missing: string[] = [];
  const { format, language, ourCompany, partner, manufacturer, bankSelection } = args;
  const formatNeedsBuyerBlock = true; // every format we render has a buyer party
  const formatNeedsSellerBank = format === 'CI' || format === 'IS-V1' || format === 'IS-V2';
  const formatIsIs = format === 'IS-V1' || format === 'IS-V2';

  // ---- Seller block (always required) -----------------------------------
  if (language === 'RU' || language === 'BILINGUAL') {
    if (!ourCompany.legal_name_ru && !ourCompany.legal_name) {
      missing.push('our_company.legal_name_ru');
    }
  } else if (!ourCompany.legal_name) {
    missing.push('our_company.legal_name');
  }
  if (!ourCompany.registered_address) missing.push('our_company.registered_address');
  if (!ourCompany.tax_id && !ourCompany.registration_no) {
    missing.push('our_company.tax_id|registration_no');
  }

  // ---- Seller banking (CI / IS) -----------------------------------------
  if (formatNeedsSellerBank) {
    if (!bankSelection) {
      missing.push('our_company.bank_account (no row in company_bank_accounts and no legacy bank columns)');
    } else {
      if (!bankSelection.bank_name) missing.push('bank.bank_name');
      if (!bankSelection.account_number && !bankSelection.iban) {
        missing.push('bank.account_number|iban');
      }
      if (!bankSelection.swift && !bankSelection.iban) {
        missing.push('bank.swift|iban');
      }
    }
  }

  // ---- Buyer block ------------------------------------------------------
  if (formatNeedsBuyerBlock) {
    if (!partner) {
      missing.push('partner (operation has no partner_id)');
    } else {
      const buyerNameField = (language === 'RU' || language === 'BILINGUAL')
        ? (partner.legal_name_local ?? partner.legal_name)
        : partner.legal_name;
      if (!buyerNameField) missing.push('partner.legal_name|legal_name_local');

      const addressField = partner.registered_address_local ?? partner.country;
      if (!addressField) missing.push('partner.registered_address_local|country');

      if (!partner.tax_id && !partner.inn) missing.push('partner.tax_id|inn');
    }
  }

  // ---- Manufacturer block (IS only) -------------------------------------
  if (formatIsIs) {
    if (!manufacturer) {
      missing.push('manufacturer (IS format requires operation.manufacturer_id)');
    } else {
      if (!manufacturer.legal_name_en) missing.push('manufacturer.legal_name_en');
      if (!manufacturer.registered_address_en) missing.push('manufacturer.registered_address_en');
      if (!manufacturer.tax_id) missing.push('manufacturer.tax_id (USCC)');
    }
  }

  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    stop: {
      code: 'CONTACTS_INCOMPLETE',
      message: `Cannot issue ${format}: contacts data is missing required fields. ` +
               'Skill rule: do not fabricate.',
      missing,
    },
  };
}

// =============================================================================
// validateStale — soft warning, never blocks issue.
// =============================================================================

export function validateStale(
  ourCompany: CompanyRow,
  partner: PartnerRow | null,
  manufacturer: ManufacturerRow | null,
  nowUnix: number
): StaleWarning[] {
  const warnings: StaleWarning[] = [];

  function check(
    entity: 'company' | 'partner' | 'manufacturer',
    id: string, lastVerified: number | null
  ) {
    if (lastVerified === null) return;
    const daysAgo = Math.floor((nowUnix - lastVerified) / SECONDS_PER_DAY);
    if (daysAgo > STALE_THRESHOLD_DAYS) {
      warnings.push({ entity, entity_id: id, days_ago: daysAgo });
    }
  }

  check('company', ourCompany.id, ourCompany.last_verified);
  if (partner) check('partner', partner.id, partner.last_verified);
  if (manufacturer) check('manufacturer', manufacturer.id, manufacturer.last_verified);
  return warnings;
}

// =============================================================================
// validatePricer — every line on a CI must have a positive unit price.
// IS variants and PL don't enforce this (PL has no money column).
// =============================================================================

export function validatePricer(
  format: DocumentFormat,
  lineItems: LineItemRow[]
): { ok: true } | { ok: false; stop: ValidationStop } {
  if (format === 'PL') return { ok: true };

  const missing: string[] = [];
  for (const li of lineItems) {
    if (!li.unit_price_after_disc || li.unit_price_after_disc <= 0) {
      missing.push(li.product_id);
    }
  }
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    stop: {
      code: 'PRICER_INCOMPLETE',
      message: `Cannot issue ${format}: ${missing.length} line item(s) have no unit price. ` +
               'Run pricer first.',
      missing,
    },
  };
}
