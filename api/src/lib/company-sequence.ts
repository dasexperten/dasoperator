// =============================================================================
// Maps company ID to its sequence ID for operation reference numbering.
// =============================================================================

const COMPANY_TO_SEQUENCE: Record<string, string> = {
  dee: 'dee',
  dei: 'dei',
  dasean: 'dasean',
  dec: 'dec',
};

export function sequenceIdForCompany(companyId: string): string | null {
  return COMPANY_TO_SEQUENCE[companyId] ?? null;
}
