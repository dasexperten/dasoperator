// =============================================================================
// PDF generation types — shared between renderer and route layer
// =============================================================================
// Money convention: amounts are passed as MINOR units (kopecks/cents). The
// renderer converts to display units using minorFactor (100 for USD/EUR/RUB/
// CNY, 1 for VND).
//
// Weight convention: weight_kg in products schema is stored as grams (whole
// units; field name is misleading). volume_m3_micro is microlitres × 1000.
// Renderer normalises: net weight = weightKgGrams / 1000 → kg.
// =============================================================================

export interface PartyBlock {
  legalName: string;
  tradeName?: string | null;
  address?: string | null;
  taxId?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  swift?: string | null;
  iban?: string | null;
  email?: string | null;
}

export interface LineItemRow {
  sku: string;                  // product.id (e.g. DE201)
  description: string;          // line_item.item_description ?? product.invoice_label
  hsCode: string | null;        // operation.hs_code (per-line absent in schema)
  qty: number;
  unitPriceMinor: number;       // line_item.unit_price_after_disc
  lineTotalMinor: number;       // line_item.line_amount
  // Packing data (may be null when product.weight_kg / volume_m3_micro absent)
  netWeightGrams: number | null;
  volumeMicroL: number | null;
  cartons: number;
}

export interface InvoiceData {
  reference: string;            // e.g. CI-202605-0001
  issuedAt: number;             // unix seconds
  currency: string;             // USD / EUR / RUB / CNY / VND
  minorFactor: number;          // 100 for USD/EUR/RUB/CNY, 1 for VND
  seller: PartyBlock;
  buyer: PartyBlock;
  lines: LineItemRow[];
  totalMinor: number;
  incoterms?: string | null;
  preparedByCountry?: string | null;
}

export interface PackingListData {
  reference: string;            // e.g. PL-202605-0001
  issuedAt: number;
  seller: PartyBlock;
  buyer: PartyBlock;
  lines: LineItemRow[];
  // Cross-reference to CI when issued before PL
  ciReference?: string | null;
}
