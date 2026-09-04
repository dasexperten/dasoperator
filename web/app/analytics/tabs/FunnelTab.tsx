'use client';

// =============================================================================
// Funnel tab — sessions → view_item → add_to_cart → begin_checkout → purchase.
// Source: GA4 event counts (global .com contour). Absolute counts + step rates.
// Includes the low-traffic confidence note and the units caveat (sessions vs
// event counts — a session can fire an event more than once).
// =============================================================================

import React from 'react';
import {
  useApi, fmtNum, fmtPct, timeAgo,
  Kpi, Panel, LoadState,
  type AdsPriceTestExposure, type Ga4Funnel, type Ga4CommerceLosses,
} from '../shared';

const STEP_LABELS: Record<string, string> = {
  sessions: 'Sessions',
  view_item: 'View item',
  add_to_cart: 'Add to cart',
  begin_checkout: 'Begin checkout',
  purchase: 'Purchase',
};

const SIGNAL_LABELS: Record<string, string> = {
  add_to_cart: 'Added to cart',
  view_cart: 'Viewed cart',
  begin_checkout: 'Began checkout',
  checkout_loaded: 'Checkout loaded',
  checkout_email_complete: 'Email completed',
  checkout_address_started: 'Address started',
  checkout_address_complete: 'Address completed',
  shipping_quote_ready: 'Shipping quote ready',
  add_payment_info: 'Reached payment',
  checkout_error: 'Checkout error',
  checkout_error_required_fields: 'Error · required fields',
  checkout_error_stripe_load_failed: 'Error · Stripe did not load',
  checkout_error_quote_invalid: 'Error · invalid shipping quote',
  checkout_error_quote_failed: 'Error · shipping quote request',
  checkout_error_card_declined: 'Error · card declined',
  checkout_error_wallet_confirm_failed: 'Error · wallet confirmation',
  checkout_error_intent_failed: 'Error · payment intent',
  paid_locale_landing_vn: 'Paid landing localized · Vietnam',
  paid_locale_landing_th: 'Paid landing localized · Thailand',
  paid_locale_landing_tl: 'Paid landing localized · Philippines',
  paid_locale_landing_ms: 'Paid landing localized · Malaysia',
  paid_locale_landing_zh: 'Paid landing localized · Taiwan',
  pdp_value_proof_view: 'Saw product value proof',
  pdp_price_view: 'Saw product price',
  shipping_unavailable: 'Shipping unavailable',
  shipping_quote_request: 'Requested shipping quote',
  shipping_bundle_offer: 'Saw two-tube shipping value',
  shipping_preview_ready: 'Saw delivery price before checkout',
  shipping_bundle_unavailable: 'Two-tube shipping offer unavailable',
  shipping_bundle_add: 'Added second tube',
  marketplace_open: 'Opened marketplace choices',
  marketplace_click: 'Clicked marketplace',
  purchase_verified: 'Stripe-verified purchase',
  purchase: 'Purchased',
};

