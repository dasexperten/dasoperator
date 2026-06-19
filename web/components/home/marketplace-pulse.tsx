'use client';

// =============================================================================
// Marketplace Pulse — Home dashboard section · Phase 9.x polish pass
// 4 cards backed by /api/marketplaces/pulse/*:
//   1. Sales today           — hero number + WB/Ozon split + 14-day spark
//   6. 30-day trend          — stacked bar chart (Ozon=blue, WB=purple)
//   3. Top & Bottom SKUs     — toggle units/revenue, product names, hover
//   9. SKU funnel            — modal: stacked horizontal bars with conv arrows
//
// Color discipline LOCKED across the section:
//   Ozon = #185FA5 (deep blue), WB = #534AB7 (deep purple).
// =============================================================================

import { useEffect, useState, useMemo, useRef } from 'react';
import { Loader2, X, Package, ShoppingBag, BarChart3 } from 'lucide-react';

const COLOR_OZON = '#185FA5';
const COLOR_OZON_LIGHT = '#85B7EB';
const COLOR_WB = '#534AB7';
const COLOR_WB_LIGHT = '#AFA9EC';
const COLOR_COMBINED = '#2E7D4F'; // green — combined WB + Ozon + Site line
const COLOR_SITE     = '#1A1A1A'; // black — dasexperten.ru site sales line

// ───────────────────────── Types ─────────────────────────
type SalesToday = {
  ozon: { revenue_rub: number; units: number; delta_pct: number | null; last_date: string | null };
  wb:   { revenue_rub: number; units: number; delta_pct: number | null; last_date: string | null };
  site: { revenue_rub: number; units: number; delta_pct: number | null; last_date: string | null };
  combined: { revenue_rub: number; units: number };
  spark: Array<{ date: string; revenue_rub: number; ozon_revenue_rub?: number; wb_revenue_rub?: number; site_revenue_rub?: number; units?: number }>;
  freshness?: { last_success_at: number | null; throttled: boolean };
};

type Spotlight = {
  period: { from: string | null; to: string | null };
  synced_at: number | null;
  top: Array<{ base_sku: string; product_name: string | null; units_sold: number; revenue_rub: number; ozon_units: number; wb_units: number }>;
  bottom: Array<{ base_sku: string; product_name: string | null; units_sold: number }>;
};

type DailyTrend = {
  days: Array<{
    date: string;
    ozon: { units: number; revenue_rub: number; delta_pct: number | null };
    wb:   { units: number; revenue_rub: number; delta_pct: number | null };
    site: { units: number; revenue_rub: number; delta_pct: number | null };
  }>;
  totals_30d?: {
    ozon: { units: number; revenue_rub: number; delta_pct: number | null };
    wb:   { units: number; revenue_rub: number; delta_pct: number | null };
    site: { units: number; revenue_rub: number; delta_pct: number | null };
  };
  history_complete: boolean;
  days_available: number;
};

type SkuFunnel = {
  base_sku: string;
  product_name: string | null;
  period: { from: string | null; to: string | null };
  ozon: { views: number; cart: number; orders: number; revenue_rub: number } | null;
  wb:   { views: number; cart: number; orders: number; revenue_rub: number } | null;
  combined: { views: number; cart: number; orders: number; revenue_rub: number };
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'https://dasoperator-api.dasexperten.workers.dev';

// ───────────────────────── Helpers ─────────────────────────
async function fetchJson<T>(path: string, cacheKey?: string): Promise<T | null> {
  try {
    // Try KV cache first (updated daily at 04:00 MSK by cron)
    if (cacheKey) {
      try {
        const cachedRes = await fetch(`${API_BASE}/api/marketplaces/pulse/cached?key=${cacheKey}`);
        if (cachedRes.ok) {
          const cachedJson = await cachedRes.json() as { success: boolean; result: T };
          if (cachedJson.success && cachedJson.result) return cachedJson.result;
        }
      } catch { /* cache miss — fall through to live */ }
    }
    // Live fallback
    const res = await fetch(`${API_BASE}${path}`);
    const json = await res.json() as { success: boolean; result: T };
    return json.success ? json.result : null;
  } catch { return null; }
}

function fmtRubCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toString();
}

function fmtRubFull(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
}

// Relative "updated" label. English, ERP UI language. Minutes/hours/days.
function fmtUpdatedAgo(unixSec: number | null): string {
  if (!unixSec) return 'never updated';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diff < 90) return 'Updated just now';
  const mins = Math.round(diff / 60);
  if (mins < 60) return `Updated ${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `Updated ${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

function fmtPct(p: number | null): { text: string; tone: 'up' | 'down' | 'flat' | 'na' } {
  if (p === null || Number.isNaN(p)) return { text: '—', tone: 'na' };
  if (Math.abs(p) < 0.05) return { text: '±0%', tone: 'flat' };
  return { text: `${p > 0 ? '+' : ''}${p.toFixed(1)}%`, tone: p > 0 ? 'up' : 'down' };
}

function fmtWeekday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}

function fmtDayMonth(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

// ───────────────────────── Section root ─────────────────────────
export default function MarketplacePulse() {
  const [salesToday, setSalesToday] = useState<SalesToday | null>(null);
  const [spotlight, setSpotlight] = useState<Spotlight | null>(null);
  const [trend, setTrend] = useState<DailyTrend | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetch(`${API_BASE}/api/marketplaces/pulse/refresh`, { method: 'POST' });
    } catch { /* throttled / network — fall through to re-fetch */ }
    const fresh = await fetchJson<SalesToday>('/api/marketplaces/pulse/sales-today');
    if (fresh) setSalesToday(fresh);
    setRefreshing(false);
  }


  useEffect(() => {
    Promise.all([
      fetchJson<SalesToday>('/api/marketplaces/pulse/sales-today', 'pulse:sales-today'),
      fetchJson<Spotlight>('/api/marketplaces/pulse/sku-spotlight', 'pulse:sku-spotlight'),
      fetchJson<DailyTrend>('/api/marketplaces/pulse/daily-trend', 'pulse:daily-trend'),
    ]).then(([s, sp, t]) => {
      setSalesToday(s); setSpotlight(sp); setTrend(t); setLoading(false);
    });
  }, []);

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h2 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '20px',
            fontWeight: 700,
            color: 'var(--fg-1)',
            textTransform: 'uppercase',
          }}>
            Marketplace Pulse
          </h2>
          <SectionLegend />
        </div>
        {spotlight?.period.from && (
          <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
            {spotlight.period.from} → {spotlight.period.to}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <SalesTodayCard data={salesToday} loading={loading} refreshing={refreshing} onRefresh={handleRefresh} />
        <TrendCard data={trend} loading={loading} />
        <PieBreakdownCard />
      </div>
    </section>
  );
}

