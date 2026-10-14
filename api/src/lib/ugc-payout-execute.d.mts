export type ExecuteResult = { http: number; ok: boolean; code?: string; message?: string; already?: boolean; payout?: Record<string, unknown> };
export function ownRubStopText(check: Record<string, unknown>, row: Record<string, unknown>): string;
export function paidNoticeText(row: Record<string, unknown>): string;
export function executePayout(id: string, deps: Record<string, any>): Promise<ExecuteResult>;
export function applyKonsolPayment(row: Record<string, any>, payment: Record<string, any>, deps: Record<string, any>): Promise<{ changed: boolean; reason?: string; status?: string; konsol_status?: string; noticed?: boolean }>;
