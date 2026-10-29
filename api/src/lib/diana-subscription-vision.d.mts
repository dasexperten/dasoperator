import type { SubscriptionInfer } from './diana-subscription.mjs';
export type ImageCheck = {label?: string; kind: 'basket'|'order'|'product_photo'|'other'|'unknown'; product: 'yes'|'no'|'unknown'; seller: 'yes'|'no'|'unknown'; amount: 'yes'|'no'|'unknown'; reason?: string; what: string; visible_text: string; requisites: Record<string,string|null>; observed: Record<string,string|null>; attempts: any[]};
export function checkSubscriptionImages(options: {images: any[]; policy: any; task: string; infer: SubscriptionInfer}): Promise<{status:'yes'|'no'|'unknown'; reasons:string[];checks:ImageCheck[]}>;
export const VISION_MODELS: string[];
export const IMAGE_SCHEMA: unknown;
