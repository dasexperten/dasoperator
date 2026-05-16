'use client';

export const runtime = 'edge';

import { useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  AlertTriangle,
  Download,
  ShoppingCart,
} from 'lucide-react';

const OZON_BLUE = 'rgb(0, 91, 255)';
const WB_PINK = 'rgb(203, 17, 122)';

const OZON_CONFIG = {
  accent: OZON_BLUE,
  accentLabel: 'OZON FBO · SUPPLY PLANNING',
  statusUrl: 'https://raw.githubusercontent.com/dasexperten/arams-db/main/docs/ozon-fbo-status.json',
  runsUrl:
    'https://api.github.com/repos/dasexperten/arams-db/actions/workflows/ozon-fbo-monthly.yml/runs?per_page=10',
  workflowUrl: 'https://github.com/dasexperten/arams-db/actions/workflows/ozon-fbo-monthly.yml',
  clusterOrder: [
    'Москва',
    'Санкт-Петербург',
    'Екатеринбург',
    'Казань',
    'Краснодар',
    'Ростов-на-Дону',
    'Новосибирск',
    'Хабаровск',
  ],
  csvPrefix: 'ozon_fbo',
};

const WB_CONFIG = {
  accent: WB_PINK,
  accentLabel: 'WB FBO · SUPPLY PLANNING',
  statusUrl: 'https://raw.githubusercontent.com/dasexperten/arams-db/main/docs/wb-fbo-status.json',
  runsUrl:
    'https://api.github.com/repos/dasexperten/arams-db/actions/workflows/wb-fbo-monthly.yml/runs?per_page=10',
  workflowUrl: 'https://github.com/dasexperten/arams-db/actions/workflows/wb-fbo-monthly.yml',
  clusterOrder: [] as string[],
  csvPrefix: 'wb_fbo',
};

interface DashboardConfig {
  accent: string;
  accentLabel: string;
  statusUrl: string;
  runsUrl: string;
  workflowUrl: string;
  clusterOrder: string[];
  csvPrefix: string;
}

interface ClusterStats {
  to_ship: number;
  sku_count: number;
  oos: number;
  deficit: number;
}

interface SkuRow {
  sku: string;
  cluster: string;
  stock: number;
  sales_30d: number;
  k: number | null;
  zone: string;
  to_ship: number;
  flag?: string;
  global_oos?: boolean;
  barcodes?: string[];
}

interface FboStatus {
  run_date: string;
  generated_at: string;
  stocks_rows: number;
  sales_rows: number;
  total_skus: number;
  to_ship_count: number;
  to_ship_units: number;
  oos_count: number;
  overstock_count: number;
  unknown_pack: number;
  clusters: Record<string, ClusterStats>;
  skus: SkuRow[];
}

