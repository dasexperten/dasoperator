'use client';

import React, { useState } from 'react';
import './analytics.css';
import OverviewTab from './tabs/OverviewTab';
import TrafficTab from './tabs/TrafficTab';
import FunnelTab from './tabs/FunnelTab';
import BehaviorTab from './tabs/BehaviorTab';
import CampaignsTab from './tabs/CampaignsTab';

// =============================================================================
// /analytics — Web Analytics Command Center.
//
// Wix + Shopify dashboard parity fed by OWN sources (see docs/analytics-parity.md):
//   Overview          GA4 + D1 orders
//   Traffic & Sources GA4 channels/pages + Metrika RU contour (kept)
//   Funnel            GA4 events
//   Behavior          Microsoft Clarity (+ D1 nightly archive)
//   Campaigns         Yandex Direct (token pending) + Google Ads (approval pending)
//
// RULES: every tab labels its data source; three trackers see three different
// volumes (geo + consent + sampling) and are never blended without a formula
// note. Nightly cron (02:30 UTC) archives into D1 — that archive is the only
// Clarity history in existence.
//
// Design: pilot of the Das Experten design-system handoff (web/design-system/),
// distributor ui_kit patterns; tokens only, no hardcoded hex.
// =============================================================================

const TABS = [
  { id: 'overview', label: 'Overview', src: 'GA4 + D1 orders' },
  { id: 'traffic', label: 'Traffic & Sources', src: 'GA4 + Metrika (RU)' },
  { id: 'funnel', label: 'Funnel', src: 'GA4 events' },
  { id: 'behavior', label: 'Behavior', src: 'Clarity' },
  { id: 'campaigns', label: 'Campaigns', src: 'Direct + Ads' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function AnalyticsPage() {
  const [active, setActive] = useState<TabId>('overview');
  // Tabs stay mounted once visited — no refetch flash when switching back.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set<TabId>(['overview']));

  const activate = (id: TabId) => {
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  return (
    <div className="space-y-6 max-w-7xl">
      {/* ============================ HEADER ============================ */}
      <div>
        <div className="dx-eyebrow mb-2">Web Analytics Command Center</div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 900, color: 'var(--fg-1)' }}>
          dasexperten.com Analytics
        </h1>
        <p style={{ color: 'var(--fg-2)', marginTop: 4, maxWidth: 720 }}>
          Wix/Shopify-grade dashboards on our own trackers: GA4 (global), Microsoft Clarity
          (behavior), Yandex Metrika (RU contour), D1 orders — refreshed nightly at 02:30 UTC.
          Each tab states its source; contours are never blended without a formula note.
        </p>
        <div className="dx-ribbon-rule mt-4" style={{ maxWidth: 240 }}><i /><i /><i /></div>
      </div>

      {/* ============================ TABS ============================ */}
      <div className="wa-tabs" role="tablist" aria-label="Analytics sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            className={`wa-tab${active === t.id ? ' active' : ''}`}
            onClick={() => activate(t.id)}
            title={`Source: ${t.src}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Panels stay mounted once visited; only the active one is shown. */}
      <div style={{ display: active === 'overview' ? 'block' : 'none' }}>
        {visited.has('overview') && <OverviewTab />}
      </div>
      <div style={{ display: active === 'traffic' ? 'block' : 'none' }}>
        {visited.has('traffic') && <TrafficTab />}
      </div>
      <div style={{ display: active === 'funnel' ? 'block' : 'none' }}>
        {visited.has('funnel') && <FunnelTab />}
      </div>
      <div style={{ display: active === 'behavior' ? 'block' : 'none' }}>
        {visited.has('behavior') && <BehaviorTab />}
      </div>
      <div style={{ display: active === 'campaigns' ? 'block' : 'none' }}>
        {visited.has('campaigns') && <CampaignsTab />}
      </div>

      {/* ============================ FOOTER ============================ */}
      <div style={{ paddingTop: 16, borderTop: '1px solid var(--border-hairline)' }}>
        <p style={{ color: 'var(--fg-3)' }}>
          Sources: GA4 property 511756146 · Clarity Data Export (10 calls/day cap — served from
          nightly cache) · Metrika counter 107720199 · D1 web_analytics_daily /
          web_behavior_snapshots. Spec: docs/analytics-parity.md — NONE-source metrics are cut,
          never faked. Pending: Yandex Direct token · Google Ads Basic-access approval.
        </p>
      </div>
    </div>
  );
}
