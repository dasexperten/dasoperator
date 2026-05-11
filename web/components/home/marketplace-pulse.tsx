'use client';

// =============================================================================
// Marketplace Pulse — Home dashboard section · Phase 9.x polish pass
// 4 cards backed by /api/marketplaces/pulse/*:
//   1. Sales today           — hero number + WB/Ozon split + 14-day spark
//   6. 7-day trend           — stacked bar chart (Ozon=blue, WB=purple)
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

// ───────────────────────── Types ─────────────────────────
type SalesToday = {
  ozon: { revenue_rub: number; units: number; delta_pct: number | null; last_date: string | null };
  wb:   { revenue_rub: number; units: number; delta_pct: number | null; last_date: string | null };
  combined: { revenue_rub: number; units: number };
  spark: Array<{ date: string; revenue_rub: number }>;
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
  }>;
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
async function fetchJson<T>(path: string): Promise<T | null> {
  try {
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

  useEffect(() => {
    Promise.all([
      fetchJson<SalesToday>('/api/marketplaces/pulse/sales-today'),
      fetchJson<Spotlight>('/api/marketplaces/pulse/sku-spotlight'),
      fetchJson<DailyTrend>('/api/marketplaces/pulse/daily-trend'),
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
        <SalesTodayCard data={salesToday} loading={loading} />
        <TrendCard data={trend} loading={loading} />
        <TopBottomCard data={spotlight} loading={loading} />
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
function SalesTodayCard({ data, loading }: { data: SalesToday | null; loading: boolean }) {
  const sparkPoints = useMemo(() => {
    if (!data?.spark || data.spark.length < 2) return [];
    const max = Math.max(...data.spark.map(d => d.revenue_rub));
    const min = Math.min(...data.spark.map(d => d.revenue_rub));
    const range = max - min || 1;
    const width = 280, height = 36;
    return data.spark.map((d, i) => {
      const x = (i / Math.max(data.spark.length - 1, 1)) * width;
      const y = height - ((d.revenue_rub - min) / range) * (height - 4) - 2;
      return { x, y, value: d.revenue_rub, date: d.date };
    });
  }, [data]);

  const sparkPath = sparkPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const sparkArea = sparkPoints.length > 0
    ? `${sparkPath} L ${sparkPoints[sparkPoints.length - 1]!.x.toFixed(1)} 38 L 0 38 Z`
    : '';

  return (
    <Card>
      <CardHeader icon={<ShoppingBag className="h-4 w-4" />} title="Sales · last day on record" subtitle={data?.ozon.last_date ?? undefined} />

      {loading ? <CardLoading /> : !data ? <CardEmpty>No data yet — cron may not have run.</CardEmpty> : (
        <>
          <div style={{ marginBottom: '14px' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 700, color: 'var(--fg-1)', lineHeight: 1.1 }}>
              {fmtRubFull(data.combined.revenue_rub)}
            </div>
            <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '2px' }}>
              {data.combined.units} ед · combined WB + Ozon
            </div>
          </div>

          {sparkPoints.length >= 2 && data.spark[0] && data.spark[data.spark.length - 1] && (
            <SparklineWithHover
              points={sparkPoints}
              area={sparkArea}
              path={sparkPath}
              spark={data.spark}
            />
          )}

          <div style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: '10px' }}>
            <SplitRow label="Wildberries" amount={data.wb.revenue_rub} units={data.wb.units} delta={data.wb.delta_pct} color={COLOR_WB} />
            <SplitRow label="Ozon"        amount={data.ozon.revenue_rub} units={data.ozon.units} delta={data.ozon.delta_pct} color={COLOR_OZON} />
          </div>
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
// Card 6 — 7-day trend (stacked bar chart with axis labels)
// ═══════════════════════════════════════════════════════════════════════════
function TrendCard({ data, loading }: { data: DailyTrend | null; loading: boolean }) {
  const chart = useMemo(() => {
    if (!data || data.days.length === 0) return null;
    const maxTotal = Math.max(...data.days.map(d => d.ozon.revenue_rub + d.wb.revenue_rub));
    const totalWeek = data.days.reduce((s, d) => s + d.ozon.revenue_rub + d.wb.revenue_rub, 0);
    return { maxTotal, totalWeek };
  }, [data]);

  return (
    <Card>
      <CardHeader icon={<BarChart3 className="h-4 w-4" />} title="7-day trend" subtitle={chart ? `Σ ${fmtRubFull(chart.totalWeek)}` : undefined} />

      {loading ? <CardLoading /> : !data || data.days.length === 0 ? <CardEmpty>No daily snapshots yet.</CardEmpty> : (
        <>
          <TrendBars data={data} chart={chart} />

          {/* Last day deltas */}
          {data.days.length > 0 && (() => {
            const last = data.days[data.days.length - 1]!;
            const ozDp = fmtPct(last.ozon.delta_pct);
            const wbDp = fmtPct(last.wb.delta_pct);
            return (
              <div style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: '10px' }}>
                <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginBottom: '6px' }}>
                  {fmtDayMonth(last.date)} · vs same weekday last week
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '14px' }}>
                  <span style={{ color: COLOR_OZON, fontWeight: 700 }}>
                    Ozon {fmtRubCompact(last.ozon.revenue_rub)}
                    {ozDp.tone !== 'na' && <DeltaPill tone={ozDp.tone}>{ozDp.text}</DeltaPill>}
                  </span>
                  <span style={{ color: COLOR_WB, fontWeight: 700 }}>
                    WB {fmtRubCompact(last.wb.revenue_rub)}
                    {wbDp.tone !== 'na' && <DeltaPill tone={wbDp.tone}>{wbDp.text}</DeltaPill>}
                  </span>
                </div>
                {!data.history_complete && (
                  <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '8px' }}>
                    Δ vs last week populates once we have 14d of history (currently {data.days_available}d)
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
// Card 3 — Top & Bottom SKUs (toggle units/revenue, product names)
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
function SparklineWithHover({
  points,
  area,
  path,
  spark,
}: {
  points: { x: number; y: number; value: number; date: string }[];
  area: string;
  path: string;
  spark: { date: string; revenue_rub: number; ozon_revenue_rub?: number; wb_revenue_rub?: number; units?: number }[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!wrapRef.current) return;
    const update = () => { if (wrapRef.current) setWidth(wrapRef.current.offsetWidth); };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const hovered = hover ? spark[hover.idx] : null;
  const hoveredPoint = hover ? points[hover.idx] : null;

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    // Map localX (0..rect.width) to viewBox X (0..280) to find nearest point
    const vbX = (localX / rect.width) * 280;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i]!.x - vbX);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    setHover({ idx: bestIdx, x: localX, y: localY });
  }

  return (
    <div style={{ marginBottom: '12px', position: 'relative' }} ref={wrapRef}
         onMouseMove={handleMove}
         onMouseLeave={() => setHover(null)}>
      <svg width="100%" height="40" viewBox="0 0 280 40" preserveAspectRatio="none" style={{ display: 'block', cursor: 'crosshair' }}>
        <path d={area} fill={COLOR_OZON} fillOpacity="0.08" />
        <path d={path} fill="none" stroke={COLOR_OZON} strokeWidth="1.5" />
        <circle cx={points[points.length - 1]!.x} cy={points[points.length - 1]!.y} r="2.5" fill={COLOR_OZON} />
        {hoveredPoint && (
          <>
            <line x1={hoveredPoint.x} y1={0} x2={hoveredPoint.x} y2={40}
                  stroke="var(--fg-muted)" strokeWidth="1" strokeDasharray="2,2" opacity="0.6" />
            <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r="3.5" fill={COLOR_OZON} stroke="var(--paper)" strokeWidth="1.5" />
          </>
        )}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
        <span>{fmtDayMonth(spark[0]!.date)}</span>
        <span style={{ color: 'var(--fg-2)', fontWeight: 700 }}>{spark.length}-day combined revenue</span>
        <span>{fmtDayMonth(spark[spark.length - 1]!.date)}</span>
      </div>
      <FloatingTooltip visible={!!hover} x={hover?.x ?? 0} y={hover?.y ?? 0} containerWidth={width}>
        {hovered && (
          <>
            <div style={{ fontWeight: 700, marginBottom: '4px' }}>{fmtWeekday(hovered.date)} · {fmtDayMonth(hovered.date)}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
              <span style={{ color: 'var(--fg-2)' }}>Combined</span>
              <span style={{ fontWeight: 700 }}>{fmtRubFull(hovered.revenue_rub)}</span>
            </div>
            {typeof hovered.ozon_revenue_rub === 'number' && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
                <span style={{ color: COLOR_OZON, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: COLOR_OZON }} />
                  Ozon
                </span>
                <span>{fmtRubFull(hovered.ozon_revenue_rub)}</span>
              </div>
            )}
            {typeof hovered.wb_revenue_rub === 'number' && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px' }}>
                <span style={{ color: COLOR_WB, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: COLOR_WB }} />
                  WB
                </span>
                <span>{fmtRubFull(hovered.wb_revenue_rub)}</span>
              </div>
            )}
            {typeof hovered.units === 'number' && (
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '13px', color: 'var(--fg-3)', marginTop: '4px' }}>
                <span>Units</span>
                <span>{hovered.units} ед</span>
              </div>
            )}
          </>
        )}
      </FloatingTooltip>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 7-day trend bars with floating tooltip on hover
// ═══════════════════════════════════════════════════════════════════════════
function TrendBars({
  data,
  chart,
}: {
  data: DailyTrend;
  chart: { maxTotal: number; totalWeek: number } | null;
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
      {/* Bars */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', height: '120px', marginBottom: '8px' }}>
        {data.days.map((d, i) => {
          const total = d.ozon.revenue_rub + d.wb.revenue_rub;
          const totalH = chart ? (total / chart.maxTotal) * 100 : 0;
          const ozH = total > 0 ? (d.ozon.revenue_rub / total) * 100 : 0;
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
                <div style={{ height: `${100 - ozH}%`, backgroundColor: COLOR_WB }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* X-axis labels */}
      <div style={{ display: 'flex', gap: '8px' }}>
        {data.days.map((d, i) => {
          const isHover = hover?.idx === i;
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
              <div style={{ fontWeight: 700 }}>{fmtWeekday(d.date)}</div>
              <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{d.date.slice(8)}</div>
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
            <div style={{ borderTop: '1px solid var(--border-hairline)', marginTop: '6px', paddingTop: '6px', display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-2)' }}>Total</span>
              <span style={{ fontWeight: 700 }}>{fmtRubFull(hovered.ozon.revenue_rub + hovered.wb.revenue_rub)}</span>
            </div>
          </>
        )}
      </FloatingTooltip>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Floating tooltip used by both Sales sparkline and 7-day trend
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
        top: Math.max(y - 8, 4),
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 80ms ease-out',
        zIndex: 50,
        backgroundColor: 'var(--paper)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
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

