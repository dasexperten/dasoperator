export function isRetiredStage(stage: string | null | undefined): boolean;
export function shownStage(stage: string, payouts?: Array<{ status?: unknown; konsol_payment_id?: unknown }>): string;
export function askedWhereToPost(text: string | null | undefined): boolean;
export function stageForPayoutStatus(status: string): 'cart' | 'paid' | 'failed' | null;
export function followPayoutStage(db: D1Database, creatorId: string | null | undefined, payoutStatus: string, now?: number): Promise<boolean>;

export function payoutStageStatement(db: D1Database, creatorId: string | null | undefined, payoutStatus: string, now?: number): D1PreparedStatement | null;
