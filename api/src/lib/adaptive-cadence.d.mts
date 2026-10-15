export declare const ACTIVE_MIN: number;
export declare const IDLE_FIRST_MIN: number;
export declare const IDLE_LONG_MIN: number;
export declare function nextCadence(activity: boolean, idle: number): { delayMin: number; idle: number };
export declare function laneDue(state: { next_at?: number } | null | undefined, now: number): boolean;
export declare function afterCheck(state: { idle?: number } | null | undefined, activity: boolean, now: number): { next_at: number; idle: number; last_at: number; last_activity: boolean; delay_min: number };
