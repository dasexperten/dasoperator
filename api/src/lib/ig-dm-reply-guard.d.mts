export const DIANA_RULES: string;
export const SCENARIO_CARDS: string[];
export function guardReply(raw: unknown, opts?: { paid?: boolean }): { reply: string | null; escalate: boolean; reason: string; sendCards?: boolean };
