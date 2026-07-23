'use client';

// =============================================================================
// AI / GEO tab — AI crawlers (Cloudflare UA pull) + site authority (Ubersuggest)
// Lives in Analytics first. Home blocks only after Owner pick.
// HARD: demo marker when demo=true; never invent crawler counts.
// =============================================================================

import React from 'react';
import {
  useApi, fmtNum, timeAgo, Panel, LoadState, SourceChip, Kpi,
} from '../shared';

export type AiCrawlerTile = {
  operator: string;
  bot: string;
  extraBots: number;
  allowed: string;
  allowed_n: number;
  referrals: number;
  bytes?: number;
};

export type AiCrawlersSnapshot = {
  domain: string;
  window_days: number;
  window_start: string;
  window_end: string;
  total_requests: number;
  total_with_search_bots?: number;
  allowed: number;
  allowed_pct: number;
  unsuccessful: number;
  referrals: number;
  source: string;
  demo: boolean;
  updated_at: number;
  note?: string;
  crawlers: AiCrawlerTile[];
  crawlers_detail?: Array<{ operator: string; bot: string; count: number; bytes?: number }>;
  spark: number[];
};

export type SiteSeoMetrics = {
  domain: string;
  domain_authority: number;
  backlinks: number;
  ref_domains: number;
  organic_traffic: number;
  updated_at: number;
  source: string;
};

/** Classic search bots — shown separately so AI headline stays clean. */
const SEARCH_BOTS = new Set(['Googlebot', 'bingbot', 'Bingbot']);

