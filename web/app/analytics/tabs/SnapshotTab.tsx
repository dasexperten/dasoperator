'use client';

// =============================================================================
// GA4 Snapshot tab — direct parity with the GA4 UI widgets Aram asked to have
// inside the ERP: active users by country (map + table), ecommerce snapshot
// (active users / add to carts / checkouts / purchases + trend), views by page
// title & screen, sessions by channel, active users by language.
//
// The Realtime overview card was removed on Owner's word (2026-09-04). GA4's
// Realtime API is metered per property per hour and this panel self-polled
// every 60s while the tab stayed open, which is what exhausted the quota and
// left the card showing HTTP 429 instead of numbers. Everything here now goes
// through the same 1h server-side cache as the other GA4 tabs.
//
// Source: GA4 property 511756146 (dasexperten.com, global contour) only —
// same rule as every other tab: never blended with Metrika or Clarity.
// Everything on this tab uses the standard 1h server-side cache.
// =============================================================================

import React from 'react';
import { BarChart, AreaChart } from '@tremor/react';
import {
  useApi, fmtNum, fmtPct, timeAgo,
  Kpi, Panel, LoadState, ChartLegend,
  type Ga4Geo, type Ga4Languages, type Ga4Content, type Ga4Snapshot, type Ga4Channels,
} from '../shared';
import { WorldMap } from '../WorldMap';

function deltaChip(pct: number | null) {
  if (pct === null) return undefined;
  const tone = pct >= 0 ? 'up' : 'down';
  const arrow = pct >= 0 ? '↑' : '↓';
  return { text: `${arrow} ${Math.abs(pct).toFixed(1)}%`, tone: tone as 'up' | 'down' };
}

