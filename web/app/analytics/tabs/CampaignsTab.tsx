'use client';

// =============================================================================
// Campaigns tab — paid media.
//   Direct column: Yandex Direct Reports API. Ships in honest "not configured"
//   state until DIRECT_OAUTH_TOKEN lands as a Worker secret (activates same day).
//   Ads column: Google Ads API v21 — credentialed but BLOCKED on Google
//   Basic-access approval (submitted 2026-06-11). [PENDING GOOGLE APPROVAL].
// HARD RULE 4: absent source = graceful empty state, never fabricated data.
// =============================================================================

import React from 'react';
import {
  useApi, fmtNum, fmtPct, timeAgo,
  Panel, LoadState,
  type DirectCampaigns, type Ga4Overview,
} from '../shared';

function fmtRub(n: number | null | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(n);
}

export default function CampaignsTab() {
  const direct = useApi<DirectCampaigns>('/api/direct/campaigns?days=30');
  const ga4 = useApi<Ga4Overview>('/api/ga4/overview?days=30');
  const d = direct.data;

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
                      <td className="num right">{fmtNum(r.impressions)}</td>
                      <td className="num right">{fmtNum(r.clicks)}</td>
                      <td className="num right">{fmtRub(r.cost)}</td>
                      <td className="num right">{fmtNum(r.conversions)}</td>
                    </tr>
                  ))}
                  {d.totals && (
                    <tr style={{ background: 'var(--paper-sunk)' }}>
                      <td style={{ fontWeight: 700 }}>TOTAL</td>
                      <td className="num right">{fmtNum(d.totals.impressions)}</td>
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
        <Panel title="Google Ads — campaigns 30d" source="Google Ads API v21 · VN paid">
          <span className="wa-status warn"><span className="dot" />pending google approval</span>
          <p style={{ color: 'var(--fg-2)', marginTop: 12 }}>
            All six credentials are stored (developer token, customer, MCC, OAuth client + secret +
            refresh token). Google Basic-access approval was submitted 2026-06-11; until it is
            granted the test-account restriction blocks real data.
          </p>
          <p style={{ color: 'var(--fg-3)', marginTop: 8 }}>
            The column activates the day access is granted. Meanwhile the VN paid traffic is
            visible in Traffic &amp; Sources as the GA4 “Paid Search” channel (~87% of .com sessions).
          </p>
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
              ROAS unlocks when a spend source is live: Direct (token pending) or Google Ads
              (approval pending). Neither blocks the rest of the dashboard.
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
