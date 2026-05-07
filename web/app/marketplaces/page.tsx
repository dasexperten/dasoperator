'use client';

import { useEffect, useState, useMemo } from 'react';
import {
  Loader2, ShoppingCart, CheckCircle2, XCircle, Clock, RefreshCw,
  TrendingUp, BarChart3,
} from 'lucide-react';
import {
  getMarketplaceHealth, getMarketplaceSyncLog, getMarketplaceSales,
  type MarketplaceHealthResponse, type MarketplaceSyncLogEntry,
  type MarketplaceSalesResponse,
} from '@/lib/api';

type Tab = 'sales' | 'sync';

export default function MarketplacesPage() {
  const [tab, setTab] = useState<Tab>('sales');
  const [health, setHealth] = useState<MarketplaceHealthResponse | null>(null);
  const [log, setLog] = useState<MarketplaceSyncLogEntry[]>([]);
  const [sales, setSales] = useState<MarketplaceSalesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [hRes, lRes, sRes] = await Promise.all([
        getMarketplaceHealth(),
        getMarketplaceSyncLog(20),
        getMarketplaceSales(),
      ]);
      if (hRes.success && hRes.result) setHealth(hRes.result);
      if (lRes.success && lRes.result) setLog(lRes.result.log);
      if (sRes.success && sRes.result) setSales(sRes.result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-8 max-w-full">
      <div>
        <div className="dx-eyebrow-rot mb-2">Sales channels</div>
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
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          Wildberries and Ozon — sales over last 30 days, sync status, and top performers.
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      {/* Tabs */}
      <div className="flex items-center gap-1" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
        <TabButton active={tab === 'sales'} onClick={() => setTab('sales')} icon={<TrendingUp className="h-4 w-4" />}>Sales</TabButton>
        <TabButton active={tab === 'sync'}  onClick={() => setTab('sync')}  icon={<BarChart3 className="h-4 w-4" />}>Sync status</TabButton>

        <div className="ml-auto pb-2">
          <button
            onClick={() => load()}
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
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      )}

      {error && (
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          Error: {error}
        </div>
      )}

      {!loading && !error && tab === 'sales' && (
        <SalesTab data={sales} />
      )}

      {!loading && !error && tab === 'sync' && (
        <SyncTab health={health} log={log} />
      )}
    </div>
  );
}

// =============================================================================
// Sales tab
// =============================================================================

