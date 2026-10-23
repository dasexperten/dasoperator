import registry from '../../scripts/erp-clock/schedules.json';
import { parseCron, matches } from '../../api/src/lib/cron-expect';

// Every enabled lane claims durable API or local ownership before business effects.
// A stable journal key alone is not a lock for unregistered self-contained workers.
type Schedule = { crons: string[]; gate?: string; execution?: string };
const schedules: Record<string, Schedule> = registry;
const parsed = new Map(Object.values(schedules).flatMap(schedule => schedule.crons).map(cron => [cron, parseCron(cron)]));
export const MINUTE_CRON = '* * * * *';
export type TriggerSource = 'cloudflare' | 'external_clock' | 'manual';
export const minuteSlot = (time: number): number => Math.floor(time / 60_000) * 60_000;
export const hasScheduledDoor = (worker: string): boolean => Object.hasOwn(schedules, worker);
export const isLocalScheduledWorker = (worker: string): boolean => hasScheduledDoor(worker) && schedules[worker]!.execution === 'local';
export const hasStableSlot = (worker: string, _cron: string, time?: number): boolean =>
  hasScheduledDoor(worker) && time !== undefined;

export function matchesScheduledCron(worker: string, cron: string, time: number): boolean {
  if (!hasScheduledDoor(worker) || !schedules[worker]!.crons.includes(cron)) return false;
  return matches(parsed.get(cron)!, new Date(time));
}

export function dueScheduledSlot(worker: string, cron: string, time: number): boolean {
  if (!matchesScheduledCron(worker, cron, time)) return false;
  const date = new Date(time), schedule = schedules[worker]!;
  if (schedule.gate === 'first_wednesday' && (date.getUTCDay() !== 3 || date.getUTCDate() > 7)) return false;
  return true;
}

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

export function currentHttpSchedule(worker: string, input: unknown, now: number): { scheduledTime: number; cron: string } | null {
  const scheduledTime = currentHttpSlot(input, now);
  if (scheduledTime === null) return null;
  const provided = (input as { cron?: unknown }).cron;
  // Keep phase1 clients compatible, but do not infer an hourly/daily job from an
  // arbitrary request that forgot to name the configured cron.
  const cron = provided === undefined && (worker === 'erp-ugc-direct' || worker === 'erp-ugc-payouts')
    ? MINUTE_CRON : provided;
  if (typeof cron !== 'string' || !dueScheduledSlot(worker, cron, scheduledTime)) return null;
  return { scheduledTime, cron };
}
