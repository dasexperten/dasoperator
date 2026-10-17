export function summarizeImageChecks(checks: any[]): {status: string; reasons: string[]; checks: any[]};
export function checkDianaImages(options: { images: any[]; policy: any; task: string; apiKey: string; fetchImpl?: typeof fetch }): Promise<{ status: string; reasons: string[]; checks: any[] }>;
