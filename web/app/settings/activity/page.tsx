'use client';

export const runtime = 'edge';

// =============================================================================
// Settings → Team Activity (admin only)
// Calendar week (Mon–Sun) per employee with prev/next week navigation.
//   row    → name, time in system / week, average working day, activity %
//   expand → metric cards + Mon–Sun active/passive bars (full bar = 8h day)
//   click a day → first login + time in system that day
// =============================================================================
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, LogIn, CalendarOff } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { getUser } from '@/lib/auth';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(s: string): string {
  const [, m, d] = s.split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${d}`;
}

interface DailyCell {
  date: string;
  weekday: number;
  is_weekday: boolean;
  in_system_h: number;
  active_h: number;
  passive_h: number;
  first_login: string | null;
}
interface UserRow {
  id: string;
  name: string;
  role: string;
  week_hours: number;
  avg_day_hours: number;
  activity_pct: number;
  daily: DailyCell[];
}
interface DashboardData {
  generated_at: number;
  tz: string;
  work_window: { start_hour: number; end_hour: number; days: string };
  heartbeat_sec: number;
  week_offset: number;
  week_start: string;
  week_end: string;
  is_current_week: boolean;
  users: UserRow[];
}

function pctColor(p: number): string {
  if (p >= 70) return '#1D9E75';
  if (p >= 55) return '#EF9F27';
  return '#E24B4A';
}
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] ?? '').concat(parts[1]?.[0] ?? '').toUpperCase() || name.slice(0, 2).toUpperCase();
}

export default function ActivityPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selDay, setSelDay] = useState<Record<string, number | null>>({});

  useEffect(() => {
    setIsAdmin(getUser()?.role === 'admin');
  }, []);

  useEffect(() => {
    if (isAdmin === null) return;
    if (isAdmin === false) { setLoading(false); return; }
    setLoading(true);
    setSelDay({});
    apiGet<DashboardData>(`/api/activity/dashboard?week=${weekOffset}`)
      .then((r) => {
        if (r.success && r.result) { setData(r.result); setError(null); }
        else setError(r.errors?.[0]?.message ?? 'Failed to load data');
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [isAdmin, weekOffset]);

  return (
    <div className="px-8 py-6 max-w-screen-2xl">
      <Link href="/settings" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--fg-3)', textDecoration: 'none', marginBottom: '16px' }}>
        <ArrowLeft className="h-4 w-4" /> Settings
      </Link>
      <div className="flex items-center gap-3 mb-2">
        <Activity className="h-7 w-7" style={{ color: 'var(--fg-1)' }} />
        <h1 style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '28px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase' }}>
          Team Activity
        </h1>
      </div>
      <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '20px', maxWidth: '720px' }}>
        Working window 10:00–18:00, Mon–Fri (weekends don&apos;t affect the average day or activity %). Activity is
        the share of the working window with mouse/keyboard movement. Each bar is scaled to a full 8-hour day.
      </p>

      {isAdmin === false && (
        <div style={{ padding: '16px 20px', border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--paper)', color: 'var(--fg-2)', fontSize: '14px' }}>
          This section is available to admins only.
        </div>
      )}

      {isAdmin && (
        <>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => setWeekOffset((o) => o - 1)}
              aria-label="Previous week"
              style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 'var(--radius-sm)', border: '1px solid var(--line-1)', color: 'var(--fg-1)' }}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', minWidth: 150, textAlign: 'center' }}>
              {data ? `${fmtDate(data.week_start)} – ${fmtDate(data.week_end)}` : '—'}
              {data?.is_current_week ? <span style={{ fontWeight: 400, color: 'var(--fg-3)' }}> · this week</span> : null}
            </span>
            <button
              onClick={() => setWeekOffset((o) => Math.min(0, o + 1))}
              aria-label="Next week"
              disabled={!!data?.is_current_week}
              style={{ all: 'unset', cursor: data?.is_current_week ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 'var(--radius-sm)', border: '1px solid var(--line-1)', color: 'var(--fg-1)', opacity: data?.is_current_week ? 0.35 : 1 }}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-wrap gap-4 mb-3" style={{ fontSize: '12px', color: 'var(--fg-2)' }}>
            <span className="inline-flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 2, background: '#1D9E75', display: 'inline-block' }} />Active time</span>
            <span className="inline-flex items-center gap-1.5"><span style={{ width: 10, height: 10, borderRadius: 2, background: '#B4B2A9', display: 'inline-block' }} />Passive (tab open)</span>
          </div>

          {loading && <div style={{ color: 'var(--fg-3)', fontSize: '14px' }}>Loading…</div>}
          {error && !loading && (
            <div style={{ padding: '16px 20px', border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--paper)', color: '#E24B4A', fontSize: '14px' }}>{error}</div>
          )}

          {!loading && data && (
            <div style={{ border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--paper)', overflow: 'hidden', maxWidth: '900px' }}>
              {data.users.length === 0 && (
                <div style={{ padding: '20px', color: 'var(--fg-3)', fontSize: '14px' }}>No activity data yet.</div>
              )}
              {data.users.map((u, i) => {
                const open = openId === u.id;
                const sel = selDay[u.id] ?? null;
                const noData = u.week_hours <= 0;
                return (
                  <div key={u.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--line-1)' }}>
                    <button
                      onClick={() => setOpenId(open ? null : u.id)}
                      style={{ all: 'unset', boxSizing: 'border-box', cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px' }}
                    >
                      <span style={{ width: 32, height: 32, borderRadius: '50%', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, flexShrink: 0 }}>{initials(u.name)}</span>
                      <span style={{ fontWeight: 700, fontSize: '14px', color: 'var(--fg-1)', flex: 1, minWidth: 80 }}>{u.name}</span>
                      <span style={{ fontSize: '12px', color: 'var(--fg-2)', width: 96 }}>{u.week_hours.toFixed(1)} h / wk</span>
                      <span style={{ fontSize: '12px', color: 'var(--fg-2)', width: 92 }}>{u.avg_day_hours.toFixed(1)} h / day</span>
                      <span className="flex items-center gap-2" style={{ width: 110 }}>
                        <span style={{ flex: 1, height: 7, borderRadius: 4, background: 'var(--paper-sunk)', overflow: 'hidden' }}>
                          <span style={{ display: 'block', width: `${u.activity_pct}%`, height: '100%', background: pctColor(u.activity_pct) }} />
                        </span>
                        <span style={{ fontSize: '12px', color: 'var(--fg-2)', minWidth: 30 }}>{u.activity_pct}%</span>
                      </span>
                      <ChevronDown className="h-4 w-4" style={{ color: 'var(--fg-3)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .18s', flexShrink: 0 }} />
                    </button>

                    {open && (
                      <div style={{ padding: '4px 16px 18px' }}>
                        <div className="grid gap-2.5 mb-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
                          {[
                            { l: 'In system this week', v: `${u.week_hours.toFixed(1)} h` },
                            { l: 'Average day (Mon–Fri)', v: `${u.avg_day_hours.toFixed(1)} h` },
                            { l: 'Activity', v: `${u.activity_pct}%` },
                          ].map((m) => (
                            <div key={m.l} style={{ background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
                              <div style={{ fontSize: '12px', color: 'var(--fg-2)' }}>{m.l}</div>
                              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)' }}>{m.v}</div>
                            </div>
                          ))}
                        </div>

                        {noData ? (
                          <div style={{ fontSize: '13px', color: 'var(--fg-3)' }}>No activity recorded this week.</div>
                        ) : (
                          <>
                            <div className="flex items-end gap-2" style={{ height: 170 }}>
                              {u.daily.map((d, di) => {
                                const FULL_H = 8; // full bar height = an 8-hour working day
                                const h = 150;
                                const px = (v: number) => Math.min(h, Math.round((v / FULL_H) * h));
                                const totalH = px(d.in_system_h);
                                const activeH = px(d.active_h);
                                const passiveH = Math.max(0, totalH - activeH);
                                const isSel = sel === di;
                                return (
                                  <button
                                    key={d.date}
                                    onClick={() => setSelDay((s) => ({ ...s, [u.id]: isSel ? null : di }))}
                                    style={{ all: 'unset', cursor: 'pointer', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}
                                  >
                                    <span style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', width: '70%', height: h, background: 'var(--paper-sunk)', borderRadius: 4, overflow: 'hidden', opacity: isSel || sel === null ? 1 : 0.5 }}>
                                      <span style={{ height: passiveH, background: '#B4B2A9' }} />
                                      <span style={{ height: activeH, background: '#1D9E75' }} />
                                    </span>
                                    <span style={{ fontSize: '11px', color: d.is_weekday ? 'var(--fg-2)' : 'var(--fg-3)', fontWeight: isSel ? 700 : 400 }}>{WEEKDAY[d.weekday]}</span>
                                  </button>
                                );
                              })}
                            </div>

                            <div style={{ marginTop: 10, fontSize: '13px', color: 'var(--fg-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
                              {sel === null ? (
                                <>Click a day to see first login and time in system.</>
                              ) : (() => {
                                const d = u.daily[sel];
                                if (!d || d.in_system_h <= 0) {
                                  return <><CalendarOff className="h-4 w-4" /><span><b>{WEEKDAY[d?.weekday ?? 0]} {d?.date}</b> — no logins</span></>;
                                }
                                return <><LogIn className="h-4 w-4" style={{ color: '#1D9E75' }} /><span><b>{WEEKDAY[d.weekday]} {d.date}</b> · first login <b>{d.first_login}</b> · in system <b>{d.in_system_h.toFixed(1)} h</b> (active {d.active_h.toFixed(1)} h)</span></>;
                              })()}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
