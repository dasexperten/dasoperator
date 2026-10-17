export const DIANA_CONTEXT_VERSION: string;
export function skillCatalog(text: string): any[];
export function selectWithJev(task: string, candidates: any[], options: { apiKey: string; fetchImpl?: typeof fetch }): Promise<any[]>;
export function prepareDianaContext(options: { task: string; githubToken: string; jevKey: string; fetchImpl?: typeof fetch }): Promise<{ system: string; imagePolicy: any; receipt: Record<string, unknown> }>;
