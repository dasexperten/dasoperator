'use client';

// =============================================================================
// Campaigns tab — paid media.
//   Direct column: Yandex Direct Reports API. Ships in honest "not configured"
//   state until DIRECT_OAUTH_TOKEN lands as a Worker secret (activates same day).
//   Ads column: bounded live Google Ads delivery from the Jurgen worker.
// HARD RULE 4: absent source = graceful empty state, never fabricated data.
// =============================================================================

import React from 'react';
import {
  useApi, fmtNum, fmtPct, timeAgo,
  Panel, LoadState,
  type AdsPriceTestExposure, type DirectCampaigns, type Ga4Overview,
} from '../shared';

function fmtRub(n: number | null | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);
}

function fmtUsd(n: number | null | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  }).format(n);
}

export default function CampaignsTab() {
  const direct = useApi<DirectCampaigns>('/api/direct/campaigns?days=30');
  const ga4 = useApi<Ga4Overview>('/api/ga4/overview?days=30');
  const ads = useApi<AdsPriceTestExposure>('/api/ga4/price-test-exposure');
  const d = direct.data;
  const search = ads.data?.replacement_search_delivery;
  const legacy = ads.data?.campaign_delivery;

  return (
    <div className="space-y-4">
      <div className="wa-grid2eq">
        {/* ---------------- Yandex Direct column ---------------- */}
        <Panel
          title="Yandex Direct — campaigns 30d"
          source="Yandex Direct Reports API · RU paid"
          pad={false}
        >
          <div className="wa-panel-body">
            <LoadState loading={direct.loading} error={direct.error} />
            {d && !d.configured && (
              <div>
                <span className="wa-status warn"><span className="dot" />not configured</span>
                <p style={{ color: 'var(--fg-2)', marginTop: 12 }}>
                  {d.reason ?? 'DIRECT_OAUTH_TOKEN is not set.'}
                </p>
                <p style={{ color: 'var(--fg-3)', marginTop: 8 }}>
                  The column activates the day the token is stored — no code change, no deploy.
                </p>
              </div>
            )}
            {d && d.configured && d.pending && (
              <div>
                <span className="wa-status warn"><span className="dot" />report building</span>
                <p style={{ color: 'var(--fg-2)', marginTop: 12 }}>
                  Direct is preparing the report offline — retry in ~{d.retry_in_sec ?? 60}s.
                </p>
              </div>
            )}
          </div>
          {d && d.configured && !d.pending && (
            <div className="wa-table-scroll">
              <table className="wa-table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th className="right">Impr.</th>
                    <th className="right">Clicks</th>
                    <th className="right">Spend</th>
                    <th className="right">Conv.</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.campaign_id}>
                      <td style={{ fontWeight: 700 }}>{r.campaign}</td>
                      <td className="num right soft">{fmtNum(r.impressions)}</td>
                      <td className="num right">{fmtNum(r.clicks)}</td>
                      <td className="num right">{fmtRub(r.cost)}</td>
                      <td className="num right">{fmtNum(r.conversions)}</td>
                    </tr>
                  ))}
                  {d.totals && (
                    <tr style={{ background: 'var(--paper-sunk)' }}>
                      <td style={{ fontWeight: 700 }}>TOTAL</td>
                      <td className="num right soft">{fmtNum(d.totals.impressions)}</td>
                      <td className="num right" style={{ fontWeight: 700 }}>{fmtNum(d.totals.clicks)}</td>
                      <td className="num right" style={{ fontWeight: 700 }}>{fmtRub(d.totals.cost)}</td>
                      <td className="num right">{fmtNum(d.totals.conversions)}</td>
                    </tr>
                  )}
                  {d.rows.length === 0 && (
                    <tr><td colSpan={5} style={{ color: 'var(--fg-3)' }}>No campaign rows in the window.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ---------------- Google Ads column ---------------- */}
        <Panel title="Google Ads — active price-test delivery" source="Google Ads API · bounded Jurgen feed" pad={false}>
          <div className="wa-panel-body">
            <LoadState loading={ads.loading} error={ads.error} />
            {ads.data && (
              <>
                <span className="wa-status ok"><span className="dot" />live</span>
                <p style={{ color: 'var(--fg-2)', marginTop: 12 }}>
                  PH and MY Search delivery is isolated from the paused legacy PMax campaign.
                  Budgets, auction status and spend below come directly from Google Ads.
                </p>
              </>
            )}
          </div>
          {ads.data && (
            <div className="wa-table-scroll">
              <table className="wa-table">
                <thead>
                  <tr><th>Campaign</th><th>Status</th><th className="right">Budget/day</th><th className="right">Impr.</th><th className="right">Clicks</th><th className="right">Spend</th><th className="right">Conv.</th></tr>
                </thead>
                <tbody>
                  {(['PH', 'MY'] as const).map((code) => {
                    const row = search?.[code];
                    return row ? (
                      <tr key={row.campaign_id}>
                        <td style={{ fontWeight: 700 }}>{code} Search</td>
                        <td>{row.primary_status || row.status || '—'}</td>
                        <td className="num right">{fmtUsd(row.daily_budget_usd)}</td>
                        <td className="num right soft">{fmtNum(row.impressions)}</td>
                        <td className="num right">{fmtNum(row.clicks)}</td>
                        <td className="num right">{fmtUsd(row.cost_usd)}</td>
                        <td className="num right">{fmtNum(row.conversions)}</td>
                      </tr>
                    ) : null;
                  })}
                  {legacy && (
                    <tr>
                      <td style={{ fontWeight: 700 }}>Legacy PMax</td>
                      <td>{legacy.primary_status || legacy.status || '—'}</td>
                      <td className="num right">{fmtUsd(legacy.daily_budget_usd)}</td>
                      <td className="num right soft">{fmtNum(legacy.post_launch_complete_hours.impressions)}</td>
                      <td className="num right">{fmtNum(legacy.post_launch_complete_hours.clicks)}</td>
                      <td className="num right">{fmtUsd(legacy.post_launch_complete_hours.cost_usd)}</td>
                      <td className="num right">{fmtNum(legacy.post_launch_complete_hours.conversions)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p style={{ color: 'var(--fg-3)', padding: '10px 14px' }}>Synced {timeAgo(ads.data.synced_at)}.</p>
            </div>
          )}
        </Panel>
      </div>

      {/* ---------------- Spend vs revenue / ROAS ---------------- */}
      <Panel title="Spend vs revenue · ROAS" source="formula-gated">
        {d && d.configured && !d.pending && d.totals && ga4.data ? (
          <div>
            <p style={{ color: 'var(--fg-1)' }}>
              Direct spend 30d: <strong className="dx-mono">{fmtRub(d.totals.cost)}</strong> · GA4 revenue 30d:{' '}
              <strong className="dx-mono">${fmtNum(ga4.data.totals.revenue)}</strong>
            </p>
            <div className="wa-note" style={{ marginTop: 8 }}>
              Formula note (HARD RULE 3): spend is Yandex Direct (RU contour, RUB incl. VAT);
              revenue is GA4 (global .com contour, mostly VN Paid Search). These are different
              contours and currencies — a blended ROAS number would be dishonest, so none is
              printed until Direct-attributed revenue exists (Metrika ecommerce or D1 order join).
            </div>
          </div>
        ) : (
          <div>
            <p style={{ color: 'var(--fg-2)' }}>
              Google Ads spend is live, but ROAS remains withheld until campaign cost and
              attributable order revenue are joined on the same contour. Direct remains token-pending.
            </p>
            <div className="wa-note" style={{ marginTop: 8 }}>
              Design rule: spend and revenue are only divided when both sides come from the same
              contour, with the formula printed next to the number. No fabricated ROAS, ever.
            </div>
          </div>
        )}
        {d && <p style={{ color: 'var(--fg-3)', marginTop: 10 }}>Synced {timeAgo(d.synced_at)}.</p>}
      </Panel>
    </div>
  );
}
