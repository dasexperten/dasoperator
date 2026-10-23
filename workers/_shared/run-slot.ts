// Only these API-backed lanes have durable API ownership before business effects.
// A stable journal key alone is NOT a lock for arbitrary self-contained workers.
const API_SLOT_WORKERS = new Set(['erp-ugc-direct', 'erp-ugc-payouts']);
export const MINUTE_CRON = '* * * * *';
export type TriggerSource = 'cloudflare' | 'external_clock' | 'manual';
export const minuteSlot = (time: number): number => Math.floor(time / 60_000) * 60_000;
export const hasScheduledDoor = (worker: string): boolean => API_SLOT_WORKERS.has(worker);
export const hasStableSlot = (worker: string, cron: string, time?: number): boolean =>
  hasScheduledDoor(worker) && cron === MINUTE_CRON && time !== undefined;

/** Both transports address the same job slot, including CF's sub-minute timestamp. */
export async function slotRunKey(worker: string, cron: string, scheduledTime: number): Promise<string> {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) throw new Error('Invalid scheduled time');
  const input = JSON.stringify(['erp-scheduled-slot-v1', worker, cron, minuteSlot(scheduledTime)]);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // UUIDv8: application-defined SHA-256 name.
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** HTTP callers may address the present slot only, never replay history/future work. */
export function currentHttpSlot(input: unknown, now: number): number | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const time = (input as { scheduledTime?: unknown }).scheduledTime;
  return typeof time === 'number' && Number.isSafeInteger(time) && time === minuteSlot(now) ? time : null;
}
