type Env = {DB:any; APIFY_TOKEN?:string; APIFY_DAILY_BUDGET_USD?:string};
type Result = {status:'ok'|'pending'|'unknown'|'budget_exhausted'|'disabled'; observedAt?:string; source?:string; runId?:string; followers?:number|null; posts?:number|null; avatar?:string|null; er?:number|null; sample?:number; url?:string; shortcode?:string; ownerUsername?:string; views?:number|null; likes?:number|null; comments?:number|null};
export function instagramProfileFallback(env:Env,args:{handle:string;cacheForMs?:number}):Promise<Result>;
export function instagramPostFallback(env:Env,args:{url:string;cacheForMs?:number}):Promise<Result>;
export function instagramPostTarget(value:string):{shortcode:string;url:string}|null;
export function parseApifyProfile(items:unknown,expected:string):Partial<Result>|null;
export function parseApifyPost(items:unknown,expected:string):Partial<Result>|null;
export function yerevanBudgetDay(now:number):string;
