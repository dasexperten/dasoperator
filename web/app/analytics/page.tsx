'use client';

import React, { useCallback, useEffect, useState } from 'react';
import './analytics.css';
import SnapshotTab from './tabs/SnapshotTab';
import OverviewTab from './tabs/OverviewTab';
import TrafficTab from './tabs/TrafficTab';
import FunnelTab from './tabs/FunnelTab';
import BehaviorTab from './tabs/BehaviorTab';
import CampaignsTab from './tabs/CampaignsTab';
import AiGeoTab from './tabs/AiGeoTab';

// =============================================================================
// /analytics — Web Analytics Command Center.
//
// Wix + Shopify dashboard parity fed by OWN sources (see docs/analytics-parity.md):
//   Overview          GA4 + D1 orders
//   Traffic & Sources GA4 channels/pages + Metrika RU contour (kept)
//   Funnel            GA4 events
//   Behavior          Microsoft Clarity (+ D1 nightly archive)
//   Campaigns         Yandex Direct (token pending) + Google Ads (approval pending)
//   AI / GEO          Cloudflare AI crawlers + Ubersuggest authority (Owner 2026-07-23)
//
// RULES: every tab labels its data source; three trackers see three different
// volumes (geo + consent + sampling) and are never blended without a formula
// note. Nightly cron (02:30 UTC) archives into D1 — that archive is the only
// Clarity history in existence. AI crawlers never invent counts — demo marker
// if no live POST yet.
//
// Design: pilot of the Das Experten design-system handoff (web/design-system/),
// distributor ui_kit patterns; tokens only, no hardcoded hex.
// =============================================================================

const TABS = [
  { id: 'snapshot', label: 'Snapshot', src: 'GA4 (map, realtime, language)' },
  { id: 'overview', label: 'Overview', src: 'GA4 + D1 orders' },
  { id: 'traffic', label: 'Traffic & Sources', src: 'GA4 + Metrika (RU)' },
  { id: 'funnel', label: 'Funnel', src: 'GA4 events' },
  { id: 'behavior', label: 'Behavior', src: 'Clarity' },
  { id: 'campaigns', label: 'Campaigns', src: 'Direct + Ads' },
  { id: 'ai-geo', label: 'AI / GEO', src: 'Cloudflare crawlers + Ubersuggest' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function AnalyticsPage() {
  const [active, setActive] = useState<TabId>('snapshot');
  // Tabs stay mounted once visited — no refetch flash when switching back.
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set<TabId>(['snapshot']));

  const activate = useCallback((id: TabId) => {
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // Desktop tier (design-system interaction principles): keyboard shortcuts
  // for the high-frequency action — keys 1-5 switch tabs. Documented in-UI
  // via the hint next to the tab bar; ignored while typing in a field.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const idx = parseInt(e.key, 10) - 1;
      const tab = idx >= 0 ? TABS[idx] : undefined;
      if (tab) activate(tab.id);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activate]);

  return (
    <div className="space-y-6 max-w-7xl">
      {/* ============================ HEADER ============================ */}
      <div>
        <div className="dx-eyebrow mb-2">Web Analytics Command Center</div>
        <p style={{ color: 'var(--fg-2)', marginTop: 4, maxWidth: 720 }}>
          Discover how visitors engage with your site&apos;s pages.
        </p>
        <div className="dx-ribbon-rule mt-4" style={{ maxWidth: 240 }}><i /><i /><i /></div>
      </div>

      {/* ============================ TABS ============================ */}
      <div className="wa-tabs" role="tablist" aria-label="Analytics sections">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            aria-keyshortcuts={String(i + 1)}
            className={`wa-tab${active === t.id ? ' active' : ''}`}
            onClick={() => activate(t.id)}
            title={`Source: ${t.src} · key ${i + 1}`}
          >
            {t.label}
          </button>
        ))}
        <span className="wa-kbd-hint" aria-hidden="true">
          <kbd>1</kbd>–<kbd>7</kbd> switch tabs
        </span>
      </div>

      {/* Panels stay mounted once visited; only the active one is shown. */}
      <div style={{ display: active === 'snapshot' ? 'block' : 'none' }}>
        {visited.has('snapshot') && <SnapshotTab />}
      </div>
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
      <div style={{ display: active === 'ai-geo' ? 'block' : 'none' }}>
        {visited.has('ai-geo') && <AiGeoTab />}
      </div>

      {/* ============================ FOOTER ============================ */}
      <div style={{ paddingTop: 16, borderTop: '1px solid var(--border-hairline)' }}>
        <p style={{ color: 'var(--fg-3)' }}>
          Sources: GA4 property 511756146 · Clarity Data Export (10 calls/day cap — served from
          nightly cache) · Metrika counter 107720199 · D1 web_analytics_daily /
          web_behavior_snapshots · SEO/GEO: Ubersuggest site-metrics + Cloudflare AI crawlers
          (KV via /api/seo/*). Spec: docs/analytics-parity.md — NONE-source metrics are cut,
          never faked. Pending: Yandex Direct token · Google Ads Basic-access approval · home
          AI blocks only after Owner pick.
        </p>
      </div>
    </div>
  );
}
