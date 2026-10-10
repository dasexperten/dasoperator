'use client';

// =============================================================================
// Wildberries · library — lasting day-by-day history per product (Owner 2026-10-10).
// Source: /api/marketplaces/wb/daily (D1 wb_sku_daily, money in kopecks → /100).
// Written by the nightly WB sales run at 05:00 Yerevan. Each source fills its own
// columns; a dash means "not received yet", never zero.
// =============================================================================

import { useEffect, useState } from 'react';
import { Loader2, Library } from 'lucide-react';
import { apiGet } from '@/lib/api';

type Row = {
  date: string;
  units_sold: number | null;
  revenue_kopecks: number | null;
  views: number | null;
  tocart: number | null;
  orders: number | null;
  price_kopecks: number | null;
  ad_spend_kopecks: number | null;
};
type Product = { sku: string; product_name: string | null };
type DailyResp = {
  from: string;
  sku: string | null;
  rows: Row[];
  products: Product[];
  synced_at: { sales: number | null; funnel: number | null; price: number | null; ad: number | null } | null;
};

const PERIODS = [14, 30, 90, 365];

function fmtInt(n: number | null): string {
  return n == null ? '—' : new Intl.NumberFormat('ru-RU').format(Math.round(n));
}
function fmtRub(kopecks: number | null): string {
  return kopecks == null ? '—' : new Intl.NumberFormat('ru-RU').format(Math.round(kopecks / 100)) + ' ₽';
}
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}
function fmtUpdated(unixSec: number | null | undefined): string {
  if (!unixSec) return 'never';
  return new Date(unixSec * 1000).toLocaleString('ru-RU', {
    timeZone: 'Asia/Yerevan', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

const cell: React.CSSProperties = { padding: '8px 10px', fontSize: '14px', textAlign: 'right', whiteSpace: 'nowrap', borderTop: '1px solid var(--border-hairline)' };
const head: React.CSSProperties = { ...cell, fontWeight: 700, color: 'var(--fg-2)', borderTop: 'none' };
const select: React.CSSProperties = { fontSize: '14px', padding: '6px 10px', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-1)', color: 'var(--fg-1)' };

export function WbLibrary() {
  const [sku, setSku] = useState('');
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DailyResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const res = await apiGet<DailyResp>(`/api/marketplaces/wb/daily?days=${days}${sku ? `&sku=${encodeURIComponent(sku)}` : ''}`);
        if (!alive) return;
        setData(res.success && res.result ? res.result : null);
        setFailed(!res.success);
      } catch {
        if (alive) { setData(null); setFailed(true); }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [sku, days]);

  const rows = data?.rows ?? [];
  const sum = (k: keyof Row) => {
    const vals = rows.map(r => r[k]).filter((v): v is number => typeof v === 'number');
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };

  return (
    <div className="bg-card p-5 space-y-4" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', minWidth: 0 }}>
      <div className="flex flex-wrap items-center justify-between" style={{ gap: '12px' }}>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--fg-2)' }}><Library size={16} /></span>
          <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase' }}>WB library · day by day</span>
        </div>
        <div className="flex flex-wrap items-center" style={{ gap: '8px' }}>
          <select style={select} value={sku} onChange={e => setSku(e.target.value)} aria-label="Product">
            <option value="">All products</option>
            {(data?.products ?? []).map(p => (
              <option key={p.sku} value={p.sku}>{p.sku.toUpperCase()}{p.product_name ? ` · ${p.product_name}` : ''}</option>
            ))}
          </select>
          <select style={select} value={days} onChange={e => setDays(Number(e.target.value))} aria-label="Period">
            {PERIODS.map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
        </div>
      </div>

      <p style={{ fontSize: '13px', color: 'var(--fg-3)', lineHeight: 1.45 }}>
        Filled every night at 05:00 Yerevan. Sales are rechecked for the last 13 days, ad spend for the last 7.
        Views and add-to-cart are taken for the previous day; price is as read the next morning.
        A dash means the figure has not been received yet — it is never shown as zero.
        Last update: sales {fmtUpdated(data?.synced_at?.sales)} · views {fmtUpdated(data?.synced_at?.funnel)} · price {fmtUpdated(data?.synced_at?.price)} · ads {fmtUpdated(data?.synced_at?.ad)}.
      </p>

      {loading ? (
        <div className="flex items-center gap-2" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : failed ? (
        <div style={{ fontSize: '14px', color: '#A32D2D' }}>The library could not be read. Try again in a minute.</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>No days recorded yet. The first night run fills the last 13 days.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr>
                <th style={{ ...head, textAlign: 'left' }}>Day</th>
                <th style={head}>Units</th>
                <th style={head}>Revenue</th>
                <th style={head}>Views</th>
                <th style={head}>Add to cart</th>
                <th style={head}>Orders</th>
                {sku && <th style={head}>Price</th>}
                <th style={head}>Ad spend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.date}>
                  <td style={{ ...cell, textAlign: 'left' }}>{fmtDate(r.date)}</td>
                  <td style={cell}>{fmtInt(r.units_sold)}</td>
                  <td style={cell}>{fmtRub(r.revenue_kopecks)}</td>
                  <td style={cell}>{fmtInt(r.views)}</td>
                  <td style={cell}>{fmtInt(r.tocart)}</td>
                  <td style={cell}>{fmtInt(r.orders)}</td>
                  {sku && <td style={cell}>{fmtRub(r.price_kopecks)}</td>}
                  <td style={cell}>{fmtRub(r.ad_spend_kopecks)}</td>
                </tr>
              ))}
              <tr>
                <td style={{ ...cell, textAlign: 'left', fontWeight: 700 }}>Total</td>
                <td style={{ ...cell, fontWeight: 700 }}>{fmtInt(sum('units_sold'))}</td>
                <td style={{ ...cell, fontWeight: 700 }}>{fmtRub(sum('revenue_kopecks'))}</td>
                <td style={{ ...cell, fontWeight: 700 }}>{fmtInt(sum('views'))}</td>
                <td style={{ ...cell, fontWeight: 700 }}>{fmtInt(sum('tocart'))}</td>
                <td style={{ ...cell, fontWeight: 700 }}>{fmtInt(sum('orders'))}</td>
                {sku && <td style={cell} />}
                <td style={{ ...cell, fontWeight: 700 }}>{fmtRub(sum('ad_spend_kopecks'))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
