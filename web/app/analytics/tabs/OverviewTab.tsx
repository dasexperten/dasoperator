'use client';

// =============================================================================
// Overview tab — Shopify-overview parity: revenue, sessions, CR, AOV,
// returning-customer rate + 30d trends.
// Sources: GA4 (global .com contour) + D1 orders (marketplace contour) +
// D1 nightly archive. Every block is source-labelled (HARD RULE 3).
// =============================================================================

import React from 'react';
import { AreaChart } from '@tremor/react';
import {
  useApi, fmtNum, fmtPct, fmtMoney, timeAgo,
  Kpi, Panel, LoadState, SourceChip,
  type Ga4Overview, type MpSummary, type WebDaily,
} from '../shared';

export default function OverviewTab() {
  const ga4 = useApi<Ga4Overview>('/api/ga4/overview?days=30');
  const mp = useApi<MpSummary>('/api/analytics/marketplace-summary');
  const archive = useApi<WebDaily>('/api/analytics/web-daily?days=30');

  const t = ga4.data?.totals;
  const archiveNights = new Set((archive.data?.rows ?? []).map((r) => r.date)).size;

  return (
    <div className="space-y-4">
      <LoadState loading={ga4.loading} error={ga4.error} />

      {/* KPI row — distributor-kit .kpis */}
      {t && (
        <div className="wa-kpis">
          <Kpi accent label="Revenue · 30d" value={fmtMoney(t.revenue)} delta={`GA4 purchase revenue`} />
          <Kpi label="Sessions · 30d" value={fmtNum(t.sessions)} delta={`${fmtNum(t.users)} users`} />
          <Kpi label="Purchases · 30d" value={fmtNum(t.purchases)} delta="GA4 ecommercePurchases" />
          <Kpi label="Conversion rate" value={fmtPct(t.cr)} delta="purchases ÷ sessions" />
          <Kpi label="Avg order value" value={fmtMoney(t.aov)} delta="revenue ÷ purchases" />
          <Kpi
            label="Returning-customer rate"
            value={ga4.data?.returning.rate_pct === null ? '—' : fmtPct(ga4.data!.returning.rate_pct)}
            delta="GA4 newVsReturning × purchases"
          />
        </div>
      )}

      {ga4.data && (
        <div className="wa-note">
          Source: {ga4.data.source} · window {ga4.data.window_days}d · synced {timeAgo(ga4.data.synced_at)}.
          Formulas above are GA4-only — never blended with Metrika (RU) or Clarity numbers.
        </div>
      )}

      <div className="wa-grid2eq">
        <Panel title="Sessions — 30 days" source="GA4 · dasexperten.com">
          {ga4.data && ga4.data.rows.length > 0 ? (
            <div className="wa-chart">
              <AreaChart
                className="h-64"
                data={ga4.data.rows}
                index="date"
                categories={['sessions']}
                colors={['stone']}
                valueFormatter={fmtNum}
                showAnimation={false}
                showLegend={false}
              />
            </div>
          ) : (
            <p style={{ color: 'var(--fg-3)' }}>No daily data.</p>
          )}
        </Panel>
        <Panel title="Revenue — 30 days" source="GA4 · dasexperten.com">
          {ga4.data && ga4.data.rows.length > 0 ? (
            <div className="wa-chart">
              <AreaChart
                className="h-64"
                data={ga4.data.rows}
                index="date"
                categories={['revenue']}
                colors={['red']}
                valueFormatter={(n: number) => fmtMoney(n)}
                showAnimation={false}
                showLegend={false}
              />
            </div>
          ) : (
            <p style={{ color: 'var(--fg-3)' }}>No daily data.</p>
          )}
        </Panel>
      </div>

      {/* D1 orders — marketplace contour, separate world from GA4 web funnel */}
      <Panel title="Orders — marketplace contour" source="D1 orders · Ozon + WB" pad={false}>
        <div className="wa-table-scroll">
          <table className="wa-table">
            <thead>
              <tr>
                <th>Marketplace</th>
                <th className="right">FBO units</th>
                <th className="right">30d sales (units)</th>
                <th className="right">SKUs stock/sales</th>
                <th className="right">Last sync</th>
              </tr>
            </thead>
            <tbody>
              {(mp.data?.marketplaces ?? []).map((m) => (
                <tr key={m.marketplace}>
                  <td style={{ fontWeight: 700, textTransform: 'uppercase' }}>{m.marketplace}</td>
                  <td className="num right">{fmtNum(m.fbo_units)}</td>
                  <td className="num right">{fmtNum(m.sales_30d)}</td>
                  <td className="num right soft">{m.sku_count_stock}/{m.sku_count_sales}</td>
                  <td className="num right soft">{timeAgo(m.last_finish ?? m.last_sync)}</td>
                </tr>
              ))}
              {!mp.loading && (mp.data?.marketplaces ?? []).length === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--fg-3)' }}>No marketplace data yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="wa-panel-body" style={{ paddingTop: 12 }}>
          <div className="wa-note">
            Units sold on Ozon/WB (RU marketplaces) — a different sales channel than the
            dasexperten.com web funnel above. Site revenue in the KPI row is GA4-tracked; the
            authoritative money ledger stays in ERP /finance settlements.
          </div>
        </div>
      </Panel>

      {/* D1 nightly archive status */}
      <Panel title="Nightly D1 archive" source="D1 · web_analytics_daily">
        {archive.loading ? (
          <p style={{ color: 'var(--fg-3)' }}>Loading…</p>
        ) : archiveNights === 0 ? (
          <p style={{ color: 'var(--fg-2)' }}>
            No rows yet — the 02:30 UTC cron writes GA4 + Metrika + Clarity (+ Direct when
            configured) every night. Acceptance: 14 consecutive nights unattended.
          </p>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="wa-status ok"><span className="dot" />{archiveNights} nights collected</span>
            <span style={{ color: 'var(--fg-3)' }}>
              Long-horizon trends unlock as the archive accumulates (Clarity has no backfill — D1 is the archive).
            </span>
          </div>
        )}
      </Panel>
    </div>
  );
}
