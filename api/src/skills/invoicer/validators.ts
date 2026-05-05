// =============================================================================
// Invoicer engine — HARD STOP validators.
// Cardinal rule: if contacts is missing a required field for the chosen
// format/language, the document does not exist yet. No fabrication, no
// placeholders, no "TBD" tax IDs, no fall-back to skill-memory.
// =============================================================================

import type {
  BankAccountSelection, CompanyRow, DocumentFormat, DocumentLanguage,
  LineItemRow, ManufacturerRow, PartnerRow, StaleWarning, ValidationStop,
} from './types';

const STALE_THRESHOLD_DAYS = 365;
const SECONDS_PER_DAY = 86400;

// =============================================================================
// Seller and buyer parties carry only the fields the validators care about.
// Renderers use the full row shapes; validators get a normalised view so
// company-as-seller and manufacturer-as-seller share one code path.
// =============================================================================

export interface PartyView {
  kind: 'company' | 'manufacturer' | 'partner';
  id: string;
  // Human-friendly identifier used in CONTACTS_INCOMPLETE error paths.
  // Companies → abbreviation (DEE); manufacturers → slug (guangzhou-honghui)
  // or fallback to name; partners → strip prt_ prefix from id.
  label: string;
  legalName: string | null;
  legalNameLocal: string | null;     // RU translation for buyers, RU/CN for manufacturers
  registeredAddress: string | null;
  registeredAddressLocal: string | null;
  taxId: string | null;
  inn: string | null;
  registrationNo: string | null;
}

export function viewCompany(c: CompanyRow): PartyView {
  return {
    kind: 'company', id: c.id,
    label: c.abbreviation || c.id,
    legalName: c.legal_name,
    legalNameLocal: c.legal_name_ru ?? c.legal_name_local,
    registeredAddress: c.registered_address,
    registeredAddressLocal: c.registered_address,
    taxId: c.tax_id,
    inn: null,
    registrationNo: c.registration_no,
  };
}

export function viewManufacturer(m: ManufacturerRow): PartyView {
  return {
    kind: 'manufacturer', id: m.id,
    label: m.slug || m.legal_name_en || m.name || m.id,
    legalName: m.legal_name_en ?? m.name,
    legalNameLocal: m.legal_name_ru ?? m.legal_name_cn,
    registeredAddress: m.registered_address_en,
    registeredAddressLocal: m.registered_address_ru,
    taxId: m.tax_id,
    inn: null,
    registrationNo: null,
  };
}

export function viewPartner(p: PartnerRow): PartyView {
  return {
    kind: 'partner', id: p.id,
    label: p.id.replace(/^prt_/, '') || p.trade_name,
    legalName: p.legal_name ?? p.trade_name,
    legalNameLocal: p.legal_name_local,
    registeredAddress: p.country,
    registeredAddressLocal: p.registered_address_local,
    taxId: p.tax_id,
    inn: p.inn,
    registrationNo: null,
  };
}

// =============================================================================
// validateContacts — one entry point per document.
// =============================================================================

export interface ContactsArgs {
  format: DocumentFormat;
  language: DocumentLanguage;
  seller: PartyView;
  buyer: PartyView;
  bankSelection: BankAccountSelection | null; // null for PL or for manufacturer-led docs
  needsBank: boolean;
}

export function validateContacts(
  args: ContactsArgs
): { ok: true } | { ok: false; stop: ValidationStop } {
  const missing: string[] = [];
  const { format, language, seller, buyer, bankSelection, needsBank } = args;

  // ---- Seller block ----------------------------------------------------
  if (language === 'RU' || language === 'BILINGUAL') {
    if (!seller.legalName && !seller.legalNameLocal) {
      missing.push(`${seller.kind}.${seller.label}.legal_name|legal_name_ru`);
    }
  } else if (!seller.legalName) {
    missing.push(`${seller.kind}.${seller.label}.legal_name`);
  }
  if (!seller.registeredAddress && !seller.registeredAddressLocal) {
    missing.push(`${seller.kind}.${seller.label}.registered_address`);
  }
  if (!seller.taxId && !seller.registrationNo) {
    missing.push(`${seller.kind}.${seller.label}.tax_id|registration_no`);
  }

  // ---- Seller bank block (CI / IS) -------------------------------------
  if (needsBank) {
    if (!bankSelection) {
      missing.push(`${seller.kind}.${seller.label}.bank (no row in company_bank_accounts and no legacy bank columns)`);
    } else {
      if (!bankSelection.bank_name) missing.push('bank.bank_name');
      if (!bankSelection.account_holder) missing.push('bank.account_holder');
      if (!bankSelection.account_number && !bankSelection.iban) {
        missing.push('bank.account_number|iban');
      }
      if (!bankSelection.swift && !bankSelection.iban) {
        missing.push('bank.swift|iban');
      }
    }
  }

  // ---- Buyer block -----------------------------------------------------
  const buyerNeedsLocal = language === 'RU' || language === 'BILINGUAL';
  const buyerName = buyerNeedsLocal
    ? (buyer.legalNameLocal ?? buyer.legalName)
    : buyer.legalName;
  if (!buyerName) {
    missing.push(`${buyer.kind}.${buyer.label}.legal_name|legal_name_local`);
  }
  if (!buyer.registeredAddress && !buyer.registeredAddressLocal) {
    missing.push(`${buyer.kind}.${buyer.label}.registered_address|registered_address_local`);
  }
  if (!buyer.taxId && !buyer.inn && !buyer.registrationNo) {
    missing.push(`${buyer.kind}.${buyer.label}.tax_id|inn|registration_no`);
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
// validateProductDescriptions — IS-V2 needs RU+EN+CN per line.
// =============================================================================

export function validateProductDescriptions(
  format: DocumentFormat, lineItems: LineItemRow[]
): { ok: true } | { ok: false; stop: ValidationStop } {
  if (format !== 'IS-V2') return { ok: true };
  const missing: string[] = [];
  for (const li of lineItems) {
    const fields: string[] = [];
    if (!li.description_en) fields.push('en');
    if (!li.description_ru) fields.push('ru');
    if (!li.description_cn) fields.push('cn');
    if (fields.length > 0) missing.push(`${li.product_id}:${fields.join(',')}`);
  }
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    stop: {
      code: 'PRODUCT_DESCRIPTION_INCOMPLETE',
      message: 'IS-V2 requires RU + EN + CN descriptions for every product. ' +
               'Populate products.description_{ru,en,cn} before re-trying.',
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
  function check(entity: 'company' | 'partner' | 'manufacturer',
                 id: string, lastVerified: number | null) {
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
// validatePricer — every line on a CI / IS must have a positive unit price.
// PL has no money column.
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
