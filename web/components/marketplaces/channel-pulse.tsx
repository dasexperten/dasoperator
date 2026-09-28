'use client';

// =============================================================================
// Marketplaces — channel pulse (Overview tab + Merchant / Shopee / TikTok Shop /
// Lazada tabs). Same two-card shape as the home Marketplace Pulse:
//   left  — sales and orders in pieces, last 30 days of data
//   right — ordered vs delivered, in pieces
//
// Numbers come only from /api/marketplaces/pulse/daily-trend (the ERP
// marketplace_sales_daily feed: Ozon + WB orders). Channels without a feed in
// the ERP show "no feed", never a zero: a zero would claim "no sales".
// Delivered has no complete source in the ERP yet, so it is shown as a gap.
// Shop facts are read-only snapshots with their source and read date.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Loader2, BarChart3, PackageCheck, Store } from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'https://dasoperator-api.dasexperten.workers.dev';

export type ChannelKey = 'ozon' | 'wb' | 'merchant' | 'shopee' | 'tiktok' | 'lazada';

interface ChannelMeta {
  key: ChannelKey;
  label: string;
  color: string;
  /** true when the ERP holds daily orders for this channel */
  fed: boolean;
}

export const CHANNELS: ChannelMeta[] = [
  { key: 'ozon', label: 'Ozon', color: '#185FA5', fed: true },
  { key: 'wb', label: 'Wildberries', color: '#534AB7', fed: true },
  { key: 'merchant', label: 'Merchant', color: '#1A73E8', fed: false },
  { key: 'shopee', label: 'Shopee', color: '#EE4D2D', fed: false },
  { key: 'tiktok', label: 'TikTok Shop', color: '#111111', fed: false },
  { key: 'lazada', label: 'Lazada', color: '#0F146D', fed: false },
];

type Day = {
  date: string;
  ozon: { units: number; revenue_rub: number };
  wb: { units: number; revenue_rub: number };
};
type Total = { units: number; revenue_rub: number; delta_pct: number | null; prev_revenue_rub: number };
type DailyTrend = {
  days: Day[];
  totals_30d: { ozon: Total; wb: Total };
};

// ───────────────────────── Shop facts (read-only snapshots) ─────────────────────────

interface ShopFacts {
  title: string;
  status: string;
  tone: 'ok' | 'warn' | 'stop';
  rows: Array<[string, string]>;
  source: string;
}

const FACTS: Record<'merchant' | 'shopee' | 'tiktok' | 'lazada', ShopFacts> = {
  merchant: {
    title: 'Google Merchant Center',
    status: 'Active · feeds updated',
    tone: 'ok',
    rows: [
      ['Store', 'Das Experten Official Store'],
      ['Website', 'www.dasexperten.com'],
      ['Feeds', '11 main + 5 supplementary'],
      ['Toothpaste offers checked', '98 of 98 active'],
      ['Open issue', 'Hong Kong: 1 of 24 products matched · US DE201 blocked as «tobacco»'],
      ['Orders', 'go to dasexperten.com checkout; not attributed to Merchant in the ERP'],
    ],
    source: 'Julian · Merchant Center, read 27.09.2026',
  },
  shopee: {
    title: 'Shopee Vietnam',
    status: 'Active · all listings sold out',
    tone: 'warn',
    rows: [
      ['Shop', 'DasExpertenVN'],
      ['Account health', 'Excellent · 0 penalty points'],
      ['Listings', '11 · 8 live, 3 unpublished · stock 0'],
      ['Sales, last 30 days', '0 orders · 0 impressions'],
      ['Fees', '16.5% commission + 6% transaction + 3 000 ₫ per order'],
      ['Mall', 'invited 01.03.2026 · no application filed'],
    ],
    source: 'Tet · Seller Centre, read 14.09.2026',
  },
  tiktok: {
    title: 'TikTok Shop Vietnam',
    status: 'Closed by the platform',
    tone: 'stop',
    rows: [
      ['Shop', 'DasExpertenVN · ID VNLCRVLHHG'],
      ['Closed', '15.04.2026 · «association with deactivated shop»'],
      ['Appeals', 'rejected 15.04 and 27.04.2026'],
      ['Reopening', 'a new shop under the same company counts as circumvention'],
      ['Fees (reference)', '9.5–16% commission + 6% transaction + 3 000 ₫ per order'],
    ],
    source: 'Tet · Seller Centre and mail, read 14.09.2026',
  },
  lazada: {
    title: 'Lazada Vietnam',
    status: 'Holiday mode · buyers cannot purchase',
    tone: 'warn',
    rows: [
      ['Seller', 'VzKJLEgm'],
      ['Listings', '6 · our 5 toothpastes created 14.09 + 1 old test item · all sold out'],
      ['Fees', '6% transaction + 3 000 ₫ per delivered order · commission row not read'],
      ['Market share', 'about 3% of Vietnam, falling'],
    ],
    source: 'Tet · Seller Center, read 14.09.2026',
  },
};