function SectionLegend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '14px', color: 'var(--fg-3)' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: COLOR_OZON, display: 'inline-block' }} />
        Ozon
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: COLOR_WB, display: 'inline-block' }} />
        Wildberries
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Card 1 — Sales today (hero number + sparkline + WB/Ozon split)
// ═══════════════════════════════════════════════════════════════════════════
function SalesTodayCard({ data, loading, refreshing, onRefresh }: { data: SalesToday | null; loading: boolean; refreshing: boolean; onRefresh: () => void }) {
  // Build last-7-days chart with 3 series:
  //   combined (green) — main line with area fill (revenue_rub)
  //   ozon     (blue)  — secondary line (ozon_revenue_rub)
  //   wb       (purple) — secondary line (wb_revenue_rub)
  // All three share the same X axis (day index 0..6) and the same Y scale
  // so they're directly comparable.
  const chart = useMemo(() => {
    if (!data?.spark || data.spark.length < 2) return null;

    // Take the most recent 7 days from the incoming spark window.
    const all = data.spark;
    const series = all.slice(Math.max(0, all.length - 7));
    if (series.length < 2) return null;

    const width = 600;
    const height = 180;
    const pad = 6;
    const innerH = height - pad * 2;

    // Shared Y scale across all three series so they're visually comparable.
    const allValues: number[] = [];
    for (const d of series) {
      allValues.push(d.revenue_rub);
      if (typeof d.ozon_revenue_rub === 'number') allValues.push(d.ozon_revenue_rub);
      if (typeof d.wb_revenue_rub === 'number')   allValues.push(d.wb_revenue_rub);
      if (typeof d.site_revenue_rub === 'number') allValues.push(d.site_revenue_rub);
    }
    const max = Math.max(...allValues, 1);
    const min = Math.min(...allValues, 0);
    const range = max - min || 1;

    function project(getter: (d: typeof series[number]) => number) {
      return series.map((d, i) => {
        const x = (i / Math.max(series.length - 1, 1)) * width;
        const y = height - pad - ((getter(d) - min) / range) * innerH;
        return { x, y, value: getter(d), date: d.date, raw: d };
      });
    }

    const combinedPts = project(d => d.revenue_rub);
    const ozonPts     = project(d => d.ozon_revenue_rub ?? 0);
    const wbPts       = project(d => d.wb_revenue_rub ?? 0);
    const sitePts     = project(d => d.site_revenue_rub ?? 0);

    const toPath = (pts: typeof combinedPts) =>
      pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

    const combinedPath = toPath(combinedPts);
    const ozonPath     = toPath(ozonPts);
    const wbPath       = toPath(wbPts);
    const sitePath     = toPath(sitePts);

    const combinedArea = combinedPts.length > 0
      ? `${combinedPath} L ${combinedPts[combinedPts.length - 1]!.x.toFixed(1)} ${(height - pad).toFixed(1)} L ${combinedPts[0]!.x.toFixed(1)} ${(height - pad).toFixed(1)} Z`
      : '';

    return {
      series,
      combinedPts,
      ozonPts,
      wbPts,
      sitePts,
      combinedPath,
      ozonPath,
      wbPath,
      sitePath,
      combinedArea,
      width,
      height,
    };
  }, [data]);

  // Hover state lifted to parent — top-right HUD reads from this
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const hoveredDay = chart && hoverIdx !== null ? chart.series[hoverIdx] : null;
  const lastDay    = chart ? chart.series[chart.series.length - 1] : null;
  // Default display: today's snapshot (last day in series). On hover, switch to hovered day.
  const displayDay = hoveredDay ?? lastDay;

  return (
    <Card>
      {loading ? <CardLoading /> : !data ? <CardEmpty>No data yet — cron may not have run.</CardEmpty> : (
        <>
          {/* Header row: big totals left, live hover HUD right */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '14px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 700, color: COLOR_OZON, lineHeight: 1.1 }}>
                {fmtRubFull(data.combined.revenue_rub)}
              </div>
              <div style={{ fontSize: '14px', color: COLOR_OZON, marginTop: '2px' }}>
                {data.combined.units} ед · combined WB + Ozon + Site · <span style={{ opacity: 0.7 }}>{data.ozon.last_date ?? ''}</span>
              </div>
              {data.freshness && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px',
                  fontSize: '14px',
                  color: refreshing ? 'var(--fg-muted)' : (data.freshness.throttled ? '#854F0B' : 'var(--fg-muted)'),
                }}>
                  <span style={{
                    width: '7px', height: '7px', borderRadius: '50%',
                    background: refreshing ? 'var(--fg-3)' : (data.freshness.throttled ? '#BA7517' : '#3B6D11'),
                    flexShrink: 0,
                  }} />
                  <span>
                    {refreshing
                      ? 'Refreshing… showing last saved'
                      : fmtUpdatedAgo(data.freshness.last_success_at) + (data.freshness.throttled ? ' · WB busy, retrying' : '')}
                  </span>
                  {!refreshing && (
                    <button
                      onClick={onRefresh}
                      style={{
                        background: 'none', border: 'none', padding: 0, marginLeft: '2px',
                        font: 'inherit', fontSize: '14px', color: 'var(--accent, #C4302B)',
                        cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '2px',
                      }}
                    >
                      refresh
                    </button>
                  )}
                </div>
              )}
            </div>

            {displayDay && (
              <div style={{ textAlign: 'right', fontSize: '14px', lineHeight: 1.5, minWidth: '190px' }}>
                <div style={{ color: 'var(--fg-muted)', fontSize: '14px', marginBottom: '2px' }}>
                  {fmtWeekday(displayDay.date)} · {fmtDayMonth(displayDay.date)}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: '10px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'var(--fg-3)' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: COLOR_OZON, display: 'inline-block' }} />
                    Ozon
                  </span>
                  <span style={{ fontWeight: 700, color: 'var(--fg-1)', minWidth: '80px', display: 'inline-block' }}>
                    {typeof displayDay.ozon_revenue_rub === 'number' ? fmtRubFull(displayDay.ozon_revenue_rub) : '—'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: '10px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'var(--fg-3)' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: COLOR_WB, display: 'inline-block' }} />
                    WB
                  </span>
                  <span style={{ fontWeight: 700, color: 'var(--fg-1)', minWidth: '80px', display: 'inline-block' }}>
                    {typeof displayDay.wb_revenue_rub === 'number' ? fmtRubFull(displayDay.wb_revenue_rub) : '—'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: '10px' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: 'var(--fg-3)' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: COLOR_SITE, display: 'inline-block' }} />
                    Site
                  </span>
                  <span style={{ fontWeight: 700, color: 'var(--fg-1)', minWidth: '80px', display: 'inline-block' }}>
                    {typeof displayDay.site_revenue_rub === 'number' ? fmtRubFull(displayDay.site_revenue_rub) : '—'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: '10px' }}>
                  <span style={{ color: 'var(--fg-3)' }}>Combined</span>
                  <span style={{ fontWeight: 700, color: 'var(--fg-1)', minWidth: '80px', display: 'inline-block' }}>
                    {fmtRubFull(displayDay.revenue_rub)}
                  </span>
                </div>
              </div>
            )}
          </div>

          {chart && (
            <SparklineWithHover
              chart={chart}
              onHoverChange={setHoverIdx}
            />
          )}
        </>
      )}
    </Card>
  );
}

