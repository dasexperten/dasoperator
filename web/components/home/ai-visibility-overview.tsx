'use client';

import { ArrowUpRight, RefreshCw } from 'lucide-react';

// =============================================================================
// AI Visibility Overview — «das-dashboard» design pattern
// Design spec: Design/das-dashboard.md
// Replaces DailyDigest on home. Demo payload until data feeds go live:
//   GSC API · Clarity AI Visibility · GA4 Data API · CF AI Crawl Control (post NS-flip)
// =============================================================================

type PlatformTile = {
  name: string;
  citations: number;
  trendPct: number; // negative = down
  crawled: string;
  health: 'ok' | 'warn';
};

type GroundingQuery = { label: string; cited: boolean };

type AiVisibilityData = {
  demo: boolean;
  authority: {
    score: number; // 0..100
    scoreTrend: number;
    linkingSites: number;
    linkingSitesTrend: number;
    backlinks: number;
    topSources: Array<{ domain: string; refs: number }>;
  };
  updatedAt: string;
  shareOfAuthority: number; // 0..100
  competitors: string; // formatted line
  platforms: PlatformTile[];
  search: { impressions: number; impressionsTrend: number; clicks: number; clicksTrend: number; spark: number[] };
  aiTraffic: {
    sessions: number;
    sessionsTrend: number;
    conversionMultiple: string;
    channels: Array<{ name: string; sessions: number; pct: number; color: string }>;
  };
  queries: GroundingQuery[];
};

// Demo payload — numbers from Wix SEO&GEO panel snapshot 2026-07-10.
// Swap for fetch(`${API_BASE}/api/ai-visibility`) when feeds are wired.
const DATA: AiVisibilityData = {
  demo: true,
  authority: {
    score: 26,
    scoreTrend: 4,
    linkingSites: 164,
    linkingSitesTrend: 12,
    backlinks: 412,
    topSources: [
      { domain: 'uni-heidelberg.de', refs: 5 },
      { domain: 'dasexperten.com', refs: 5 },
      { domain: 'dasexperten.com', refs: 4 },
      { domain: 'das-experten.com', refs: 4 },
    ],
  },
  updatedAt: '07:00',
  shareOfAuthority: 19,
  competitors: 'Aster DM 10% · ORAL7 5% · Biofarma 0%',
  platforms: [
    { name: 'ChatGPT', citations: 113, trendPct: -42, crawled: 'Jul 7', health: 'ok' },
    { name: 'Gemini', citations: 48, trendPct: 12, crawled: 'Jul 8', health: 'ok' },
    { name: 'Perplexity', citations: 26, trendPct: 225, crawled: 'Jul 1', health: 'warn' },
    { name: 'Claude', citations: 14, trendPct: -55, crawled: 'Jul 7', health: 'ok' },
  ],
  search: { impressions: 187, impressionsTrend: -45, clicks: 8, clicksTrend: -47, spark: [26, 28, 24, 18, 12, 10, 24] },
  aiTraffic: {
    sessions: 31,
    sessionsTrend: 64,
    conversionMultiple: '7×',
    channels: [
      { name: 'ChatGPT', sessions: 19, pct: 62, color: 'var(--brand-schwarz)' },
      { name: 'Perplexity', sessions: 8, pct: 26, color: 'var(--brand-rot)' },
      { name: 'Gemini', sessions: 4, pct: 13, color: 'var(--status-warning)' },
    ],
  },
  queries: [
    { label: 'enzyme toothpaste UAE', cited: true },
    { label: 'probiotic mouthwash', cited: true },
    { label: 'oral care B2B Germany', cited: false },
    { label: 'sensitive teeth enzyme', cited: false },
  ],
};

const ARC_CIRCUMFERENCE = 2 * Math.PI * 30; // r=30