interface RunRow {
  run_number: number;
  created_at: string;
  updated_at: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

type FilterType = 'toship' | 'top5' | 'stockout' | 'overstock' | null;
type Tab = 'ozon' | 'wb';

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

export default function MarketplacesPage() {
  const [tab, setTab] = useState<Tab>('ozon');

  return (
    <div className="space-y-6 max-w-full">
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
          FBO supply planning · Ozon and Wildberries
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
        <TabButton
          active={tab === 'ozon'}
          onClick={() => setTab('ozon')}
          label="Ozon FBO"
          accent={OZON_BLUE}
        />
        <TabButton
          active={tab === 'wb'}
          onClick={() => setTab('wb')}
          label="WB FBO"
          accent={WB_PINK}
        />
      </div>

      {tab === 'ozon' && <FboDashboard config={OZON_CONFIG} key="ozon" />}
      {tab === 'wb' && <FboDashboard config={WB_CONFIG} key="wb" />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '12px 24px',
        fontSize: '15px',
        fontWeight: 700,
        color: active ? accent : 'var(--fg-2)',
        backgroundColor: 'transparent',
        border: 'none',
        borderBottom: active ? `2px solid ${accent}` : '2px solid transparent',
        marginBottom: '-1px',
        cursor: 'pointer',
        fontFamily: 'var(--font-body)',
        transition: 'color 120ms',
      }}
    >
      {label}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   FBO DASHBOARD (shared by Ozon and WB)
   ════════════════════════════════════════════════════════════════════════ */

function FboDashboard({ config }: { config: DashboardConfig }) {
  const [status, setStatus] = useState<FboStatus | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>(null);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(config.statusUrl + '?t=' + Date.now());
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as FboStatus;
      setStatus(d);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Load failed';
      setError(
        msg.includes('404')
          ? 'No run yet — start the workflow in GitHub Actions.'
          : msg,
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadRuns() {
    setRunsLoading(true);
    setRunsError(null);
    try {
      const r = await fetch(config.runsUrl, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setRuns((data.workflow_runs || []) as RunRow[]);
    } catch (e) {
      setRunsError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setRunsLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
    loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.statusUrl]);

  function reload() {
    loadStatus();
    loadRuns();
  }

  const skuAgg = useMemo(() => {
    const agg: Record<string, { stock: number; sales: number }> = {};
    if (!status) return agg;
    for (const s of status.skus) {
      if (!agg[s.sku]) agg[s.sku] = { stock: 0, sales: 0 };
      agg[s.sku].stock += s.stock || 0;
      agg[s.sku].sales += s.sales_30d || 0;
    }
    return agg;
  }, [status]);

  const skuColorMap = useMemo(() => {
    const m: Record<string, 'red' | 'green' | 'neutral'> = {};
    for (const [sku, v] of Object.entries(skuAgg)) {
      if (v.sales === 0) continue;
      const k = v.stock / v.sales;
      m[sku] = k >= 2.0 ? 'red' : k < 0.7 ? 'green' : 'neutral';
    }
    return m;
  }, [skuAgg]);

  const skusByCluster = useMemo(() => {
    const map: Record<string, SkuRow[]> = {};
    if (!status) return map;
    for (const s of status.skus) {
      const cl = s.cluster || '';
      if (!map[cl]) map[cl] = [];
      map[cl].push(s);
    }
    return map;
  }, [status]);

  const clusterKeys = useMemo(() => {
    if (!status) return [];
    const clusters = status.clusters || {};
    if (config.clusterOrder.length > 0) {
      // Use predefined order for Ozon
      const ordered = config.clusterOrder.filter((k) => clusters[k]);
      Object.keys(clusters).forEach((k) => {
        if (!config.clusterOrder.includes(k) && k !== 'UNKNOWN') ordered.push(k);
      });
      return ordered;
    }
    // For WB: sort by to_ship desc
    return Object.keys(clusters)
      .filter((k) => k !== 'UNKNOWN')
      .sort((a, b) => (clusters[b].to_ship || 0) - (clusters[a].to_ship || 0));
  }, [status, config.clusterOrder]);

  if (loading && !status) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
      </div>
    );
  }

  if (error && !status) {
    return (
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
    );
  }

  if (!status) return null;

  return (
    <div className="space-y-8">
      {/* Hero sub */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div
            style={{
              fontSize: '13px',
              fontWeight: 700,
              color: config.accent,
              marginBottom: 6,
            }}
          >
            {config.accentLabel}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '28px',
              fontWeight: 900,
              color: 'var(--fg-1)',
              lineHeight: 1.1,
              letterSpacing: 0,
            }}
          >
            Supply control center
          </div>
          <div className="mt-2" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            run_date={status.run_date} · stocks={fmt(status.stocks_rows)} · sales=
            {fmt(status.sales_rows)}
          </div>
        </div>
        <button
          onClick={reload}
          className="flex items-center gap-2 px-3 py-1.5"
          style={{
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px',
            color: 'var(--fg-1)',
            cursor: 'pointer',
          }}
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* OOS banner */}
      {status.oos_count > 0 && (
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{
            backgroundColor: 'rgba(229,32,44,0.06)',
            border: '1px solid rgba(229,32,44,0.25)',
            color: 'var(--brand-rot)',
            borderRadius: 'var(--radius-md)',
            fontSize: '14px',
            fontWeight: 600,
          }}
        >
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>
            <strong style={{ fontWeight: 800 }}>{status.oos_count}</strong> SKUs out of stock —
            priority shipment required
          </span>
        </div>
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          value={fmt(status.to_ship_units)}
          label="Units to ship"
          tone="accent"
          accent={config.accent}
          active={filter === 'toship'}
          onClick={() => setFilter(filter === 'toship' ? null : 'toship')}
        />
        <MetricCard
          value={fmt(status.to_ship_count)}
          label="Top-5 sales"
          tone="default"
          accent={config.accent}
          active={filter === 'top5'}
          onClick={() => setFilter(filter === 'top5' ? null : 'top5')}
        />
        <MetricCard
          value={fmt(status.oos_count)}
          label="Stock-out"
          tone={status.oos_count > 0 ? 'danger' : 'default'}
          accent={config.accent}
          active={filter === 'stockout'}
          onClick={() => setFilter(filter === 'stockout' ? null : 'stockout')}
        />
        <MetricCard
          value={fmt(status.overstock_count)}
          label="Overstock"
          tone="default"
          accent={config.accent}
          active={filter === 'overstock'}
          onClick={() => setFilter(filter === 'overstock' ? null : 'overstock')}
        />
      </div>

      {/* Clusters accordion */}
      {clusterKeys.length > 0 && (
        <div>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '18px',
              fontWeight: 700,
              color: 'var(--fg-1)',
              marginBottom: 12,
            }}
          >
            By cluster
          </div>
          <div className="space-y-2">
            {clusterKeys.map((cl) => (
              <ClusterItem
                key={cl}
                cluster={cl}
                stats={status.clusters[cl]}
                skus={skusByCluster[cl] || []}
                skuAgg={skuAgg}
                skuColorMap={skuColorMap}
                filter={filter}
                accent={config.accent}
                csvPrefix={config.csvPrefix}
              />
            ))}
          </div>
        </div>
      )}

