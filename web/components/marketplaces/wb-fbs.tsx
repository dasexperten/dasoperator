'use client';

// =============================================================================
// Wildberries · FBS — Arina Volkova's board (replaces the retired WB FBO planner).
// WB is FBS-only since 2026-09-19 (Owner): no FBO cover, clusters or FBO supply.
// The board follows Arina's standing goals:
//   1. every seller price after discount at or above the approved minimum
//      (HARD_RULES §5a, Owner 26.09.2026)
//   2. every eligible SKU in a promo at the highest resulting customer price
//   3. SYMBIOS top-4 on probiotic searches, ad share within Owner thresholds
//   4. FBS orders and stock in the ERP
//
// Numbers: /api/marketplaces/sales (marketplace_sales_wb, money in kopecks → /100).
// A goal without a live ERP source is shown as a gap with its last manual
// reading and date, never as a zero.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Loader2, BarChart3, Target, Tag } from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'https://dasoperator-api.dasexperten.workers.dev';
const WB = '#534AB7';
const GREEN = '#3B6D11';
const AMBER = '#BA7517';
const RED = '#A32D2D';

// Approved absolute minimum seller price per SKU, RUB.
// Mirror of HARD_RULES §5a (organizacia agents/arina-volkova/data/
// WB_MIN_AUTO_PROMO_PRICES_260906.md, column K, Owner 28.11.2025 / 26.09.2026).
// If §5a changes, change this table in the same session.
const FLOOR_SOURCE = 'approved minimums, HARD_RULES §5a (26.09.2026)';
const FLOORS: Record<string, number> = (() => {
  const groups: Array<[number, string[]]> = [
    [224, ['DE105', 'DE120', 'DE122AAAA', 'DE106', 'DE123', 'DE107', 'DE116', 'DE118', 'DE108', 'DE109', 'DE110']],
    [364, ['DE201', 'DE202', 'DE203', 'DE204', 'DE205', 'DE206', 'DE207', 'DE208', 'DE130', 'DE125', 'DE126', 'DE114', 'DE119', 'DE113', 'DE107AA', 'DE105AA', 'DE116AA', 'DE123AA', 'DE120AA', 'DE121']],
    [616, ['DE203AA', 'DE111', 'DE112', 'DE120AAAA', 'DE105AAAA', 'DE123AAAA', 'DE116AAAA', 'DE107AAAA', 'DE201AA', 'DE115', 'DE202AA', 'DE110AAAA', 'DE118AAAA', 'DE106AAAA', 'DE121AAAA', 'DE119AA', 'DE207AA', 'DE208AA']],
    [624, ['DE205AA']],
    [630, ['DE206AA']],
    [740, ['DE210', 'DE310']],
  ];
  const m: Record<string, number> = {};
  for (const [floor, skus] of groups) for (const s of skus) m[s] = floor;
  return m;
})();

type WbSku = {
  sku: string;
  product_name: string | null;
  units_sold: number;
  revenue_rub: number; // kopecks
  views: number | null;
  tocart_count: number | null;
  current_price_rub: number | null; // kopecks, seller price after seller discount
  ad_spend_rub: number | null; // kopecks
};
type SalesResp = {
  sync_windows: { wb: { from: string | null; to: string | null } };
  totals: { wb: { units_sold: number; revenue_rub: number; synced_at: number | null } };
  top_skus: { wb: WbSku[] };
};

function rub(kopecks: number): number {
  return kopecks / 100;
}
function fmtRub(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₽';
}
function fmtInt(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n));
}
function fmtAge(unixSec: number | null): string {
  if (!unixSec) return 'never updated';
  const h = Math.floor((Date.now() / 1000 - unixSec) / 3600);
  if (h < 1) return 'updated within the hour';
  if (h < 48) return `updated ${h} h ago`;
  return `updated ${Math.floor(h / 24)} days ago`;
}

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
  return <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: color, display: 'inline-block', flexShrink: 0, marginTop: '6px' }} />;
}

