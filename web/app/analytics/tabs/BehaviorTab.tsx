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
  type ClarityBehavior, type BehaviorHistory, type Ga4NavFlows,
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

// Wix "Top navigation flows" analogue — see /api/ga4/nav-flows. Two columns:
// entry pages (landingPage sessions) and top internal transitions
// (pageReferrer -> pagePath views). Pairwise, not full 4-step session paths —
// GA4's Data API has no path dimension; the method note comes from the API.
function NavFlows({ data }: { data: Ga4NavFlows }) {
  const entryMax = Math.max(1, ...data.entries.map((e) => e.sessions));
  const edgeMax = Math.max(1, ...data.edges.map((e) => e.views));
  const bar = (v: number, max: number) => (
    <div style={{ height: 4, background: 'var(--paper-sunk)', borderRadius: 2, marginTop: 3 }}>
      <div style={{ height: 4, width: `${(v / max) * 100}%`, background: 'var(--fg-link)', borderRadius: 2 }} />
    </div>
  );
  return (
    <div className="wa-grid2eq">
      <div>
        <h4 style={{ color: 'var(--fg-2)', marginBottom: 8 }}>1st page (entry) · sessions</h4>
        {data.entries.slice(0, 8).map((e) => (
          <div key={e.page} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ wordBreak: 'break-all' }}>{e.page}</span>
              <span className="num">{fmtNum(e.sessions)}</span>
            </div>
            {bar(e.sessions, entryMax)}
          </div>
        ))}
        {data.entries.length === 0 && <p style={{ color: 'var(--fg-3)' }}>No data in this window.</p>}
      </div>
      <div>
        <h4 style={{ color: 'var(--fg-2)', marginBottom: 8 }}>Top transitions (from → to) · page views</h4>
        {data.edges.slice(0, 8).map((e) => (
          <div key={e.from + e.to} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ wordBreak: 'break-all' }}>{e.from} → {e.to}</span>
              <span className="num">{fmtNum(e.views)}</span>
            </div>
            {bar(e.views, edgeMax)}
          </div>
        ))}
        {data.edges.length === 0 && <p style={{ color: 'var(--fg-3)' }}>No internal transitions in this window.</p>}
      </div>
    </div>
  );
}

export default function BehaviorTab() {
  const behavior = useApi<ClarityBehavior>('/api/clarity/behavior?days=1');
  const history = useApi<BehaviorHistory>('/api/analytics/behavior-history?days=30');
  const flows = useApi<Ga4NavFlows>('/api/ga4/nav-flows?days=30');

  const b = behavior.data;
  const sig = (k: string) => b?.signals?.[k]?.sessions_pct ?? null;
  const histRows = history.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <LoadState loading={behavior.loading} error={behavior.error} />

      {b && (
        <>
          {/* Clarity-native snapshot row — same 4 cards, same wording, as the
              Clarity dashboard itself (Sessions / Pages per session /
              Scroll depth / Active time spent). Kept separate from the
              dead/rage/quickback KPI row below, which is our own added signal. */}
          <div className="wa-kpis">
            <Kpi
              label="Sessions"
              value={fmtNum(b.totals.sessions)}
              delta={`${fmtNum(b.totals.bot_sessions)} bot sessions excluded`}
            />
            <Kpi
              label="Pages per session"
              value={b.totals.pages_per_session === null ? '—' : b.totals.pages_per_session.toFixed(2)}
              delta="average"
            />
            <Kpi
              label="Scroll depth"
              value={fmtPct(b.engagement.avg_scroll_depth_pct)}
              delta="average"
            />
            <Kpi
              label="Active time spent"
              value={fmtSec(b.engagement.active_time_sec)}
              delta={`out of ${fmtSec(b.engagement.total_time_sec)} total time`}
            />
          </div>

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

      <Panel title="Top navigation flows" source="GA4 · pageReferrer → pagePath (internal)">
        <LoadState loading={flows.loading} error={flows.error} />
        {flows.data && (
          <>
            <NavFlows data={flows.data} />
            <p className="wa-note" style={{ marginTop: 12 }}>
              {flows.data.method} Window: {flows.data.window_days}d · synced {timeAgo(flows.data.synced_at)}.
            </p>
          </>
        )}
      </Panel>

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