function SplitRow({ label, amount, units, delta, color }: { label: string; amount: number; units: number; delta: number | null; color: string }) {
  const dp = fmtPct(delta);
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '6px 0' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: 'var(--fg-2)' }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: color, display: 'inline-block' }} />
        {label}
      </span>
      <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
        {fmtRubFull(amount)}
        <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: '8px' }}>{units} ед</span>
        {dp.tone !== 'na' && <DeltaPill tone={dp.tone}>{dp.text}</DeltaPill>}
      </span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Card 6 — 30-day trend (stacked bar chart with axis labels)
// ═══════════════════════════════════════════════════════════════════════════
function TrendCard({ data, loading }: { data: DailyTrend | null; loading: boolean }) {
  const chart = useMemo(() => {
    if (!data || data.days.length === 0) return null;
    const maxTotal = Math.max(...data.days.map(d => d.ozon.revenue_rub + d.wb.revenue_rub + d.site.revenue_rub));
    const totalRange = data.days.reduce((s, d) => s + d.ozon.revenue_rub + d.wb.revenue_rub + d.site.revenue_rub, 0);
    return { maxTotal, totalRange };
  }, [data]);

  return (
    <Card>
      <CardHeader icon={<BarChart3 className="h-4 w-4" />} title="30-day trend" subtitle={chart ? `Σ ${fmtRubFull(chart.totalRange)}` : undefined} />

      {loading ? <CardLoading /> : !data || data.days.length === 0 ? <CardEmpty>No daily snapshots yet.</CardEmpty> : (
        <>
          <TrendBars data={data} chart={chart} />

          {/* 30-day totals per channel — sums over the entire 30d window with Δ vs previous 30d */}
          {data.totals_30d && (() => {
            const t = data.totals_30d;
            const ozDp = fmtPct(t.ozon.delta_pct);
            const wbDp = fmtPct(t.wb.delta_pct);
            const siDp = fmtPct(t.site.delta_pct);
            return (
              <div style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: '10px' }}>
                <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginBottom: '6px' }}>
                  30-day totals · vs previous 30 days
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '14px', flexWrap: 'wrap', gap: '8px' }}>
                  <span style={{ color: COLOR_OZON, fontWeight: 700 }}>
                    Ozon {fmtRubCompact(t.ozon.revenue_rub)}
                    {ozDp.tone !== 'na' && <DeltaPill tone={ozDp.tone}>{ozDp.text}</DeltaPill>}
                  </span>
                  <span style={{ color: COLOR_WB, fontWeight: 700 }}>
                    WB {fmtRubCompact(t.wb.revenue_rub)}
                    {wbDp.tone !== 'na' && <DeltaPill tone={wbDp.tone}>{wbDp.text}</DeltaPill>}
                  </span>
                  <span style={{ color: COLOR_SITE, fontWeight: 700 }}>
                    dasexperten.ru {fmtRubCompact(t.site.revenue_rub)}
                    {siDp.tone !== 'na' && <DeltaPill tone={siDp.tone}>{siDp.text}</DeltaPill>}
                  </span>
                </div>
                {!data.history_complete && (
                  <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '8px' }}>
                    Δ vs previous 30 days populates once we have 60d of history (currently {data.days_available}d)
                  </div>
                )}
              </div>
            );
          })()}
        </>
      )}
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Card 3 — Sales Breakdown YTD (two pies: by SKU + by Partner)
// ═══════════════════════════════════════════════════════════════════════════

type BreakdownData = {
  period: { from: string; to: string; label: string };
  sku: {
    top10: Array<{ sku: string; product_name: string | null; units: number; revenue: number }>;
    other: { count: number; revenue: number };
    total: number;
    sku_count: number;
  };
  partners: {
    items: Array<{ id: string; label: string; revenue: number; ops_count: number }>;
    total: number;
    currency: 'USD';
    fx_date: string | null;
  };
};

const SKU_COLORS = ['#C4302B', '#D4A017', '#1D9E75', '#534AB7', '#D4537E', '#378ADD', '#639922', '#D85A30', '#993556', '#0F6E56'];
const OTHER_COLOR = '#888780';
const PARTNER_COLORS: Record<string, string> = {
  ozon:                                                '#378ADD',
  wb:                                                  '#7F77DD',
  dasex_group:                                         '#888780',
  tori_georgia:                                        '#1D9E75',
  torwey:                                              '#D85A30',
  'яндекс_пей_продажи_с_нашего_сайта':                 '#D4A017',
  dm:                                                  '#97C459',
  letoile:                                             '#D4537E',
  dasexperten_com:                                     '#534AB7',
};
const PARTNER_PALETTE = ['#888780', '#1D9E75', '#D85A30', '#D4A017', '#97C459', '#D4537E', '#534AB7'];
const PARTNER_OTHER = '#5F5E5A';

function buildPieSlices(values: number[], explode = 6, rx = 90, ry = 49.5) {
  const total = values.reduce((s, v) => s + v, 0);
  if (total <= 0) return [];
  const slices = [];
  let angle = 0;
  for (const v of values) {
    const sweep = (v / total) * 360;
    const start = angle;
    const end = angle + sweep;
    const mid = (start + end) / 2;
    const sx = rx * Math.cos((start * Math.PI) / 180);
    const sy = -ry * Math.sin((start * Math.PI) / 180);
    const ex = rx * Math.cos((end * Math.PI) / 180);
    const ey = -ry * Math.sin((end * Math.PI) / 180);
    const dx = explode * Math.cos((mid * Math.PI) / 180);
    const dy = -explode * Math.sin((mid * Math.PI) / 180) * (ry / rx);
    const largeArc = sweep > 180 ? 1 : 0;
    slices.push({ sx, sy, ex, ey, dx, dy, largeArc, rx, ry, pct: (v / total) * 100 });
    angle = end;
  }
  return slices;
}

function fmtMoneyShort(v: number): string {
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(0) + 'k';
  return v.toFixed(0);
}

