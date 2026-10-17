export const DIANA_RULES: string;
export const DIANA_RULES_BODY: string;
export const SCENARIO_RULES: string;
export const JSON_SPEC: string;
export const SCENARIO_CARDS: string[];
export type CleanRequisites = { amount_minor: number; phone: string; bank: string; last_name: string; first_name: string; patronymic: string | null; product: string | null };
export function cleanRequisites(r: unknown): CleanRequisites | null;
export function guardReply(raw: unknown, opts?: { paid?: boolean; inCount?: number; lastIn?: string; allowBrush?: boolean }): { reply: string | null; escalate: boolean; reason: string; sendCards?: boolean; requisites?: CleanRequisites | null; parts?: string[] };

export function requisitesSupportedByText(r: CleanRequisites | null | undefined, text: string): boolean;
