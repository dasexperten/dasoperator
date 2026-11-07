import type { Env } from '../types';
import { ALARM, alarmState } from './diter-ugc-alarm.mjs';

// The ERP Worker's existing minute tick owns this alarm. No model/publication.
export async function tickDiterUgcAlarm(env: Env, now = new Date()) {
  const rows = (await env.DB.prepare(`SELECT content_id,status,attempts,dispatch_attempts,started_at FROM ugc_reel_jobs ORDER BY requested_at,content_id`).all()).results ?? [];
  const signal = alarmState(rows, now);
  await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(ALARM, JSON.stringify(signal), now.getTime()).run();
  return signal;
}

// Selection/operator retry refreshes the ERP alarm, never the /adhoc cloud stub.
export async function dispatchReel(env: Env, _contentId: string, _origin: string): Promise<void> {
  await tickDiterUgcAlarm(env);
}
