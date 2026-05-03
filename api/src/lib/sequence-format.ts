// =============================================================================
// Sequence number formatter
// Translates (raw_number, format_example, padding) → formatted string
//
// Format types supported:
//   1. Simple prefix + padded number:
//      "DEE-001" (padding=3)         → 7 → "DEE-007"
//      "DEE-001" (padding=3)         → 142 → "DEE-142"
//      "DEE-001" (padding=3)         → 9999 → "DEE-9999" (overflow tolerated)
//
//   2. Prefix + year-month + padded number:
//      "CI-202605-0001" (padding=4)  → 7  → "CI-{YYYYMM}-0007"
//      "PL-202605-0001" (padding=4)  → 1  → "PL-{YYYYMM}-0001"
//      Year-month is current UTC at issue time.
// =============================================================================

const YEAR_MONTH_PATTERN = /\d{6}/;

export function formatSequenceValue(
  rawNumber: number,
  formatExample: string,
  padding: number
): string {
  const padded = String(rawNumber).padStart(padding, '0');

  // Detect year-month pattern (6 consecutive digits, e.g. 202605)
  if (YEAR_MONTH_PATTERN.test(formatExample)) {
    const now = new Date();
    const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    // Replace 6-digit year-month with current, then replace trailing padded number
    // Pattern: PREFIX-YYYYMM-NNNN
    const parts = formatExample.split('-');
    const result = parts.map((part, idx) => {
      if (/^\d{6}$/.test(part)) return yyyymm;
      // Last part — the padded counter
      if (idx === parts.length - 1 && /^\d+$/.test(part)) return padded;
      return part;
    }).join('-');

    return result;
  }

  // Simple format: PREFIX-NNN — replace trailing digits
  return formatExample.replace(/\d+$/, padded);
}
