export type PostMeta = { likes: number; comments: number; at: number | null };
export function parseCount(s: unknown): number | null;
export function parsePostMeta(meta: unknown): PostMeta | null;
export function engagementLast6(followers: number, posts: PostMeta[]): number | null;