function PieBreakdownCard() {
  const [data, setData] = useState<BreakdownData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || 'https://dasoperator-api.dasexperten.workers.dev';
    fetch(`${apiBase}/api/dashboard/sales-breakdown`)
      .then(r => r.json())
      .then(j => { if (j?.success) setData(j.result); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', gridColumn: 'span 2' }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Package className="h-4 w-4" style={{ color: 'var(--fg-2)' }} />
          <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase' }}>
            Sales breakdown · {data?.period.label || 'YTD'}
          </span>
        </div>
      </div>

      {loading ? <CardLoading /> : !data ? <CardEmpty>No data.</CardEmpty> : (
        <div className="grid grid-cols-2 gap-8">
          <SkuPie data={data} />
          <PartnerPie data={data} />
        </div>
      )}
    </div>
  );
}

function SkuPie({ data }: { data: BreakdownData }) {
  // Re-rank ALL SKUs by units (server sent them sorted by revenue)
  // Server now returns top10 already sorted by units; just trust it.
  const sortedTop10 = data.sku.top10;
  const otherUnits = (data.sku.other as any).units ?? 0;
  // Prefer real total from server; fall back to summing what we have if absent.
  const totalUnits = (data.sku as any).total_units
    ?? (sortedTop10.reduce((s, r) => s + r.units, 0) + otherUnits);
  const other = { count: data.sku.other.count, units: otherUnits };

  const slices = useMemo(() => {
    const values = [...sortedTop10.map(s => s.units), other.units];
    return buildPieSlices(values, 6);
  }, [data]);

  const legend = [
    ...sortedTop10.map((s, i) => ({
      label: s.sku.toUpperCase(),
      units: s.units,
      pct: totalUnits > 0 ? (s.units / totalUnits) * 100 : 0,
      color: SKU_COLORS[i] || OTHER_COLOR,
      muted: false,
    })),
    {
      label: `Other (${other.count} SKU)`,
      units: other.units,
      pct: totalUnits > 0 ? (other.units / totalUnits) * 100 : 0,
      color: OTHER_COLOR,
      muted: true,
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
        <span style={{ fontSize: '13px', color: 'var(--fg-3)', textTransform: 'uppercase' }}>By SKU · retail only (units)</span>
        <span style={{ fontSize: '12px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{totalUnits.toLocaleString('ru-RU')} шт</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '220px' }}>
        <svg viewBox="-150 -90 300 180" width="100%" height="100%" style={{ overflow: 'visible' }}>
          {slices.map((s, i) => (
            <g key={i} transform={`translate(${s.dx.toFixed(2)},${s.dy.toFixed(2)})`}>
              <path
                d={`M 0,0 L ${s.sx.toFixed(2)},${s.sy.toFixed(2)} A ${s.rx},${s.ry} 0 ${s.largeArc},0 ${s.ex.toFixed(2)},${s.ey.toFixed(2)} Z`}
                fill={SKU_COLORS[i] || OTHER_COLOR}
                stroke="white"
                strokeWidth={1.5}
              />
            </g>
          ))}
        </svg>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11px', marginTop: '14px' }}>
        {legend.map((l, i) => (
          <div
            key={l.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '3px 0',
              borderTop: l.muted && i > 0 ? '0.5px solid var(--border-hairline)' : 'none',
              marginTop: l.muted ? '4px' : 0,
              paddingTop: l.muted ? '6px' : '3px',
            }}
          >
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: l.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontWeight: 700, color: l.muted ? 'var(--fg-3)' : 'var(--fg-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {l.label}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: l.muted ? 'var(--fg-3)' : 'var(--fg-1)', whiteSpace: 'nowrap' }}>
              {l.units.toLocaleString('ru-RU')} шт
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-3)', width: '38px', textAlign: 'right', whiteSpace: 'nowrap' }}>
              {l.pct.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtUsdShort(v: number): string {
  if (Math.abs(v) >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(v) >= 1_000)     return '$' + (v / 1_000).toFixed(1) + 'k';
  return '$' + v.toFixed(0);
}

function PartnerPie({ data }: { data: BreakdownData }) {
  const slices = useMemo(() => {
    return buildPieSlices(data.partners.items.map(p => p.revenue), 7);
  }, [data]);

  // Colors: explicit map for known partners; for the rest, walk PARTNER_PALETTE
  // in order so we never collapse into one gray block.
  let paletteIdx = 0;
  const colors = data.partners.items.map((p) => {
    if (p.id === '_other') return PARTNER_OTHER;
    if (PARTNER_COLORS[p.id]) return PARTNER_COLORS[p.id];
    const c = PARTNER_PALETTE[paletteIdx % PARTNER_PALETTE.length];
    paletteIdx++;
    return c;
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' }}>
        <span style={{ fontSize: '13px', color: 'var(--fg-3)', textTransform: 'uppercase' }}>By Partner (USD)</span>
        <span style={{ fontSize: '12px', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{fmtUsdShort(data.partners.total)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '220px' }}>
        <svg viewBox="-150 -90 300 180" width="100%" height="100%" style={{ overflow: 'visible' }}>
          {slices.map((s, i) => (
            <g key={i} transform={`translate(${s.dx.toFixed(2)},${s.dy.toFixed(2)})`}>
              <path
                d={`M 0,0 L ${s.sx.toFixed(2)},${s.sy.toFixed(2)} A ${s.rx},${s.ry} 0 ${s.largeArc},0 ${s.ex.toFixed(2)},${s.ey.toFixed(2)} Z`}
                fill={colors[i]}
                stroke="white"
                strokeWidth={2}
              />
            </g>
          ))}
        </svg>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11px', marginTop: '14px' }}>
        {data.partners.items.map((p, i) => {
          const muted = p.id === '_other';
          return (
          <div key={p.id} style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0',
            borderTop: muted ? '0.5px solid var(--border-hairline)' : 'none',
            marginTop:   muted ? '4px' : 0,
            paddingTop:  muted ? '6px' : '3px',
          }}>
            <span style={{ width: '10px', height: '10px', borderRadius: '2px', background: colors[i], flexShrink: 0 }} />
            <span style={{ flex: 1, fontWeight: 700, color: 'var(--fg-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {p.label}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--fg-1)', whiteSpace: 'nowrap' }}>
              {fmtUsdShort(p.revenue)}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-3)', width: '38px', textAlign: 'right', whiteSpace: 'nowrap' }}>
              {data.partners.total > 0 ? ((p.revenue / data.partners.total) * 100).toFixed(1) : '0.0'}%
            </span>
          </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY — Top & Bottom SKUs (not currently used, kept for reference) (toggle units/revenue, product names)
// ═══════════════════════════════════════════════════════════════════════════
type SortMode = 'units' | 'revenue';

function TopBottomCard({ data, loading }: { data: Spotlight | null; loading: boolean }) {
  const [sortMode, setSortMode] = useState<SortMode>('revenue');

  const sortedTop = useMemo(() => {
    if (!data) return [];
    return [...data.top].sort((a, b) => sortMode === 'units' ? b.units_sold - a.units_sold : b.revenue_rub - a.revenue_rub);
  }, [data, sortMode]);

  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', gridColumn: 'span 2' }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Package className="h-4 w-4" style={{ color: 'var(--fg-2)' }} />
          <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase' }}>
            Top &amp; Bottom SKUs
          </span>
        </div>
        <SortToggle value={sortMode} onChange={setSortMode} />
      </div>

      {loading ? <CardLoading /> : !data ? <CardEmpty>No data.</CardEmpty> : (
        <div className="grid grid-cols-2 gap-8">
          <div>
            <div style={{ fontSize: '14px', color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: '8px' }}>
              Top 5 movers
            </div>
            {sortedTop.map(row => (
              <TopRow key={row.base_sku} row={row} sortMode={sortMode} />
            ))}
          </div>

          <div>
            <div style={{ fontSize: '14px', color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: '8px' }}>
              Zero sales (catalog)
            </div>
            {data.bottom.length === 0 ? (
              <div style={{ fontSize: '14px', color: 'var(--fg-3)', padding: '8px 0' }}>
                Every catalog SKU sold something. Nice.
              </div>
            ) : (
              data.bottom.map(row => (
                <div key={row.base_sku} style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 0',
                  borderBottom: '1px solid var(--border-hairline)',
                  fontSize: '14px',
                }}>
                  <span>
                    <span style={{ fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase' }}>{row.base_sku.toUpperCase()}</span>
                    {row.product_name && (
                      <span style={{ color: 'var(--fg-3)', marginLeft: '8px' }}>{row.product_name}</span>
                    )}
                  </span>
                  <span style={{ color: '#A32D2D', fontWeight: 700 }}>0</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TopRow({ row, sortMode }: { row: Spotlight['top'][number]; sortMode: SortMode }) {
  const valueLabel = sortMode === 'units' ? `${row.units_sold} ед` : fmtRubCompact(row.revenue_rub) + ' ₽';
  const wbShare = row.units_sold > 0 ? (row.wb_units / row.units_sold) * 100 : 0;

  return (
    <div
      style={{
        display: 'block',
        width: '100%',
        padding: '10px 8px',
        margin: '0 -8px',
        borderBottom: '1px solid var(--border-hairline)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
        <span>
          <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase' }}>
            {row.base_sku.toUpperCase()}
          </span>
          {row.product_name && (
            <span style={{ fontSize: '14px', color: 'var(--fg-3)', marginLeft: '8px' }}>{row.product_name}</span>
          )}
        </span>
        <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>{valueLabel}</span>
      </div>
      <div style={{ display: 'flex', height: '6px', borderRadius: '3px', overflow: 'hidden', backgroundColor: 'var(--paper-sunk)' }}>
        <div style={{ width: `${wbShare}%`, backgroundColor: COLOR_WB }} title={`WB ${row.wb_units} ед`} />
        <div style={{ width: `${100 - wbShare}%`, backgroundColor: COLOR_OZON }} title={`Ozon ${row.ozon_units} ед`} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
        <span>WB {row.wb_units}</span>
        <span>Ozon {row.ozon_units}</span>
      </div>
    </div>
  );
}

function SortToggle({ value, onChange }: { value: SortMode; onChange: (m: SortMode) => void }) {
  return (
    <div style={{ display: 'inline-flex', backgroundColor: 'var(--paper-sunk)', borderRadius: 'var(--radius-pill)', padding: '2px', border: '1px solid var(--border-hairline)' }}>
      {(['revenue', 'units'] as SortMode[]).map(m => (
        <button
          key={m}
          onClick={() => onChange(m)}
          style={{
            padding: '4px 12px',
            fontSize: '14px',
            fontWeight: 700,
            border: 'none',
            borderRadius: 'var(--radius-pill)',
            backgroundColor: value === m ? 'var(--paper)' : 'transparent',
            color: value === m ? 'var(--fg-1)' : 'var(--fg-3)',
            cursor: 'pointer',
            boxShadow: value === m ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
            transition: 'all 80ms ease',
          }}
        >
          {m === 'revenue' ? 'by revenue' : 'by units'}
        </button>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Card 9 — SKU funnel modal (polished)
// ═══════════════════════════════════════════════════════════════════════════
function SkuFunnelModal({ sku, onClose }: { sku: string; onClose: () => void }) {
  const [funnel, setFunnel] = useState<SkuFunnel | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<SkuFunnel>(`/api/marketplaces/pulse/sku-funnel/${encodeURIComponent(sku)}`).then(d => {
      setFunnel(d); setLoading(false);
    });
  }, [sku]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: '20px',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--paper)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          maxWidth: '760px',
          width: '100%',
          maxHeight: '85vh',
          overflow: 'auto',
          padding: '28px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
        }}
      >
        <div className="flex items-start justify-between mb-6">
          <div>
            <div style={{ fontSize: '14px', color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: '4px' }}>
              Conversion funnel
            </div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 700, color: 'var(--fg-1)', lineHeight: 1.1 }}>
              {sku.toUpperCase()}
            </h2>
            {funnel?.product_name && (
              <p style={{ fontSize: '16px', color: 'var(--fg-2)', marginTop: '4px' }}>{funnel.product_name}</p>
            )}
            {funnel?.period.from && (
              <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '6px' }}>
                {funnel.period.from} → {funnel.period.to}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px', color: 'var(--fg-3)' }}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading ? <CardLoading /> : !funnel ? <CardEmpty>No funnel data for this SKU.</CardEmpty> : (
          <>
            <div style={{
              backgroundColor: 'var(--paper-sunk)',
              borderRadius: 'var(--radius-md)',
              padding: '16px',
              marginBottom: '24px',
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '16px',
            }}>
              <FunnelStat label="Views" value={funnel.combined.views} />
              <FunnelStat label="In cart" value={funnel.combined.cart} />
              <FunnelStat label="Orders" value={funnel.combined.orders} />
              <FunnelStat label="Revenue" value={funnel.combined.revenue_rub} format="rub" />
            </div>

            <div className="grid grid-cols-2 gap-6">
              <FunnelColumn label="Wildberries" data={funnel.wb} color={COLOR_WB} colorLight={COLOR_WB_LIGHT} />
              <FunnelColumn label="Ozon"        data={funnel.ozon} color={COLOR_OZON} colorLight={COLOR_OZON_LIGHT} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FunnelStat({ label, value, format }: { label: string; value: number; format?: 'rub' }) {
  return (
    <div>
      <div style={{ fontSize: '14px', color: 'var(--fg-3)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)', marginTop: '2px' }}>
        {format === 'rub' ? fmtRubFull(value) : new Intl.NumberFormat('ru-RU').format(value)}
      </div>
    </div>
  );
}

function FunnelColumn({ label, data, color, colorLight }: { label: string; data: { views: number; cart: number; orders: number; revenue_rub: number } | null; color: string; colorLight: string }) {
  if (!data || (data.views === 0 && data.cart === 0 && data.orders === 0)) {
    return (
      <div>
        <div style={{ fontSize: '14px', fontWeight: 700, color, textTransform: 'uppercase', marginBottom: '12px' }}>{label}</div>
        <div style={{
          padding: '20px',
          backgroundColor: 'var(--paper-sunk)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '14px',
          color: 'var(--fg-3)',
          textAlign: 'center',
        }}>
          {!data ? 'Not listed on this marketplace' : 'API did not return funnel events'}
        </div>
      </div>
    );
  }

  const viewsToCart = data.views > 0 ? (data.cart / data.views) * 100 : 0;
  const cartToOrder = data.cart > 0 ? (data.orders / data.cart) * 100 : 0;
  const overall = data.views > 0 ? (data.orders / data.views) * 100 : 0;
  const maxBar = Math.max(data.views, data.cart, data.orders, 1);

  return (
    <div>
      <div style={{ fontSize: '14px', fontWeight: 700, color, textTransform: 'uppercase', marginBottom: '12px' }}>{label}</div>

      <FunnelBar label="Views"   count={data.views}  pct={(data.views  / maxBar) * 100} color={color} />
      <FunnelArrow conv={viewsToCart} note="add to cart" />
      <FunnelBar label="In cart" count={data.cart}   pct={(data.cart   / maxBar) * 100} color={color} opacity={0.7} />
      <FunnelArrow conv={cartToOrder} note="checkout" />
      <FunnelBar label="Orders"  count={data.orders} pct={(data.orders / maxBar) * 100} color={colorLight} />

      <div style={{
        marginTop: '14px',
        padding: '12px',
        backgroundColor: 'var(--paper-sunk)',
        borderRadius: 'var(--radius-sm)',
        fontSize: '14px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
          <span style={{ color: 'var(--fg-3)' }}>View → buy</span>
          <span style={{ fontWeight: 700, color: overall >= 1.5 ? '#3B6D11' : overall >= 0.8 ? 'var(--fg-1)' : '#A32D2D' }}>
            {overall.toFixed(2)}%
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--fg-3)' }}>Revenue</span>
          <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{fmtRubFull(data.revenue_rub)}</span>
        </div>
      </div>
    </div>
  );
}

function FunnelBar({ label, count, pct, color, opacity = 1 }: { label: string; count: number; pct: number; color: string; opacity?: number }) {
  return (
    <div style={{ marginBottom: '6px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', marginBottom: '4px' }}>
        <span style={{ color: 'var(--fg-2)' }}>{label}</span>
        <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{new Intl.NumberFormat('ru-RU').format(count)}</span>
      </div>
      <div style={{ height: '22px', backgroundColor: 'var(--paper-sunk)', borderRadius: 'var(--radius-xs)', overflow: 'hidden' }}>
        <div style={{
          width: `${Math.max(pct, 1)}%`,
          height: '100%',
          backgroundColor: color,
          opacity,
          borderRadius: 'var(--radius-xs)',
        }} />
      </div>
    </div>
  );
}

function FunnelArrow({ conv, note }: { conv: number; note: string }) {
  return (
    <div style={{ textAlign: 'center', fontSize: '14px', color: 'var(--fg-3)', padding: '4px 0' }}>
      ↓ <span style={{ fontWeight: 700, color: 'var(--fg-2)' }}>{conv.toFixed(1)}%</span> · {note}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared atoms
// ═══════════════════════════════════════════════════════════════════════════
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
      {children}
    </div>
  );
}

function CardHeader({ icon, title, subtitle }: { icon?: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        {icon && <span style={{ color: 'var(--fg-2)' }}>{icon}</span>}
        <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase' }}>{title}</span>
      </div>
      {subtitle && <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{subtitle}</span>}
    </div>
  );
}

function CardLoading() {
  return <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--fg-3)' }} /></div>;
}

function CardEmpty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: '14px', color: 'var(--fg-3)', padding: '12px 0' }}>{children}</div>;
}

function DeltaPill({ tone, children }: { tone: 'up' | 'down' | 'flat'; children: React.ReactNode }) {
  const styles = {
    up:   { bg: '#EAF3DE', fg: '#3B6D11' },
    down: { bg: '#FCEBEB', fg: '#A32D2D' },
    flat: { bg: 'var(--paper-sunk)', fg: 'var(--fg-3)' },
  }[tone];
  return (
    <span style={{
      display: 'inline-block',
      marginLeft: '8px',
      fontSize: '14px',
      fontWeight: 700,
      padding: '2px 8px',
      borderRadius: 'var(--radius-pill)',
      backgroundColor: styles.bg,
      color: styles.fg,
    }}>{children}</span>
  );
}




// ═══════════════════════════════════════════════════════════════════════════
// Sparkline with hover — finds nearest point under cursor and shows tooltip
// ═══════════════════════════════════════════════════════════════════════════
type SparkRaw = { date: string; revenue_rub: number; ozon_revenue_rub?: number; wb_revenue_rub?: number; site_revenue_rub?: number; units?: number };

function SparklineWithHover({
  chart,
  onHoverChange,
}: {
  chart: {
    series: SparkRaw[];
    combinedPts: { x: number; y: number; value: number; date: string; raw: SparkRaw }[];
    ozonPts:     { x: number; y: number; value: number; date: string; raw: SparkRaw }[];
    wbPts:       { x: number; y: number; value: number; date: string; raw: SparkRaw }[];
    sitePts:     { x: number; y: number; value: number; date: string; raw: SparkRaw }[];
    combinedPath: string;
    ozonPath:     string;
    wbPath:       string;
    sitePath:     string;
    combinedArea: string;
    width: number;
    height: number;
  };
  onHoverChange?: (idx: number | null) => void;
}) {
  const { series, combinedPts, ozonPts, wbPts, sitePts, combinedPath, ozonPath, wbPath, sitePath, combinedArea, width: viewWidth, height: viewHeight } = chart;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Y-axis: derive max from all values to label the gridlines (300k / 225k / 150k / 75k / 0 style)
  const yMax = useMemo(() => {
    let m = 0;
    for (const d of series) {
      if (d.revenue_rub > m) m = d.revenue_rub;
      if (typeof d.ozon_revenue_rub === 'number' && d.ozon_revenue_rub > m) m = d.ozon_revenue_rub;
      if (typeof d.wb_revenue_rub === 'number' && d.wb_revenue_rub > m) m = d.wb_revenue_rub;
    }
    return m;
  }, [series]);

  function fmtAxis(v: number): string {
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1) + 'M';
    if (v >= 1_000)     return Math.round(v / 1_000) + 'k';
    return String(Math.round(v));
  }
  const axisLabels = [yMax, yMax * 0.75, yMax * 0.5, yMax * 0.25, 0];

  // Grid line Y coordinates inside the viewBox (matches chart's pad=6, height=180)
  const pad = 6;
  const innerH = viewHeight - pad * 2;
  const gridY = [pad, pad + innerH * 0.25, pad + innerH * 0.5, pad + innerH * 0.75, pad + innerH];

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const vbX = (localX / rect.width) * viewWidth;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < combinedPts.length; i++) {
      const d = Math.abs(combinedPts[i]!.x - vbX);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx !== hoverIdx) {
      setHoverIdx(bestIdx);
      onHoverChange?.(bestIdx);
    }
  }

  function handleLeave() {
    setHoverIdx(null);
    onHoverChange?.(null);
  }

  const hoveredCombinedPt = hoverIdx !== null ? combinedPts[hoverIdx] : null;
  const hoveredOzonPt     = hoverIdx !== null ? ozonPts[hoverIdx]     : null;
  const hoveredWbPt       = hoverIdx !== null ? wbPts[hoverIdx]       : null;
  const hoveredSitePt     = hoverIdx !== null ? sitePts[hoverIdx]     : null;

  return (
    <div style={{ marginBottom: '4px' }}>
      <div style={{ display: 'flex', gap: '8px' }}>
        {/* Y-axis labels column */}
        <div style={{ width: '48px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                      fontSize: '14px', color: 'var(--fg-muted)', textAlign: 'right',
                      height: `${viewHeight}px`, paddingTop: '0px', paddingBottom: '0px' }}>
          {axisLabels.map((v, i) => (<span key={i}>{fmtAxis(v)}</span>))}
        </div>

        {/* Chart SVG */}
        <div ref={wrapRef} style={{ flex: 1, position: 'relative', cursor: 'crosshair' }}
             onMouseMove={handleMove}
             onMouseLeave={handleLeave}>
          <svg width="100%" height={viewHeight} viewBox={`0 0 ${viewWidth} ${viewHeight}`}
               preserveAspectRatio="none" style={{ display: 'block' }}>
            {/* Y grid */}
            {gridY.map((y, i) => (
              <line key={i} x1={0} y1={y} x2={viewWidth} y2={y}
                    stroke="var(--border-hairline)" strokeWidth="0.5"
                    strokeDasharray={i === gridY.length - 1 ? undefined : "2 3"} />
            ))}

            {/* Combined area + lines */}
            <path d={combinedArea} fill={COLOR_COMBINED} fillOpacity="0.10" />
            <path d={ozonPath}     fill="none" stroke={COLOR_OZON}     strokeWidth="1.4" opacity="0.9" />
            <path d={wbPath}       fill="none" stroke={COLOR_WB}       strokeWidth="1.4" opacity="0.9" />
            <path d={sitePath}     fill="none" stroke={COLOR_SITE}     strokeWidth="1.4" opacity="0.9" />
            <path d={combinedPath} fill="none" stroke={COLOR_COMBINED} strokeWidth="1.8" />

            {/* Last-day marker dots (when no hover) */}
            {hoverIdx === null && combinedPts.length > 0 && (
              <>
                <circle cx={combinedPts[combinedPts.length - 1]!.x} cy={combinedPts[combinedPts.length - 1]!.y} r="3.2" fill={COLOR_COMBINED} />
                <circle cx={ozonPts[ozonPts.length - 1]!.x}         cy={ozonPts[ozonPts.length - 1]!.y}         r="2.8" fill={COLOR_OZON} />
                <circle cx={wbPts[wbPts.length - 1]!.x}             cy={wbPts[wbPts.length - 1]!.y}             r="2.8" fill={COLOR_WB} />
                <circle cx={sitePts[sitePts.length - 1]!.x}         cy={sitePts[sitePts.length - 1]!.y}         r="2.8" fill={COLOR_SITE} />
              </>
            )}

            {/* Hover cursor */}
            {hoveredCombinedPt && (
              <>
                <line x1={hoveredCombinedPt.x} y1={pad} x2={hoveredCombinedPt.x} y2={viewHeight - pad}
                      stroke="var(--fg-muted)" strokeWidth="1" strokeDasharray="2,2" opacity="0.6" />
                {hoveredOzonPt && <circle cx={hoveredOzonPt.x} cy={hoveredOzonPt.y} r="3.2" fill={COLOR_OZON} stroke="var(--paper)" strokeWidth="1.5" />}
                {hoveredWbPt   && <circle cx={hoveredWbPt.x}   cy={hoveredWbPt.y}   r="3.2" fill={COLOR_WB}   stroke="var(--paper)" strokeWidth="1.5" />}
                {hoveredSitePt && <circle cx={hoveredSitePt.x} cy={hoveredSitePt.y} r="3.2" fill={COLOR_SITE} stroke="var(--paper)" strokeWidth="1.5" />}
                <circle cx={hoveredCombinedPt.x} cy={hoveredCombinedPt.y} r="3.6" fill={COLOR_COMBINED} stroke="var(--paper)" strokeWidth="1.5" />
              </>
            )}
          </svg>
        </div>
      </div>

      {/* X axis labels: spread evenly under chart, aligned with Y column */}
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    fontSize: '14px', color: 'var(--fg-muted)',
                    marginTop: '6px', paddingLeft: '56px' }}>
        {series.map((d, i) => {
          // Show 1st, last, and a few in between to avoid clutter on long series
          const showCount = Math.min(series.length, 7);
          const step = (series.length - 1) / (showCount - 1);
          const shouldShow = i === 0 || i === series.length - 1 ||
                             Math.abs(i - Math.round(Math.round(i / step) * step)) < 0.5;
          return shouldShow
            ? <span key={i}>{fmtDayMonth(d.date)}</span>
            : <span key={i} />;
        })}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '20px',
                    fontSize: '14px', color: 'var(--fg-3)', marginTop: '10px', paddingLeft: '56px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '16px', height: '2px', backgroundColor: COLOR_COMBINED, display: 'inline-block' }} />
          Combined
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '16px', height: '2px', backgroundColor: COLOR_OZON, display: 'inline-block' }} />
          Ozon
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '16px', height: '2px', backgroundColor: COLOR_WB, display: 'inline-block' }} />
          Wildberries
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: '16px', height: '2px', backgroundColor: COLOR_SITE, display: 'inline-block' }} />
          dasexperten.ru
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 30-day trend bars with floating tooltip on hover
// ═══════════════════════════════════════════════════════════════════════════
function TrendBars({
  data,
  chart,
}: {
  data: DailyTrend;
  chart: { maxTotal: number; totalRange: number } | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      if (containerRef.current) setWidth(containerRef.current.offsetWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const hovered = hover ? data.days[hover.idx] : null;

  return (
    <div ref={containerRef} style={{ position: 'relative', marginBottom: '12px' }}>
      {/* Bars — gap shrinks for dense (30-day) charts */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: data.days.length > 14 ? '3px' : '8px', height: '120px', marginBottom: '8px' }}>
        {data.days.map((d, i) => {
          const total = d.ozon.revenue_rub + d.wb.revenue_rub + d.site.revenue_rub;
          const totalH = chart ? (total / chart.maxTotal) * 100 : 0;
          const ozH = total > 0 ? (d.ozon.revenue_rub / total) * 100 : 0;
          const wbH = total > 0 ? (d.wb.revenue_rub   / total) * 100 : 0;
          const siteH = total > 0 ? 100 - ozH - wbH : 0;
          const isLast = i === data.days.length - 1;
          const isHover = hover?.idx === i;
          return (
            <div
              key={d.date}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget.parentElement!.parentElement as HTMLElement).getBoundingClientRect();
                const cx = e.currentTarget.getBoundingClientRect();
                setHover({ idx: i, x: cx.left + cx.width / 2 - rect.left, y: 0 });
              }}
              onMouseMove={(e) => {
                if (!containerRef.current) return;
                const rect = containerRef.current.getBoundingClientRect();
                setHover({ idx: i, x: e.clientX - rect.left, y: e.clientY - rect.top });
              }}
              onMouseLeave={() => setHover(null)}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-end',
                height: '100%',
                minWidth: 0,
                cursor: 'crosshair',
              }}
            >
              <div style={{
                width: '100%',
                height: `${totalH}%`,
                minHeight: total > 0 ? '4px' : '0',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: '3px 3px 0 0',
                overflow: 'hidden',
                transition: 'opacity 80ms ease-out',
                opacity: !hover ? (isLast ? 1 : 0.85) : (isHover ? 1 : 0.45),
              }}>
                <div style={{ height: `${ozH}%`, backgroundColor: COLOR_OZON }} />
                <div style={{ height: `${wbH}%`, backgroundColor: COLOR_WB }} />
                <div style={{ height: `${siteH}%`, backgroundColor: COLOR_SITE }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* X-axis labels — on 30-day chart we only show every 5th label + first + last + hovered */}
      <div style={{ display: 'flex', gap: data.days.length > 14 ? '3px' : '8px' }}>
        {data.days.map((d, i) => {
          const isHover = hover?.idx === i;
          const isLast = i === data.days.length - 1;
          const isFirst = i === 0;
          const showLabel = data.days.length <= 10 || isFirst || isLast || isHover || (i % 5 === 0);
          return (
            <div
              key={d.date}
              style={{
                flex: 1,
                textAlign: 'center',
                fontSize: '14px',
                color: isHover ? 'var(--fg-1)' : 'var(--fg-3)',
                fontWeight: isHover ? 700 : 400,
                minWidth: 0,
                transition: 'color 80ms ease-out',
              }}
            >
              {showLabel ? (
                <>
                  <div style={{ fontWeight: 700 }}>{fmtWeekday(d.date)}</div>
                  <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{d.date.slice(8)}</div>
                </>
              ) : (
                <>&nbsp;</>
              )}
            </div>
          );
        })}
      </div>

      <FloatingTooltip visible={!!hover} x={hover?.x ?? 0} y={hover?.y ?? 0} containerWidth={width}>
        {hovered && (
          <>
            <div style={{ fontWeight: 700, marginBottom: '6px' }}>
              {fmtWeekday(hovered.date)} · {fmtDayMonth(hovered.date)}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ color: COLOR_OZON, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: COLOR_OZON }} />
                Ozon
              </span>
              <span style={{ fontWeight: 700 }}>{fmtRubFull(hovered.ozon.revenue_rub)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px', color: 'var(--fg-3)' }}>
              <span></span><span>{hovered.ozon.units} ед</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginTop: '4px' }}>
              <span style={{ color: COLOR_WB, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: COLOR_WB }} />
                WB
              </span>
              <span style={{ fontWeight: 700 }}>{fmtRubFull(hovered.wb.revenue_rub)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px', color: 'var(--fg-3)' }}>
              <span></span><span>{hovered.wb.units} ед</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginTop: '4px' }}>
              <span style={{ color: COLOR_SITE, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: COLOR_SITE }} />
                Site
              </span>
              <span style={{ fontWeight: 700 }}>{fmtRubFull(hovered.site.revenue_rub)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px', color: 'var(--fg-3)' }}>
              <span></span><span>{hovered.site.units} ед</span>
            </div>
            <div style={{ borderTop: '1px solid var(--border-hairline)', marginTop: '6px', paddingTop: '6px', display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-2)' }}>Total</span>
              <span style={{ fontWeight: 700 }}>{fmtRubFull(hovered.ozon.revenue_rub + hovered.wb.revenue_rub + hovered.site.revenue_rub)}</span>
            </div>
          </>
        )}
      </FloatingTooltip>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Floating tooltip used by both Sales sparkline and 30-day trend
// ═══════════════════════════════════════════════════════════════════════════
function FloatingTooltip({
  visible,
  x,
  y,
  containerWidth,
  children,
}: {
  visible: boolean;
  x: number;
  y: number;
  containerWidth: number;
  children: React.ReactNode;
}) {
  // Flip horizontally if too close to right edge
  const tooltipMaxWidth = 220;
  const flipRight = x + tooltipMaxWidth + 16 > containerWidth;
  return (
    <div
      style={{
        position: 'absolute',
        left: flipRight ? undefined : x + 12,
        right: flipRight ? containerWidth - x + 12 : undefined,
        // Anchor TOP-edge of tooltip below the cursor → tooltip always grows DOWNward,
        // never covers the chart above the cursor.
        top: y + 14,
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 80ms ease-out',
        zIndex: 50,
        backgroundColor: 'rgba(252, 250, 245, 0.30)',
        backdropFilter: 'blur(10px) saturate(140%)',
        WebkitBackdropFilter: 'blur(10px) saturate(140%)',
        border: '1px solid rgba(0,0,0,0.06)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.10)',
        padding: '10px 12px',
        fontSize: '14px',
        color: 'var(--fg-1)',
        minWidth: '180px',
        maxWidth: `${tooltipMaxWidth}px`,
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

