export const DIANA_RULES: string;
export const DIANA_RULES_BODY: string;
export const JSON_SPEC: string;
export const SCENARIO_CARDS: string[];
export type CleanRequisites = { amount_minor: number; phone: string; bank: string; last_name: string; first_name: string; patronymic: string | null; product: string | null };
export function cleanRequisites(r: unknown): CleanRequisites | null;
export function guardReply(raw: unknown, opts?: { paid?: boolean }): { reply: string | null; escalate: boolean; reason: string; sendCards?: boolean; requisites?: CleanRequisites | null };
