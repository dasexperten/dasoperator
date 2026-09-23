export type UgcProductStatus = 'identified' | 'queued' | 'unknown';
export type UgcProductSource = 'explicit_import' | 'metadata_text' | 'vision' | 'manual';
export type UgcProductMatch = { raw_code: string; raw_offer_id: string; sku: string; name: string; pack_factor: number | null; source: UgcProductSource; confidence: number };
export const UGC_PRODUCTS: Record<string, string>;
export function baseProductSku(value: unknown): string | null;
export function identifyExplicitProducts(values: unknown[]): { matches: UgcProductMatch[]; unknown_codes: string[] };
export function initialProductClassification(values: unknown[], hasContentUrl: boolean): { status: UgcProductStatus; source: UgcProductSource | null; confidence: number | null; evidence: string | null };
