// =============================================================================
// Activity routes — team activity tracking
//
//   POST /api/activity/ping        Authorization: Bearer <token>
//        body { kind?: 'login'|'heartbeat'|'logout', active?: boolean, path?: string }
//        → writes one user_activity row. Frontend pings every ~30s while the
//          tab is open; active=true when mouse/keyboard moved in the interval.
//
//   GET  /api/activity/dashboard   Authorization: Bearer <token>  (admin only)
//        → per-user aggregate for the last 7 local days:
//          time in system, average working day (Mon-Fri), activity %
//          (share of the 10:00-18:00 working window), and a per-day breakdown.
//
// Time model: in-system = heartbeat_count * HEARTBEAT_SEC,
//             active    = SUM(active)      * HEARTBEAT_SEC.
// Weekends (Sat/Sun) are excluded from the average-day and activity-% maths.
// =============================================================================
import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { validateSession } from '../lib/auth';

const activity = new Hono<{ Bindings: Env }>();

const HEARTBEAT_SEC = 30;                    // frontend ping cadence
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;     // Europe/Moscow, UTC+3
const DAY_MS = 24 * 60 * 60 * 1000;
const WORK_START_H = 10;
const WORK_END_H = 18;
const WORK_WINDOW_HOURS = (WORK_END_H - WORK_START_H) * 5;  // 8h * 5 weekdays = 40
const WORK_DAYS = 5;

