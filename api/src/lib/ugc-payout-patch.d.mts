export type PayoutPatchFailure = { ok: false; http: 404 | 409 | 422 | 503; code: string };
export function patchPayout(db: D1Database, input: {
  id: string;
  patch: Record<string, string | number | null>;
  now: number;
}): Promise<PayoutPatchFailure | {
  ok: true;
  changes: number;
  payout: Record<string, string | number | null>;
}>;