function gaMinute(value: string) {
  return /^\d{12}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}`
    : value || '—';
}

export default function FunnelTab() {
  const funnel = useApi<Ga4Funnel>('/api/ga4/funnel?days=30');
  const losses = useApi<Ga4CommerceLosses>('/api/ga4/commerce-losses?days=30&limit=250');
  const exposure = useApi<AdsPriceTestExposure>('/api/ga4/price-test-exposure');
  const t = funnel.data?.totals;
  const rows = funnel.data?.rows ?? [];
  const base = rows[0]?.count ?? 0;
  const verifiedPurchases = losses.data?.totals.purchase_verified ?? 0;
  const verifiedCr = t?.sessions ? (verifiedPurchases / t.sessions) * 100 : 0;
  const lowTraffic = verifiedPurchases < 30;
  const bundleOffers = losses.data?.totals.shipping_bundle_offer ?? 0;
  const bundleAdds = losses.data?.totals.shipping_bundle_add ?? 0;
  const bundleUptake = bundleOffers > 0 ? (bundleAdds / bundleOffers) * 100 : 0;
  const paidVnLandings = losses.data?.market_totals.vn_paid_landing ?? 0;
  const vnCartAdds = losses.data?.market_totals.vn_add_to_cart ?? 0;
  const vnLandingToCart = paidVnLandings > 0 ? (vnCartAdds / paidVnLandings) * 100 : 0;
  const paidPhLandings = losses.data?.price_test?.ph_paid_landing ?? 0;
  const phCartAdds = losses.data?.price_test?.ph_add_to_cart ?? 0;
  const phLandingToCart = paidPhLandings > 0 ? (phCartAdds / paidPhLandings) * 100 : null;
  const paidMyLandings = losses.data?.price_test?.my_paid_landing ?? 0;
  const myCartAdds = losses.data?.price_test?.my_add_to_cart ?? 0;
  const myLandingToCart = paidMyLandings > 0 ? (myCartAdds / paidMyLandings) * 100 : null;
  const postLaunchAds = exposure.data?.campaign_delivery?.post_launch_complete_hours;

  return (
    <div className="space-y-4">
      <LoadState loading={funnel.loading} error={funnel.error} />
      <LoadState loading={losses.loading} error={losses.error} />
      <LoadState loading={exposure.loading} error={exposure.error} />

      {t && (
        <div className="wa-kpis">
          <Kpi label="Sessions · 30d" value={fmtNum(t.sessions)} delta="funnel base" />
          <Kpi label="GA4 purchase events · 30d" value={fmtNum(t.purchases)} delta="legacy + verified sources" />
          <Kpi label="Stripe-verified purchases" value={fmtNum(verifiedPurchases)} delta="server-confirmed succeeded" />
          <Kpi accent label="Verified CR" value={fmtPct(verifiedCr)} delta="verified purchases ÷ sessions" />
        </div>
      )}

      <Panel title="E-commerce funnel — 30 days" source="GA4 events · dasexperten.com">
        {rows.length > 0 ? (
          <div>
            {rows.map((r, i) => {
              const width = base > 0 ? Math.max((r.count / base) * 100, 0.5) : 0;
              return (
                <div className="wa-funnel-row" key={r.step}>
                  <div style={{ fontWeight: 700 }}>{STEP_LABELS[r.step] ?? r.step}</div>
                  <div className="wa-funnel-bar">
                    <div
                      className={`wa-funnel-fill${r.step === 'purchase' ? ' rot' : ''}`}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <div className="meta" style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>
                    <strong style={{ color: 'var(--brand-rot)', fontWeight: 800 }}>{fmtNum(r.count)}</strong>
                    {i > 0 && r.rate_vs_prev_pct !== null && <> · {fmtPct(r.rate_vs_prev_pct)} of prev</>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          !funnel.loading && <p style={{ color: 'var(--fg-3)' }}>No funnel data.</p>
        )}
        <div className="wa-note" style={{ marginTop: 12 }}>
          Units caveat: the first step counts sessions; later steps count GA4 events — one session
          can fire view_item several times, so step rates are indicative, not user-level.
          {funnel.data && <> Synced {timeAgo(funnel.data.synced_at)}.</>}
        </div>
        {lowTraffic && !funnel.loading && (
          <div className="wa-note" style={{ marginTop: 8, color: 'var(--status-warning)' }}>
            Low-traffic confidence note: fewer than 30 purchases in the window — step rates swing
            hard on single orders. Read direction, not decimals.
          </div>
        )}
      </Panel>

      <Panel title="Paid landing through checkout — progress, failures and handoffs" source="Google Ads calendar delivery + GA4 post-launch events">
        {exposure.data && (
          <>
            <div className="wa-kpis" style={{ marginBottom: 16 }}>
              {(['PH', 'MY', 'VN'] as const).map((code) => {
                const market = exposure.data!.markets[code];
                return (
                  <Kpi
                    key={code}
                    accent={code === 'MY' && market.clicks === 0}
                    label={`${code} Ads impressions`}
                    value={fmtNum(market.impressions)}
                    delta={`${fmtNum(market.clicks)} clicks · $${market.cost_usd.toFixed(2)}`}
                  />
                );
              })}
            </div>
            {postLaunchAds && (
              <div className="wa-kpis" style={{ marginBottom: 16 }}>
                <Kpi label="Ads after launch · impressions" value={fmtNum(postLaunchAds.impressions)} delta="complete account-time hours" />
                <Kpi accent={postLaunchAds.clicks === 0} label="Ads after launch · clicks" value={fmtNum(postLaunchAds.clicks)} delta={`$${postLaunchAds.cost_usd.toFixed(4)} spend`} />
                <Kpi label="Campaign delivery" value={exposure.data.campaign_delivery?.primary_status ?? '—'} delta={`$${exposure.data.campaign_delivery?.daily_budget_usd.toFixed(2)} daily · ${exposure.data.campaign_delivery?.serving_status ?? 'unknown'}`} />
              </div>
            )}
            <div className="wa-note" style={{ marginBottom: 16 }}>
              Ads delivery covers calendar days {exposure.data.calendar_start} → {exposure.data.calendar_end};
              launch day includes time before 09:46 UTC. The PH/MY price cards below use the exact GA4 release seam.
              {exposure.data.campaign_delivery && <>{' '}Post-launch Ads totals conservatively exclude the partial launch hour ({exposure.data.campaign_delivery.launch_account_hour}:00) in {exposure.data.campaign_delivery.account_time_zone}.</>}
              {' '}Synced {timeAgo(exposure.data.synced_at)}.
            </div>
          </>
        )}
        {losses.data && (
          <>
            <div className="wa-kpis" style={{ marginBottom: 16 }}>
              <Kpi label="VN paid landings" value={fmtNum(paidVnLandings)} delta="localized paid traffic" />
              <Kpi label="VN carts" value={fmtNum(vnCartAdds)} delta="add_to_cart events" />
              <Kpi accent label="VN landing → cart" value={fmtPct(vnLandingToCart)} delta="aggregate signal ratio" />
            </div>
            <div className="wa-kpis" style={{ marginBottom: 16 }}>
              <Kpi label="PH ₱499 landings" value={fmtNum(paidPhLandings)} delta="post-launch · exact PDP" />
              <Kpi label="PH ₱499 carts" value={fmtNum(phCartAdds)} delta="post-launch · exact PDP" />
              <Kpi accent label="PH ₱499 landing → cart" value={fmtPct(phLandingToCart)} delta="Sep 4 09:46 UTC → Sep 11" />
            </div>
            <div className="wa-kpis" style={{ marginBottom: 16 }}>
              <Kpi label="MY RM29.90 landings" value={fmtNum(paidMyLandings)} delta="post-launch · exact PDP" />
              <Kpi label="MY RM29.90 carts" value={fmtNum(myCartAdds)} delta="post-launch · exact PDP" />
              <Kpi accent label="MY RM29.90 landing → cart" value={fmtPct(myLandingToCart)} delta="Sep 4 09:46 UTC → Sep 11" />
            </div>
            <div className="wa-kpis" style={{ marginBottom: 16 }}>
              <Kpi label="Shipping bundle offers" value={fmtNum(bundleOffers)} delta="DE · VN · PH · MY" />
              <Kpi label="Second tubes added" value={fmtNum(bundleAdds)} delta="one-click action" />
              <Kpi accent label="Bundle uptake" value={fmtPct(bundleUptake)} delta="adds ÷ offers" />
            </div>
          </>
        )}
        {losses.data?.rows.length ? (
          <div className="wa-table-scroll">
            <table className="wa-table">
              <thead>
                <tr><th>Signal</th><th>Minute · GA4</th><th>Count</th><th>Country</th><th>Page</th><th>Campaign</th></tr>
              </thead>
              <tbody>
                {losses.data.rows.map((row, i) => {
                  const isFailure = row.event === 'checkout_error' || row.event === 'shipping_unavailable';
                  return (
                    <tr key={`${row.event}-${row.country}-${row.page}-${row.campaign}-${i}`}>
                      <td style={isFailure ? { color: 'var(--status-warning)', fontWeight: 800 } : undefined}>
                        {SIGNAL_LABELS[row.event] ?? row.event}
                      </td>
                      <td><time>{gaMinute(row.event_minute)}</time></td>
                      <td className="num">{fmtNum(row.count)}</td>
                      <td>{row.country}</td>
                      <td><code>{row.page}</code></td>
                      <td>{row.campaign}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          !losses.loading && <p style={{ color: 'var(--fg-3)' }}>No downstream commerce signals in this window.</p>
        )}
        <div className="wa-note" style={{ marginTop: 12 }}>
          Aggregate event counts, not a user-level sequence. Marketplace handoffs stay separate
          from on-site purchases; technical and shipping failures stay separate from abandonment.
          {losses.data && <> Synced {timeAgo(losses.data.synced_at)}.</>}
        </div>
      </Panel>
    </div>
  );
}
