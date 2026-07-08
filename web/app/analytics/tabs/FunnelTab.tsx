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
  type Ga4Funnel,
} from '../shared';

const STEP_LABELS: Record<string, string> = {
  sessions: 'Sessions',
  view_item: 'View item',
  add_to_cart: 'Add to cart',
  begin_checkout: 'Begin checkout',
  purchase: 'Purchase',
};

export default function FunnelTab() {
  const funnel = useApi<Ga4Funnel>('/api/ga4/funnel?days=30');
  const t = funnel.data?.totals;
  const rows = funnel.data?.rows ?? [];
  const base = rows[0]?.count ?? 0;
  const lowTraffic = (t?.purchases ?? 0) < 30;

  return (
    <div className="space-y-4">
      <LoadState loading={funnel.loading} error={funnel.error} />

      {t && (
        <div className="wa-kpis">
          <Kpi label="Sessions · 30d" value={fmtNum(t.sessions)} delta="funnel base" />
          <Kpi label="Purchases · 30d" value={fmtNum(t.purchases)} delta="purchase events" />
          <Kpi accent label="Overall CR" value={fmtPct(t.overall_cr)} delta="purchase ÷ sessions" />
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
    </div>
  );
}
