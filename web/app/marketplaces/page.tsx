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
  Check,
} from 'lucide-react';

const OZON_BLUE = 'rgb(0, 91, 255)';

// Short display names for promo product rows. Keeps the table readable
// Marketplace card uses product.name (from D1 products.product_name) as-is.
// Short, canonical names live in the database — single source of truth.

// Превращает многословные сообщения Ozon в одну короткую человеко-читаемую
// строку. Возвращает оригинал, если паттерн не распознан.
function humanizeOzonError(raw: string): string {
  if (!raw) return 'Не удалось сохранить';
  // Discount-percent reject: "DiscountPercent must be greater or equal than X, but actual is Y"
  const m = raw.match(/DiscountPercent must be greater or equal than ([\d.]+), but actual is ([\d.]+)/i);
  if (m) {
    const required = parseFloat(m[1]);
    return `Ozon требует скидку минимум ${required.toFixed(1)}% — снизь цену сильнее`;
  }
  // Action stopped
  if (/action.*stop|stop.*action/i.test(raw)) {
    return 'Акция уже закрыта на стороне Озона';
  }
  // Product not in action
  if (/not.*found.*action|not.*in.*action/i.test(raw)) {
    return 'Товар больше не в этой акции';
  }
  // Trim "Ozon rejected: product ID NNN: " prefix
  const trimmed = raw.replace(/^Ozon rejected:\s*product ID \d+:\s*/i, '');
  return trimmed.length > 120 ? trimmed.slice(0, 117) + '…' : trimmed;
}
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
type Tab = 'promos' | 'ozon' | 'wb';

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

