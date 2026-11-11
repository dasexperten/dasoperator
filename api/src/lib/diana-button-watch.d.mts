export const WATCH_KEY: string;
export type MissingButton = { handle: string; cid: string; since: string; first_name: string | null };
export function findMissingButtons(db: D1Database, now?: number): Promise<MissingButton[]>;
export function runButtonWatch(db: D1Database, now?: number): Promise<number | null>;
