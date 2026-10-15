export const PAYOUT_STATUS_LABEL: Record<'none' | 'awaiting_approval' | 'approved' | 'sent' | 'paid' | 'failed', string>;
export const STALE_SENT_MS: number;
export function formatRub(minor: number | null | undefined): string;
export type PayoutCellInput = {
  status: string;
  amount_minor: number;
  konsol_payment_id?: string | null;
  has_requisites?: number | boolean;
  over_limit?: boolean;
  sent_at?: string | null;
  payout_date?: string | null;
};
export function isKonsolPaid(payout: PayoutCellInput | null | undefined): boolean;
export function isStaleSent(payout: PayoutCellInput | null | undefined, now?: number): boolean;
export function payoutCell(payout: PayoutCellInput | null | undefined, now?: number): { tone: 'green' | 'lightgreen' | 'brown' | 'grey' | 'red'; text: string; reason: string; title: string };
export function canPay(payout: (PayoutCellInput & { status: string }) | null | undefined): boolean;
export function payConfirmText(payout: { amount_minor: number; bank_ref?: string | null; fps_bank_member_id?: string | null; phone_masked?: string | null } | null | undefined, handle?: string | null): string;
