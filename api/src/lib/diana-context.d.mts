export const DIANA_CONTEXT_VERSION: string;
export function skillCatalog(text: string): any[];
export function prepareDianaContext(options: { task: string; githubToken: string; infer: (messages: any[], options?: any) => Promise<{text: string}>; fetchImpl?: typeof fetch }): Promise<{ system: string; imagePolicy: any; receipt: Record<string, unknown> }>;
