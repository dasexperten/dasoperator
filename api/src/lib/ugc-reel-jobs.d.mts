export const REEL_STATUSES: Set<string>;
export type ReelPublication = { platform: string; url: string; account: string; verified: boolean; verified_at: string; evidence: string };
export function reelPublicationProof(value: unknown, sourceUrl: string): ReelPublication[] | null;
export function reelTaskText(job: { content_id: string; content_url: string; handle: string }, origin: string): string;

export function publicationKey(item: {platform: string;url: string}): string;
export function appendPublicationProofs(existing: ReelPublication[], incoming: ReelPublication[]): ReelPublication[];
