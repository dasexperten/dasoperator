// =============================================================================
// Maps company ID to its sequence ID for operation reference numbering.
// =============================================================================

const COMPANY_TO_SEQUENCE: Record<string, string> = {
  cmp_dee: 'seq_dee',
  cmp_dei: 'seq_dei',
  cmp_dasean: 'seq_dasean',
  cmp_dec: 'seq_dec',
};

export function sequenceIdForCompany(companyId: string): string | null {
  return COMPANY_TO_SEQUENCE[companyId] ?? null;
}