      {/* Runs history */}
      <div>
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '18px',
            fontWeight: 700,
            color: 'var(--fg-1)',
            marginBottom: 12,
          }}
        >
          Run history
        </div>
        {runsLoading && (
          <div
            className="flex items-center gap-2 py-4"
            style={{ color: 'var(--fg-muted)', fontSize: '14px' }}
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}
        {runsError && !runsLoading && (
          <div style={{ color: 'var(--brand-rot)', fontSize: '14px' }}>{runsError}</div>
        )}
        {!runsLoading && !runsError && <RunsTable runs={runs} accent={config.accent} />}
      </div>
    </div>
  );
}

function MetricCard({
  value,
  label,
  tone,
  accent,
  active,
  onClick,
}: {
  value: string;
  label: string;
  tone: 'accent' | 'danger' | 'default';
  accent: string;
  active: boolean;
  onClick: () => void;
}) {
  let valueColor = 'var(--fg-1)';
  if (tone === 'accent') valueColor = accent;
  if (tone === 'danger') valueColor = 'var(--brand-rot)';

  return (
    <button
      onClick={onClick}
      style={{
        backgroundColor: 'var(--paper-1)',
        border: '1px solid var(--border-hairline)',
        outline: active ? `2px solid ${accent}` : 'none',
        outlineOffset: 2,
        borderRadius: 'var(--radius-md)',
        padding: '20px',
        textAlign: 'left',
        cursor: 'pointer',
        transition: 'transform 120ms, box-shadow 120ms',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '32px',
          fontWeight: 900,
          lineHeight: 1,
          color: valueColor,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg-2)' }}>{label}</div>
    </button>
  );
}

function ClusterItem({
  cluster,
  stats,
  skus,
  skuAgg,
  skuColorMap,
  filter,
  accent,
  csvPrefix,
}: {
  cluster: string;
  stats: ClusterStats;
  skus: SkuRow[];
  skuAgg: Record<string, { stock: number; sales: number }>;
  skuColorMap: Record<string, 'red' | 'green' | 'neutral'>;
  filter: FilterType;
  accent: string;
  csvPrefix: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (filter) setOpen(true);
  }, [filter]);

  function downloadCsv() {
    const rows = skus.filter((s) => (s.to_ship || 0) > 0);
    if (!rows.length) {
      alert(`No items to ship for ${cluster}`);
      return;
    }
    const lines = ['SKU,Quantity'];
    for (const r of rows) lines.push(`${r.sku},${r.to_ship}`);
    const csv = '\uFEFF' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const dt = new Date().toISOString().slice(0, 10);
    a.download = `${csvPrefix}_${cluster}_${dt}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const visibleSkus = useMemo(() => {
    let list = [...skus];
    list.sort(
      (a, b) =>
        (b.to_ship || 0) - (a.to_ship || 0) || (b.sales_30d || 0) - (a.sales_30d || 0),
    );
    if (filter === 'stockout') {
      list = list.filter((s) => (skuAgg[s.sku]?.stock || 0) === 0);
    } else if (filter === 'overstock') {
      list = list.filter((s) => s.zone === 'OVERSTOCK');
      list.sort((a, b) => (b.k || 0) - (a.k || 0));
    } else if (filter === 'toship') {
      list = list.filter((s) => (s.to_ship || 0) > 0);
    } else if (filter === 'top5') {
      list.sort((a, b) => (b.sales_30d || 0) - (a.sales_30d || 0));
      list = list.slice(0, 5);
    } else {
      list.sort((a, b) => (b.stock || 0) - (a.stock || 0));
    }
    return list;
  }, [skus, filter, skuAgg]);

  return (
    <div
      style={{
        backgroundColor: 'var(--paper-1)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 20,
          padding: '20px 24px',
          backgroundColor: 'transparent',
          border: 'none',
          borderBottom: open ? '1px solid var(--border-hairline)' : 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '24px',
            fontWeight: 800,
            color: accent,
            flex: 1,
            letterSpacing: 0,
          }}
        >
          {cluster}
        </div>
        <div style={{ minWidth: 130, flexShrink: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '26px',
              fontWeight: 900,
              lineHeight: 1,
              color: 'var(--fg-1)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {fmt(stats.to_ship)}
          </div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--fg-2)', marginTop: 2 }}>
            units to ship
          </div>
        </div>
        <div style={{ fontSize: '14px', color: 'var(--fg-2)', minWidth: 160 }}>
          <strong style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{stats.sku_count}</strong> SKUs
          {stats.oos > 0 && (
            <span style={{ color: 'var(--brand-rot)', fontWeight: 700, marginLeft: 6 }}>
              · {stats.oos} stock-out
            </span>
          )}
        </div>
        <ChevronDown
          className="h-5 w-5"
          style={{
            color: 'var(--fg-muted)',
            transition: 'transform 200ms',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {open && (
        <div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ backgroundColor: 'var(--paper-sunk)' }}>
                  <th style={thStyle}>SKU</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Stock</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Sales 30d</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>K</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>To ship</th>
                </tr>
              </thead>
              <tbody>
                {visibleSkus.map((s, i) => {
                  const col = skuColorMap[s.sku];
                  const isOos = (skuAgg[s.sku]?.stock || 0) === 0;
                  const rowBg =
                    col === 'red'
                      ? 'rgba(229,32,44,0.05)'
                      : col === 'green'
                      ? 'rgba(138,96,0,0.06)'
                      : s.zone === 'DEFICIT'
                      ? 'rgba(212,160,23,0.04)'
                      : s.zone === 'OVERSTOCK'
                      ? 'rgba(229,32,44,0.04)'
                      : 'transparent';
                  const skuColor =
                    col === 'red'
                      ? 'var(--brand-rot)'
                      : col === 'green'
                      ? '#8A6000'
                      : 'var(--fg-1)';
                  const agg = skuAgg[s.sku];
                  const aggK = agg && agg.sales > 0 ? (agg.stock / agg.sales).toFixed(2) : null;
                  const showAggK = aggK && col;
                  const kDisplay = s.k != null ? Number(s.k).toFixed(2) : '—';

                  return (
                    <tr
                      key={`${s.sku}-${i}`}
                      style={{
                        backgroundColor: rowBg,
                        borderBottom: '1px solid var(--border-hairline)',
                      }}
                    >
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 700, color: skuColor }}>{s.sku}</span>
                        {showAggK && (
                          <span
                            title="Global K across all clusters"
                            style={{
                              fontSize: '12px',
                              fontWeight: 600,
                              color: 'var(--fg-muted)',
                              marginLeft: 8,
                            }}
                          >
                            (K={aggK})
                          </span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>
                        {fmt(s.stock)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>
                        {fmt(s.sales_30d)}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          textAlign: 'right',
                          fontWeight: 600,
                          color: 'var(--fg-2)',
                        }}
                      >
                        {kDisplay}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800 }}>
                        {(s.to_ship || 0) > 0 ? (
                          <>
                            {fmt(s.to_ship)}
                            {isOos && (
                              <AlertTriangle
                                className="inline-block ml-1"
                                style={{ width: 14, height: 14, color: 'var(--brand-rot)' }}
                              />
                            )}
                          </>
                        ) : (
                          <span style={{ color: 'var(--fg-muted)', fontWeight: 400 }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div
            style={{
              padding: '16px 24px',
              borderTop: '1px solid var(--border-hairline)',
              backgroundColor: 'var(--paper-sunk)',
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <button
              onClick={downloadCsv}
              className="inline-flex items-center gap-2"
              style={{
                padding: '10px 22px',
                backgroundColor: accent,
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                fontSize: '14px',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              <Download className="h-4 w-4" />
              Create supply (CSV)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunsTable({ runs, accent }: { runs: RunRow[]; accent: string }) {
  if (!runs.length) {
    return (
      <div style={{ padding: 20, color: 'var(--fg-muted)', fontSize: '14px' }}>No runs yet</div>
    );
  }
  return (
    <div
      style={{
        backgroundColor: 'var(--paper-1)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
        <thead>
          <tr style={{ backgroundColor: 'var(--paper-sunk)' }}>
            <th style={thStyle}>#</th>
            <th style={thStyle}>Run date</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Duration</th>
            <th style={thStyle}>Log</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const cr = r.created_at ? new Date(r.created_at) : null;
            const up = r.updated_at ? new Date(r.updated_at) : null;
            const dur =
              cr && up ? Math.max(0, Math.round((+up - +cr) / 60000)) + ' min' : '—';
            return (
              <tr key={r.run_number} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <td style={{ ...tdStyle, color: 'var(--fg-muted)', fontWeight: 700 }}>
                  #{r.run_number}
                </td>
                <td style={{ ...tdStyle, fontWeight: 700 }}>
                  {cr ? cr.toLocaleString('en-GB') : '—'}
                </td>
                <td style={tdStyle}>
                  <RunBadge conclusion={r.conclusion} status={r.status} />
                </td>
                <td style={{ ...tdStyle, color: 'var(--fg-2)', fontWeight: 700 }}>{dur}</td>
                <td style={tdStyle}>
                  <a
                    href={r.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: accent,
                      fontWeight: 700,
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    Log
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RunBadge({
  conclusion,
  status,
}: {
  conclusion: string | null;
  status: string;
}) {
  let bg = 'var(--paper-sunk)';
  let color = 'var(--fg-muted)';
  let label = conclusion || status || '?';
  if (status === 'in_progress' || status === 'queued') {
    bg = 'rgba(212,160,23,0.12)';
    color = '#8A6000';
    label = 'in progress';
  } else if (conclusion === 'success') {
    bg = 'rgba(46,125,79,0.12)';
    color = '#2E7D4F';
    label = 'success';
  } else if (conclusion === 'failure') {
    bg = 'rgba(229,32,44,0.10)';
    color = 'var(--brand-rot)';
    label = 'failure';
  } else if (conclusion === 'cancelled') {
    label = 'cancelled';
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 10px',
        backgroundColor: bg,
        color,
        fontSize: '12px',
        fontWeight: 700,
        borderRadius: 'var(--radius-pill)',
      }}
    >
      {label}
    </span>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '12px 16px',
  fontFamily: 'var(--font-body)',
  fontSize: '13px',
  fontWeight: 700,
  color: 'var(--fg-2)',
  borderBottom: '1px solid var(--border-hairline)',
  letterSpacing: 0,
};

const tdStyle: React.CSSProperties = {
  padding: '12px 16px',
  color: 'var(--fg-1)',
};