export default function MarketplacesPage() {
  const [tab, setTab] = useState<Tab>('promos');

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
          Ozon promotions · FBO supply planning · cross-channel insights
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
        <TabButton
          active={tab === 'promos'}
          onClick={() => setTab('promos')}
          label="Promotions"
          accent={OZON_BLUE}
        />
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

      {tab === 'promos' && (
        <>
          <RefillHistoryBlock key="refills" />
          <OzonPromotionsWidget key="promos" />
        </>
      )}
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

/* ════════════════════════════════════════════════════════════════════════
   OZON ACTIVE PROMOTIONS WIDGET
   ════════════════════════════════════════════════════════════════════════ */

interface PromoProduct {
  product_id: number;
  offer_id: string;
  name: string;
  price: number;
  action_price: number;
  discount_pct: number;
  stock: number;
  min_stock: number;
  min_price: number | null;
  current_price: number;
  is_deciding_price: boolean;
  sold_count: number | null;
  left_to_sell: number | null;
  refill_rule: { threshold: number; target: number } | null;
  price_min_elastic: number | null;
  price_max_elastic: number | null;
  current_boost: number | null;
  min_boost: number | null;
  max_boost: number | null;
  fbo_present: number | null;
  fbo_reserved: number | null;
  cluster_fbo_present: number | null;
  cluster_fbo_days: number | null;
  cluster_fbo_warehouse: string | null;
}

interface PromoAction {
  action_id: number;
  title: string;
  action_type: string;
  date_start: string;
  date_end: string;
  days_left: number;
  is_voucher_action: boolean;
  is_participating: boolean;
  participating_products_count: number;
  potential_products_count: number;
  total_units_left: number;
  deciding_count: number;
  auto_zeroed_at: string | null;
  products: PromoProduct[];
}

interface PromosPayload {
  generated_at: string;
  total_actions: number;
  participating_count: number;
  total_units_left: number;
  total_skus_in_promos: number;
  actions: PromoAction[];
}

interface RefillEntry {
  ts: string;
  action_id: number;
  product_id: number;
  sku?: string;
  status: 'refilled' | 'rejected' | 'error';
  from?: number;
  to?: number;
  reason?: string;
}

function RefillHistoryBlock() {
  const [entries, setEntries] = useState<RefillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const apiBase =
        (typeof window !== 'undefined' &&
          (window as unknown as { __API_BASE?: string }).__API_BASE) ||
        'https://dasoperator-api.dasexperten.workers.dev';
      const r = await fetch(`${apiBase}/api/marketplaces/ozon/refill-history`);
      const j = await r.json();
      if (j.success && j.result?.entries) {
        setEntries(j.result.entries as RefillEntry[]);
      }
    } catch {
      // silent — history is informational
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // refresh every 60s so a fresh cron run appears without manual reload
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, []);

  // Hide entirely if cron hasn't run yet — no point showing an empty card
  if (!loading && entries.length === 0) return null;

  const stats = {
    refilled: entries.filter((e) => e.status === 'refilled').length,
    rejected: entries.filter((e) => e.status === 'rejected').length,
    error: entries.filter((e) => e.status === 'error').length,
  };

  // Most recent timestamp
  const lastTs = entries.length > 0 ? entries[0].ts : null;

  const fmtTime = (iso: string) => {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMin = Math.round(diffMs / 60_000);
      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return `${diffMin}m ago`;
      const diffHr = Math.round(diffMin / 60);
      if (diffHr < 24) return `${diffHr}h ago`;
      return d.toISOString().slice(5, 16).replace('T', ' ');
    } catch {
      return iso;
    }
  };

  const statusColor = (s: RefillEntry['status']) => {
    if (s === 'refilled') return '#16a34a'; // green
    if (s === 'rejected') return '#d97706'; // amber
    return 'var(--brand-rot)'; // red
  };
  const statusLabel = (s: RefillEntry['status']) => {
    if (s === 'refilled') return 'Refilled';
    if (s === 'rejected') return 'Rejected';
    return 'Error';
  };

  return (
    <div
      style={{
        backgroundColor: 'var(--paper-1)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        marginBottom: 16,
      }}
    >
      <button
        onClick={() => setCollapsed(!collapsed)}
        style={{
          width: '100%',
          padding: '14px 20px',
          backgroundColor: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          textAlign: 'left',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--fg-1)' }}>
            Auto-refill cron history
          </div>
          <div style={{ fontSize: '13px', color: 'var(--fg-muted)', marginTop: 2 }}>
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
            {lastTs && ` · last ${fmtTime(lastTs)}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: '13px', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ color: '#16a34a', fontWeight: 700 }}>{stats.refilled} ok</span>
          {stats.rejected > 0 && <span style={{ color: '#d97706', fontWeight: 700 }}>{stats.rejected} rejected</span>}
          {stats.error > 0 && <span style={{ color: 'var(--brand-rot)', fontWeight: 700 }}>{stats.error} error</span>}
        </div>
        <span style={{ color: 'var(--fg-muted)', fontSize: '18px' }}>
          {collapsed ? '▸' : '▾'}
        </span>
      </button>
      {!collapsed && entries.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border-hairline)', maxHeight: 360, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--paper-2)', borderBottom: '1px solid var(--border-hairline)' }}>
                <th style={{ textAlign: 'left', padding: '8px 16px', fontWeight: 600, color: 'var(--fg-2)' }}>When</th>
                <th style={{ textAlign: 'left', padding: '8px 16px', fontWeight: 600, color: 'var(--fg-2)' }}>SKU</th>
                <th style={{ textAlign: 'left', padding: '8px 16px', fontWeight: 600, color: 'var(--fg-2)' }}>Action</th>
                <th style={{ textAlign: 'left', padding: '8px 16px', fontWeight: 600, color: 'var(--fg-2)' }}>Status</th>
                <th style={{ textAlign: 'right', padding: '8px 16px', fontWeight: 600, color: 'var(--fg-2)' }}>From → To</th>
                <th style={{ textAlign: 'left', padding: '8px 16px', fontWeight: 600, color: 'var(--fg-2)' }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr
                  key={i}
                  style={{
                    borderBottom: i < entries.length - 1 ? '1px solid var(--border-hairline)' : 'none',
                  }}
                >
                  <td style={{ padding: '8px 16px', color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtTime(e.ts)}
                  </td>
                  <td style={{ padding: '8px 16px', fontWeight: 700, color: 'var(--fg-1)' }}>
                    {e.sku || `pid ${e.product_id}`}
                  </td>
                  <td style={{ padding: '8px 16px', color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>
                    {e.action_id}
                  </td>
                  <td style={{ padding: '8px 16px' }}>
                    <span
                      style={{
                        color: statusColor(e.status),
                        fontWeight: 700,
                      }}
                    >
                      {statusLabel(e.status)}
                    </span>
                  </td>
                  <td style={{ padding: '8px 16px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                    {e.from != null && e.to != null ? `${e.from} → ${e.to}` : '—'}
                  </td>
                  <td style={{ padding: '8px 16px', color: 'var(--fg-muted)', fontSize: '12px' }}>
                    {e.reason || ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OzonPromotionsWidget() {
  const [data, setData] = useState<PromosPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (force = false, silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const apiBase =
        (typeof window !== 'undefined' &&
          (window as unknown as { __API_BASE?: string }).__API_BASE) ||
        'https://dasoperator-api.dasexperten.workers.dev';
      const url = `${apiBase}/api/marketplaces/ozon/actions${force ? '?refresh=1' : ''}`;
      const r = await fetch(url);
      const j = await r.json();
      if (!j.success) throw new Error(j.errors?.[0]?.message || 'API error');
      setData(j.result as PromosPayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading && !data) {
    return (
      <div
        style={{
          backgroundColor: 'var(--paper-1)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          padding: '32px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          color: 'var(--fg-muted)',
        }}
      >
        <Loader2 className="h-5 w-5 animate-spin" />
        <span style={{ fontSize: '14px' }}>Loading Ozon promotions…</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div
        style={{
          backgroundColor: 'rgba(229,32,44,0.05)',
          border: '1px solid rgba(229,32,44,0.2)',
          color: 'var(--brand-rot)',
          padding: '16px',
          borderRadius: 'var(--radius-sm)',
          fontSize: '14px',
        }}
      >
        Failed to load promotions: {error}
      </div>
    );
  }

  if (!data) return null;

  const mostUrgent = data.actions.length > 0 ? data.actions[0] : null;

  return (
    <div
      style={{
        backgroundColor: 'var(--paper-1)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '20px 24px',
          borderBottom: '1px solid var(--border-hairline)',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>
          <div
            style={{
              fontSize: '12px',
              fontWeight: 700,
              color: OZON_BLUE,
              marginBottom: 4,
              letterSpacing: 0,
            }}
          >
            OZON · ACTIVE PROMOTIONS
          </div>
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '22px',
              fontWeight: 900,
              color: 'var(--fg-1)',
              letterSpacing: 0,
            }}
          >
            Sell-through tracker
          </div>
        </div>
        <button
          onClick={() => load(true)}
          className="inline-flex items-center gap-2 px-3 py-1.5"
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

      {/* Metric strip */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <PromoMetric label="Active promos" value={fmt(data.participating_count)} />
        <PromoMetric label="SKUs in promos" value={fmt(data.total_skus_in_promos)} />
        <PromoMetric
          label="Units to sell"
          value={fmt(data.total_units_left)}
          highlight
        />
        <PromoMetric
          label="Most urgent"
          value={mostUrgent ? `${mostUrgent.days_left}d` : '—'}
          subtitle={mostUrgent ? mostUrgent.title.slice(0, 22) : ''}
          tone={mostUrgent && mostUrgent.days_left <= 7 ? 'danger' : 'default'}
        />
      </div>

      {/* Policy notice */}
      <div
        style={{
          padding: '10px 24px',
          borderBottom: '1px solid var(--border-hairline)',
          backgroundColor: 'rgba(212,160,23,0.06)',
          fontSize: '12px',
          fontWeight: 600,
          color: '#8A6000',
          letterSpacing: 0,
        }}
      >
        Policy: stock-discount actions (Распродажа стока etc.) are auto-zeroed on first detection. Raise individual SKUs manually to commit.
      </div>

      {/* Actions list */}
      <div>
        {data.actions.length === 0 && (
          <div style={{ padding: 24, color: 'var(--fg-muted)', fontSize: '14px' }}>
            No active promotions
          </div>
        )}
        {data.actions.map((a) => (
          <PromoActionItem
            key={a.action_id}
            action={a}
            allActions={data.actions}
            onSaved={() => load(false, true)}
          />
        ))}
      </div>
    </div>
  );
}

function PromoMetric({
  label,
  value,
  subtitle,
  highlight,
  tone,
}: {
  label: string;
  value: string;
  subtitle?: string;
  highlight?: boolean;
  tone?: 'danger' | 'default';
}) {
  let color = 'var(--fg-1)';
  if (highlight) color = OZON_BLUE;
  if (tone === 'danger') color = 'var(--brand-rot)';
  return (
    <div
      style={{
        padding: '16px 20px',
        borderRight: '1px solid var(--border-hairline)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '24px',
          fontWeight: 900,
          color,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg-2)', marginTop: 4 }}>
        {label}
      </div>
      {subtitle && (
        <div
          style={{
            fontSize: '12px',
            color: 'var(--fg-muted)',
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subtitle}
        </div>
      )}
    </div>
  );
}

function PromoActionItem({
  action,
  allActions,
  onSaved,
}: {
  action: PromoAction;
  allActions: PromoAction[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const totalActive = action.products.filter((p) => p.stock > 0).length;
  const dateEndShort = action.date_end ? action.date_end.slice(0, 10) : '';
  const urgent = action.days_left <= 7;
  const veryUrgent = action.days_left <= 3;
  // Boost-level column only makes sense for elastic boost actions; STOCK_DISCOUNT
  // and similar promos have no min_boost / max_boost mechanics.
  const hasElasticBoost = action.action_type === 'MARKETPLACE_MULTI_LEVEL_DISCOUNT_ON_AMOUNT';

  // Is this a regional Распродажа (clearance sale) we don't participate in?
  // Those are OFF by default — render a compact one-row toggle. When ON,
  // expand the full candidate table. Toggle persists in localStorage.
  const titleLower = (action.title || '').toLowerCase();
  const isClearance = titleLower.includes('распродажа') && !action.is_participating;
  const toggleKey = `promo:clearance-on:${action.action_id}`;
  const [clearanceOn, setClearanceOn] = useState<boolean>(false);
  const [leaving, setLeaving] = useState<boolean>(false);
  useEffect(() => {
    if (!isClearance) return;
    try {
      const v = localStorage.getItem(toggleKey);
      if (v === '1') {
        setClearanceOn(true);
        setOpen(true);
      }
    } catch {
      // ignore
    }
  }, [isClearance, toggleKey]);
  function toggleClearance() {
    const next = !clearanceOn;
    setClearanceOn(next);
    try {
      if (next) localStorage.setItem(toggleKey, '1');
      else localStorage.removeItem(toggleKey);
    } catch {
      // ignore
    }
    setOpen(next);
  }

  // Auto-expand when a sibling row clicks our "winning" current-price
  useEffect(() => {
    function onOpenEvent(e: Event) {
      const detail = (e as CustomEvent).detail as { action_id: number };
      if (detail.action_id === action.action_id) {
        setOpen(true);
      }
    }
    window.addEventListener('promo:open-action', onOpenEvent);
    return () => window.removeEventListener('promo:open-action', onOpenEvent);
  }, [action.action_id]);

  return (
    <div
      id={`promo-action-${action.action_id}`}
      style={{ borderBottom: '1px solid var(--border-hairline)' }}
    >
      <button
        onClick={() => {
          if (isClearance) {
            // Clicking the header just expands/collapses without toggling the
            // action ON/OFF — that's a separate switch
            if (clearanceOn) setOpen(!open);
          } else {
            setOpen(!open);
          }
        }}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '16px 24px',
          backgroundColor: 'transparent',
          border: 'none',
          cursor: isClearance && !clearanceOn ? 'default' : 'pointer',
          textAlign: 'left',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '15px',
              fontWeight: 700,
              color: 'var(--fg-1)',
              marginBottom: 4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {action.title}
            </span>
            {!action.is_participating && (
              <span
                title="Мы не участвуем в этой акции. Включи отдельные товары нажав + на строке."
                style={{
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 8px',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: 'var(--fg-2)',
                  backgroundColor: 'rgba(0,0,0,0.06)',
                  borderRadius: 'var(--radius-pill)',
                  letterSpacing: 0,
                }}
              >
                not joined
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: '13px',
              color: 'var(--fg-2)',
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span>
              <strong style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{totalActive}</strong> of{' '}
              {action.participating_products_count} SKUs active
            </span>
            <span style={{ color: 'var(--fg-muted)' }}>·</span>
            <span>
              ends <strong style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{dateEndShort}</strong>
            </span>
          </div>
        </div>
        <div style={{ flexShrink: 0, textAlign: 'right' }}>
          <div
            title={`${action.deciding_count} of ${action.products.length} products in this promo currently show this promo's price as the active Ozon listing price (i.e. this promo is the winning offer for that SKU). The rest are in the promo but a different promo or base price is currently the deciding one.`}
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '22px',
              fontWeight: 900,
              color: OZON_BLUE,
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span>{action.deciding_count}</span>
            <span style={{ color: 'var(--fg-muted)', fontWeight: 700 }}> / </span>
            <span style={{ color: 'var(--fg-1)' }}>{action.products.length}</span>
          </div>
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg-2)', marginTop: 2 }}>
            winning / in promo
          </div>
        </div>
        <div
          style={{
            flexShrink: 0,
            minWidth: 80,
            textAlign: 'right',
            color: veryUrgent
              ? 'var(--brand-rot)'
              : urgent
              ? '#8A6000'
              : 'var(--fg-2)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '22px',
              fontWeight: 900,
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {action.days_left}d
          </div>
          <div style={{ fontSize: '12px', fontWeight: 600, marginTop: 2 }}>left</div>
        </div>
        {isClearance ? (
          <span
            role="switch"
            aria-checked={clearanceOn}
            aria-label={`${clearanceOn ? 'Выключить' : 'Включить'} ${action.title}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleClearance();
            }}
            style={{
              flexShrink: 0,
              width: 40,
              height: 22,
              borderRadius: 11,
              backgroundColor: clearanceOn ? OZON_BLUE : 'var(--paper-2)',
              border: '0.5px solid var(--border-hairline)',
              position: 'relative',
              cursor: 'pointer',
              transition: 'background-color 0.15s',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: clearanceOn ? 20 : 2,
                width: 16,
                height: 16,
                borderRadius: '50%',
                backgroundColor: '#fff',
                border: '0.5px solid var(--border-hairline)',
                transition: 'left 0.15s',
              }}
            />
          </span>
        ) : action.is_participating ? (
          // Participating action: blue toggle ON. Click → confirm → bulk leave.
          <span
            role="switch"
            aria-checked={true}
            aria-label={`Выйти из акции ${action.title}`}
            onClick={(e) => {
              e.stopPropagation();
              if (leaving) return;
              const ok = window.confirm(
                `Выйти из акции "${action.title}"? Все ${action.participating_products_count} SKU будут отключены от акции.`,
              );
              if (!ok) return;
              setLeaving(true);
              const apiBase =
                (typeof window !== 'undefined' &&
                  (window as unknown as { __API_BASE?: string }).__API_BASE) ||
                'https://dasoperator-api.dasexperten.workers.dev';
              fetch(
                `${apiBase}/api/marketplaces/ozon/actions/${action.action_id}/leave`,
                { method: 'POST' },
              )
                .then((r) => r.json())
                .then((j) => {
                  if (!j.success) {
                    alert('Ошибка: ' + (j.errors?.[0]?.message || 'unknown'));
                    setLeaving(false);
                    return;
                  }
                  // Force reload of promos data
                  window.location.reload();
                })
                .catch((err) => {
                  alert('Ошибка: ' + String(err));
                  setLeaving(false);
                });
            }}
            style={{
              flexShrink: 0,
              width: 40,
              height: 22,
              borderRadius: 11,
              backgroundColor: leaving ? 'var(--paper-2)' : OZON_BLUE,
              border: '0.5px solid var(--border-hairline)',
              position: 'relative',
              cursor: leaving ? 'wait' : 'pointer',
              opacity: leaving ? 0.6 : 1,
              transition: 'background-color 0.15s',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: 20,
                width: 16,
                height: 16,
                borderRadius: '50%',
                backgroundColor: '#fff',
                border: '0.5px solid var(--border-hairline)',
                transition: 'left 0.15s',
              }}
            />
          </span>
        ) : (
          <ChevronDown
            className="h-5 w-5"
            style={{
              color: 'var(--fg-muted)',
              transition: 'transform 200ms',
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        )}
      </button>
      {open && (!isClearance || clearanceOn) && (
        <div
          style={{
            backgroundColor: 'var(--paper-sunk)',
            borderTop: '1px solid var(--border-hairline)',
            overflowX: 'auto',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr>
                <th style={thStyle}>SKU</th>
                <th style={{ ...thStyle, minWidth: 160 }}>Product</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Current price</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Promo</th>
                {hasElasticBoost && (
                  <th style={{ ...thStyle, textAlign: 'center', minWidth: 200 }}>Boost level</th>
                )}
                <th style={{ ...thStyle, textAlign: 'right', minWidth: 110 }}>Left to sell</th>
                <th style={{ ...thStyle, textAlign: 'right', minWidth: 80 }}>FBO stock</th>
                <th style={{ ...thStyle, textAlign: 'right', minWidth: 150 }}>Keep stock topped up</th>
                <th style={{ ...thStyle, width: 36, padding: '10px 6px' }}></th>
              </tr>
            </thead>
            <tbody>
              {[...action.products]
                .sort((a, b) =>
                  (a.offer_id || '').localeCompare(b.offer_id || '', undefined, {
                    numeric: true,
                    sensitivity: 'base',
                  }),
                )
                .map((p) => (
                <PromoProductRow
                  key={p.product_id}
                  product={p}
                  actionId={action.action_id}
                  actionPrice={p.action_price}
                  isParticipating={action.is_participating}
                  isClearance={isClearance}
                  allActions={allActions}
                  showBoost={hasElasticBoost}
                  onSaved={onSaved}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PromoProductRow({
  product,
  actionId,
  actionPrice,
  isParticipating,
  isClearance,
  allActions,
  showBoost,
  onSaved,
}: {
  product: PromoProduct;
  actionId: number;
  actionPrice: number;
  isParticipating: boolean;
  isClearance: boolean;
  allActions: PromoAction[];
  showBoost: boolean;
  onSaved: () => void;
}) {
  const isOut = product.stock === 0;

  // Where does this SKU's current_price come from? If it matches this row's
  // action_price → this promo wins (blue). If it's strictly lower → another
  // promo or base price is winning (red, clickable to scroll there). If it's
  // higher → no promo applies right now (black).
  let priceState: 'this' | 'other' | 'higher' = 'higher';
  let winningAction: PromoAction | null = null;
  if (product.current_price > 0) {
    if (Math.abs(product.current_price - product.action_price) <= 1) {
      priceState = 'this';
    } else if (product.current_price < product.action_price) {
      priceState = 'other';
      // Find the promo whose action_price equals current_price for this SKU
      for (const a of allActions) {
        if (a.action_id === actionId) continue;
        const match = a.products.find(
          (p) =>
            p.product_id === product.product_id &&
            Math.abs(p.action_price - product.current_price) <= 1,
        );
        if (match) {
          winningAction = a;
          break;
        }
      }
    }
  }

  function scrollToAction(aid: number) {
    // Dispatch event so the target PromoActionItem can auto-expand
    window.dispatchEvent(
      new CustomEvent('promo:open-action', { detail: { action_id: aid } }),
    );
    // Defer scroll a tick so the expand has time to render the table
    setTimeout(() => {
      const el = document.getElementById(`promo-action-${aid}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.style.transition = 'background-color 0.3s';
        el.style.backgroundColor = 'rgba(212,160,23,0.18)';
        setTimeout(() => {
          el.style.backgroundColor = '';
        }, 1400);
      }
    }, 50);
  }


  return (
    <tr
      style={{
        borderBottom: '1px solid var(--border-hairline)',
        backgroundColor: isOut
          ? 'rgba(0,0,0,0.02)'
          : product.is_deciding_price
          ? '#FFFFFF'
          : 'transparent',
        opacity: isOut ? 0.55 : 1,
      }}
    >
      <td style={tdStyle}>
        <span style={{ fontWeight: 700, color: OZON_BLUE }}>{product.offer_id || '—'}</span>
      </td>
      <td
        style={{
          ...tdStyle,
          maxWidth: 220,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        <a
          href={`/products/${product.offer_id.toLowerCase()}`}
          style={{ color: 'var(--fg-1)', textDecoration: 'none' }}
          title={product.name}
        >
          {product.name || '—'}
        </a>
      </td>
      {/* Current price — three states:
          - 'this' (blue):   this promo wins → current_price = action_price
          - 'other' (red):   another deeper promo is winning → click to jump
          - 'higher' (black): no promo applies, current price above promo */}
      <td
        style={{
          ...tdStyle,
          textAlign: 'right',
          fontWeight: 800,
          color:
            priceState === 'this'
              ? OZON_BLUE
              : priceState === 'other'
              ? 'var(--brand-rot)'
              : 'var(--fg-1)',
          cursor: priceState === 'other' && winningAction ? 'pointer' : 'default',
          textDecoration:
            priceState === 'other' && winningAction ? 'underline dotted' : 'none',
          textUnderlineOffset: 3,
        }}
        onClick={() => {
          if (priceState === 'other' && winningAction) {
            scrollToAction(winningAction.action_id);
          }
        }}
        title={
          priceState === 'this'
            ? 'Эта акция определяет текущую цену'
            : priceState === 'other' && winningAction
            ? `Цену определяет «${winningAction.title}» — клик чтобы перейти`
            : priceState === 'other'
            ? 'Цена определяется другой акцией или базовой ценой'
            : 'Эта акция не применяется — цена выше промо'
        }
      >
        {product.current_price > 0 ? `${fmt(product.current_price)}₽` : '—'}
        {product.min_price != null &&
          product.current_price > 0 &&
          Math.abs(product.current_price - product.min_price) < 0.5 && (
            <div
              style={{
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--fg-muted)',
                marginTop: 2,
                letterSpacing: 0,
              }}
              title="Current price equals the seller minimum for this SKU"
            >
              min
            </div>
          )}
      </td>
      {/* Promo: editable for boost actions, read-only for Распродажа (Ozon sets it) */}
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        {!isParticipating ? (
          <span
            style={{ color: 'var(--fg-muted)', fontSize: '14px', fontStyle: 'italic' }}
            title="Включи товар чтобы участвовать"
          >
            —
          </span>
        ) : isClearance ? (
          <span style={{ fontWeight: 700, fontSize: '14px' }}>
            {fmt(product.action_price)}₽
          </span>
        ) : (
          <PromoPriceCell actionId={actionId} product={product} onSaved={onSaved} />
        )}
      </td>

      {/* Boost level slider — only for elastic boost actions */}
      {showBoost && (
        <td style={{ ...tdStyle, padding: '12px 10px' }}>
          <BoostSliderCell
            actionId={actionId}
            product={product}
            onSaved={onSaved}
          />
        </td>
      )}

      {/* Left to sell — wider field to fit 4-digit values */}
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        {isParticipating ? (
          <LeftToSellCell actionId={actionId} product={product} onSaved={onSaved} />
        ) : (
          <span
            style={{ color: 'var(--fg-muted)', fontSize: '14px', fontStyle: 'italic' }}
          >
            —
          </span>
        )}
      </td>

      {/* FBO column: per-cluster (with days) for regional Распродажа,
          overall FBO otherwise */}
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        {isClearance && product.cluster_fbo_present != null ? (
          <div>
            <div
              style={{
                fontSize: '15px',
                fontWeight: 700,
                color:
                  product.cluster_fbo_present === 0
                    ? 'var(--brand-rot)'
                    : 'var(--fg-1)',
                fontVariantNumeric: 'tabular-nums',
              }}
              title={`Остаток на складе ${product.cluster_fbo_warehouse}`}
            >
              {fmt(product.cluster_fbo_present)}
            </div>
            {product.cluster_fbo_present === 0 ? (
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  color: 'var(--brand-rot)',
                  marginTop: 2,
                  fontStyle: 'italic',
                }}
              >
                пусто
              </div>
            ) : product.cluster_fbo_days != null ? (
              <div
                style={{
                  fontSize: '12px',
                  fontWeight: 500,
                  marginTop: 2,
                  color:
                    product.cluster_fbo_days > 120
                      ? '#A32D2D'
                      : product.cluster_fbo_days >= 60
                      ? '#8A6000'
                      : '#3B6D11',
                }}
                title="Дней хватит при текущей скорости продаж в этом регионе"
              >
                {fmt(product.cluster_fbo_days)} дн.
              </div>
            ) : (
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 500,
                  marginTop: 2,
                  color: '#A32D2D',
                  fontStyle: 'italic',
                }}
                title="Нет продаж этого SKU из этого склада за 30 дней — товар залежался"
              >
                нет продаж
              </div>
            )}
          </div>
        ) : product.fbo_present != null ? (
          <div>
            <div
              style={{
                fontSize: '15px',
                fontWeight: 400,
                fontStyle: 'italic',
                color: 'var(--fg-2)',
                fontVariantNumeric: 'tabular-nums',
              }}
              title={
                product.fbo_reserved && product.fbo_reserved > 0
                  ? `${product.fbo_present} доступно · ${product.fbo_reserved} в заказах`
                  : `${product.fbo_present} доступно на складах Ozon`
              }
            >
              {fmt(product.fbo_present)}
            </div>
            {product.fbo_reserved != null && product.fbo_reserved > 0 && (
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--fg-muted)',
                  fontWeight: 400,
                  fontStyle: 'italic',
                  letterSpacing: 0,
                  marginTop: 2,
                }}
                title="Зарезервировано в текущих заказах"
              >
                +{fmt(product.fbo_reserved)} рез.
              </div>
            )}
          </div>
        ) : (
          <span style={{ fontSize: '13px', color: 'var(--fg-muted)' }}>—</span>
        )}
      </td>

      {/* Keep stock topped up (Below / Refill to) — after FBO */}
      <td style={{ ...tdStyle, textAlign: 'right' }}>
        {isParticipating ? (
          <RefillRuleCell
            actionId={actionId}
            productId={product.product_id}
            currentRule={product.refill_rule}
            onSaved={onSaved}
          />
        ) : (
          <span
            style={{ color: 'var(--fg-muted)', fontSize: '14px', fontStyle: 'italic' }}
          >
            —
          </span>
        )}
      </td>

      {/* Per-product toggle — present on every row, every action */}
      <td
        style={{
          ...tdStyle,
          padding: '0 6px',
          textAlign: 'center',
          verticalAlign: 'middle',
        }}
      >
        <ToggleActionButton
          actionId={actionId}
          productId={product.product_id}
          offerId={product.offer_id}
          actionPrice={actionPrice}
          isParticipating={isParticipating}
          onToggled={onSaved}
        />
      </td>
    </tr>
  );
}

