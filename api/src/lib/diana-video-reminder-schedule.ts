import type { Env } from '../types';
import { VIDEO_REMINDER_BATCH_KEY, yerevanDay } from './diana-alarm';
import { overdueVideoReminders } from './ugc-payout-store';

// Runs on the existing three-minute Direct timer. Only its 07:00 Yerevan hour opens the batch.
// A failed pass may retry during that hour; already queued events are deduplicated by payout.
export async function startDailyVideoReminders(env: Env, now = Date.now()) {
  const local = new Date(now + 4 * 3600_000);
  if (local.getUTCHours() !== 7) return { due: false };
  const day = yerevanDay(now);
  const previous = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(VIDEO_REMINDER_BATCH_KEY).first<{value:string}>();
  if (previous?.value === day) return { due: false, opened: true };
  let queued = 0, error: string | undefined;
  try { queued = await overdueVideoReminders(env, now); }
  catch (e) { error = e instanceof Error ? e.message : String(e); }
  await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(VIDEO_REMINDER_BATCH_KEY,day,now).run();
  return { due: true, opened: true, queued, ...(error ? { error } : {}) };
}
