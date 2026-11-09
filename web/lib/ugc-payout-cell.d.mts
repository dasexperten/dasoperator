export const PAYOUT_STATUS_LABEL: Record<'none' | 'awaiting_approval' | 'approved' | 'sent' | 'paid' | 'failed', string>;
export const STALE_SENT_MS: number;
export function formatRub(minor: number | null | undefined): string;
export type PayoutCellInput = {
  status: string;
  amount_minor: number;
  konsol_payment_id?: string | null;
  konsol_status?: string | null;
  has_requisites?: number | boolean;
  over_limit?: boolean;
  payout_hold?: boolean;
  payout_review_required?: boolean;
  execute_claim?: string | null;
  has_konsol_contractor?: boolean;
  sent_at?: string | null;
  payout_date?: string | null;
};
export function isKonsolPaid(payout: PayoutCellInput | null | undefined): boolean;
export function isPaidOutside(payout: PayoutCellInput | null | undefined): boolean;
export function isStaleSent(payout: PayoutCellInput | null | undefined, now?: number): boolean;
export function payoutCell(payout: PayoutCellInput | null | undefined, now?: number): { tone: 'green' | 'lightgreen' | 'brown' | 'grey' | 'red'; text: string; reason: string; title: string };
export function canPay(payout: (PayoutCellInput & { status: string; execute_claim?: string | null }) | null | undefined, now?: number): boolean;
export function payConfirmText(payout: { amount_minor: number; bank_ref?: string | null; fps_bank_member_id?: string | null; phone_masked?: string | null } | null | undefined, handle?: string | null): string;

export function canSetPayoutAmount(payout: PayoutCellInput | null | undefined): boolean;
export function canMarkPaidOutside(payout: PayoutCellInput | null | undefined): boolean;