function SalesTab({ data }: { data: MarketplaceSalesResponse | null }) {
  if (!data) return null;

  const ozonRevRub = data.totals.ozon.revenue_rub / 100;
  const wbRevRub = data.totals.wb.revenue_rub / 100;
  const ozonUnits = data.totals.ozon.units_sold;
  const wbUnits = data.totals.wb.units_sold;

  return (
    <>
      {/* Two big cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SalesCard
          title="Ozon"
          tint="rgba(0, 91, 255, 0.06)"
          accentColor="rgb(0, 91, 255)"
          units={ozonUnits}
          revenue={ozonRevRub}
          syncedAt={data.totals.ozon.synced_at}
        />
        <SalesCard
          title="Wildberries"
          tint="rgba(203, 17, 122, 0.06)"
          accentColor="rgb(203, 17, 122)"
          units={wbUnits}
          revenue={wbRevRub}
          syncedAt={data.totals.wb.synced_at}
        />
      </div>

      {/* Daily chart */}
      {data.daily.length > 0 && (
        <DailyChart daily={data.daily} />
      )}

      {/* Top SKUs table */}
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)', marginBottom: '12px' }}>
          Top SKUs by revenue (last 30 days)
        </h2>

        {data.top_skus.length === 0 ? (
          <div
            className="text-center py-12"
            style={{
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-md)',
              fontSize: '14px', color: 'var(--fg-3)',
            }}
          >
            No sales data yet — sync hasn't run or no products have sold in 30 days.
          </div>
        ) : (
          <div className="overflow-x-auto" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
            <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr>
                  <Th>SKU</Th>
                  <Th>Product</Th>
                  <Th right tint="rgba(0, 91, 255, 0.06)">Ozon units</Th>
                  <Th right tint="rgba(0, 91, 255, 0.06)">Ozon revenue</Th>
                  <Th right tint="rgba(203, 17, 122, 0.06)">WB units</Th>
                  <Th right tint="rgba(203, 17, 122, 0.06)">WB revenue</Th>
                  <Th right>Total revenue</Th>
                </tr>
              </thead>
              <tbody>
                {data.top_skus.map((row) => {
                  const total = (row.ozon_revenue + row.wb_revenue) / 100;
                  const skuUpper = row.sku.toUpperCase();
                  return (
                    <tr key={row.sku} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td className="px-3 py-2" style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: '14px' }}>{skuUpper}</td>
                      <td className="px-3 py-2" style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: '14px' }}>{row.product_name}</td>
                      <td className="px-3 py-2 text-right" style={{ backgroundColor: 'rgba(0, 91, 255, 0.04)', fontSize: '14px', color: row.ozon_units > 0 ? 'var(--fg-1)' : 'var(--fg-muted)' }}>
                        {row.ozon_units > 0 ? row.ozon_units.toLocaleString('en-US') : '—'}
                      </td>
                      <td className="px-3 py-2 text-right" style={{ backgroundColor: 'rgba(0, 91, 255, 0.04)', fontSize: '14px', color: row.ozon_revenue > 0 ? 'var(--fg-1)' : 'var(--fg-muted)' }}>
                        {row.ozon_revenue > 0 ? formatRub(row.ozon_revenue / 100) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right" style={{ backgroundColor: 'rgba(203, 17, 122, 0.04)', fontSize: '14px', color: row.wb_units > 0 ? 'var(--fg-1)' : 'var(--fg-muted)' }}>
                        {row.wb_units > 0 ? row.wb_units.toLocaleString('en-US') : '—'}
                      </td>
                      <td className="px-3 py-2 text-right" style={{ backgroundColor: 'rgba(203, 17, 122, 0.04)', fontSize: '14px', color: row.wb_revenue > 0 ? 'var(--fg-1)' : 'var(--fg-muted)' }}>
                        {row.wb_revenue > 0 ? formatRub(row.wb_revenue / 100) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right" style={{ fontWeight: 700, color: 'var(--fg-1)', fontSize: '14px', backgroundColor: 'var(--paper-sunk)' }}>
                        {formatRub(total)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function SalesCard({
  title, tint, accentColor, units, revenue, syncedAt,
}: {
  title: string; tint: string; accentColor: string;
  units: number; revenue: number; syncedAt: number | null;
}) {
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
      <div className="mt-4">
        <div style={{ fontSize: '36px', fontWeight: 900, color: 'var(--fg-1)', lineHeight: 1 }}>
          {units.toLocaleString('en-US')}
          <span style={{ fontSize: '14px', fontWeight: 400, color: 'var(--fg-2)', marginLeft: '6px' }}>units</span>
        </div>
        <div className="mt-2" style={{ fontSize: '24px', fontWeight: 700, color: 'var(--fg-1)' }}>
          {formatRub(revenue)}
        </div>
        <div className="mt-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
          over last 30 days · {syncedAt ? `synced ${formatRelative(syncedAt)}` : 'never synced'}
        </div>
      </div>
    </div>
  );
}

// Simple bar chart (no external lib): one bar per day, two colors stacked
function DailyChart({ daily }: { daily: MarketplaceSalesResponse['daily'] }) {
  // Aggregate by date: { date → { ozon: revenue, wb: revenue } }
  const byDate = new Map<string, { ozon: number; wb: number }>();
  for (const d of daily) {
    const cur = byDate.get(d.date) || { ozon: 0, wb: 0 };
    if (d.marketplace === 'ozon') cur.ozon += d.revenue_rub;
    if (d.marketplace === 'wb')   cur.wb += d.revenue_rub;
    byDate.set(d.date, cur);
  }
  const sorted = Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b));
  const maxRev = Math.max(0, ...sorted.map(([, v]) => v.ozon + v.wb));

  return (
    <div>
      <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)', marginBottom: '12px' }}>
        Revenue by day (last 30 days)
      </h2>
      <div
        style={{
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          padding: '20px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '180px' }}>
          {sorted.map(([date, v]) => {
            const total = v.ozon + v.wb;
            const heightPct = maxRev > 0 ? (total / maxRev) * 100 : 0;
            const ozonPct = total > 0 ? (v.ozon / total) * 100 : 0;
            const dateLabel = date.substring(8, 10);
            const totalRub = total / 100;
            return (
              <div key={date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div
                  title={`${date}: ${formatRub(totalRub)} (Ozon ${formatRub(v.ozon / 100)} + WB ${formatRub(v.wb / 100)})`}
                  style={{
                    width: '100%',
                    height: `${heightPct}%`,
                    minHeight: total > 0 ? '4px' : '0',
                    backgroundColor: 'rgba(203, 17, 122, 0.7)',
                    position: 'relative',
                    borderRadius: '2px 2px 0 0',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{
                    width: '100%',
                    height: `${ozonPct}%`,
                    backgroundColor: 'rgba(0, 91, 255, 0.7)',
                  }} />
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '14px', color: 'var(--fg-3)' }}>
          {sorted.length > 0 && (
            <>
              <span>{formatChartDate(sorted[0][0])}</span>
              <span>{formatChartDate(sorted[Math.floor(sorted.length / 2)][0])}</span>
              <span>{formatChartDate(sorted[sorted.length - 1][0])}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-6 mt-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
          <div className="flex items-center gap-2">
            <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(0, 91, 255, 0.7)', borderRadius: '2px' }}></span>
            Ozon
          </div>
          <div className="flex items-center gap-2">
            <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: 'rgba(203, 17, 122, 0.7)', borderRadius: '2px' }}></span>
            Wildberries
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Sync tab (existing content from Phase 6.0b)
// =============================================================================

function SyncTab({ health, log }: { health: MarketplaceHealthResponse | null; log: MarketplaceSyncLogEntry[] }) {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <HealthCard title="Ozon" tint="rgba(0, 91, 255, 0.06)" entry={health?.ozon ?? null} />
        <HealthCard title="Wildberries" tint="rgba(203, 17, 122, 0.06)" entry={health?.wb ?? null} />
      </div>

      <div
        className="flex items-start gap-3 p-4"
        style={{
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '14px',
          color: 'var(--fg-2)',
        }}
      >
        <Clock className="h-5 w-5 mt-0.5 flex-shrink-0" style={{ color: 'var(--fg-muted)' }} />
        <div>
          <div style={{ color: 'var(--fg-1)', fontWeight: 700 }}>Auto sync schedule</div>
          <div className="mt-1">
            Stocks refresh every hour (00 minutes UTC). Sales refresh every 4 hours (00, 04, 08, 12, 16, 20 UTC). WB has a strict rate limit, so syncs run sequentially: Ozon first, then WB after a brief pause.
          </div>
        </div>
      </div>

      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)', marginBottom: '12px' }}>Recent syncs</h2>
        <div className="overflow-x-auto" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
          <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Marketplace</Th>
                <Th>Status</Th>
                <Th>Duration</Th>
                <Th right>Rows synced</Th>
                <Th>Error</Th>
              </tr>
            </thead>
            <tbody>
              {log.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>No syncs recorded yet</td>
                </tr>
              ) : log.map((entry) => (
                <tr key={entry.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-1)' }}>{formatTimestamp(entry.started_at)}</td>
                  <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-1)', fontWeight: 700 }}>{marketplaceLabel(entry.marketplace)}</td>
                  <td className="px-3 py-2"><StatusPill status={entry.status} /></td>
                  <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{formatDuration(entry.started_at, entry.finished_at)}</td>
                  <td className="px-3 py-2 text-right" style={{ fontSize: '14px', color: entry.rows_synced ? 'var(--fg-1)' : 'var(--fg-muted)' }}>
                    {entry.rows_synced != null ? entry.rows_synced.toLocaleString('en-US') : '—'}
                  </td>
                  <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--brand-rot)', maxWidth: '320px' }}>
                    {entry.error_message ? truncate(entry.error_message, 80) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function HealthCard({ title, tint, entry }: { title: string; tint: string; entry: any }) {
  return (
    <div style={{ backgroundColor: tint, border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', padding: '16px 18px' }}>
      <div className="flex items-center gap-2" style={{ fontSize: '16px', fontWeight: 700, color: 'var(--fg-1)' }}>
        <ShoppingCart className="h-4 w-4" />
        {title}
      </div>
      {entry == null ? (
        <div className="mt-3" style={{ fontSize: '14px', color: 'var(--fg-muted)' }}>No syncs recorded yet</div>
      ) : (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <StatusPill status={entry.status} />
            <span style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{formatRelative(entry.finished_at ?? entry.started_at)}</span>
          </div>
          {entry.status === 'ok' && entry.rows_synced != null && (
            <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{entry.rows_synced} rows synced</div>
          )}
          {entry.status === 'error' && entry.error_message && (
            <div style={{ fontSize: '14px', color: 'var(--brand-rot)' }}>{truncate(entry.error_message, 100)}</div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: 'running' | 'ok' | 'error' }) {
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5"
        style={{ backgroundColor: 'rgba(34,139,69,0.10)', color: 'rgb(34,139,69)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 }}>
        <CheckCircle2 className="h-3.5 w-3.5" /> OK
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5"
        style={{ backgroundColor: 'rgba(229,32,44,0.10)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 }}>
        <XCircle className="h-3.5 w-3.5" /> Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5"
      style={{ backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-2)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 }}>
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running
    </span>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function TabButton({ active, onClick, icon, children }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2"
      style={{
        backgroundColor: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: '15px',
        fontWeight: active ? 700 : 400,
        color: active ? 'var(--brand-rot)' : 'var(--fg-2)',
        borderBottom: active ? '2px solid var(--brand-rot)' : '2px solid transparent',
        marginBottom: '-1px',
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function Th({ children, right, tint }: { children: React.ReactNode; right?: boolean; tint?: string }) {
  return (
    <th
      className={`px-3 py-3 ${right ? 'text-right' : 'text-left'}`}
      style={{
        fontSize: '14px',
        color: 'var(--fg-3)',
        backgroundColor: tint ?? 'var(--paper-sunk)',
        borderBottom: '1px solid var(--border-hairline)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

function marketplaceLabel(m: string): string {
  if (m === 'ozon') return 'Ozon';
  if (m === 'wb') return 'Wildberries';
  if (m === 'ozon-sales') return 'Ozon (sales)';
  if (m === 'wb-sales') return 'Wildberries (sales)';
  return m;
}

function formatTimestamp(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatRelative(unix: number): string {
  const diff = Date.now() / 1000 - unix;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatDuration(start: number, end: number | null): string {
  if (end == null) return '—';
  const seconds = end - start;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.substring(0, max - 1) + '…';
}

function formatRub(rub: number): string {
  // Compact for big numbers: 3.3M ₽, 247K ₽
  if (rub >= 1_000_000) return `${(rub / 1_000_000).toFixed(1)}M ₽`;
  if (rub >= 10_000) return `${(rub / 1000).toFixed(0)}K ₽`;
  return `${rub.toLocaleString('en-US', { maximumFractionDigits: 0 })} ₽`;
}

function formatChartDate(date: string): string {
  const d = new Date(date);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
