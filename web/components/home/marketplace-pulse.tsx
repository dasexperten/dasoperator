'use client';

// =============================================================================
// Marketplace Pulse — Home dashboard section
// Phase 9.x — 4 cards backed by /api/marketplaces/pulse/*
//   1. Sales today    — combined today's revenue + Δ vs yesterday
//   3. Top & bottom   — top 5 movers (clickable → funnel modal) + bottom 5 dead SKUs
//   6. 7-day trend    — Ozon (blue) vs WB (purple), per-day Δ vs same weekday last week
//   9. SKU funnel     — modal popped when user clicks a top-SKU row
// =============================================================================

import { useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';

// Brand-locked: Ozon = BLUE, WB = PURPLE (per Aram)
const COLOR_OZON = '#185FA5';
const COLOR_WB = '#534AB7';

type SalesToday = {
  ozon: { revenue_rub: number; units: number; delta_pct: number | null; last_date: string | null };
  wb:   { revenue_rub: number; units: number; delta_pct: number | null; last_date: string | null };
  combined: { revenue_rub: number; units: number };
};

type Spotlight = {
  period: { from: string | null; to: string | null };
  synced_at: number | null;
  top: Array<{ base_sku: string; units_sold: number; revenue_rub: number; ozon_units: number; wb_units: number }>;
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

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`);
    const json = await res.json() as { success: boolean; result: T };
    return json.success ? json.result : null;
  } catch {
    return null;
  }
}

function fmtRub(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(0)}k`;
  return amount.toString();
}

function fmtRubFull(amount: number): string {
  // amount is already in rubles (not minor units in this DB) — format with thin spaces
  return new Intl.NumberFormat('ru-RU').format(amount) + ' ₽';
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

export default function MarketplacePulse() {
  const [salesToday, setSalesToday] = useState<SalesToday | null>(null);
  const [spotlight, setSpotlight] = useState<Spotlight | null>(null);
  const [trend, setTrend] = useState<DailyTrend | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSku, setActiveSku] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchJson<SalesToday>('/api/marketplaces/pulse/sales-today'),
      fetchJson<Spotlight>('/api/marketplaces/pulse/sku-spotlight'),
      fetchJson<DailyTrend>('/api/marketplaces/pulse/daily-trend'),
    ]).then(([s, sp, t]) => {
      setSalesToday(s);
      setSpotlight(sp);
      setTrend(t);
      setLoading(false);
    });
  }, []);

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '20px',
          fontWeight: 700,
          color: 'var(--fg-1)',
          textTransform: 'uppercase',
        }}>
          Marketplace Pulse
        </h2>
        {spotlight?.period.from && (
          <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
            {spotlight.period.from} — {spotlight.period.to}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <SalesTodayCard data={salesToday} loading={loading} />
        <TrendCard data={trend} loading={loading} />
        <TopBottomCard data={spotlight} loading={loading} onSkuClick={setActiveSku} />
        <div /> {/* placeholder — funnel pops as modal, not a static card */}
      </div>

      {activeSku && (
        <SkuFunnelModal sku={activeSku} onClose={() => setActiveSku(null)} />
      )}
    </section>
  );
}

// ===========================================================================
// Card 1 — Sales today
// ===========================================================================
function SalesTodayCard({ data, loading }: { data: SalesToday | null; loading: boolean }) {
  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ fontSize: '14px', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0', marginBottom: '12px' }}>
        Sales today {data?.ozon.last_date && <span style={{ textTransform: 'none' }}>· {data.ozon.last_date}</span>}
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--fg-3)' }} /></div>
      ) : !data ? (
        <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>No data yet — cron may not have run.</div>
      ) : (
        <>
          <SalesRow label="Wildberries" amount={data.wb.revenue_rub} units={data.wb.units} delta={data.wb.delta_pct} color={COLOR_WB} />
          <SalesRow label="Ozon"         amount={data.ozon.revenue_rub} units={data.ozon.units} delta={data.ozon.delta_pct} color={COLOR_OZON} />
          <div style={{ borderTop: '1px solid var(--border-hairline)', paddingTop: '10px', marginTop: '4px' }}>
            <SalesRow label="Combined" amount={data.combined.revenue_rub} units={data.combined.units} delta={null} color="var(--fg-1)" bold />
          </div>
        </>
      )}
    </div>
  );
}

