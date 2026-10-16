export const DIANA_RULES: string;
export function guardReply(raw: unknown, opts?: { paid?: boolean }): { reply: string | null; escalate: boolean; reason: string };