function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2).replace(/\.?0+$/, '')}k`;
  return fmtNum(n);
}

export default function AiGeoTab() {
  const crawlers = useApi<AiCrawlersSnapshot>('/api/seo/ai-crawlers?domain=dasexperten.com');
  const authority = useApi<SiteSeoMetrics>('/api/seo/site-metrics?domain=dasexperten.com');

  const d = crawlers.data;
  const auth = authority.data;

  const aiTiles = (d?.crawlers ?? []).filter((t) => !SEARCH_BOTS.has(t.bot));
  const searchTiles = (d?.crawlers ?? []).filter((t) => SEARCH_BOTS.has(t.bot));
  const detail = (d?.crawlers_detail ?? []).slice().sort((a, b) => b.count - a.count);

  const sparkMax = Math.max(1, ...(d?.spark ?? [1]));

  return (
    <div className="space-y-4">
      <LoadState loading={crawlers.loading || authority.loading} error={crawlers.error || authority.error} />

      <div className="wa-note">
        AI crawlers = bots that read the site for generative engines / training / AI search.
        Counts from Cloudflare edge by User-Agent (7 days). Site authority from Ubersuggest.
        This tab is Analytics-only — home page blocks wait for Owner pick.
      </div>

      {/* Site authority */}
      <Panel title="Site authority" source="Ubersuggest · /api/seo/site-metrics">
        {auth ? (
          <div className="wa-kpis">
            <Kpi label="Domain authority" value={String(auth.domain_authority)} delta={`/ 100 · ${auth.source}`} />
            <Kpi label="Referring domains" value={fmtNum(auth.ref_domains)} delta="linking sites" />
            <Kpi label="Backlinks" value={fmtNum(auth.backlinks)} delta="total external links" />
            <Kpi label="Organic traffic (est.)" value={fmtNum(auth.organic_traffic)} delta="monthly · US pack" />
          </div>
        ) : (
          <p style={{ color: 'var(--fg-3)' }}>No authority snapshot yet.</p>
        )}
        {auth && (
          <p style={{ color: 'var(--fg-3)', marginTop: 8, fontSize: 12 }}>
            Updated {timeAgo(auth.updated_at)} · {auth.domain}
          </p>
        )}
      </Panel>

      {/* AI crawlers hero */}
      <Panel
        title="AI crawlers · 7 days"
        source={d ? `${d.source}${d.demo ? ' · DEMO' : ''}` : 'Cloudflare GraphQL UA'}
      >
        {!d || (d.demo && d.total_requests === 0 && d.crawlers.length === 0) ? (
          <p style={{ color: 'var(--status-warning)' }}>
            No live pull stored yet. Agent posts to <code>POST /api/seo/ai-crawlers</code> after
            Cloudflare Analytics Read pull.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2" style={{ marginBottom: 12 }}>
              <SourceChip label={d.demo ? 'demo data — do not trust' : 'live Cloudflare pull'} />
              <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>
                window {d.window_days}d · synced {timeAgo(d.updated_at)}
                {d.window_start ? ` · ${d.window_start.slice(0, 10)} → ${d.window_end.slice(0, 10)}` : ''}
              </span>
            </div>

            <div className="wa-kpis">
              <Kpi
                accent
                label="AI crawler requests"
                value={fmtCompact(d.total_requests)}
                delta={`${fmtNum(d.total_requests)} raw · Googlebot/Bing excluded`}
              />
              <Kpi
                label="Allowed share"
                value={`${d.allowed_pct}%`}
                delta="CF AI bot blocks off → 100% if open"
              />
              <Kpi label="Unsuccessful" value={fmtNum(d.unsuccessful)} delta="blocked or errored" />
              <Kpi
                label="AI referrals (humans)"
                value={fmtNum(d.referrals)}
                delta={d.referrals === 0 ? 'not in this pull yet' : 'from AI UIs'}
              />
            </div>

            {d.note && (
              <p style={{ color: 'var(--fg-3)', marginTop: 10, fontSize: 12 }}>{d.note}</p>
            )}

            {/* Spark */}
            {d.spark && d.spark.length > 1 && (
              <div style={{ marginTop: 16 }}>
                <div className="dx-eyebrow" style={{ marginBottom: 6 }}>Requests by day (AI UAs)</div>
                <div className="flex items-end gap-1" style={{ height: 56 }}>
                  {d.spark.map((v, i) => (
                    <div
                      key={i}
                      title={String(v)}
                      style={{
                        flex: 1,
                        height: `${Math.max(4, (v / sparkMax) * 100)}%`,
                        background: 'var(--brand-schwarz)',
                        borderRadius: 2,
                        opacity: 0.75 + (v / sparkMax) * 0.25,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Operator tiles */}
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', marginTop: 16 }}
            >
              {aiTiles.map((t) => (
                <div
                  key={t.operator + t.bot}
                  style={{
                    background: 'var(--paper-raised)',
                    border: '1px solid var(--border-hairline)',
                    borderRadius: 'var(--radius-md)',
                    padding: '12px 14px',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 800 }}>{t.operator}</div>
                  <div style={{ marginTop: 4, fontSize: 10, color: 'var(--fg-3)' }}>
                    {t.bot}{t.extraBots > 0 ? ` +${t.extraBots}` : ''}
                  </div>
                  <div className="dx-mono" style={{ fontSize: 20, fontWeight: 900, marginTop: 8 }}>
                    {fmtCompact(t.allowed_n || Number(t.allowed) || 0)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--fg-3)', marginTop: 4 }}>
                    referrals <b>{t.referrals}</b>
                  </div>
                </div>
              ))}
            </div>

            {searchTiles.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="dx-eyebrow" style={{ marginBottom: 8 }}>Classic search (same pull, not AI headline)</div>
                <div className="flex flex-wrap gap-2">
                  {searchTiles.map((t) => (
                    <span
                      key={t.bot}
                      style={{
                        fontSize: 12,
                        padding: '4px 10px',
                        borderRadius: 999,
                        border: '1px solid var(--border-hairline)',
                        background: 'var(--paper-sunk)',
                      }}
                    >
                      {t.bot}: <b className="dx-mono">{fmtCompact(t.allowed_n || 0)}</b>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Detail table */}
            {detail.length > 0 && (
              <div style={{ marginTop: 16, overflowX: 'auto' }}>
                <div className="dx-eyebrow" style={{ marginBottom: 8 }}>All user-agents in pull</div>
                <table className="w-full" style={{ fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border-hairline)', textAlign: 'left' }}>
                      <th className="py-2 pr-3">Operator</th>
                      <th className="py-2 pr-3">Bot</th>
                      <th className="py-2 pr-3" style={{ textAlign: 'right' }}>Requests</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.map((r) => (
                      <tr key={r.bot} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                        <td className="py-1.5 pr-3">{r.operator}</td>
                        <td className="py-1.5 pr-3">{r.bot}</td>
                        <td className="py-1.5 dx-mono" style={{ textAlign: 'right' }}>{fmtNum(r.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
