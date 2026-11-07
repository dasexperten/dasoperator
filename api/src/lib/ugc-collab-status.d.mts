export function postCode(url: string | null | undefined): string | null;
export function codeOrder(code: string | null | undefined): bigint;
export function decideCollab(
  rows: { id: string; handle: string | null; content_url: string | null; published_at?: string | null }[],
  confirmedCodes: Set<string>,
  invites: Map<string, number>,
): Map<string, 'confirmed' | 'requested' | null>;
