export const WINDOW_MS: number;
export type UndeliveredChat = { key: string; cid: string; handle: string | null; last_in: string; until: string; status: 'undelivered' | 'expired' };
export function undeliveredChats(db: D1Database, now?: number): Promise<UndeliveredChat[]>;
export function expireUndelivered(db: D1Database, now?: number): Promise<number>;