function Goal({ tone, title, value, note }: { tone: 'ok' | 'warn' | 'bad' | 'gap'; title: string; value: string; note: string }) {
  const color = tone === 'ok' ? GREEN : tone === 'warn' ? AMBER : tone === 'bad' ? RED : 'var(--fg-muted)';
  return (
    <div className="flex" style={{ gap: '10px', padding: '10px 0', borderTop: '1px solid var(--border-hairline)' }}>
      <Dot color={color} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="flex items-baseline justify-between" style={{ gap: '12px' }}>
          <span style={{ fontSize: '14px', color: 'var(--fg-1)', fontWeight: 600 }}>{title}</span>
          <span style={{ fontSize: '14px', fontWeight: 700, color, whiteSpace: 'nowrap' }}>{value}</span>
        </div>
        <div style={{ fontSize: '13px', color: 'var(--fg-3)', marginTop: '2px', lineHeight: 1.45 }}>{note}</div>
      </div>
    </div>
  );
}

export function WbFbsBoard() {
  const [data, setData] = useState<SalesResp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/marketplaces/sales?days=7`);
        const json = (await res.json()) as { success: boolean; result: SalesResp };
        if (alive) setData(json.success ? json.result : null);
      } catch {
        if (alive) setData(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const view = useMemo(() => {
    if (!data) return null;
    const rows = data.top_skus.wb.map(r => {
      const key = r.sku.toUpperCase();
      const floor = FLOORS[key] ?? null;
      const price = r.current_price_rub != null ? rub(r.current_price_rub) : null;
      const status: 'below' | 'ok' | 'unknown' =
        floor == null || price == null ? 'unknown' : price < floor ? 'below' : 'ok';
      return { ...r, key, floor, price, status };
    });
    const units = rows.reduce((s, r) => s + r.units_sold, 0);
    const revenue = rows.reduce((s, r) => s + rub(r.revenue_rub), 0);
    const views = rows.reduce((s, r) => s + (r.views ?? 0), 0);
    const carts = rows.reduce((s, r) => s + (r.tocart_count ?? 0), 0);
    const ad = rows.reduce((s, r) => s + rub(r.ad_spend_rub ?? 0), 0);
    const below = rows.filter(r => r.status === 'below');
    const unknown = rows.filter(r => r.status === 'unknown');
    return { rows, units, revenue, views, carts, ad, below, unknown };
  }, [data]);

  const win = data?.sync_windows.wb;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap" style={{ gap: '12px' }}>
        <div className="flex items-center flex-wrap" style={{ gap: '12px' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '22px', fontWeight: 800, color: WB, textTransform: 'uppercase' }}>
            Wildberries · FBS
          </span>
          <span style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            FBS only since 19.09.2026 · FBO planning retired · seat: Arina Volkova
          </span>
        </div>
        {win?.from && win.to && (
          <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{win.from} → {win.to}</span>
        )}
      </div>

      {loading ? (
        <Card>
          <div className="flex items-center justify-center" style={{ minHeight: '160px', color: 'var(--fg-muted)' }}>
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        </Card>
      ) : !data || !view ? (
        <Card><span style={{ fontSize: '14px', color: RED }}>WB sales feed did not answer. Try again later.</span></Card>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left — sales and orders */}
            <Card>
              <CardTitle icon={<BarChart3 className="h-4 w-4" />} title="Sales and orders · 7 days" right={fmtAge(data.totals.wb.synced_at)} />
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 700, color: WB, lineHeight: 1.1 }}>
                {fmtRub(view.revenue)}
              </div>
              <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '4px' }}>
                {fmtInt(view.units)}{' '}pcs ordered · {view.rows.length} cards with sales
              </div>
              <div className="grid grid-cols-3" style={{ gap: '12px', marginTop: '18px' }}>
                {[
                  ['Views', fmtInt(view.views)],
                  ['Added to cart', fmtInt(view.carts)],
                  ['Ordered', fmtInt(view.units)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: '13px', color: 'var(--fg-3)' }}>{k}</div>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)' }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '13px', color: 'var(--fg-3)', marginTop: '10px' }}>
                View to cart {view.views > 0 ? ((view.carts / view.views) * 100).toFixed(1) : '—'}% · cart to order{' '}
                {view.carts > 0 ? ((view.units / view.carts) * 100).toFixed(1) : '—'}%
              </div>
            </Card>

            {/* Right — Arina's goals */}
            <Card>
              <CardTitle icon={<Target className="h-4 w-4" />} title="Goals" />
              <Goal
                tone={view.below.length > 0 ? 'bad' : 'ok'}
                title="Price at or above approved minimum"
                value={`${view.below.length} of ${view.rows.length - view.unknown.length} below`}
                note={`Seller price after discount vs ${FLOOR_SOURCE}. ${view.unknown.length > 0 ? `${view.unknown.length} card(s) have no approved minimum.` : ''} Fix prepared by Arina on 26.09, not yet applied on WB.`}
              />
              <Goal
                tone="gap"
                title="Every eligible SKU in a promo at the highest price"
                value="no feed"
                note="WB promotions are not stored in the ERP yet, so coverage cannot be counted here."
              />
              <Goal
                tone="warn"
                title="SYMBIOS top 4 on probiotic searches"
                value="13 · 6"
                note="Last measured 24.09 in Moscow: «с пробиотиками» 13th, «с пребиотиками» 6th. Bid raised 120 → 180 ₽ the same day."
              />
              <Goal
                tone={view.ad > 0 ? 'ok' : 'gap'}
                title="Ad share within 10% (15% high, 20% ceiling)"
                value={view.ad > 0 ? `${((view.ad / view.revenue) * 100).toFixed(1)}%` : 'no feed'}
                note={view.ad > 0
                  ? `${fmtRub(view.ad)} ad spend on ${fmtRub(view.revenue)} sales, 7 days.`
                  : 'Ad spend reads 0 on every card in the ERP, which is not true: the ad feed is not landing. Last manual reading: SYMBIOS 7.08% for 17–23.09.'}
              />
              <Goal
                tone="bad"
                title="FBS orders and stock in the ERP"
                value="0 rows"
                note="8 FBS warehouses are registered, but no FBS orders or stock have been written yet. Ordered and delivered by FBS order status fill from here."
              />
            </Card>
          </div>

          {/* Per-SKU price check */}
          <Card>
            <CardTitle icon={<Tag className="h-4 w-4" />} title="Cards · price vs minimum" right="7 days" />
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', minWidth: '620px' }}>
                <thead>
                  <tr style={{ color: 'var(--fg-3)', textAlign: 'right' }}>
                    <th style={{ textAlign: 'left', fontWeight: 500, padding: '6px 8px 6px 0' }}>Card</th>
                    <th style={{ fontWeight: 500, padding: '6px 8px' }}>Ordered</th>
                    <th style={{ fontWeight: 500, padding: '6px 8px' }}>Sales</th>
                    <th style={{ fontWeight: 500, padding: '6px 8px' }}>Price now</th>
                    <th style={{ fontWeight: 500, padding: '6px 8px' }}>Minimum</th>
                    <th style={{ fontWeight: 500, padding: '6px 0 6px 8px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...view.rows]
                    .sort((a, b) => (a.status === 'below' ? 0 : 1) - (b.status === 'below' ? 0 : 1) || b.units_sold - a.units_sold)
                    .map(r => (
                      <tr key={r.sku} style={{ borderTop: '1px solid var(--border-hairline)', textAlign: 'right' }}>
                        <td style={{ textAlign: 'left', padding: '8px 8px 8px 0' }}>
                          <span style={{ fontWeight: 600, color: 'var(--fg-1)' }}>{r.key}</span>
                          {r.product_name && <span style={{ color: 'var(--fg-3)', marginLeft: '8px' }}>{r.product_name}</span>}
                        </td>
                        <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{fmtInt(r.units_sold)}{' '}pcs</td>
                        <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{fmtRub(rub(r.revenue_rub))}</td>
                        <td style={{ padding: '8px', whiteSpace: 'nowrap', fontWeight: 600, color: r.status === 'below' ? RED : 'var(--fg-1)' }}>
                          {r.price != null ? fmtRub(r.price) : '—'}
                        </td>
                        <td style={{ padding: '8px', whiteSpace: 'nowrap', color: 'var(--fg-2)' }}>{r.floor != null ? fmtRub(r.floor) : '—'}</td>
                        <td style={{ padding: '8px 0 8px 8px', whiteSpace: 'nowrap', fontWeight: 600, color: r.status === 'below' ? RED : r.status === 'ok' ? GREEN : 'var(--fg-muted)' }}>
                          {r.status === 'below' ? 'below minimum' : r.status === 'ok' ? 'ok' : 'no minimum'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