function EditableQuotaCell({
  value,
  onChange,
  onSave,
  onCancel,
  dirty,
  saving,
  disabled,
  showSaved,
  hasError,
  bigValue,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  dirty: boolean;
  saving: boolean;
  disabled: boolean;
  showSaved: boolean;
  hasError: boolean;
  bigValue: boolean;
  placeholder?: string;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        justifyContent: 'flex-end',
      }}
    >
      <input
        type="text"
          inputMode="numeric"
        min={0}
        value={value}
        placeholder={placeholder}
        disabled={saving || disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
            onSave();
          }
          if (e.key === 'Escape') onCancel();
        }}
        style={{
          width: 90,
          padding: '6px 10px',
          fontFamily: 'var(--font-body)',
          fontSize: '14px',
          fontWeight: 800,
          textAlign: 'right',
          color: bigValue ? OZON_BLUE : 'var(--fg-1)',
          backgroundColor: dirty ? 'rgba(212,160,23,0.10)' : 'var(--paper-1)',
          border: dirty
            ? '1px solid #D4A017'
            : hasError
            ? '1px solid var(--brand-rot)'
            : '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-sm)',
          outline: 'none',
          fontVariantNumeric: 'tabular-nums',
          opacity: disabled && !saving ? 0.5 : 1,
        }}
      />
      {dirty && (
        <button
          onClick={onSave}
          disabled={saving || disabled}
          title="Save to Ozon"
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            backgroundColor: OZON_BLUE,
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: saving ? 'wait' : 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        </button>
      )}
      {showSaved && !dirty && (
        <span
          style={{
            fontSize: '12px',
            fontWeight: 700,
            color: '#2E7D4F',
            whiteSpace: 'nowrap',
          }}
        >
          saved ✓
        </span>
      )}
    </div>
  );
}

