// Owner 2026-11-08: age is business activity/publication, never a check date.
export const DAY_MS = 86_400_000;
export function refreshCadence({activityAt, checkedAt, manual = false, now = Date.now()} = {}) {
  const at = typeof activityAt === 'number' ? activityAt : Date.parse(activityAt ?? '');
  const known = Number.isFinite(at) && at <= now;
  const ageDays = known ? Math.max(0,(now-at)/DAY_MS) : null;
  const days = ageDays == null ? 30 : ageDays <= 10 ? 1 : ageDays <= 30 ? 3 : ageDays <= 365 ? 7 : 30;
  const checked = typeof checkedAt === 'number' ? checkedAt : Date.parse(checkedAt ?? '');
  return {days, cacheForMs:days*DAY_MS, ageDays, due:manual || !Number.isFinite(checked) || checked > now || now-checked >= days*DAY_MS};
}
// Trusted source expressions only; caller never interpolates request values.
export function dueCadenceSql(activity, checked) {
  const age=`(julianday('now')-julianday(${activity}))`;
  const days=`CASE WHEN julianday(${activity}) IS NULL OR ${age}<0 THEN 30 WHEN ${age}<=10 THEN 1 WHEN ${age}<=30 THEN 3 WHEN ${age}<=365 THEN 7 ELSE 30 END`;
  return `(${checked} IS NULL OR julianday(${checked}) IS NULL OR julianday(${checked})>julianday('now') OR julianday('now')-julianday(${checked})>=(${days}))`;
}