export default function SnapshotTab() {
  const geo = useApi<Ga4Geo>('/api/ga4/geo?days=7&limit=50');
  const languages = useApi<Ga4Languages>('/api/ga4/languages?days=28&limit=10');
  const content = useApi<Ga4Content>('/api/ga4/content?days=7&limit=10');
  const snapshot = useApi<Ga4Snapshot>('/api/ga4/snapshot?days=28');
  const channels = useApi<Ga4Channels>('/api/ga4/channels?days=7');

  const geoMax = geo.data?.rows[0]?.active_users ?? 0;
  const snapDelta = snapshot.data?.deltas_pct;

  return (
    <div className="space-y-4">
      <div className="wa-note">
        Snapshot — the same six cards as the GA4 UI's Reports snapshot, rebuilt here so the
        numbers live next to the rest of the ERP. Source: GA4 property 511756146.
      </div>

      {/* ============ Active users by country — map + table ============ */}
      <Panel
        title="Active users by Country"
        source="GA4 · last 7 days"
        right={geo.data && <span style={{ color: 'var(--fg-3)' }}>{fmtNum(geo.data.totals.active_users)} total</span>}
      >
        <LoadState loading={geo.loading} error={geo.error} />
        {geo.data && (
          <div className="wa-grid2eq" style={{ alignItems: 'start' }}>
            <div>
              <WorldMap
                data={geo.data.rows.map((r) => ({ country: r.country, value: r.active_users }))}
                height={280}
              />
            </div>
            <div className="wa-table-scroll" style={{ maxHeight: 280 }}>
              <table className="wa-table">
                <thead>
                  <tr><th>Country</th><th className="right">Active users</th><th className="right">7d change</th></tr>
                </thead>
                <tbody>
                  {geo.data.rows.slice(0, 12).map((r) => (
                    <tr key={r.country_id || r.country}>
                      <td style={{ fontWeight: 700 }}>{r.country}</td>
                      <td className="num right">{fmtNum(r.active_users)}</td>
                      <td className="num right">
                        {r.delta_pct === null ? '—' : (
                          <span style={{ color: r.delta_pct >= 0 ? 'var(--status-success)' : 'var(--brand-rot)' }}>
                            {r.delta_pct >= 0 ? '↑' : '↓'} {Math.abs(r.delta_pct).toFixed(1)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {geo.data.rows.length === 0 && (
                    <tr><td colSpan={3} style={{ color: 'var(--fg-3)' }}>No geo data.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {geo.data && (
          <div className="wa-note" style={{ marginTop: 12 }}>
            Map shading is relative to {geo.data.rows[0]?.country ?? 'the top country'}
            ({fmtNum(geoMax)} active users) — a sqrt scale so one dominant market doesn't wash out
            the rest. Synced {timeAgo(geo.data.synced_at)}.
          </div>
        )}
      </Panel>

      {/* ============ Ecommerce snapshot — 4 KPIs + trend ============ */}
      <Panel title="Ecommerce snapshot" source={`GA4 · ${snapshot.data?.window_days ?? 28} days vs prior period`}>
        <LoadState loading={snapshot.loading} error={snapshot.error} />
        {snapshot.data && (
          <>
            <div className="wa-kpis">
              <Kpi
                label="Active users"
                value={fmtNum(snapshot.data.totals.active_users)}
                delta={deltaChip(snapDelta!.active_users)?.text}
                deltaTone={deltaChip(snapDelta!.active_users)?.tone ?? null}
              />
              <Kpi
                label="Add to carts"
                value={fmtNum(snapshot.data.totals.add_to_carts)}
                delta={deltaChip(snapDelta!.add_to_carts)?.text}
                deltaTone={deltaChip(snapDelta!.add_to_carts)?.tone ?? null}
              />
              <Kpi
                label="Checkouts"
                value={fmtNum(snapshot.data.totals.checkouts)}
                delta={deltaChip(snapDelta!.checkouts)?.text}
                deltaTone={deltaChip(snapDelta!.checkouts)?.tone ?? null}
              />
              <Kpi
                accent
                label="Ecommerce purchases"
                value={fmtNum(snapshot.data.totals.purchases)}
                delta={deltaChip(snapDelta!.purchases)?.text}
                deltaTone={deltaChip(snapDelta!.purchases)?.tone ?? null}
              />
            </div>
            {snapshot.data.rows.length > 0 && (
              <div className="wa-chart" style={{ marginTop: 12 }}>
                <ChartLegend items={[
                  { label: 'active users', color: 'var(--stone-500)' },
                  { label: 'add to carts', color: 'var(--brand-rot)' },
                ]} />
                <AreaChart
                  className="h-56"
                  data={snapshot.data.rows}
                  index="date"
                  categories={['active_users', 'add_to_carts']}
                  colors={['stone', 'red']}
                  valueFormatter={fmtNum}
                  showAnimation={false}
                  showLegend={false}
                />
              </div>
            )}
            <div className="wa-note" style={{ marginTop: 12 }}>
              Deltas compare the trailing {snapshot.data.window_days}d to the {snapshot.data.window_days}d
              immediately before it — same window length, no calendar-month skew. GA4's own
              "peer median and range" benchmarking isn't shown (requires opting the property into
              Google's cross-property benchmarking, which we haven't turned on).
            </div>
          </>
        )}
      </Panel>

      <div className="wa-grid2eq">
        {/* ============ Views by page title & screen ============ */}
        <Panel title="Views by page title and screen" source="GA4 · last 7 days" pad={false}>
          <LoadState loading={content.loading} error={content.error} />
          <div className="wa-table-scroll">
            <table className="wa-table">
              <thead>
                <tr><th>Page title and path</th><th className="right">Views</th></tr>
              </thead>
              <tbody>
                {(content.data?.rows ?? []).map((r) => (
                  <tr key={`${r.title}:${r.page}`}>
                    <td style={{ maxWidth: 320, wordBreak: 'break-word' }}>
                      <div>{r.title}</div>
                      <div className="num" style={{ color: 'var(--fg-3)', marginTop: 3 }}>{r.page}</div>
                    </td>
                    <td className="num right">{fmtNum(r.views)}</td>
                  </tr>
                ))}
                {!content.loading && (content.data?.rows ?? []).length === 0 && (
                  <tr><td colSpan={2} style={{ color: 'var(--fg-3)' }}>No page-view data.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="wa-table-scroll" style={{ marginTop: 16 }}>
            <table className="wa-table">
              <thead><tr><th>Commerce event and page</th><th className="right">Count</th></tr></thead>
              <tbody>
                {(content.data?.commerce_rows ?? []).map((r) => (
                  <tr key={`${r.event}:${r.page}:${r.title}`}>
                    <td style={{ maxWidth: 320, wordBreak: 'break-word' }}>
                      <div style={{ fontWeight: 700 }}>{r.event}</div>
                      <div>{r.title}</div>
                      <div className="num" style={{ color: 'var(--fg-3)', marginTop: 3 }}>{r.page}</div>
                    </td>
                    <td className="num right">{fmtNum(r.count)}</td>
                  </tr>
                ))}
                {!content.loading && (content.data?.commerce_rows ?? []).length === 0 && (
                  <tr><td colSpan={2} style={{ color: 'var(--fg-3)' }}>No page-attributed commerce events yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* ============ Sessions by channel ============ */}
        <Panel title="Sessions by Session default channel" source="GA4 · last 7 days" pad={false}>
          <LoadState loading={channels.loading} error={channels.error} />
          <div className="wa-table-scroll">
            <table className="wa-table">
              <thead>
                <tr><th>Session default channel group</th><th className="right">Sessions</th></tr>
              </thead>
              <tbody>
                {(channels.data?.rows ?? []).map((r) => (
                  <tr key={r.channel}>
                    <td style={{ fontWeight: 700 }}>{r.channel}</td>
                    <td className="num right">{fmtNum(r.sessions)}</td>
                  </tr>
                ))}
                {!channels.loading && (channels.data?.rows ?? []).length === 0 && (
                  <tr><td colSpan={2} style={{ color: 'var(--fg-3)' }}>No channel data.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div className="wa-grid2eq">
        {/* ============ Active users by language ============ */}
        <Panel title="Active users by Language" source="GA4 · last 28 days" pad={false}>
          <LoadState loading={languages.loading} error={languages.error} />
          {languages.data && languages.data.rows.length > 0 && (
            <div className="wa-panel-body">
              <div className="wa-chart">
                <BarChart
                  className="h-64"
                  data={languages.data.rows.map((r) => ({ language: r.language, 'active users': r.active_users }))}
                  index="language"
                  categories={['active users']}
                  colors={['stone']}
                  valueFormatter={fmtNum}
                  showAnimation={false}
                  showLegend={false}
                  yAxisWidth={100}
                  layout="vertical"
                />
              </div>
            </div>
          )}
          {!languages.loading && (languages.data?.rows ?? []).length === 0 && (
            <p style={{ color: 'var(--fg-3)', padding: '0 16px 16px' }}>No language data.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}