function bearer(c: import('hono').Context): string | null {
  const h = c.req.header('Authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// POST /api/activity/ping
// ---------------------------------------------------------------------------
activity.post('/ping', async (c) => {
  const token = bearer(c);
  if (!token) return fail(c, 401, [{ code: 'no_token', message: 'missing bearer token' }]);
  const user = await validateSession(c.env.DB, token);
  if (!user) return fail(c, 401, [{ code: 'invalid_session', message: 'session not found or expired' }]);

  let body: { kind?: unknown; active?: unknown; path?: unknown } = {};
  try { body = await c.req.json(); } catch { /* empty body = plain heartbeat */ }

  const kind = body?.kind === 'login' || body?.kind === 'logout' ? body.kind : 'heartbeat';
  const active = body?.active === true || body?.active === 1 ? 1 : 0;
  const path = typeof body?.path === 'string' ? body.path.slice(0, 200) : null;

  await c.env.DB
    .prepare(`INSERT INTO user_activity (user_id, session_token, ts, kind, active, path)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(user.id, token, Date.now(), kind, active, path)
    .run();

  return ok(c, { recorded: true, kind });
});

// ---------------------------------------------------------------------------
// GET /api/activity/dashboard
// ---------------------------------------------------------------------------
activity.get('/dashboard', async (c) => {
  const token = bearer(c);
  if (!token) return fail(c, 401, [{ code: 'no_token', message: 'missing bearer token' }]);
  const me = await validateSession(c.env.DB, token);
  if (!me) return fail(c, 401, [{ code: 'invalid_session', message: 'session not found or expired' }]);
  if (me.role !== 'admin') return fail(c, 403, [{ code: 'forbidden', message: 'admin role required' }]);

  // week=0 current calendar week, -1 previous, etc. Future weeks clamp to 0.
  const weekRaw = parseInt(c.req.query('week') ?? '0', 10);
  const weekOffset = Number.isFinite(weekRaw) ? Math.min(0, weekRaw) : 0;

  const now = Date.now();
  const todayIdx = Math.floor((now + TZ_OFFSET_MS) / DAY_MS);
  const todayWeekday = new Date(todayIdx * DAY_MS).getUTCDay();   // 0=Sun..6=Sat
  const daysSinceMonday = (todayWeekday + 6) % 7;                 // Mon=0
  const mondayIdx = todayIdx - daysSinceMonday + weekOffset * 7;  // Monday of the selected week

  const dayIdxList: number[] = [];
  for (let i = 0; i < 7; i++) dayIdxList.push(mondayIdx + i);     // Mon..Sun
  const sinceTs = mondayIdx * DAY_MS - TZ_OFFSET_MS;
  const untilTs = (mondayIdx + 7) * DAY_MS - TZ_OFFSET_MS;

  const dayMeta = dayIdxList.map((idx) => {
    const d = new Date(idx * DAY_MS);
    return { day_idx: idx, date: d.toISOString().slice(0, 10), weekday: d.getUTCDay() }; // 0=Sun..6=Sat
  });

  // Active users (show everyone, even with zero activity this week)
  const usersRes = await c.env.DB
    .prepare(`SELECT id, name, role FROM users WHERE active = 1
              ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'support' THEN 3 ELSE 4 END, name`)
    .all<{ id: string; name: string; role: string }>();
  const users = usersRes.results ?? [];

  // Aggregate beats per user per local day
  const aggRes = await c.env.DB
    .prepare(`SELECT user_id,
                     CAST((ts + ?1) / ?2 AS INTEGER) AS day_idx,
                     COUNT(*) AS beats,
                     SUM(active) AS active_beats,
                     MIN(ts) AS first_ts
              FROM user_activity
              WHERE kind IN ('login', 'heartbeat') AND ts >= ?3 AND ts < ?4
              GROUP BY user_id, day_idx`)
    .bind(TZ_OFFSET_MS, DAY_MS, sinceTs, untilTs)
    .all<{ user_id: string; day_idx: number; beats: number; active_beats: number; first_ts: number }>();

  const byUser = new Map<string, Map<number, { beats: number; active_beats: number; first_ts: number }>>();
  for (const r of aggRes.results ?? []) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Map());
    byUser.get(r.user_id)!.set(r.day_idx, {
      beats: r.beats, active_beats: r.active_beats ?? 0, first_ts: r.first_ts,
    });
  }

  const hoursFromBeats = (beats: number) => (beats * HEARTBEAT_SEC) / 3600;

  const usersOut = users.map((u) => {
    const days = byUser.get(u.id) ?? new Map();
    let weekHours = 0;
    let weekdayInSystem = 0;
    let weekdayActive = 0;

    const daily = dayMeta.map((dm) => {
      const cell = days.get(dm.day_idx);
      const inSystem = cell ? hoursFromBeats(cell.beats) : 0;
      const activeH = cell ? hoursFromBeats(cell.active_beats) : 0;
      const passiveH = Math.max(0, inSystem - activeH);
      const isWeekday = dm.weekday >= 1 && dm.weekday <= 5;
      weekHours += inSystem;
      if (isWeekday) { weekdayInSystem += inSystem; weekdayActive += activeH; }
      return {
        date: dm.date,
        weekday: dm.weekday,
        is_weekday: isWeekday,
        in_system_h: round2(inSystem),
        active_h: round2(activeH),
        passive_h: round2(passiveH),
        first_login: cell ? new Date(cell.first_ts + TZ_OFFSET_MS).toISOString().slice(11, 16) : null,
      };
    });

    const activityPct = Math.min(100, Math.round((weekdayActive / WORK_WINDOW_HOURS) * 100));

    return {
      id: u.id,
      name: u.name,
      role: u.role,
      week_hours: round2(weekHours),
      avg_day_hours: round2(weekdayInSystem / WORK_DAYS),
      activity_pct: activityPct,
      daily,
    };
  });

  return ok(c, {
    generated_at: now,
    tz: 'UTC+3',
    work_window: { start_hour: WORK_START_H, end_hour: WORK_END_H, days: 'Mon-Fri' },
    heartbeat_sec: HEARTBEAT_SEC,
    week_offset: weekOffset,
    week_start: dayMeta[0].date,
    week_end: dayMeta[6].date,
    is_current_week: weekOffset === 0,
    days: dayMeta,
    users: usersOut,
  });
});

export default activity;
