'use client';

// =============================================================================
// GA4 Snapshot tab — direct parity with the six GA4 UI widgets Aram asked to
// have inside the ERP: active users by country (map + table), ecommerce
// snapshot (active users / add to carts / checkouts / purchases + trend),
// views by page title & screen, sessions by channel, realtime (last 30 min +
// by country), active users by language.
//
// Source: GA4 property 511756146 (dasexperten.com, global contour) only —
// same rule as every other tab: never blended with Metrika or Clarity.
// Realtime panel self-polls every 60s while this tab is mounted (GA4's own
// realtime cards refresh on a similar cadence); everything else is the
// standard 1h server-side cache other GA4 tabs already use.
// =============================================================================

import React, { useEffect, useState } from 'react';
import { BarChart, AreaChart } from '@tremor/react';
import {
  useApi, fmtNum, fmtPct, timeAgo,
  Kpi, Panel, LoadState, ChartLegend,
  type Ga4Geo, type Ga4Languages, type Ga4Content, type Ga4Snapshot, type Ga4Realtime, type Ga4Channels,
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

  // Realtime: self-polling — this is the one panel where "1h cache" would be
  // pointless. Polls every 60s while the tab is mounted; stops on unmount.
  const [realtime, setRealtime] = useState<{ data: Ga4Realtime | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('https://dasoperator-api.dasexperten.workers.dev/api/ga4/realtime');
        const json = await res.json();
        if (cancelled) return;
        if (json?.success) setRealtime({ data: json.result, error: null, loading: false });
        else setRealtime((s) => ({ ...s, error: json?.errors?.[0]?.message ?? 'API error', loading: false }));
      } catch (e) {
        if (!cancelled) setRealtime((s) => ({ ...s, error: e instanceof Error ? e.message : 'Unknown error', loading: false }));
      }
    }
    poll();
    const id = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const geoMax = geo.data?.rows[0]?.active_users ?? 0;
  const snapDelta = snapshot.data?.deltas_pct;

  const rt = realtime.data;

  return (
    <div className="space-y-4">
      <div className="wa-note">
        Snapshot — same six cards as the GA4 UI's Reports snapshot + Realtime overview, rebuilt
        here so the numbers live next to the rest of the ERP. Source: GA4 property 511756146.
      </div>

      {/* ============ Realtime overview — GA4-style, self-refreshes 60s ============ */}
      <Panel title="Realtime overview" source="GA4 realtime · self-refreshes 60s">
        <LoadState loading={realtime.loading} error={realtime.error} />
        {rt && (
          <>
            <div className="wa-grid2eq" style={{ alignItems: 'start' }}>
              <div>
                <div className="wa-kpis">
                  <Kpi label="Active users in last 30 minutes" value={fmtNum(rt.active_users_now)} />
                  <Kpi label="Active users in last 5 minutes" value={rt.active_users_5min === undefined ? '—' : fmtNum(rt.active_users_5min)} />
                </div>
                {rt.per_minute.length > 0 && (
                  <div className="wa-chart" style={{ marginTop: 12 }}>
                    <BarChart
                      className="h-40"
                      data={rt.per_minute.map((r) => ({ minute: `-${r.minutes_ago}`, 'active users': r.active_users }))}
                      index="minute"
                      categories={['active users']}
                      colors={['stone']}
                      valueFormatter={fmtNum}
                      showAnimation={false}
                      showLegend={false}
                      showXAxis={false}
                    />
                  </div>
                )}
              </div>
              <WorldMap
                data={rt.by_country.map((r) => ({ country: r.country, value: r.active_users }))}
                height={260}
              />
            </div>

            <div className="wa-grid2eq" style={{ marginTop: 16 }}>
              <div className="wa-table-scroll" style={{ maxHeight: 240 }}>
                <table className="wa-table">
                  <thead><tr><th>Audience</th><th className="right">Active users</th></tr></thead>
                  <tbody>
                    {(rt.by_audience ?? []).map((r) => (
                      <tr key={r.audience}><td style={{ fontWeight: 700 }}>{r.audience}</td><td className="num right">{fmtNum(r.count)}</td></tr>
                    ))}
                    {(rt.by_audience ?? []).length === 0 && (
                      <tr><td colSpan={2} style={{ color: 'var(--fg-3)' }}>No audience data right now.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="wa-table-scroll" style={{ maxHeight: 240 }}>
                <table className="wa-table">
                  <thead><tr><th>Country</th><th className="right">Active users</th></tr></thead>
                  <tbody>
                    {rt.by_country.map((r) => (
                      <tr key={r.country}><td style={{ fontWeight: 700 }}>{r.country}</td><td className="num right">{fmtNum(r.active_users)}</td></tr>
                    ))}
                    {rt.by_country.length === 0 && (
                      <tr><td colSpan={2} style={{ color: 'var(--fg-3)' }}>Nobody on-site right now.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="wa-grid2eq" style={{ marginTop: 16 }}>
              <div className="wa-table-scroll" style={{ maxHeight: 240 }}>
                <table className="wa-table">
                  <thead><tr><th>Page title and screen name</th><th className="right">Views</th></tr></thead>
                  <tbody>
                    {(rt.by_page ?? []).map((r) => (
                      <tr key={r.title}><td style={{ maxWidth: 320, wordBreak: 'break-word' }}>{r.title}</td><td className="num right">{fmtNum(r.count)}</td></tr>
                    ))}
                    {(rt.by_page ?? []).length === 0 && (
                      <tr><td colSpan={2} style={{ color: 'var(--fg-3)' }}>No page views right now.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="wa-table-scroll" style={{ maxHeight: 240 }}>
                <table className="wa-table">
                  <thead><tr><th>Event name</th><th className="right">Event count</th></tr></thead>
                  <tbody>
                    {(rt.by_event ?? []).map((r) => (
                      <tr key={r.event}><td style={{ fontWeight: 700 }}>{r.event}</td><td className="num right">{fmtNum(r.count)}</td></tr>
                    ))}
                    {(rt.by_event ?? []).length === 0 && (
                      <tr><td colSpan={2} style={{ color: 'var(--fg-3)' }}>No events right now.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="wa-table-scroll" style={{ maxHeight: 300, marginTop: 16 }}>
              <table className="wa-table">
                <thead><tr><th>Country</th><th>Commerce event</th><th className="right">Count</th></tr></thead>
                <tbody>
                  {(rt.by_country_event ?? []).map((r) => (
                    <tr key={`${r.country}:${r.event}`}>
                      <td style={{ fontWeight: 700 }}>{r.country}</td>
                      <td>{r.event}</td>
                      <td className="num right">{fmtNum(r.count)}</td>
                    </tr>
                  ))}
                  {(rt.by_country_event ?? []).length === 0 && (
                    <tr><td colSpan={3} style={{ color: 'var(--fg-3)' }}>No country-level commerce events right now.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="wa-note" style={{ marginTop: 12 }}>
              Synced {timeAgo(rt.synced_at)} · minute bars run oldest (-29) to newest (0, now).
              GA4's "by First user source" realtime card has no Realtime-API dimension — cut,
              never faked.
            </div>
          </>
        )}
      </Panel>

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
                <tr><th>Page title and screen</th><th className="right">Views</th></tr>
              </thead>
              <tbody>
                {(content.data?.rows ?? []).map((r) => (
                  <tr key={r.title}>
                    <td style={{ maxWidth: 320, wordBreak: 'break-word' }}>{r.title}</td>
                    <td className="num right">{fmtNum(r.views)}</td>
                  </tr>
                ))}
                {!content.loading && (content.data?.rows ?? []).length === 0 && (
                  <tr><td colSpan={2} style={{ color: 'var(--fg-3)' }}>No page-view data.</td></tr>
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
