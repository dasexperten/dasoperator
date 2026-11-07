export const ALARM: string;
export const ROUND: string;
export const START_GAP_MS: number;
export const SIGNAL_TTL_MS: number;
export const CLAIM_SQL: string;
export function inMoscowWindow(now?: Date): boolean;
export function alarmState(rows: any[], now?: Date): Record<string, any>;
export function freshSignal(value: string, now?: Date): Record<string, any> | null;
