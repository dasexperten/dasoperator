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
  return `clarity:behavior|days=${days}`;
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
  const out: ClarityBehavior = {
    source: 'Microsoft Clarity (Data Export API, dasexperten.com project)',
    window_days: windowDays,
    totals: { sessions: 0, bot_sessions: 0, distinct_users: 0, pages_per_session: null },
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
      out.signals[signalKey] = {
        sessions_count: num(first['sessionsCount'] ?? first['subTotal']),
        sessions_pct: numOrNull(first['sessionsWithMetricPercentage']),
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

// One upstream call. Callers own the quota discipline:
//  - nightly cron: exactly 1 call, result written to KV + D1
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
