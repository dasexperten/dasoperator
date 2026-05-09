// =============================================================================
// Agreement type labels and groupings used across the UI.
// All 8 values that contracts.agreement_type accepts at DB level (migration 0025).
// =============================================================================

import type { AgreementType } from '@/lib/api';

export const AGREEMENT_TYPE_LABELS: Record<AgreementType, string> = {
  main:     'Main Contract',
  addendum: 'Addendum',
  annex:    'Annex',
  sla:      'SLA',
  nda:      'NDA',
  mou:      'MoU',
  loi:      'LoI',
  other:    'Other',
};

// Display order for dropdowns and tables.
// Business contracts first, then legal docs, then "other" last.
export const AGREEMENT_TYPE_ORDER: AgreementType[] = [
  'main', 'addendum', 'annex', 'sla',
  'nda', 'mou', 'loi', 'other',
];

// Legal docs differ from business contracts: their currency and our_company_id
// are not strictly meaningful, and the contract_no is auto-generated if blank.
export const LEGAL_DOC_TYPES: AgreementType[] = ['nda', 'mou', 'loi', 'other'];

export function isLegalDocType(t?: AgreementType | null): boolean {
  return !!t && (LEGAL_DOC_TYPES as string[]).includes(t);
}

export function agreementTypeLabel(t?: string | null): string {
  if (!t) return 'Main Contract';
  if (t in AGREEMENT_TYPE_LABELS) return AGREEMENT_TYPE_LABELS[t as AgreementType];
  return t.toUpperCase();
}
