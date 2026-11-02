export function stageForPayoutStatus(status: string): 'cart' | 'paid' | 'failed' | null;
export function followPayoutStage(db: D1Database, creatorId: string | null | undefined, payoutStatus: string, now?: number): Promise<boolean>;
