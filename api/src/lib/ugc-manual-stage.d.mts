export type ManualStage = { from: string; to: string; by: string | null; at: number; reviewed_at: number | null };
export const MANUAL_STAGE_PREFIX: string;
export function manualStageKey(creatorId: string): string;
export function buildManualStage(input: { from: unknown; to: unknown; by?: string | null; at: number }): ManualStage | null;
export function parseManualStage(raw: unknown): ManualStage | null;
export function markReviewed(record: ManualStage | null, at: number): ManualStage | null;
