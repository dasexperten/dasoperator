// =============================================================================
// Nightly web-analytics ingestion — cron "30 2 * * *" (05:30 МСК).
//
// Pulls yesterday from every configured tracker and upserts into D1:
//   web_analytics_daily     (date, source) — ga4 / metrika / direct
//   web_behavior_snapshots  (date)         — Clarity daily snapshot
//
// Quota discipline: Clarity gets EXACTLY ONE call per night (10/day hard
// limit); the normalized payload is also written to the KV key that
// /api/clarity/behavior serves, so dashboard traffic stays off the API.
//
// Failure policy: each leg is independent; a failed leg reports through the
// auto-healer (reportCronFailure) and never blocks the other legs.
// Direct is optional — absent token is a silent skip (configured:false).
// =============================================================================

import type { Env } from '../types';
import { ga4Configured, ga4RunReport, metricNum } from './ga4';
import { fetchClarityBehavior, clarityCacheKey } from './clarity';
import { directConfigured, fetchDirectCampaigns } from './direct';
import { reportCronFailure } from './auto-healer';

const CRON = '30 2 * * *';
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function ensureWebAnalyticsTables(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS web_analytics_daily (
         date TEXT,
         source TEXT,
         sessions INTEGER,
         users INTEGER,
         purchases INTEGER,
         revenue REAL,
         cr REAL,
         aov REAL,
         PRIMARY KEY (date, source)
       )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS web_behavior_snapshots (
         date TEXT PRIMARY KEY,
         sessions INTEGER,
         bot_sessions INTEGER,
         dead_click_pct REAL,
         rage_click_pct REAL,
         quickback_pct REAL,
         avg_scroll_depth REAL,
         avg_engagement_sec REAL,
         top_pages TEXT,
         top_referrers TEXT,
         countries TEXT,
         devices TEXT
       )`
    ),
  ]);
}

function yesterdayUtc(): string {
  return new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
}

async function upsertDaily(
  env: Env,
  row: {
    date: string;
    source: string;
    sessions: number | null;
    users: number | null;
    purchases: number | null;
    revenue: number | null;
    cr: number | null;
    aov: number | null;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO web_analytics_daily (date, source, sessions, users, purchases, revenue, cr, aov)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, source) DO UPDATE SET
       sessions = excluded.sessions,
       users = excluded.users,
       purchases = excluded.purchases,
       revenue = excluded.revenue,
       cr = excluded.cr,
       aov = excluded.aov`
  )
    .bind(row.date, row.source, row.sessions, row.users, row.purchases, row.revenue, row.cr, row.aov)
    .run();
}

// ----- GA4: yesterday's totals (global .com contour) -------------------------
async function syncGa4(env: Env, date: string): Promise<string> {
  if (!ga4Configured(env)) return 'ga4: skipped (not configured)';
  const resp = await ga4RunReport(env, {
    dateRanges: [{ startDate: date, endDate: date }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'ecommercePurchases' },
      { name: 'purchaseRevenue' },
    ],
  });
  const r = resp.rows?.[0] ?? {};
  const sessions = Math.round(metricNum(r, 0));
  const users = Math.round(metricNum(r, 1));
  const purchases = Math.round(metricNum(r, 2));
  const revenue = round2(metricNum(r, 3));
  await upsertDaily(env, {
    date,
    source: 'ga4',
    sessions,
    users,
    purchases,
    revenue,
    cr: sessions > 0 ? round2((purchases / sessions) * 100) : 0,
    aov: purchases > 0 ? round2(revenue / purchases) : null,
  });
  return `ga4: ${sessions} sessions, ${purchases} purchases`;
}

// ----- Metrika: yesterday's totals (RU contour) -------------------------------
// Same Stat API + purchase goal as routes/metrika.ts (counter 107720199,
// goal 541778813). Revenue is not pulled (RU contour has no reliable
// ecommerce revenue stream) — column stays NULL, never faked.
const METRIKA_PURCHASE_GOAL_ID = '541778813';

