export const REEL_STATUSES: Set<string>;
export type ReelPublication = { platform: string; url: string; account: string; verified: boolean; verified_at: string; evidence: string; publication_transport?: 'api'; placement?: 'product_video'; ozon_sku?: string; ozon_video_url?: string; instagram_placement?: 'accepted_coauth'; instagram_media_id?: string; instagram_collaborator_account_id?: string };
export function reelPublicationProof(value: unknown, sourceUrl: string): ReelPublication[] | null;
export function reelTaskText(job: { content_id: string; content_url: string; handle: string; claim_id?: string; required_destinations?: string | string[]; publications?: string }, origin: string): string;

export function publicationKey(item: {platform: string;url: string;ozon_sku?:string;ozon_video_url?:string}): string;
export function appendPublicationProofs(existing: ReelPublication[], incoming: ReelPublication[]): ReelPublication[];

export const REEL_SCOPE_VERSION: string;
export const ACTIVE_REEL_DESTINATIONS: readonly string[];
export const OPTIONAL_REEL_DESTINATIONS: readonly string[];
export const REEL_DESTINATIONS: readonly string[];
export const DEFERRED_REEL_DESTINATIONS: readonly string[];
export function reelScope(job?: {required_destinations?: string | string[]}): {version:string;active:string[];optional:string[];deferred:string[];original_required_destinations:string[];publication_transport:'api';local_browser_fallback:false;cloud_headless_enabled:false;tiktok_publisher:string;placements:{wibes:'public_video';ozon:'product_video'};model_policy:{codex:string;higher_model_fallback:boolean};accounts:{instagram:string;threads:string;tiktok:string;youtube_channel_id:string;facebook_page_id:string;vk_community_id:string;rutube_channel_id:string}};
export function reelJobScopeView<T extends {required_destinations?: string | string[]}>(job:T): T & {destination_scope: ReturnType<typeof reelScope>;active_destinations:string[];optional_destinations:string[];deferred_destinations:string[]};
