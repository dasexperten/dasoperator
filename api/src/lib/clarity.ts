// =============================================================================
// Microsoft Clarity Data Export API client
//
// Base:      https://www.clarity.ms/export-data/api/v1
// Main call: GET /project-live-insights?numOfDays=N   (N max 3!)
// Auth:      Bearer CLARITY_API_TOKEN (scope Data.Export, effectively
//            non-expiring — see SECRETS).
//
// HARD LIMIT: 10 API calls/project/day. The nightly cron makes EXACTLY ONE
// call and writes the normalized payload into the same KV key the
// /api/clarity/behavior endpoint reads (24h TTL), so dashboard traffic never
// goes upstream. No historical backfill exists — the D1 accumulation in
// web_behavior_snapshots IS the archive.
// =============================================================================

import type { Env } from '../types';

const CLARITY_BASE = 'https://www.clarity.ms/export-data/api/v1';

export function clarityCacheKey(days: number): string {
  return `clarity:behavior:v5|days=${days}`;
}

export function clarityUrlCacheKey(days: number): string {
  return `clarity:behavior-by-url:v1|days=${days}`;
}

// The API returns an array of metric blocks:
//   [{ metricName: 'Traffic', information: [{ totalSessionCount, ... }] },
//    { metricName: 'DeadClickCount', information: [{ sessionsWithMetricPercentage, ... }] },
//    ...]
// Field names vary per block, so the normalizer is tolerant: it keeps a
// normalized summary for the blocks the dashboard needs and passes every
// block through as rows for the generic tables.
interface ClarityBlock {
  metricName: string;
  information?: Array<Record<string, unknown>>;
}

export interface ClarityBehavior {
  source: string;
  window_days: number;
  totals: {
    sessions: number;
    bot_sessions: number;
    distinct_users: number;
    pages_per_session: number | null;
  };
  engagement: {
    total_time_sec: number | null;
    active_time_sec: number | null;
    avg_scroll_depth_pct: number | null;
  };
  // percentage-of-sessions metrics (Clarity's behavioral signals)
  signals: Record<
    string,
    { sessions_count: number; sessions_pct: number | null }
  >;
  // dimension blocks: PopularPages, ReferrerUrl, Device, Country, OS, Browser, PageTitle
  dimensions: Record<string, Array<{ name: string; sessions: number }>>;
  synced_at: number;
}

export interface ClarityBehaviorByUrl {
  source: string;
  window_days: number;
  method: string;
  rows: Array<{
    url: string;
    sessions: number;
    dead_click_sessions: number;
    dead_click_pct: number | null;
    quickback_sessions: number;
    quickback_pct: number | null;
    rage_click_sessions: number;
    rage_click_pct: number | null;
  }>;
  synced_at: number;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Behavioral signal blocks — metricName -> normalized snake_case key
const SIGNAL_KEYS: Record<string, string> = {
  DeadClickCount: 'dead_click',
  RageClickCount: 'rage_click',
  QuickbackClick: 'quickback',
  ExcessiveScroll: 'excessive_scroll',
  ScriptErrorCount: 'script_error',
  ErrorClickCount: 'error_click',
};

// Dimension blocks — the first non-count field in each row is the label
const DIMENSION_BLOCKS = new Set([
  'PopularPages',
  'ReferrerUrl',
  'Device',
  'Country',
  'OS',
  'Browser',
  'PageTitle',
  'Source',
  'URL',
]);

export function normalizeClarity(blocks: ClarityBlock[], windowDays: number): ClarityBehavior {
  // Clarity's behavioral blocks expose `subTotal` as the denominator (all
  // sessions), not the number of sessions that exhibited the signal. Resolve
  // Traffic first so a missing explicit sessionsCount can be reconstructed
  // from the percentage without depending on block order.
  const traffic = (blocks ?? []).find((block) => block.metricName === 'Traffic')?.information?.[0] ?? {};
  const totalSessions = num(traffic['totalSessionCount']);
  const out: ClarityBehavior = {
    source: 'Microsoft Clarity (Data Export API, dasexperten.com project)',
    window_days: windowDays,
    totals: { sessions: totalSessions, bot_sessions: 0, distinct_users: 0, pages_per_session: null },
    engagement: { total_time_sec: null, active_time_sec: null, avg_scroll_depth_pct: null },
    signals: {},
    dimensions: {},
    synced_at: Math.floor(Date.now() / 1000),
  };

  for (const block of blocks ?? []) {
    const name = block.metricName;
    const info = block.information ?? [];
    const first = info[0] ?? {};

    if (name === 'Traffic') {
      out.totals.sessions = num(first['totalSessionCount']);
      out.totals.bot_sessions = num(first['totalBotSessionCount']);
      out.totals.distinct_users = num(first['distantUserCount'] ?? first['distinctUserCount']);
      out.totals.pages_per_session = numOrNull(first['PagesPerSessionPercentage']);
      continue;
    }

    if (name === 'EngagementTime') {
      out.engagement.total_time_sec = numOrNull(first['totalTime']);
      out.engagement.active_time_sec = numOrNull(first['activeTime']);
      continue;
    }

    if (name === 'ScrollDepth') {
      out.engagement.avg_scroll_depth_pct = numOrNull(first['averageScrollDepth']);
      continue;
    }

    const signalKey = SIGNAL_KEYS[name];
    if (signalKey) {
      const pct = numOrNull(first['sessionsWithMetricPercentage']);
      const reportedCount = numOrNull(first['sessionsCount']);
      out.signals[signalKey] = {
        // sessionsCount is the examined denominator; subTotal/pagesViews are
        // signal occurrences and can exceed the number of affected sessions.
        // sessionsWithMetricPercentage is the only session-grain numerator.
        sessions_count: pct !== null && totalSessions > 0
          ? Math.round(totalSessions * pct / 100)
          : reportedCount ?? 0,
        sessions_pct: pct,
      };
      continue;
    }

    if (DIMENSION_BLOCKS.has(name)) {
      out.dimensions[name] = info
        .map((row) => {
          const sessions = num(row['sessionsCount'] ?? row['visitsCount'] ?? row['subTotal']);
          // label = first string field that isn't a count/percentage
          let label = '';
          for (const [k, v] of Object.entries(row)) {
            if (typeof v === 'string' && !/count|percentage|total/i.test(k) && v !== '') {
              label = v;
              break;
            }
          }
          return { name: label || 'unknown', sessions };
        })
        .filter((r) => r.sessions > 0 || r.name !== 'unknown')
        .sort((a, b) => b.sessions - a.sessions);
    }
  }

  return out;
}

function storefrontUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!['dasexperten.com', 'www.dasexperten.com', 'dasexperten.ru', 'www.dasexperten.ru'].includes(host)) return null;
    return `${host.replace(/^www\./, '')}${url.pathname}`;
  } catch {
    return null;
  }
}

