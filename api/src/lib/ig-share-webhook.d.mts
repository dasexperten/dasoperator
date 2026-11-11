export const SHARE_PREFIX: string;
export type IgShare = { mid: string; type: string; url: string; sender: string; title: string | null; media_id: string | null; at: number | null };
export function validSignature(rawBody: string, header: string, secret: string): Promise<boolean>;
export function extractShares(payload: unknown): IgShare[];
export function saveShares(db: D1Database, shares: IgShare[], now?: number): Promise<number>;
export function applyShares(db: D1Database, messages: any[]): Promise<number>;