export default function AiVisibilityOverview() {
  const d = DATA;
  const arcFill = (d.shareOfAuthority / 100) * ARC_CIRCUMFERENCE;

  return (
    <section>
      <div
        className="overflow-hidden"
        style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', background: 'var(--paper)' }}
      >
        {/* Tricolor ribbon rule */}
        <div
          style={{
            height: '4px',
            background:
              'linear-gradient(90deg, var(--brand-schwarz) 0 33.33%, var(--brand-rot) 33.33% 66.66%, var(--brand-gold) 66.66% 100%)',
          }}
        />

        <div style={{ padding: '20px 24px 24px' }}>
          {/* Header */}
          <div className="flex items-baseline justify-between" style={{ marginBottom: '16px' }}>
            <div>
              <div className="dx-eyebrow-rot">AI Visibility Overview</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-3)', marginTop: '3px' }}>
                How AI assistants and Google see dasexperten.com
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1" style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                <RefreshCw size={11} /> updated {d.updatedAt}
                {d.demo && <span style={{ color: 'var(--status-warning)', fontWeight: 700 }}>· demo data</span>}
              </span>
              <a
                href="/analytics"
                className="inline-flex items-center gap-1"
                style={{ fontSize: '12px', fontWeight: 700, color: 'var(--brand-rot)', textDecoration: 'none' }}
              >
                Full report <ArrowUpRight size={13} />
              </a>
            </div>
          </div>

          {/* Hero row */}
          <div className="grid gap-3.5" style={{ gridTemplateColumns: '240px 1fr', marginBottom: '14px' }}>
            {/* Share of authority — dark hero tile */}
            <div
              style={{
                background: 'var(--brand-schwarz)',
                borderRadius: 'var(--radius-md)',
                padding: '18px',
                color: 'var(--paper)',
              }}
            >
              <div
                style={{
                  fontSize: '10px',
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'rgba(251,250,246,.55)',
                }}
              >
                Share of authority
              </div>
              <div className="flex items-center gap-3.5" style={{ marginTop: '10px' }}>
                <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label={`${d.shareOfAuthority}% share of authority`}>
                  <circle cx="36" cy="36" r="30" fill="none" stroke="rgba(251,250,246,.15)" strokeWidth="7" />
                  <circle
                    cx="36"
                    cy="36"
                    r="30"
                    fill="none"
                    stroke="var(--brand-gold)"
                    strokeWidth="7"
                    strokeLinecap="round"
                    strokeDasharray={`${arcFill} ${ARC_CIRCUMFERENCE - arcFill}`}
                    transform="rotate(-90 36 36)"
                  />
                  <text x="36" y="41" textAnchor="middle" fontSize="17" fontWeight="800" fill="var(--paper)">
                    {d.shareOfAuthority}%
                  </text>
                </svg>
                <div>
                  <div style={{ fontSize: '12px', color: 'rgba(251,250,246,.75)', lineHeight: 1.5 }}>
                    of AI citations in your query set
                  </div>
                  <div
                    style={{
                      display: 'inline-block',
                      marginTop: '6px',
                      fontSize: '11px',
                      fontWeight: 800,
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-pill)',
                      background: 'rgba(254,240,4,.16)',
                      color: 'var(--brand-gold)',
                    }}
                  >
                    #1 vs competitors
                  </div>
                </div>
              </div>
              <div
                style={{
                  marginTop: '12px',
                  fontSize: '11px',
                  color: 'rgba(251,250,246,.55)',
                  borderTop: '1px solid rgba(251,250,246,.12)',
                  paddingTop: '8px',
                }}
              >
                {d.competitors}
              </div>
            </div>

            {/* Platform tiles */}
            <div className="grid grid-cols-4 gap-3.5">
              {d.platforms.map((p) => (
                <div
                  key={p.name}
                  style={{
                    background: 'var(--paper-raised)',
                    border: '1px solid var(--border-hairline)',
                    borderRadius: 'var(--radius-md)',
                    padding: '14px',
                    boxShadow: 'var(--shadow-card)',
                  }}
                >
                  <div className="flex justify-between items-center">
                    <span style={{ fontSize: '12px', fontWeight: 800 }}>{p.name}</span>
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: p.health === 'ok' ? 'var(--status-success)' : 'var(--status-warning)',
                        display: 'inline-block',
                      }}
                    />
                  </div>
                  <div className="dx-mono" style={{ fontSize: '26px', fontWeight: 900, marginTop: '8px' }}>
                    {p.citations}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                    citations ·{' '}
                    <span style={{ color: p.trendPct >= 0 ? 'var(--status-success)' : 'var(--brand-rot)', fontWeight: 700 }}>
                      {p.trendPct >= 0 ? '↑' : '↓'} {Math.abs(p.trendPct)}%
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: '10px',
                      color: 'var(--fg-3)',
                      marginTop: '8px',
                      borderTop: '1px solid var(--border-hairline)',
                      paddingTop: '6px',
                    }}
                  >
                    crawled {p.crawled}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Authority row */}
          <div className="grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr 1fr 1.6fr', marginBottom: '14px' }}>
            {/* Domain authority */}
            <div
              style={{
                background: 'var(--paper-raised)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-md)',
                padding: '14px',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <div className="dx-eyebrow" style={{ fontSize: '10px' }}>Domain authority</div>
              <div className="flex items-baseline" style={{ gap: '4px', marginTop: '8px' }}>
                <span className="dx-mono" style={{ fontSize: '26px', fontWeight: 900 }}>{d.authority.score}</span>
                <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>/ 100</span>
                <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--status-success)', marginLeft: '6px' }}>
                  ↑{d.authority.scoreTrend}
                </span>
              </div>
              <div style={{ height: '6px', background: 'var(--paper-sunk)', borderRadius: 'var(--radius-pill)', marginTop: '10px' }}>
                <div
                  style={{
                    width: `${d.authority.score}%`,
                    height: '6px',
                    background: 'var(--brand-schwarz)',
                    borderRadius: 'var(--radius-pill)',
                  }}
                />
              </div>
            </div>

            {/* Linking sites */}
            <div
              style={{
                background: 'var(--paper-raised)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-md)',
                padding: '14px',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <div className="dx-eyebrow" style={{ fontSize: '10px' }}>Linking sites</div>
              <div className="dx-mono" style={{ fontSize: '26px', fontWeight: 900, marginTop: '8px' }}>
                {d.authority.linkingSites}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                domains ·{' '}
                <span style={{ color: 'var(--status-success)', fontWeight: 700 }}>↑ {d.authority.linkingSitesTrend}%</span>
              </div>
            </div>

            {/* Backlinks */}
            <div
              style={{
                background: 'var(--paper-raised)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-md)',
                padding: '14px',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <div className="dx-eyebrow" style={{ fontSize: '10px' }}>Backlinks</div>
              <div className="dx-mono" style={{ fontSize: '26px', fontWeight: 900, marginTop: '8px' }}>
                {d.authority.backlinks}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>total external links</div>
            </div>

            {/* Top sources */}
            <div
              style={{
                background: 'var(--paper-raised)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-md)',
                padding: '14px 16px',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <div className="dx-eyebrow" style={{ fontSize: '10px', marginBottom: '8px' }}>Top sources by references</div>
              <div className="flex flex-col" style={{ gap: '5px' }}>
                {d.authority.topSources.map((s) => (
                  <div key={s.domain} className="flex items-center justify-between" style={{ fontSize: '11px' }}>
                    <span style={{ color: 'var(--fg-2)' }}>{s.domain}</span>
                    <b className="dx-mono">{s.refs}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Middle row */}
          <div className="grid grid-cols-2 gap-3.5" style={{ marginBottom: '14px' }}>
            {/* Google Search */}
            <div
              style={{
                background: 'var(--paper-raised)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-md)',
                padding: '16px',
              }}
            >
              <div className="flex justify-between items-baseline">
                <span className="dx-eyebrow" style={{ fontSize: '11px' }}>Google Search · 7 days</span>
                <span style={{ fontSize: '10px', color: 'var(--fg-3)' }}>GSC</span>
              </div>
              <div className="flex" style={{ gap: '28px', marginTop: '10px' }}>
                <div>
                  <div className="dx-mono" style={{ fontSize: '24px', fontWeight: 900 }}>{d.search.impressions}</div>
                  <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                    impressions · <span style={{ color: 'var(--brand-rot)', fontWeight: 700 }}>↓{Math.abs(d.search.impressionsTrend)}%</span>
                  </div>
                </div>
                <div>
                  <div className="dx-mono" style={{ fontSize: '24px', fontWeight: 900 }}>{d.search.clicks}</div>
                  <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                    clicks · <span style={{ color: 'var(--brand-rot)', fontWeight: 700 }}>↓{Math.abs(d.search.clicksTrend)}%</span>
                  </div>
                </div>
              </div>
              <svg width="100%" height="44" viewBox="0 0 300 44" preserveAspectRatio="none" style={{ marginTop: '10px' }} aria-hidden="true">
                <polyline
                  points={d.search.spark.map((v, i) => `${i * (300 / (d.search.spark.length - 1))},${44 - v * 1.2}`).join(' ')}
                  fill="none"
                  stroke="var(--brand-rot)"
                  strokeWidth="2"
                />
                <polygon
                  points={`${d.search.spark.map((v, i) => `${i * (300 / (d.search.spark.length - 1))},${44 - v * 1.2}`).join(' ')} 300,44 0,44`}
                  fill="rgba(229,32,44,.07)"
                />
              </svg>
            </div>

            {/* Traffic from AI */}
            <div
              style={{
                background: 'var(--paper-raised)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-md)',
                padding: '16px',
              }}
            >
              <div className="flex justify-between items-baseline">
                <span className="dx-eyebrow" style={{ fontSize: '11px' }}>Traffic from AI · 7 days</span>
                <span style={{ fontSize: '10px', color: 'var(--fg-3)' }}>GA4 + Clarity</span>
              </div>
              <div className="flex" style={{ gap: '28px', marginTop: '10px' }}>
                <div>
                  <div className="dx-mono" style={{ fontSize: '24px', fontWeight: 900 }}>{d.aiTraffic.sessions}</div>
                  <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                    sessions · <span style={{ color: 'var(--status-success)', fontWeight: 700 }}>↑{d.aiTraffic.sessionsTrend}%</span>
                  </div>
                </div>
                <div>
                  <div className="dx-mono" style={{ fontSize: '24px', fontWeight: 900, color: 'var(--status-success)' }}>
                    {d.aiTraffic.conversionMultiple}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>conversion vs search</div>
                </div>
              </div>
              <div className="flex flex-col" style={{ gap: '6px', marginTop: '12px' }}>
                {d.aiTraffic.channels.map((c) => (
                  <div key={c.name} className="flex items-center" style={{ gap: '8px', fontSize: '11px' }}>
                    <span style={{ width: '78px', color: 'var(--fg-2)' }}>{c.name}</span>
                    <div style={{ flex: 1, height: '8px', background: 'var(--paper-sunk)', borderRadius: 'var(--radius-pill)' }}>
                      <div style={{ width: `${c.pct}%`, height: '8px', background: c.color, borderRadius: 'var(--radius-pill)' }} />
                    </div>
                    <b>{c.sessions}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Grounding queries */}
          <div
            style={{
              background: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-md)',
              padding: '14px 16px',
            }}
          >
            <div className="flex justify-between items-baseline" style={{ marginBottom: '8px' }}>
              <span className="dx-eyebrow" style={{ fontSize: '11px' }}>What AI asks about you — grounding queries</span>
              <a href="/analytics" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--brand-rot)', textDecoration: 'none' }}>
                all 21 →
              </a>
            </div>
            <div className="flex flex-wrap" style={{ gap: '8px' }}>
              {d.queries.map((q) => (
                <span
                  key={q.label}
                  style={{
                    fontSize: '12px',
                    background: 'var(--paper-raised)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-pill)',
                    padding: '4px 12px',
                  }}
                >
                  {q.label}{' '}
                  <b style={{ color: q.cited ? 'var(--status-success)' : 'var(--brand-rot)' }}>
                    {q.cited ? '✓ cited' : '✗ missing'}
                  </b>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
