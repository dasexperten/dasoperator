export declare const RUN_COOLDOWN_MS: number;
export declare function queueItems(rows: Array<{ key: string; value: string }>): Array<{ handle: string; texts: string[] }>;
export declare function isTarget(value: string): value is 'pc' | 'mac';
export declare function cooldownLeft(lastAt: number, now: number): number;
export declare function fireText(input: { target: string; run: string; key: string; doneUrl: string; items: Array<{ handle: string; texts: string[] }> }): string;