export function normalizeClarityByUrl(blocks: ClarityBlock[], windowDays: number): ClarityBehaviorByUrl {
  type Row = ClarityBehaviorByUrl['rows'][number];
  type WorkingRow = Row & { dead_base: number; quickback_base: number; rage_base: number };
  const rows = new Map<string, WorkingRow>();
  const ensure = (url: string): WorkingRow => {
    const current = rows.get(url) ?? {
      url,
      sessions: 0,
      dead_click_sessions: 0,
      dead_click_pct: null,
      quickback_sessions: 0,
      quickback_pct: null,
      rage_click_sessions: 0,
      rage_click_pct: null,
      dead_base: 0,
      quickback_base: 0,
      rage_base: 0,
    };
    rows.set(url, current);
    return current;
  };

  for (const block of blocks ?? []) {
    const signal = SIGNAL_KEYS[block.metricName];
    if (!['dead_click', 'quickback', 'rage_click'].includes(signal ?? '')) continue;
    for (const info of block.information ?? []) {
      const url = storefrontUrl(info['Url'] ?? info['URL']);
      if (!url) continue;
      const sessions = num(info['sessionsCount']);
      const pct = numOrNull(info['sessionsWithMetricPercentage']);
      const affected = pct !== null && sessions > 0 ? Math.round(sessions * pct / 100) : 0;
      const row = ensure(url);
      if (signal === 'dead_click') {
        row.dead_base += sessions;
        row.dead_click_sessions += affected;
      } else if (signal === 'quickback') {
        row.quickback_base += sessions;
        row.quickback_sessions += affected;
      } else {
        row.rage_base += sessions;
        row.rage_click_sessions += affected;
      }
      row.sessions = Math.max(row.dead_base, row.quickback_base, row.rage_base);
    }
  }

  return {
    source: 'Microsoft Clarity Data Export API · URL dimension',
    window_days: windowDays,
    method: 'Affected sessions are derived per exact URL row from sessionsCount × sessionsWithMetricPercentage; query strings and fragments are removed, and only Das Experten storefront hosts are retained.',
    rows: [...rows.values()].map(({ dead_base, quickback_base, rage_base, ...row }) => ({
      ...row,
      dead_click_pct: dead_base > 0 ? Math.round(row.dead_click_sessions / dead_base * 10000) / 100 : null,
      quickback_pct: quickback_base > 0 ? Math.round(row.quickback_sessions / quickback_base * 10000) / 100 : null,
      rage_click_pct: rage_base > 0 ? Math.round(row.rage_click_sessions / rage_base * 10000) / 100 : null,
    }))
      .filter((row) => row.dead_click_sessions > 0 || row.quickback_sessions > 0 || row.rage_click_sessions > 0)
      .sort((a, b) => b.quickback_sessions - a.quickback_sessions || b.dead_click_sessions - a.dead_click_sessions || b.rage_click_sessions - a.rage_click_sessions || b.sessions - a.sessions || a.url.localeCompare(b.url)),
    synced_at: Math.floor(Date.now() / 1000),
  };
}

// One upstream call per function. Callers own the quota discipline:
//  - nightly cron: exactly 2 calls (global + URL), results written to KV + D1
//  - /api/clarity/behavior: reads KV first (24h TTL), cold-start only
export async function fetchClarityBehavior(env: Env, days: number): Promise<ClarityBehavior> {
  if (!env.CLARITY_API_TOKEN) throw new Error('CLARITY_API_TOKEN not configured');
  const n = Math.min(Math.max(Math.floor(days) || 1, 1), 3); // API hard max = 3
  const res = await fetch(`${CLARITY_BASE}/project-live-insights?numOfDays=${n}`, {
    headers: { Authorization: `Bearer ${env.CLARITY_API_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Clarity HTTP ${res.status}: ${await res.text()}`);
  }
  const blocks = (await res.json()) as ClarityBlock[];
  return normalizeClarity(blocks, n);
}

export async function fetchClarityBehaviorByUrl(env: Env, days: number): Promise<ClarityBehaviorByUrl> {
  if (!env.CLARITY_API_TOKEN) throw new Error('CLARITY_API_TOKEN not configured');
  const n = Math.min(Math.max(Math.floor(days) || 1, 1), 3);
  const res = await fetch(`${CLARITY_BASE}/project-live-insights?numOfDays=${n}&dimension1=URL`, {
    headers: { Authorization: `Bearer ${env.CLARITY_API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Clarity URL breakdown HTTP ${res.status}: ${await res.text()}`);
  return normalizeClarityByUrl((await res.json()) as ClarityBlock[], n);
}
