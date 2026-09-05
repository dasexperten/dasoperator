'use client';

// =============================================================================
// /analytics shared plumbing — API client, formatters, payload types, and the
// small UI atoms (SourceChip, Kpi, Panel) every tab reuses.
// =============================================================================

import React, { useEffect, useState } from 'react';

export const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

// ----- payload types (mirror api/src/routes/*) --------------------------------
export type Ga4DailyRow = { date: string; sessions: number; users: number; purchases: number; revenue: number };
export type Ga4Overview = {
  source: string;
  window_days: number;
  totals: { sessions: number; users: number; purchases: number; revenue: number; cr: number; aov: number };
  returning: { new_purchases: number; returning_purchases: number; rate_pct: number | null };
  rows: Ga4DailyRow[];
  synced_at: number;
};
export type Ga4Channels = {
  source: string;
  window_days: number;
  totals: { sessions: number; users: number; purchases: number; revenue: number; cr: number };
  rows: Array<{ channel: string; sessions: number; users: number; purchases: number; revenue: number; cr: number }>;
  synced_at: number;
};
export type Ga4Pages = {
  source: string;
  window_days: number;
  totals: { sessions: number; purchases: number };
  rows: Array<{ page: string; sessions: number; purchases: number; cr: number }>;
  synced_at: number;
};
export type Ga4AcquisitionDetail = {
  source: string;
  window_days: number;
  method: string;
  totals: { sessions: number; engaged_sessions: number; add_to_carts: number; checkouts: number; purchases: number; revenue: number };
  visible_row_totals: { sessions: number; engaged_sessions: number; add_to_carts: number; checkouts: number; purchases: number; revenue: number };
  coverage: { returned_rows: number; available_rows: number; sessions_pct: number | null };
  rows: Array<{ channel: string; campaign: string; country: string; landing_page: string; date: string; sessions: number; engaged_sessions: number; engagement_rate_pct: number; add_to_carts: number; checkouts: number; purchases: number; revenue: number; cr: number }>;
  synced_at: number;
};
export type Ga4Funnel = {
  source: string;
  window_days: number;
  totals: { sessions: number; page_view_events: number; purchases: number; overall_cr: number };
  rows: Array<{ step: string; count: number; rate_vs_prev_pct: number | null; rate_vs_sessions_pct: number | null }>;
  synced_at: number;
};
export type Ga4CommerceLosses = {
  source: string;
  window_days: number;
  method: string;
  totals: Record<string, number>;
  market_totals: {
    vn_paid_landing: number;
    vn_add_to_cart: number;
    ph_paid_landing: number;
    ph_add_to_cart: number;
    my_paid_landing: number;
    my_add_to_cart: number;
  };
  price_test?: {
    start_utc: string;
    end_utc: string;
    property_time_zone: string;
    boundary_source: string;
    start_minute: string;
    end_minute: string;
    vn_paid_landing: number;
    vn_add_to_cart: number;
    ph_paid_landing: number;
    ph_add_to_cart: number;
    my_paid_landing: number;
    my_add_to_cart: number;
  };
  row_coverage: { returned_rows: number; available_rows: number; failure_rows: number };
  page_totals: Array<{
    country: string;
    page: string;
    price_views: number;
    value_proof_views: number;
    add_to_cart: number;
    view_cart: number;
    begin_checkout: number;
    purchases: number;
    checkout_errors: number;
  }>;
  rows: Array<{ event: string; country: string; page: string; campaign: string; event_minute: string; count: number }>;
  synced_at: number;
};
export type AdsPriceTestExposure = {
  source: string;
  campaign: string;
  campaign_id: string;
  calendar_start: string;
  calendar_end: string;
  launch_seam_caveat: string;
  campaign_delivery?: {
    account_time_zone: string;
    launch_account_date: string;
    launch_account_hour: number;
    status: string | null;
    serving_status: string | null;
    primary_status: string | null;
    primary_status_reasons: string[];
    daily_budget_usd: number;
    post_launch_complete_hours: {
      impressions: number;
      clicks: number;
      cost_usd: number;
      conversions: number;
    };
    hourly: Array<{
      date: string;
      hour: number;
      impressions: number;
      clicks: number;
      cost_usd: number;
      conversions: number;
    }>;
  };
  replacement_search_delivery?: Record<'PH' | 'MY', {
    campaign_id: string;
    campaign: string | null;
    country: string;
    launch_date: string;
    status: string | null;
    serving_status: string | null;
    primary_status: string | null;
    primary_status_reasons: string[];
    daily_budget_usd: number;
    impressions: number;
    clicks: number;
    cost_usd: number;
    conversions: number;
    hourly: Array<{
      date: string;
      hour: number;
      impressions: number;
      clicks: number;
      cost_usd: number;
      conversions: number;
    }>;
  }>;
  markets: Record<'PH' | 'MY' | 'VN', {
    country: string;
    impressions: number;
    clicks: number;
    cost_usd: number;
    conversions: number;
  }>;
  synced_at: number;
};
export type Ga4NavFlows = {
  source: string;
  window_days: number;
  method: string;
  totals: { entry_sessions: number; edge_views: number };
  entries: Array<{ page: string; sessions: number }>;
  edges: Array<{ from: string; to: string; views: number }>;
  synced_at: number;
};
export type ClarityBehavior = {
  source: string;
  window_days: number;
  totals: { sessions: number; bot_sessions: number; distinct_users: number; pages_per_session: number | null };
  engagement: { total_time_sec: number | null; active_time_sec: number | null; avg_scroll_depth_pct: number | null };
  signals: Record<string, { sessions_count: number; sessions_pct: number | null }>;
  dimensions: Record<string, Array<{ name: string; sessions: number }>>;
  synced_at: number;
};
export type DirectCampaigns = {
  configured: boolean;
  pending?: boolean;
  retry_in_sec?: number;
  source: string;
  reason?: string;
  window_days: number;
  totals?: { impressions: number; clicks: number; cost: number; conversions: number };
  rows: Array<{ campaign_id: string; campaign: string; impressions: number; clicks: number; cost: number; conversions: number }>;
  synced_at: number;
};
export type WebDaily = {
  window_days: number;
  rows: Array<{ date: string; source: string; sessions: number | null; users: number | null; purchases: number | null; revenue: number | null; cr: number | null; aov: number | null }>;
  synced_at: number;
};
export type BehaviorHistory = {
  window_days: number;
  rows: Array<{
    date: string; sessions: number; bot_sessions: number;
    dead_click_pct: number | null; rage_click_pct: number | null; quickback_pct: number | null;
    avg_scroll_depth: number | null; avg_engagement_sec: number | null;
    top_pages: Array<{ name: string; sessions: number }>;
    top_referrers: Array<{ name: string; sessions: number }>;
    countries: Array<{ name: string; sessions: number }>;
    devices: Array<{ name: string; sessions: number }>;
  }>;
  synced_at: number;
};
export type MetrikaSources = {
  window_days: number;
  totals: { visits: number; purchases: number; cr: number };
  rows: Array<{ source: string; visits: number; purchases: number; cr: number }>;
  synced_at: number;
};
export type MetrikaPhrases = {
  window_days: number;
  total_visits_with_phrase: number;
  rows: Array<{ phrase: string; visits: number }>;
  synced_at: number;
};
export type MetrikaStats = {
  today: { visits: number; users: number; bounce_rate_pct: number; avg_duration_sec: number };
  timeline: Array<{ date: string; visits: number; users: number }>;
};
export type Ga4Geo = {
  source: string;
  window_days: number;
  totals: { active_users: number };
  rows: Array<{ country: string; country_id: string; active_users: number; delta_pct: number | null }>;
  synced_at: number;
};
export type Ga4Languages = {
  source: string;
  window_days: number;
  totals: { active_users: number };
  rows: Array<{ language: string; active_users: number }>;
  synced_at: number;
};
export type Ga4Content = {
  source: string;
  window_days: number;
  totals: { views: number };
  rows: Array<{ title: string; page: string; views: number }>;
  commerce_rows: Array<{ event: string; title: string; page: string; count: number }>;
  synced_at: number;
};
export type Ga4Snapshot = {
  source: string;
  window_days: number;
  totals: { active_users: number; add_to_carts: number; checkouts: number; purchases: number };
  previous_totals: { active_users: number; add_to_carts: number; checkouts: number; purchases: number };
  deltas_pct: { active_users: number | null; add_to_carts: number | null; checkouts: number | null; purchases: number | null };
  rows: Array<{ date: string; active_users: number; add_to_carts: number; checkouts: number; purchases: number }>;
  synced_at: number;
};
export type Ga4Realtime = {
  source: string;
  active_users_now: number;
  active_users_5min?: number;
  per_minute: Array<{ minutes_ago: number; active_users: number }>;
  by_country: Array<{ country: string; active_users: number }>;
  by_audience?: Array<{ audience: string; count: number }>;
  by_page?: Array<{ title: string; count: number }>;
  by_event?: Array<{ event: string; count: number }>;
  synced_at: number;
};