async function syncMetrika(env: Env, date: string): Promise<string> {
  const counter = env.YANDEX_METRIKA_COUNTER;
  const token = env.YANDEX_METRIKA_TOKEN;
  if (!counter || !token) return 'metrika: skipped (not configured)';

  const url = new URL('https://api-metrika.yandex.net/stat/v1/data');
  url.searchParams.set('ids', counter);
  url.searchParams.set(
    'metrics',
    `ym:s:visits,ym:s:users,ym:s:goal${METRIKA_PURCHASE_GOAL_ID}reaches`
  );
  url.searchParams.set('date1', date);
  url.searchParams.set('date2', date);
  url.searchParams.set('accuracy', 'full');
  const res = await fetch(url.toString(), { headers: { Authorization: `OAuth ${token}` } });
  if (!res.ok) throw new Error(`Metrika HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json<{ totals?: number[] }>();
  const totals = data.totals ?? [0, 0, 0];
  const sessions = Math.round(totals[0] ?? 0);
  const purchases = Math.round(totals[2] ?? 0);
  await upsertDaily(env, {
    date,
    source: 'metrika',
    sessions,
    users: Math.round(totals[1] ?? 0),
    purchases,
    revenue: null,
    cr: sessions > 0 ? round2((purchases / sessions) * 100) : 0,
    aov: null,
  });
  return `metrika: ${sessions} visits, ${purchases} purchases`;
}

// ----- Clarity: one call, snapshot + KV pre-warm ------------------------------
async function syncClarity(env: Env, date: string): Promise<string> {
  if (!env.CLARITY_API_TOKEN) return 'clarity: skipped (not configured)';

  // THE one nightly call (numOfDays=1 = trailing 24h ≈ yesterday).
  const behavior = await fetchClarityBehavior(env, 1);

  // Pre-warm the dashboard cache so /api/clarity/behavior never re-calls.
  try {
    await env.CACHE.put(clarityCacheKey(1), JSON.stringify(behavior), { expirationTtl: 86400 });
  } catch {
    // non-fatal
  }

  const top = (dim: string, n: number) =>
    JSON.stringify((behavior.dimensions[dim] ?? []).slice(0, n));

  await env.DB.prepare(
    `INSERT INTO web_behavior_snapshots
       (date, sessions, bot_sessions, dead_click_pct, rage_click_pct, quickback_pct,
        avg_scroll_depth, avg_engagement_sec, top_pages, top_referrers, countries, devices)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       sessions = excluded.sessions,
       bot_sessions = excluded.bot_sessions,
       dead_click_pct = excluded.dead_click_pct,
       rage_click_pct = excluded.rage_click_pct,
       quickback_pct = excluded.quickback_pct,
       avg_scroll_depth = excluded.avg_scroll_depth,
       avg_engagement_sec = excluded.avg_engagement_sec,
       top_pages = excluded.top_pages,
       top_referrers = excluded.top_referrers,
       countries = excluded.countries,
       devices = excluded.devices`
  )
    .bind(
      date,
      behavior.totals.sessions,
      behavior.totals.bot_sessions,
      behavior.signals['dead_click']?.sessions_pct ?? null,
      behavior.signals['rage_click']?.sessions_pct ?? null,
      behavior.signals['quickback']?.sessions_pct ?? null,
      behavior.engagement.avg_scroll_depth_pct,
      behavior.engagement.active_time_sec,
      top('PopularPages', 20),
      top('ReferrerUrl', 20),
      top('Country', 20),
      top('Device', 10)
    )
    .run();
  return `clarity: ${behavior.totals.sessions} sessions (${behavior.totals.bot_sessions} bots)`;
}

// ----- Direct: yesterday's account totals (only when token exists) -----------
// Paid-source semantics for web_analytics_daily: sessions=clicks,
// purchases=conversions, revenue=spend (cost, VAT incl.). The UI labels the
// 'direct' source accordingly — never blended with tracker rows.
async function syncDirect(env: Env, date: string): Promise<string> {
  if (!directConfigured(env)) return 'direct: skipped (not configured)';
  const report = await fetchDirectCampaigns(env, date, date);
  if (report.status === 'pending') return 'direct: report pending (will retry next night)';
  if (report.status === 'error') throw new Error(report.message);
  const clicks = report.rows.reduce((a, r) => a + r.clicks, 0);
  const conversions = report.rows.reduce((a, r) => a + r.conversions, 0);
  const cost = round2(report.rows.reduce((a, r) => a + r.cost, 0));
  await upsertDaily(env, {
    date,
    source: 'direct',
    sessions: clicks,
    users: null,
    purchases: conversions,
    revenue: cost,
    cr: clicks > 0 ? round2((conversions / clicks) * 100) : 0,
    aov: null,
  });
  return `direct: ${clicks} clicks, ${cost} spend`;
}

// =============================================================================
// Entry point for scheduled.ts
// =============================================================================
export async function runWebAnalyticsNightly(
  env: Env
): Promise<{ date: string; legs: string[] }> {
  const date = yesterdayUtc();
  await ensureWebAnalyticsTables(env);

  const legs: string[] = [];
  const run = async (name: string, fn: () => Promise<string>) => {
    try {
      legs.push(await fn());
    } catch (e) {
      legs.push(`${name}: FAILED (${e instanceof Error ? e.message.slice(0, 120) : e})`);
      await reportCronFailure(env, `web_analytics:${name}`, e, { cron: CRON });
    }
  };

  await run('ga4', () => syncGa4(env, date));
  await run('metrika', () => syncMetrika(env, date));
  await run('clarity', () => syncClarity(env, date));
  await run('direct', () => syncDirect(env, date));

  return { date, legs };
}