function RefillRuleCell({
  actionId,
  productId,
  currentRule,
  onSaved,
}: {
  actionId: number;
  productId: number;
  currentRule: { threshold: number; target: number } | null;
  onSaved: () => void;
}) {
  const [belowDraft, setBelowDraft] = useState<string>(
    currentRule ? String(currentRule.threshold) : '',
  );
  const [targetDraft, setTargetDraft] = useState<string>(
    currentRule ? String(currentRule.target) : '',
  );
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setBelowDraft(currentRule ? String(currentRule.threshold) : '');
    setTargetDraft(currentRule ? String(currentRule.target) : '');
    setErr(null);
  }, [currentRule]);

  const belowNum = Number(belowDraft);
  const targetNum = Number(targetDraft);
  const bothEmpty = belowDraft.trim() === '' && targetDraft.trim() === '';
  const bothValid =
    !bothEmpty &&
    Number.isFinite(belowNum) &&
    Number.isFinite(targetNum) &&
    belowNum >= 0 &&
    targetNum > belowNum;
  const currentMatchesDraft =
    currentRule != null &&
    Number(belowDraft) === currentRule.threshold &&
    Number(targetDraft) === currentRule.target;
  const dirty = bothEmpty ? currentRule != null : bothValid && !currentMatchesDraft;
  const hasRule = currentRule != null;

  async function save() {
    if (saving) return;
    if (!dirty) return;
    setSaving(true);
    setErr(null);
    try {
      const apiBase =
        (typeof window !== 'undefined' &&
          (window as unknown as { __API_BASE?: string }).__API_BASE) ||
        'https://dasoperator-api.dasexperten.workers.dev';
      const body: Record<string, unknown> = { product_id: productId };
      if (bothEmpty) {
        body.clear = true;
      } else {
        body.threshold = belowNum;
        body.target = targetNum;
      }
      const r = await fetch(
        `${apiBase}/api/marketplaces/ozon/actions/${actionId}/refill-rule`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const j = await r.json();
      if (!j.success) throw new Error(j.errors?.[0]?.message || j.errors || 'Save failed');
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved();
    } catch (e) {
      setErr(humanizeOzonError(e instanceof Error ? e.message : ''));
    } finally {
      setSaving(false);
    }
  }

  const labelStyle: React.CSSProperties = {
    fontSize: '13px',
    letterSpacing: 0,
    opacity: hasRule ? 1 : 0.45,
  };
  const inputStyle: React.CSSProperties = {
    width: 64,
    padding: '4px 8px',
    fontFamily: 'var(--font-body)',
    fontSize: '13px',
    fontWeight: 700,
    textAlign: 'right',
    color: 'var(--fg-1)',
    backgroundColor: dirty ? 'rgba(212,160,23,0.10)' : 'var(--paper-1)',
    border: dirty
      ? '1px solid #D4A017'
      : err
      ? '1px solid var(--brand-rot)'
      : '1px solid var(--border-hairline)',
    borderRadius: 'var(--radius-sm)',
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...labelStyle, color: '#A32D2D' }}>Below</span>
        <input
          type="text"
          inputMode="numeric"
          min={0}
          value={belowDraft}
          placeholder="—"
          disabled={saving}
          onChange={(e) => setBelowDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
            save();
          }
          }}
          onBlur={() => {
            if (dirty) save();
          }}
          style={inputStyle}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...labelStyle, color: '#3B6D11', fontWeight: 700 }}>Refill to</span>
        <input
          type="text"
          inputMode="numeric"
          min={0}
          value={targetDraft}
          placeholder="—"
          disabled={saving}
          onChange={(e) => setTargetDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
            save();
          }
          }}
          onBlur={() => {
            if (dirty) save();
          }}
          style={inputStyle}
        />
      </div>
      {savedFlash && !dirty && (
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            color: '#2E7D4F',
            marginTop: 2,
          }}
        >
          saved ✓
        </span>
      )}
      {err && (
        <span
          style={{
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--brand-rot)',
            marginTop: 2,
            maxWidth: 160,
            textAlign: 'right',
            lineHeight: 1.3,
          }}
        >
          {err}
        </span>
      )}
    </div>
  );
}

