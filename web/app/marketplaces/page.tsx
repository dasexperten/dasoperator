'use client';

import { useEffect, useState, useMemo } from 'react';
import { Loader2, RefreshCw, ChevronDown, ChevronUp, ShoppingCart } from 'lucide-react';
import { getMarketplaceSales } from '@/lib/api';

interface SkuRow {
  sku: string;
  product_name: string;
  units_sold: number;
  revenue_rub: number;
  views: number;
  tocart_count: number;
  position_category: number | null;
  current_price_rub: number | null;
  ad_spend_rub: number;
}

interface SalesData {
  period_days: number;
  totals: {
    ozon: { units_sold: number; revenue_rub: number; synced_at: number | null };
    wb:   { units_sold: number; revenue_rub: number; synced_at: number | null };
  };
  daily: { marketplace: string; date: string; units_sold: number; revenue_rub: number }[];
  top_skus: { ozon: SkuRow[]; wb: SkuRow[] };
}

export default function MarketplacesPage() {
  const [data, setData] = useState<SalesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await getMarketplaceSales();
      if (res.success && res.result) {
        setData(res.result as SalesData);
        setError(null);
      } else {
        setError('Failed to load');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6 max-w-full">
      <div className="flex items-end justify-between">
        <div>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--fs-display-md)',
              fontWeight: 900,
              color: 'var(--fg-1)',
            }}
          >
            Marketplaces
          </h1>
          <p className="mt-2" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            Wildberries and Ozon — last 7 days
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-3 py-1.5"
          style={{
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px', color: 'var(--fg-1)', cursor: 'pointer',
          }}
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      )}

      {error && (
        <div
          className="p-4"
          style={{
            backgroundColor: 'rgba(229,32,44,0.05)',
            border: '1px solid rgba(229,32,44,0.2)',
            color: 'var(--brand-rot)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px',
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && data && <Dashboard data={data} />}
    </div>
  );
}

function Dashboard({ data }: { data: SalesData }) {
  return (
    <div className="space-y-8">
      {/* Two headline cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <HeadlineCard
          title="Ozon"
          accentColor="rgb(0, 91, 255)"
          tint="rgba(0, 91, 255, 0.06)"
          units={data.totals.ozon.units_sold}
        />
        <HeadlineCard
          title="Wildberries"
          accentColor="rgb(203, 17, 122)"
          tint="rgba(203, 17, 122, 0.06)"
          units={data.totals.wb.units_sold}
        />
      </div>

      {/* Two columns of top SKUs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <SkuPanel
          title="Ozon"
          accentColor="rgb(0, 91, 255)"
          tint="rgba(0, 91, 255, 0.04)"
          rows={data.top_skus.ozon}
        />
        <SkuPanel
          title="Wildberries"
          accentColor="rgb(203, 17, 122)"
          tint="rgba(203, 17, 122, 0.04)"
          rows={data.top_skus.wb}
        />
      </div>
    </div>
  );
}

function HeadlineCard({
  title, accentColor, tint, units,
}: { title: string; accentColor: string; tint: string; units: number }) {
  return (
    <div
      style={{
        backgroundColor: tint,
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        padding: '20px 24px',
      }}
    >
      <div className="flex items-center gap-2" style={{ fontSize: '16px', fontWeight: 700, color: accentColor }}>
        <ShoppingCart className="h-4 w-4" />
        {title}
      </div>
      <div className="mt-3" style={{ fontSize: '40px', fontWeight: 900, color: 'var(--fg-1)', lineHeight: 1 }}>
        {units.toLocaleString('en-US')}
      </div>
      <div className="mt-1" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
        units · last 7 days
      </div>
    </div>
  );
}

function SkuPanel({
  title, accentColor, tint, rows,
}: { title: string; accentColor: string; tint: string; rows: SkuRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const top5 = rows.slice(0, 5);
  const next15 = rows.slice(5, 20);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3" style={{ fontSize: '18px', fontWeight: 700, color: accentColor }}>
        <ShoppingCart className="h-4 w-4" />
        {title} — top SKUs
      </div>

      <div
        className="overflow-hidden"
        style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}
      >
        <table className="w-full" style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: '14px' }}>
          <thead>
            <tr style={{ backgroundColor: tint }}>
              <Th>SKU</Th>
              <Th right>Sold</Th>
              <Th right>Price</Th>
              <Th right title="Position in category (lower = better)">Pos</Th>
              <Th right title="CTR = views→cart, CR = cart→buy">CTR / CR</Th>
              <Th right title="Ad spend / revenue">DRR</Th>
            </tr>
          </thead>
          <tbody>
            {top5.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>
                  No sales data
                </td>
              </tr>
            ) : top5.map((r) => <SkuRowRender key={r.sku} row={r} />)}

            {expanded && next15.map((r) => <SkuRowRender key={r.sku} row={r} dim />)}
          </tbody>
        </table>

        {next15.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center justify-center gap-2 py-2"
            style={{
              backgroundColor: 'var(--paper-sunk)',
              borderTop: '1px solid var(--border-hairline)',
              fontSize: '14px',
              color: 'var(--fg-2)',
              cursor: 'pointer',
            }}
          >
            {expanded ? (
              <>
                <ChevronUp className="h-4 w-4" />
                Hide
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" />
                Show top {Math.min(20, rows.length)}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function SkuRowRender({ row, dim }: { row: SkuRow; dim?: boolean }) {
  const ctr = row.views > 0 ? (row.tocart_count / row.views) * 100 : null;
  const cr = row.tocart_count > 0 ? (row.units_sold / row.tocart_count) * 100 : null;
  const drr = row.revenue_rub > 0 && row.ad_spend_rub > 0
    ? (row.ad_spend_rub / row.revenue_rub) * 100
    : null;

  const opacity = dim ? 0.85 : 1;
  const skuUpper = row.sku.toUpperCase();
  const shortName = (row.product_name || '').replace(/Toothpaste|Brush/i, '').trim();

  return (
    <tr style={{ borderBottom: '1px solid var(--border-hairline)', opacity }}>
      <td className="px-3 py-2.5">
        <div style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{skuUpper}</div>
        <div style={{ fontSize: '13px', color: 'var(--fg-3)' }}>{shortName}</div>
      </td>
      <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700, color: 'var(--fg-1)' }}>
        {row.units_sold.toLocaleString('en-US')}
      </td>
      <td className="px-3 py-2.5 text-right" style={{ color: 'var(--fg-1)' }}>
        {row.current_price_rub != null
          ? `${(row.current_price_rub / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} ₽`
          : <span style={{ color: 'var(--fg-muted)' }}>—</span>
        }
      </td>
      <td className="px-3 py-2.5 text-right" style={{ color: 'var(--fg-1)' }}>
        {row.position_category != null
          ? Math.round(row.position_category)
          : <span style={{ color: 'var(--fg-muted)' }}>—</span>
        }
      </td>
      <td className="px-3 py-2.5 text-right" style={{ color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums' }}>
        {ctr != null && cr != null
          ? <>
              <span>{ctr.toFixed(1)}%</span>
              <span style={{ color: 'var(--fg-muted)', margin: '0 4px' }}>/</span>
              <span>{cr.toFixed(1)}%</span>
            </>
          : <span style={{ color: 'var(--fg-muted)' }}>—</span>
        }
      </td>
      <td className="px-3 py-2.5 text-right" style={{ color: drr != null ? drrColor(drr) : 'var(--fg-muted)', fontWeight: drr != null ? 700 : 400 }}>
        {drr != null ? `${drr.toFixed(1)}%` : '—'}
      </td>
    </tr>
  );
}

function drrColor(drr: number): string {
  if (drr <= 10) return 'rgb(34, 139, 69)';   // green
  if (drr <= 25) return 'rgb(180, 130, 0)';   // amber
  return 'var(--brand-rot)';                  // red
}

function Th({ children, right, title }: { children: React.ReactNode; right?: boolean; title?: string }) {
  return (
    <th
      title={title}
      className={`px-3 py-2.5 ${right ? 'text-right' : 'text-left'}`}
      style={{
        fontSize: '13px',
        color: 'var(--fg-3)',
        fontWeight: 500,
        borderBottom: '1px solid var(--border-hairline)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}