// ───────────────────────── Helpers ─────────────────────────

function fmtRub(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
}
function fmtPcs(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' pcs';
}
function fmtDay(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}
function fmtDelta(t: Total): string | null {
  if (t.delta_pct === null) return null;
  return `${t.delta_pct > 0 ? '+' : ''}${t.delta_pct.toFixed(1)}%`;
}

function useDailyTrend() {
  const [data, setData] = useState<DailyTrend | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/marketplaces/pulse/daily-trend`);
        const json = (await res.json()) as { success: boolean; result: DailyTrend };
        if (alive) setData(json.success ? json.result : null);
      } catch {
        if (alive) setData(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);
  return { data, loading };
}

// ───────────────────────── Building blocks ─────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card p-5" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', minWidth: 0 }}>
      {children}
    </div>
  );
}

function CardTitle({ icon, title, right }: { icon: React.ReactNode; title: string; right?: string }) {
  return (
    <div className="flex items-center justify-between mb-4" style={{ gap: '12px' }}>
      <div className="flex items-center gap-2">
        <span style={{ color: 'var(--fg-2)' }}>{icon}</span>
        <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase' }}>{title}</span>
      </div>
      {right && <span style={{ fontSize: '14px', color: 'var(--fg-3)', whiteSpace: 'nowrap' }}>{right}</span>}
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: color, display: 'inline-block', flexShrink: 0 }} />;
}

function NoFeed({ children = 'no feed in ERP' }: { children?: React.ReactNode }) {
  return <span style={{ fontSize: '14px', color: 'var(--fg-muted)', fontStyle: 'italic' }}>{children}</span>;
}

function Loading() {
  return (
    <div className="flex items-center justify-center" style={{ minHeight: '160px', color: 'var(--fg-muted)' }}>
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

// Daily ordered pieces, stacked Ozon / WB.
function DailyBars({ days }: { days: Day[] }) {
  const max = Math.max(1, ...days.map(d => d.ozon.units + d.wb.units));
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '120px' }}>
        {days.map(d => {
          const total = d.ozon.units + d.wb.units;
          return (
            <div
              key={d.date}
              title={`${fmtDay(d.date)} · Ozon ${fmtPcs(d.ozon.units)} · WB ${fmtPcs(d.wb.units)}`}
              style={{ flex: 1, minWidth: 0, height: `${(total / max) * 100}%`, display: 'flex', flexDirection: 'column', borderRadius: '3px 3px 0 0', overflow: 'hidden' }}
            >
              <div style={{ flex: d.ozon.units, backgroundColor: CHANNELS[0].color }} />
              <div style={{ flex: d.wb.units, backgroundColor: CHANNELS[1].color }} />
            </div>
          );
        })}
      </div>
      {days.length > 0 && (
        <div className="flex justify-between" style={{ fontSize: '13px', color: 'var(--fg-3)', marginTop: '6px' }}>
          <span>{fmtDay(days[0].date)}</span>
          <span>ordered pieces per day</span>
          <span>{fmtDay(days[days.length - 1].date)}</span>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Overview (landing) ─────────────────────────

export function ChannelsOverview({ onOpen }: { onOpen?: (key: ChannelKey) => void }) {
  const { data, loading } = useDailyTrend();

  const totals = useMemo(() => {
    if (!data) return null;
    const oz = data.totals_30d.ozon;
    const wb = data.totals_30d.wb;
    return {
      revenue: oz.revenue_rub + wb.revenue_rub,
      units: oz.units + wb.units,
      from: data.days[0]?.date ?? null,
      to: data.days[data.days.length - 1]?.date ?? null,
    };
  }, [data]);

  const per = (key: ChannelKey): Total | null =>
    data && (key === 'ozon' || key === 'wb') ? data.totals_30d[key] : null;

  const maxOrdered = Math.max(1, ...(['ozon', 'wb'] as const).map(k => per(k)?.units ?? 0));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap" style={{ gap: '12px' }}>
        <div className="flex items-center flex-wrap" style={{ gap: '16px' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 800, color: 'var(--fg-1)', textTransform: 'uppercase' }}>
            Marketplace pulse
          </span>
          {CHANNELS.map(ch => (
            <span key={ch.key} className="inline-flex items-center" style={{ gap: '6px', fontSize: '14px', color: 'var(--fg-2)' }}>
              <Dot color={ch.color} />
              {ch.label}
            </span>
          ))}
        </div>
        {totals?.from && totals.to && (
          <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{totals.from} → {totals.to}</span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left — sales and orders in pieces */}
        <Card>
          <CardTitle icon={<BarChart3 className="h-4 w-4" />} title="Sales and orders · 30 days" />
          {loading ? <Loading /> : !data || !totals ? <NoFeed>Sales feed did not answer. Try again later.</NoFeed> : (
            <>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 700, color: CHANNELS[0].color, lineHeight: 1.1 }}>
                {fmtRub(totals.revenue)}
              </div>
              <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '4px', marginBottom: '16px' }}>
                {fmtPcs(totals.units)} ordered · Ozon + Wildberries
              </div>
              <DailyBars days={data.days} />
              <div style={{ marginTop: '16px', borderTop: '1px solid var(--border-hairline)', paddingTop: '8px' }}>
                {CHANNELS.map(ch => {
                  const t = per(ch.key);
                  const delta = t ? fmtDelta(t) : null;
                  return (
                    <button
                      key={ch.key}
                      onClick={() => onOpen?.(ch.key)}
                      className="w-full flex items-baseline justify-between"
                      style={{ padding: '7px 0', background: 'none', border: 'none', cursor: onOpen ? 'pointer' : 'default', textAlign: 'left', gap: '12px' }}
                    >
                      <span className="inline-flex items-center" style={{ gap: '8px', fontSize: '14px', color: 'var(--fg-2)' }}>
                        <Dot color={ch.color} />
                        {ch.label}
                      </span>
                      {t ? (
                        <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', whiteSpace: 'nowrap' }}>
                          {fmtRub(t.revenue_rub)}
                          <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: '8px' }}>{fmtPcs(t.units)}</span>
                          {delta && (
                            <span style={{ fontWeight: 600, marginLeft: '8px', color: (t.delta_pct ?? 0) >= 0 ? '#3B6D11' : '#A32D2D' }}>{delta}</span>
                          )}
                        </span>
                      ) : <NoFeed />}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: '13px', color: 'var(--fg-3)', marginTop: '6px' }}>
                Change is against the previous 30 days.
              </div>
            </>
          )}
        </Card>

        {/* Right — ordered vs delivered */}
        <Card>
          <CardTitle icon={<PackageCheck className="h-4 w-4" />} title="Ordered and delivered · pieces" right="30 days" />
          {loading ? <Loading /> : (
            <>
              <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto auto', columnGap: '16px', rowGap: '4px', alignItems: 'center' }}>
                <span style={{ fontSize: '13px', color: 'var(--fg-3)' }}>Channel</span>
                <span style={{ fontSize: '13px', color: 'var(--fg-3)', textAlign: 'right' }}>Ordered</span>
                <span style={{ fontSize: '13px', color: 'var(--fg-3)', textAlign: 'right' }}>Delivered</span>
                {CHANNELS.map(ch => {
                  const t = per(ch.key);
                  return (
                    <div key={ch.key} style={{ display: 'contents' }}>
                      <div style={{ padding: '8px 0', minWidth: 0 }}>
                        <div className="inline-flex items-center" style={{ gap: '8px', fontSize: '14px', color: 'var(--fg-2)' }}>
                          <Dot color={ch.color} />
                          {ch.label}
                        </div>
                        <div style={{ height: '6px', marginTop: '6px', borderRadius: '3px', backgroundColor: 'var(--paper-sunk, #F1EFE8)' }}>
                          {t && (
                            <div style={{ height: '100%', width: `${(t.units / maxOrdered) * 100}%`, borderRadius: '3px', backgroundColor: ch.color }} />
                          )}
                        </div>
                      </div>
                      <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {t ? fmtPcs(t.units) : <NoFeed>—</NoFeed>}
                      </span>
                      <span style={{ textAlign: 'right' }}><NoFeed>—</NoFeed></span>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: '16px', padding: '12px', borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper-sunk, #F1EFE8)', fontSize: '14px', color: 'var(--fg-2)', lineHeight: 1.5 }}>
                Delivered pieces have no complete source in the ERP yet. The Wildberries sales reports in the ERP stop at
                16.09.2026 with gaps; the Ozon ones stop at 31.01.2026. The column fills once those reports arrive in full.
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

// ───────────────────────── One channel tab (Merchant / Shopee / TikTok / Lazada) ─────────────────────────

export function ChannelTab({ channel }: { channel: 'merchant' | 'shopee' | 'tiktok' | 'lazada' }) {
  const ch = CHANNELS.find(c => c.key === channel)!;
  const f = FACTS[channel];
  const toneColor = f.tone === 'ok' ? '#3B6D11' : f.tone === 'warn' ? '#BA7517' : '#A32D2D';

  return (
    <div className="space-y-4">
      <div className="flex items-center flex-wrap" style={{ gap: '12px' }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 800, color: ch.color, textTransform: 'uppercase' }}>
          {ch.label}
        </span>
        <span className="inline-flex items-center" style={{ gap: '6px', fontSize: '14px', color: toneColor, fontWeight: 600 }}>
          <Dot color={toneColor} />
          {f.status}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardTitle icon={<BarChart3 className="h-4 w-4" />} title="Sales and orders · 30 days" />
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 700, color: 'var(--fg-muted)', lineHeight: 1.1 }}>—</div>
          <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '6px', lineHeight: 1.5 }}>
            No sales feed from {ch.label} in the ERP yet, so there is no sales or pieces figure to show.
          </div>
        </Card>
        <Card>
          <CardTitle icon={<PackageCheck className="h-4 w-4" />} title="Ordered and delivered · pieces" right="30 days" />
          <div className="grid grid-cols-2" style={{ gap: '16px' }}>
            {['Ordered', 'Delivered'].map(label => (
              <div key={label}>
                <div style={{ fontSize: '13px', color: 'var(--fg-3)' }}>{label}</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 700, color: 'var(--fg-muted)' }}>—</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '8px' }}>
            <NoFeed />
          </div>
        </Card>
      </div>

      <Card>
        <CardTitle icon={<Store className="h-4 w-4" />} title={f.title} />
        <div className="grid" style={{ gridTemplateColumns: 'minmax(120px, 220px) minmax(0, 1fr)', columnGap: '16px', rowGap: '8px' }}>
          {f.rows.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{k}</span>
              <span style={{ fontSize: '14px', color: 'var(--fg-1)' }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: '13px', color: 'var(--fg-3)', marginTop: '14px' }}>Source: {f.source}</div>
      </Card>
    </div>
  );
}
