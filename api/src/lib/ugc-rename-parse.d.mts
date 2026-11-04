export function instagramPostCode(url: unknown): string | null;
export function parsePostOwner(html: unknown): string | null;
export type RenameDecision = { outcome: 'renamed' | 'alive' | 'gone'; handle: string; evidence: string };
export function decideRename(oldHandle: string, input?: { graphUsername?: string | null; postOwners?: string[]; profileAlive?: boolean }): RenameDecision;
