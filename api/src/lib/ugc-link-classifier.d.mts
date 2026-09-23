export type UgcLinkStatus = 'active' | 'missing' | 'restricted' | 'unknown' | 'invalid';
export const UGC_LINK_STATUSES: readonly UgcLinkStatus[];
export function isSafePublicHttpUrl(raw: unknown): boolean;
export function classifyUgcLink(httpStatus: number, finalUrl: string, bodySnippet?: string): UgcLinkStatus;