function SalesRow({ label, amount, units, delta, color, bold }: { label: string; amount: number; units: number; delta: number | null; color: string; bold?: boolean }) {
  const dp = fmtPct(delta);
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '6px 0' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: 'var(--fg-2)' }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: color, display: 'inline-block' }} />
        {label}
      </span>
      <span style={{ fontSize: '14px', fontWeight: bold ? 700 : 500, color: 'var(--fg-1)' }}>
        {fmtRubFull(amount)}
        <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: '8px' }}>· {units} ед</span>
        {dp.tone !== 'na' && (
          <span style={{
            marginLeft: '8px',
            fontSize: '12px',
            fontWeight: 500,
            padding: '2px 6px',
            borderRadius: '3px',
            backgroundColor: dp.tone === 'up' ? '#EAF3DE' : dp.tone === 'down' ? '#FCEBEB' : 'var(--paper-sunk)',
            color: dp.tone === 'up' ? '#3B6D11' : dp.tone === 'down' ? '#A32D2D' : 'var(--fg-3)',
          }}>{dp.text}</span>
        )}
      </span>
    </div>
  );
}

// ===========================================================================
// Card 6 — 7-day trend (Ozon blue / WB purple, per-day vs last week)
// ===========================================================================
function TrendCard({ data, loading }: { data: DailyTrend | null; loading: boolean }) {
  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
      <div style={{ fontSize: '14px', color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: '12px' }}>
        7-day trend
        {data && !data.history_complete && (
          <span style={{ marginLeft: '8px', fontSize: '11px', textTransform: 'none', color: 'var(--fg-3)' }}>
            (Δ vs last week — needs 14d, have {data.days_available}d)
          </span>
        )}
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--fg-3)' }} /></div>
      ) : !data || data.days.length === 0 ? (
        <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>No daily snapshots yet.</div>
      ) : (
        <table style={{ width: '100%', fontSize: '13px' }}>
          <thead>
            <tr style={{ color: 'var(--fg-3)', borderBottom: '1px solid var(--border-hairline)' }}>
              <th style={{ textAlign: 'left',  padding: '6px 4px', fontWeight: 500, fontSize: '11px' }}>Day</th>
              <th style={{ textAlign: 'right', padding: '6px 4px', fontWeight: 500, fontSize: '11px', color: COLOR_OZON }}>Ozon</th>
              <th style={{ textAlign: 'right', padding: '6px 4px', fontWeight: 500, fontSize: '11px', color: COLOR_WB }}>WB</th>
              <th style={{ textAlign: 'right', padding: '6px 4px', fontWeight: 500, fontSize: '11px' }}>Day total</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map(d => (
              <TrendRow key={d.date} day={d} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TrendRow({ day }: { day: DailyTrend['days'][number] }) {
  const total = day.ozon.revenue_rub + day.wb.revenue_rub;
  return (
    <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
      <td style={{ padding: '6px 4px', color: 'var(--fg-2)' }}>
        <span style={{ fontWeight: 500 }}>{fmtWeekday(day.date)}</span>
        <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--fg-3)' }}>{day.date.slice(5)}</span>
      </td>
      <TrendCell amount={day.ozon.revenue_rub} delta={day.ozon.delta_pct} color={COLOR_OZON} />
      <TrendCell amount={day.wb.revenue_rub}   delta={day.wb.delta_pct}   color={COLOR_WB} />
      <td style={{ padding: '6px 4px', textAlign: 'right', fontWeight: 700, color: 'var(--fg-1)' }}>{fmtRub(total)} ₽</td>
    </tr>
  );
}

function TrendCell({ amount, delta, color }: { amount: number; delta: number | null; color: string }) {
  const dp = fmtPct(delta);
  return (
    <td style={{ padding: '6px 4px', textAlign: 'right' }}>
      <span style={{ fontWeight: 700, color }}>{fmtRub(amount)}</span>
      {dp.tone !== 'na' && (
        <span style={{
          display: 'inline-block',
          marginLeft: '6px',
          fontSize: '11px',
          fontWeight: 500,
          color: dp.tone === 'up' ? '#3B6D11' : dp.tone === 'down' ? '#A32D2D' : 'var(--fg-3)',
        }}>{dp.text}</span>
      )}
    </td>
  );
}

// ===========================================================================
// Card 3 — Top & Bottom SKUs (clickable rows → funnel modal)
// ===========================================================================
function TopBottomCard({ data, loading, onSkuClick }: { data: Spotlight | null; loading: boolean; onSkuClick: (sku: string) => void }) {
  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', gridColumn: 'span 2' }}>
      <div style={{ fontSize: '14px', color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: '12px' }}>
        Top & bottom SKUs
        <span style={{ marginLeft: '8px', fontSize: '11px', textTransform: 'none', color: 'var(--fg-3)' }}>
          (click a top SKU to see its conversion funnel)
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--fg-3)' }} /></div>
      ) : !data ? (
        <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>No data.</div>
      ) : (
        <div className="grid grid-cols-2 gap-6">
          <div>
            <div style={{ fontSize: '11px', color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: '4px' }}>
              Top 5 by units
            </div>
            <div>
              {data.top.map((row, i) => {
                const max = data.top[0]?.units_sold || 1;
                return (
                  <button
                    key={row.base_sku}
                    onClick={() => onSkuClick(row.base_sku)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '10px',
                      padding: '6px 0',
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--border-hairline)',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--paper-sunk)')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <span style={{ width: '70px', fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase' }}>
                      {row.base_sku.toUpperCase()}
                    </span>
                    <span style={{ flex: 1, height: '10px', backgroundColor: 'var(--paper-sunk)', borderRadius: '4px', overflow: 'hidden' }}>
                      <span style={{
                        display: 'block',
                        height: '100%',
                        width: `${(row.units_sold / max) * 100}%`,
                        background: `linear-gradient(90deg, ${COLOR_WB} 0%, ${COLOR_WB} ${(row.wb_units / row.units_sold) * 100}%, ${COLOR_OZON} ${(row.wb_units / row.units_sold) * 100}%, ${COLOR_OZON} 100%)`,
                      }} />
                    </span>
                    <span style={{ width: '64px', textAlign: 'right', fontSize: '14px', fontWeight: 700 }}>
                      {row.units_sold}
                    </span>
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--fg-3)' }}>
              <span style={{ display: 'inline-block', width: '8px', height: '8px', backgroundColor: COLOR_WB, marginRight: '4px', borderRadius: '50%' }} />WB
              <span style={{ display: 'inline-block', width: '8px', height: '8px', backgroundColor: COLOR_OZON, marginLeft: '12px', marginRight: '4px', borderRadius: '50%' }} />Ozon
            </div>
          </div>

          <div>
            <div style={{ fontSize: '11px', color: 'var(--fg-3)', textTransform: 'uppercase', marginBottom: '4px' }}>
              No sales (catalog SKUs)
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
                  padding: '6px 0',
                  borderBottom: '1px solid var(--border-hairline)',
                  fontSize: '14px',
                }}>
                  <span style={{ fontWeight: 700, color: 'var(--fg-2)', textTransform: 'uppercase' }}>{row.base_sku.toUpperCase()}</span>
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

// ===========================================================================
// Card 9 — SKU funnel modal (popped from top-SKU click)
// ===========================================================================
function SkuFunnelModal({ sku, onClose }: { sku: string; onClose: () => void }) {
  const [funnel, setFunnel] = useState<SkuFunnel | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchJson<SkuFunnel>(`/api/marketplaces/pulse/sku-funnel/${encodeURIComponent(sku)}`).then(d => {
      setFunnel(d);
      setLoading(false);
    });
  }, [sku]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: '20px',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--paper)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          maxWidth: '720px',
          width: '100%',
          maxHeight: '80vh',
          overflow: 'auto',
          padding: '24px',
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '24px', fontWeight: 700, color: 'var(--fg-1)' }}>
              {sku.toUpperCase()}
            </h2>
            {funnel?.product_name && (
              <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '4px' }}>{funnel.product_name}</p>
            )}
            {funnel?.period.from && (
              <p style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
                Conversion funnel · {funnel.period.from} — {funnel.period.to}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '6px',
              color: 'var(--fg-3)',
            }}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-3)' }} /></div>
        ) : !funnel ? (
          <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>No funnel data for this SKU.</div>
        ) : (
          <div className="grid grid-cols-2 gap-6">
            <FunnelColumn label="Wildberries" data={funnel.wb} color={COLOR_WB} />
            <FunnelColumn label="Ozon"        data={funnel.ozon} color={COLOR_OZON} />
          </div>
        )}
      </div>
    </div>
  );
}

