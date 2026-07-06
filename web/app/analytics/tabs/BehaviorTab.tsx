'use client';

// =============================================================================
// Behavior tab — Microsoft Clarity live insight (1-day window, API max 3d) +
// the D1 nightly archive trend. Deep-links to clarity.microsoft.com for
// recordings/heatmaps (not embeddable).
// Quota note: the API allows 10 calls/day; this tab reads the KV cache the
// nightly cron pre-warms, so browsing never burns quota.
// =============================================================================

import React from 'react';
import { AreaChart } from '@tremor/react';
import {
  useApi, fmtNum, fmtPct, fmtSec, timeAgo,
  Kpi, Panel, LoadState, ChartLegend,
  type ClarityBehavior, type BehaviorHistory,
} from '../shared';

const CLARITY_PROJECT_URL = 'https://clarity.microsoft.com/projects';

function DimTable({ title, rows }: { title: string; rows: Array<{ name: string; sessions: number }> }) {
  return (
    <div className="wa-panel">
      <div className="wa-panel-head"><h3>{title}</h3></div>
      <div className="wa-table-scroll">
        <table className="wa-table">
          <tbody>
            {rows.slice(0, 8).map((r, i) => (
              <tr key={r.name + i}>
                <td style={{ maxWidth: 380, wordBreak: 'break-all' }}>{r.name}</td>
                <td className="num right">{fmtNum(r.sessions)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td style={{ color: 'var(--fg-3)' }}>No data in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function BehaviorTab() {
  const behavior = useApi<ClarityBehavior>('/api/clarity/behavior?days=1');
  const history = useApi<BehaviorHistory>('/api/analytics/behavior-history?days=30');

  const b = behavior.data;
  const sig = (k: string) => b?.signals?.[k]?.sessions_pct ?? null;
  const histRows = history.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <LoadState loading={behavior.loading} error={behavior.error} />

      {b && (
        <>
          <div className="wa-kpis">
            <Kpi
              label="Sessions · 24h"
              value={fmtNum(b.totals.sessions)}
              delta={`${fmtNum(b.totals.bot_sessions)} bots filtered out by Clarity`}
            />
            <Kpi
              label="Dead clicks"
              value={fmtPct(sig('dead_click'))}
              delta="% of sessions"
              deltaTone={(sig('dead_click') ?? 0) > 25 ? 'down' : null}
            />
            <Kpi
              label="Rage clicks"
              value={fmtPct(sig('rage_click'))}
              delta="% of sessions"
              deltaTone={(sig('rage_click') ?? 0) > 5 ? 'down' : null}
            />
            <Kpi label="Quickbacks" value={fmtPct(sig('quickback'))} delta="% of sessions" />
            <Kpi label="Avg scroll depth" value={fmtPct(b.engagement.avg_scroll_depth_pct)} delta="of page height" />
            <Kpi label="Active engagement" value={fmtSec(b.engagement.active_time_sec)} delta="per session" />
          </div>

          <div className="wa-note">
            Source: {b.source} · {b.window_days}-day live window (API max 3d) · synced{' '}
            {timeAgo(b.synced_at)} · refreshed nightly (1 API call — 10/day hard limit).{' '}
            <a
              href={CLARITY_PROJECT_URL}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--fg-link)', fontWeight: 700 }}
            >
              Open recordings &amp; heatmaps in Clarity →
            </a>
          </div>

          <div className="wa-grid2eq">
            <DimTable title="Popular pages" rows={b.dimensions['PopularPages'] ?? []} />
            <DimTable title="Referrers" rows={b.dimensions['ReferrerUrl'] ?? []} />
          </div>
          <div className="wa-grid2eq">
            <DimTable title="Countries" rows={b.dimensions['Country'] ?? []} />
            <DimTable title="Devices" rows={b.dimensions['Device'] ?? []} />
          </div>
        </>
      )}

      <Panel title="Behavior trend — nightly archive" source="D1 · web_behavior_snapshots">
        {histRows.length >= 2 ? (
          <div className="wa-chart">
            <ChartLegend items={[
              { label: 'dead click %', color: 'var(--stone-500)' },
              { label: 'rage click %', color: 'var(--brand-rot)' },
            ]} />
            <AreaChart
              className="h-64"
              data={histRows.map((r) => ({
                date: r.date,
                'dead click %': r.dead_click_pct ?? 0,
                'rage click %': r.rage_click_pct ?? 0,
              }))}
              index="date"
              categories={['dead click %', 'rage click %']}
              colors={['stone', 'red']}
              valueFormatter={(n: number) => `${n.toFixed(1)}%`}
              showAnimation={false}
              showLegend={false}
            />
          </div>
        ) : (
          <p style={{ color: 'var(--fg-2)' }}>
            {histRows.length === 0
              ? 'Archive is empty — it fills one row per night at 02:30 UTC. Clarity offers no historical backfill; this D1 table IS the archive.'
              : '1 night collected — the trend chart unlocks from the second night.'}
          </p>
        )}
      </Panel>
    </div>
  );
}