export type MpSummary = {
  marketplaces: Array<{
    marketplace: string; fbo_units: number; sales_30d: number;
    sku_count_stock: number; sku_count_sales: number;
    last_sync: number | null; last_finish: number | null;
  }>;
  top_sku: Array<{ base_sku: string; marketplace: string; units_30d: number }>;
};

// ----- fetch helpers -----------------------------------------------------------
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'Content-Type': 'application/json' } });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`Request failed (${res.status}) for ${path}`);
  if (!json.success) throw new Error(json.errors?.[0]?.message ?? `API error (${res.status})`);
  return json.result as T;
}

export function useApi<T>(path: string | null): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGet<T>(path)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Unknown error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  return { data, error, loading };
}

// ----- formatters ----------------------------------------------------------------
export function fmtNum(n: number | null | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}
export function fmtPct(n: number | null | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return `${n.toFixed(1)}%`;
}
export function fmtMoney(n: number | null | undefined, currency = 'USD'): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}
export function fmtSec(n: number | null | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  if (n < 90) return `${Math.round(n)}s`;
  return `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;
}
export function timeAgo(unix: number | null | undefined): string {
  if (!unix) return 'never';
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ----- UI atoms ---------------------------------------------------------------------
export function SourceChip({ label }: { label: string }) {
  return (
    <span className="wa-source">
      <span className="dot" />
      {label}
    </span>
  );
}

export function Kpi({
  label,
  value,
  delta,
  deltaTone,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: 'up' | 'down' | null;
  accent?: boolean;
}) {
  return (
    <div className={accent ? 'wa-kpi accent' : 'wa-kpi'}>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {delta !== undefined && <div className={`d ${deltaTone ?? ''}`}>{delta}</div>}
    </div>
  );
}

export function Panel({
  title,
  source,
  children,
  right,
  pad,
}: {
  title: string;
  source?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  pad?: boolean;
}) {
  return (
    <div className="wa-panel">
      <div className="wa-panel-head">
        <h3>{title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {right}
          {source && <SourceChip label={source} />}
        </div>
      </div>
      {pad === false ? children : <div className="wa-panel-body">{children}</div>}
    </div>
  );
}

// Token-styled legend — replaces Tremor's built-in legend (which fights the
// project's 14px type floor). Dot colors are design-system tokens.
export function ChartLegend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--fg-2)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: it.color, flex: 'none' }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <p style={{ color: 'var(--fg-3)' }}>Loading…</p>;
  if (error) return <p style={{ color: 'var(--brand-rot)', fontWeight: 600 }}>Load error: {error}</p>;
  return null;
}