function FunnelColumn({ label, data, color }: { label: string; data: { views: number; cart: number; orders: number; revenue_rub: number } | null; color: string }) {
  if (!data) {
    return (
      <div>
        <div style={{ fontSize: '14px', fontWeight: 700, color, marginBottom: '12px' }}>{label}</div>
        <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>Not listed on this marketplace.</div>
      </div>
    );
  }

  const viewsToCart = data.views > 0 ? (data.cart / data.views) * 100 : 0;
  const cartToOrder = data.cart > 0 ? (data.orders / data.cart) * 100 : 0;
  const overall = data.views > 0 ? (data.orders / data.views) * 100 : 0;

  return (
    <div>
      <div style={{ fontSize: '14px', fontWeight: 700, color, marginBottom: '12px', textTransform: 'uppercase' }}>{label}</div>

      <FunnelStep label="Views" count={data.views} pct={100} color={color} prefix="" />
      <FunnelArrow conv={viewsToCart} note="add to cart" />
      <FunnelStep label="In cart" count={data.cart} pct={(data.cart / Math.max(data.views, 1)) * 100} color={color} prefix="" opacity={0.7} />
      <FunnelArrow conv={cartToOrder} note="checkout" />
      <FunnelStep label="Ordered" count={data.orders} pct={(data.orders / Math.max(data.views, 1)) * 100} color={color} prefix="" opacity={0.4} />

      <div style={{ marginTop: '12px', padding: '10px', backgroundColor: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)', fontSize: '13px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
          <span style={{ color: 'var(--fg-3)' }}>View → buy</span>
          <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{overall.toFixed(2)}%</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--fg-3)' }}>Revenue</span>
          <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{fmtRubFull(data.revenue_rub)}</span>
        </div>
      </div>
    </div>
  );
}

function FunnelStep({ label, count, pct, color, opacity = 1 }: { label: string; count: number; pct: number; color: string; prefix?: string; opacity?: number }) {
  return (
    <div style={{ marginBottom: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
        <span style={{ color: 'var(--fg-2)' }}>{label}</span>
        <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{new Intl.NumberFormat('ru-RU').format(count)}</span>
      </div>
      <div style={{ height: '20px', backgroundColor: 'var(--paper-sunk)', borderRadius: 'var(--radius-xs)', overflow: 'hidden' }}>
        <div style={{
          width: `${Math.max(pct, 2)}%`,
          height: '100%',
          backgroundColor: color,
          opacity,
        }} />
      </div>
    </div>
  );
}

function FunnelArrow({ conv, note }: { conv: number; note: string }) {
  return (
    <div style={{ textAlign: 'center', fontSize: '11px', color: 'var(--fg-3)', padding: '2px 0' }}>
      ↓ {conv.toFixed(1)}% — {note}
    </div>
  );
}
