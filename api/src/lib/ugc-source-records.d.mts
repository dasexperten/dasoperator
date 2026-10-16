export function identifySourceProductNames(value: unknown): string[];
export function sourceProductLabels(value: unknown, codes?: string[]): { name: string }[];
export function publicationProductLabels(evidence: unknown): { name: string }[];
export function payoutProductRecords(payouts: Record<string, any>[]): Record<string, any>[];
export const ORIGINAL_BLOGGER_DATABASE: string;
export function paymentSource(document: string): { source_title: string; amount_column: string; priority: number };
export function sourceRecordIndex(rows: Record<string, any>[]): { payments: Map<string, Record<string, any>[]>; paymentSources: Map<string, Record<string, any>[]>; products: Map<string, Record<string, any>[]>; productLabels: Map<string, Record<string, any>[]> };
