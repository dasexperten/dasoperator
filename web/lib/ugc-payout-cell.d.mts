export const PAYOUT_STATUS_LABEL: Record<'none' | 'awaiting_approval' | 'approved' | 'sent' | 'paid' | 'failed', string>;
export function formatRub(minor: number | null | undefined): string;
export function payoutCell(payout: { status: string; amount_minor: number } | null | undefined): { tone: 'green' | 'red'; text: string; title: string };
