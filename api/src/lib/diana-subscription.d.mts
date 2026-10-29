export type SubscriptionModel = 'gpt-6-luna' | 'gpt-6.1-terra';
export type SubscriptionInfer = (messages: any[], options?: {model?: SubscriptionModel; schema?: unknown}) => Promise<{text: string; receipt: Record<string, unknown>}>;
export function subscriptionInfer(env: {DIANA_SUBSCRIPTION?: {fetch: typeof fetch}}, operation: 'context' | 'image'): SubscriptionInfer;
