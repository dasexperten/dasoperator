export function refreshCadence(options?: {activityAt?: string|number|null;checkedAt?: string|number|null;manual?:boolean;now?:number}): {days:number;cacheForMs:number;ageDays:number|null;due:boolean};
export function dueCadenceSql(activity:string,checked:string):string;
export const DAY_MS:number;