function BoostSliderCell({
  actionId,
  product,
  onSaved,
}: {
  actionId: number;
  product: PromoProduct;
  onSaved: () => void;
}) {
  // Pull boost range values; nulls = Ozon didn't return them (rare)
  const pMin = product.price_min_elastic;
  const pMax = product.price_max_elastic;
  const bMin = product.min_boost;
  const bMax = product.max_boost;
  const hasRange = pMin != null && pMax != null && bMin != null && bMax != null && pMin > pMax;

  // Slider's internal "boost intensity" goes from 0% to 100% across the bar.
  //   intensity = 0   → price = pMin (the higher price, +bMin boost)
  //   intensity = 100 → price = pMax (the lower price, +bMax boost)
  const priceForIntensity = (pct: number): number => {
    if (!hasRange) return product.action_price;
    return Math.round((pMin as number) - ((pMin as number) - (pMax as number)) * (pct / 100));
  };
  const intensityForPrice = (price: number): number => {
    if (!hasRange) return 0;
    const lo = pMax as number;
    const hi = pMin as number;
    const clamped = Math.min(hi, Math.max(lo, price));
    return Math.round(((hi - clamped) / (hi - lo)) * 100);
  };
  const boostForIntensity = (pct: number): number => {
    if (!hasRange) return product.current_boost ?? 0;
    return Math.round(((bMin as number) + ((bMax as number) - (bMin as number)) * (pct / 100)) * 10) / 10;
  };

  const currentIntensity = intensityForPrice(product.action_price);
  const currentBoost = product.current_boost ?? 0;
  const aboveRange = hasRange && product.action_price > (pMin as number) + 0.5;

  const [draftIntensity, setDraftIntensity] = useState<number>(currentIntensity);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraftIntensity(currentIntensity);
    setErr(null);
  }, [currentIntensity]);

  const draftPrice = priceForIntensity(draftIntensity);
  const draftBoost = boostForIntensity(draftIntensity);
  const dirty = hasRange && draftPrice !== product.action_price;

  async function save() {
    if (saving || !dirty || !hasRange) return;
    setSaving(true);
    setErr(null);
    try {
      const apiBase =
        (typeof window !== 'undefined' &&
          (window as unknown as { __API_BASE?: string }).__API_BASE) ||
        'https://dasoperator-api.dasexperten.workers.dev';
      const r = await fetch(
        `${apiBase}/api/marketplaces/ozon/actions/${actionId}/price`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_id: product.product_id,
            action_price: draftPrice,
            current_stock: product.stock,
          }),
        },
      );
      const j = await r.json();
      if (!j.success) throw new Error(j.errors?.[0]?.message || j.errors || 'Save failed');
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved();
    } catch (e) {
      setErr(humanizeOzonError(e instanceof Error ? e.message : ''));
    } finally {
      setSaving(false);
    }
  }

  if (!hasRange) {
    return (
      <div style={{ fontSize: '12px', color: 'var(--fg-muted)', textAlign: 'center', fontStyle: 'italic' }}>
        no boost data
      </div>
    );
  }

  const GREEN = '#2E7D4F';
  const RED = '#A32D2D';
  const trackColor = aboveRange ? RED : GREEN;
  const middleLabel = aboveRange
    ? 'no boost'
    : dirty
    ? `${draftPrice}₽ · ${draftBoost}%`
    : draftIntensity >= 99
    ? `max ${draftBoost}%`
    : `${draftBoost}%`;

  return (
    <div style={{ width: '100%', minWidth: 220, padding: '4px 8px' }}>
      <div style={{ position: 'relative', height: 6, margin: '4px 0' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.08)',
            borderRadius: 3,
          }}
        />
        {!aboveRange && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: `${draftIntensity}%`,
              background: trackColor,
              borderRadius: 3,
            }}
          />
        )}
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={aboveRange ? 0 : draftIntensity}
          disabled={saving}
          onChange={(e) => setDraftIntensity(Number(e.target.value))}
          onMouseUp={save}
          onTouchEnd={save}
          onKeyUp={(e) => {
            if (e.key === 'Enter' || e.key === ' ') save();
          }}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            opacity: 0,
            cursor: saving ? 'wait' : 'pointer',
            margin: 0,
            padding: 0,
          }}
          aria-label={`Boost level for ${product.offer_id}`}
        />
        <div
          style={{
            position: 'absolute',
            left: `${aboveRange ? -4 : draftIntensity}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 14,
            height: 14,
            background: '#fff',
            border: `2px solid ${trackColor}`,
            borderRadius: '50%',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            pointerEvents: 'none',
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 6,
          fontSize: '11px',
          color: 'var(--fg-2)',
          letterSpacing: 0,
          gap: 4,
        }}
      >
        <span>
          <span style={{ fontWeight: 700 }}>{pMin}₽</span> +{bMin}%
        </span>
        <span style={{ fontWeight: 700, color: trackColor }}>{middleLabel}</span>
        <span>
          <span style={{ fontWeight: 700 }}>{pMax}₽</span> +{bMax}%
        </span>
      </div>
      {savedFlash && (
        <div
          style={{
            fontSize: '11px',
            fontWeight: 700,
            color: GREEN,
            textAlign: 'center',
            marginTop: 2,
          }}
        >
          saved ✓
        </div>
      )}
      {err && (
        <div
          style={{
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--brand-rot)',
            textAlign: 'center',
            marginTop: 2,
          }}
        >
          {err}
        </div>
      )}
      {saving && (
        <div
          style={{
            fontSize: '11px',
            color: 'var(--fg-muted)',
            textAlign: 'center',
            marginTop: 2,
          }}
        >
          saving…
        </div>
      )}
    </div>
  );
}

function PromoPriceCell({
  actionId,
  product,
  onSaved,
}: {
  actionId: number;
  product: PromoProduct;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string>(String(product.action_price));
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(product.action_price));
    setErr(null);
  }, [product.action_price]);

  const num = Number(draft);
  const valid = Number.isFinite(num) && num > 0;
  const dirty = valid && num !== product.action_price;

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    setErr(null);
    try {
      const apiBase =
        (typeof window !== 'undefined' &&
          (window as unknown as { __API_BASE?: string }).__API_BASE) ||
        'https://dasoperator-api.dasexperten.workers.dev';
      const r = await fetch(
        `${apiBase}/api/marketplaces/ozon/actions/${actionId}/price`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_id: product.product_id,
            action_price: num,
            current_stock: product.stock,
          }),
        },
      );
      const j = await r.json();
      if (!j.success) throw new Error(j.errors?.[0]?.message || j.errors || 'Save failed');
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved();
    } catch (e) {
      setErr(humanizeOzonError(e instanceof Error ? e.message : ''));
      setDraft(String(product.action_price));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        justifyContent: 'flex-end',
      }}
    >
      <input
        type="text"
          inputMode="numeric"
        min={1}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
            save();
          }
          if (e.key === 'Escape') {
            setDraft(String(product.action_price));
            setErr(null);
          }
        }}
        onBlur={() => {
          if (dirty) save();
        }}
        style={{
          width: 78,
          padding: '6px 8px',
          fontFamily: 'var(--font-body)',
          fontSize: '14px',
          fontWeight: 800,
          textAlign: 'right',
          color: 'var(--fg-1)',
          backgroundColor: dirty ? 'rgba(212,160,23,0.10)' : 'transparent',
          border: dirty
            ? '1px solid #D4A017'
            : err
            ? '1px solid var(--brand-rot)'
            : '1px solid transparent',
          borderRadius: 'var(--radius-sm)',
          outline: 'none',
          fontVariantNumeric: 'tabular-nums',
        }}
      />
      <span style={{ fontWeight: 800, color: 'var(--fg-1)' }}>₽</span>
      {savedFlash && !dirty && (
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            color: '#2E7D4F',
            marginLeft: 4,
          }}
        >
          ✓
        </span>
      )}
      {err && (
        <div
          onClick={() => setErr(null)}
          title={err + ' (клик чтобы закрыть)'}
          style={{
            position: 'absolute',
            zIndex: 50,
            background: 'var(--brand-rot)',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 600,
            padding: '6px 10px',
            borderRadius: 4,
            top: '100%',
            right: 0,
            marginTop: 4,
            maxWidth: 280,
            minWidth: 200,
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            letterSpacing: 0,
            whiteSpace: 'normal',
            lineHeight: 1.35,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

function LeftToSellCell({
  actionId,
  product,
  onSaved,
}: {
  actionId: number;
  product: PromoProduct;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string>(
    product.left_to_sell != null ? String(product.left_to_sell) : '',
  );
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(product.left_to_sell != null ? String(product.left_to_sell) : '');
    setErr(null);
  }, [product.left_to_sell]);

  const num = Number(draft);
  const valid = draft !== '' && Number.isFinite(num) && num >= 0;
  const dirty = valid && num !== (product.left_to_sell ?? -1);

  async function save() {
    if (saving || !dirty || !valid) return;
    setSaving(true);
    setErr(null);
    try {
      const apiBase =
        (typeof window !== 'undefined' &&
          (window as unknown as { __API_BASE?: string }).__API_BASE) ||
        'https://dasoperator-api.dasexperten.workers.dev';
      const payload: Record<string, unknown> = {
        product_id: product.product_id,
        action_price: product.action_price,
        current_stock: product.stock,
        left_to_sell: num,
      };
      // action_price is required by Ozon /activate, so always echo the current
      // value. If Ozon rejects on discount-percent grounds, the user sees the
      // humanized error and the input snaps back.
      if (product.left_to_sell != null) {
        payload.current_left = product.left_to_sell;
      }
      const r = await fetch(
        `${apiBase}/api/marketplaces/ozon/actions/${actionId}/stock`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const j = await r.json();
      if (!j.success) throw new Error(j.errors?.[0]?.message || j.errors || 'Save failed');
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved();
    } catch (e) {
      setErr(humanizeOzonError(e instanceof Error ? e.message : ''));
      setDraft(product.left_to_sell != null ? String(product.left_to_sell) : '');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        justifyContent: 'flex-end',
      }}
    >
      <input
        type="text"
          inputMode="numeric"
        min={0}
        value={draft}
        disabled={saving}
        placeholder={product.left_to_sell == null ? 'set' : ''}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
            save();
          }
          if (e.key === 'Escape') {
            setDraft(product.left_to_sell != null ? String(product.left_to_sell) : '');
            setErr(null);
          }
        }}
        onBlur={() => {
          if (dirty) save();
        }}
        style={{
          width: 90,
          padding: '4px 8px',
          fontFamily: 'var(--font-body)',
          fontSize: '18px',
          fontWeight: 800,
          textAlign: 'right',
          color: 'var(--fg-1)',
          backgroundColor: dirty ? 'rgba(212,160,23,0.10)' : 'transparent',
          border: dirty
            ? '1px solid #D4A017'
            : err
            ? '1px solid var(--brand-rot)'
            : '1px solid transparent',
          borderRadius: 'var(--radius-sm)',
          outline: 'none',
          fontVariantNumeric: 'tabular-nums',
        }}
      />
      {savedFlash && !dirty && (
        <span
          style={{
            fontSize: '11px',
            fontWeight: 700,
            color: '#2E7D4F',
            marginLeft: 2,
          }}
        >
          ✓
        </span>
      )}
      {err && (
        <div
          onClick={() => setErr(null)}
          title={err + ' (клик чтобы закрыть)'}
          style={{
            position: 'absolute',
            zIndex: 50,
            background: 'var(--brand-rot)',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 600,
            padding: '6px 10px',
            borderRadius: 4,
            top: '100%',
            right: 0,
            marginTop: 4,
            maxWidth: 280,
            minWidth: 200,
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            letterSpacing: 0,
            whiteSpace: 'normal',
            lineHeight: 1.35,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

function ToggleActionButton({
  actionId,
  productId,
  offerId,
  actionPrice,
  isParticipating,
  onToggled,
}: {
  actionId: number;
  productId: number;
  offerId: string;
  actionPrice: number;
  isParticipating: boolean;
  onToggled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);

  // We don't know per-product participation in the candidate list — for
  // CAND (action not participating) all rows are inactive, for PART all rows
  // are active. So action-level flag works as a proxy for the row's state.
  const isActive = isParticipating;

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const apiBase =
        (typeof window !== 'undefined' &&
          (window as unknown as { __API_BASE?: string }).__API_BASE) ||
        'https://dasoperator-api.dasexperten.workers.dev';
      if (isActive) {
        // Remove
        const r = await fetch(
          `${apiBase}/api/marketplaces/ozon/actions/${actionId}/products/${productId}`,
          { method: 'DELETE' },
        );
        const j = await r.json();
        if (!j.success) throw new Error(j.errors?.[0]?.message || j.errors || 'Remove failed');
      } else {
        // Activate: send Ozon-suggested action_price so it picks an acceptable
        // discount level automatically.
        const r = await fetch(
          `${apiBase}/api/marketplaces/ozon/actions/${actionId}/products/${productId}/activate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action_price: actionPrice }),
          },
        );
        const j = await r.json();
        if (!j.success) throw new Error(j.errors?.[0]?.message || j.errors || 'Activate failed');
      }
      onToggled();
    } catch (e) {
      setErr(humanizeOzonError(e instanceof Error ? e.message : ''));
    } finally {
      setBusy(false);
    }
  }

  // Active: red ✕ on hover (remove). Inactive: green + on hover (add).
  const baseColor = 'rgba(0,0,0,0.35)';
  const activeColor = isActive ? '#A32D2D' : '#2E7D4F';
  const color = err ? '#A32D2D' : hovered ? activeColor : baseColor;
  const bg = hovered
    ? isActive
      ? 'rgba(163,45,45,0.08)'
      : 'rgba(46,125,79,0.10)'
    : 'transparent';

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={handleClick}
        disabled={busy}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={isActive ? `Снять ${offerId} с акции` : `Включить ${offerId} в акцию`}
        aria-label={isActive ? `Снять ${offerId} с акции` : `Включить ${offerId} в акцию`}
        style={{
          width: 24,
          height: 24,
          padding: 0,
          background: bg,
          border: 'none',
          cursor: busy ? 'wait' : 'pointer',
          color,
          fontSize: '16px',
          lineHeight: 1,
          borderRadius: '50%',
          transition: 'all 0.15s',
          fontWeight: 600,
          letterSpacing: 0,
        }}
      >
        {busy ? '…' : isActive ? '✕' : '+'}
      </button>
      {err && (
        <div
          onClick={() => setErr(null)}
          title={err + ' (клик чтобы закрыть)'}
          style={{
            position: 'absolute',
            zIndex: 50,
            background: 'var(--brand-rot)',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 600,
            padding: '6px 10px',
            borderRadius: 4,
            top: '100%',
            right: 0,
            marginTop: 4,
            maxWidth: 280,
            minWidth: 200,
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            letterSpacing: 0,
            whiteSpace: 'normal',
            lineHeight: 1.35,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}
