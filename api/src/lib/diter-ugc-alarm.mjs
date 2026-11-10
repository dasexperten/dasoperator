// Owner 2026-11-08: Moscow-time alarm windows; the round starts on its signal.
export const ALARM = 'erp-ugc-diter';
export const LEGACY_ALARM = 'diter-ugc-alarm';
export const ROUND = 'diter-ugc-round';
export const START_GAP_MS = 15 * 60_000;
export const SIGNAL_TTL_MS = 3 * 60_000;
// Owner 10.11.2026: one 90-minute cadence in Europe/Moscow.
export const MOSCOW_SCHEDULE = {
  weekdays: ['09:00','10:30','12:00','13:30','15:00','16:30','18:00','19:30','21:00','22:30'],
  weekends: ['10:00','11:30','13:00','14:30','16:00','17:30','19:00','20:30','22:00'],
};
export function triggerSlot(now = new Date()) {
  const moscow = new Date(now.getTime() + 3 * 3600_000);
  const day = moscow.getUTCDay();
  const minute = moscow.getUTCHours() * 60 + moscow.getUTCMinutes();
  const times = day >= 1 && day <= 5 ? MOSCOW_SCHEDULE.weekdays : MOSCOW_SCHEDULE.weekends;
  const slot = times.map(time => { const [h,m] = time.split(':').map(Number); return h*60+m; })
    .find(time => minute >= time && minute < time + SIGNAL_TTL_MS/60000);
  if (slot === undefined) return null;
  return now.getTime() - ((minute-slot)*60000 + now.getUTCSeconds()*1000 + now.getUTCMilliseconds());
}
// Allow the existing bounded preflight to finish after a fixed trigger.
export function inMoscowWindow(now = new Date()) { return triggerSlot(now) !== null; }
export function isTriggerMinute(now = new Date()) {
  const slot=triggerSlot(now);
  return slot !== null && Math.floor(now.getTime()/60000) === Math.floor(slot/60000);
}
export function alarmWireName(requestedName) {
  return requestedName === ALARM ? ALARM : LEGACY_ALARM;
}
export function alarmState(rows, now = new Date()) {
  const base = { name: ALARM, target: ROUND, checked_at: now.toISOString(), content_id: null,
    queued: rows.filter(row=>row.status==='queued').length,
    exhausted: rows.filter(row=>row.status==='queued'&&(row.attempts>=3||row.dispatch_attempts>=3)).length };
  if (rows.some(row => row.status === 'working')) return { ...base, state: 'working' };
  const candidate = rows.find(row => row.status === 'queued' && row.attempts < 3 && row.dispatch_attempts < 3);
  if (!candidate) return { ...base, state: 'empty_or_attempt_limit' };
  if (!inMoscowWindow(now)) return { ...base, state: 'outside_window' };
  const last = Math.max(0, ...rows.map(row => Date.parse(row.started_at ?? '') || 0));
  if (last + START_GAP_MS > now.getTime()) return { ...base, state: 'cooldown', next_start_at: new Date(last + START_GAP_MS).toISOString() };
  return { ...base, state: 'ready', content_id: candidate.content_id };
}
export function freshSignal(value, now = new Date()) {
  try {
    const signal = JSON.parse(value);
    const age = now.getTime() - Date.parse(signal.checked_at);
    return signal.name === ALARM && signal.target === ROUND && signal.state === 'ready'
      && typeof signal.content_id === 'string' && age >= 0 && age < SIGNAL_TTL_MS && inMoscowWindow(now) ? signal : null;
  } catch { return null; }
}
// One statement: D1 serializes simultaneous claims, including distinct posts.
// Keep started_at after release: retries cannot erase the global start gap.
export const CLAIM_SQL = `UPDATE ugc_reel_jobs
  SET status='working',claim_id=?1,started_at=?2,attempts=attempts+1,
      dispatch_attempts=dispatch_attempts+1,dispatched_at=?2,last_error=NULL,updated_at=?2
  WHERE content_id=?3 AND status='queued' AND attempts<3 AND dispatch_attempts<3
    AND NOT EXISTS (SELECT 1 FROM ugc_reel_jobs WHERE status='working')
    AND NOT EXISTS (SELECT 1 FROM ugc_reel_jobs WHERE started_at>?4)
    AND EXISTS (SELECT 1 FROM crm_sync_state WHERE key='erp-ugc-diter'
      AND json_extract(value,'$.state')='ready' AND json_extract(value,'$.content_id')=?3
      AND json_extract(value,'$.checked_at')>?5)`;
