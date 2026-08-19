'use client';

import { ArrowUpRight, RefreshCw } from 'lucide-react';

// =============================================================================
// AI Crawlers — «das-dashboard» design pattern (Design/das-dashboard.md)
// Source: Cloudflare AI Crawl Control. Demo payload until zone feed is wired.
// =============================================================================

type CrawlerTile = {
  operator: string;
  bot: string;
  extraBots: number;
  allowed: string;
  referrals: number;
};

type AiCrawlersData = {
  demo: boolean;
  updatedAt: string;
  totalRequests: string;
  allowed: string;
  allowedPct: number; // share of total, 0..100
  unsuccessful: number;
  referrals: number;
  spark: number[];
  crawlers: CrawlerTile[];
};

// Demo payload — numbers from CF AI Crawl Control snapshot 2026-07-10.
const DATA: AiCrawlersData = {
  demo: true,
  updatedAt: '07:00',
  totalRequests: '9k',
  allowed: '8k',
  allowedPct: 89,
  unsuccessful: 935,
  referrals: 273,
  spark: [4, 6, 5, 9, 7, 12, 8, 18, 10, 24, 14, 9],
  crawlers: [
    { operator: 'OpenAI', bot: 'GPTBot', extraBots: 2, allowed: '2.38k', referrals: 0 },
    { operator: 'Google', bot: 'Googlebot', extraBots: 1, allowed: '1.26k', referrals: 255 },
    { operator: 'Meta', bot: 'Meta-ExternalAgent', extraBots: 2, allowed: '1.11k', referrals: 0 },
    { operator: 'Amazon', bot: 'Amazonbot', extraBots: 0, allowed: '1.09k', referrals: 0 },
    { operator: 'Anthropic', bot: 'ClaudeBot', extraBots: 2, allowed: '1.04k', referrals: 0 },
    { operator: 'Apple', bot: 'Applebot', extraBots: 0, allowed: '474', referrals: 0 },
    { operator: 'Microsoft', bot: 'BingBot', extraBots: 0, allowed: '237', referrals: 0 },
    { operator: 'ByteDance', bot: 'Bytespider', extraBots: 1, allowed: '129', referrals: 0 },
    { operator: 'Baidu', bot: 'Baidu', extraBots: 0, allowed: '108', referrals: 0 },
    { operator: 'Huawei', bot: 'PetalBot', extraBots: 0, allowed: '16', referrals: 0 },
  ],
};

const ARC_CIRCUMFERENCE = 2 * Math.PI * 30;

export default function AiCrawlers() {
  const d = DATA;
  const arcFill = (d.allowedPct / 100) * ARC_CIRCUMFERENCE;

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
              <div className="dx-eyebrow-rot">AI Crawlers</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-3)', marginTop: '3px' }}>
                Which AI bots read dasexperten.com — Cloudflare AI Crawl Control
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
            {/* Total requests — dark hero tile */}
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
                  letterSpacing: '0',
                  textTransform: 'uppercase',
                  color: 'rgba(251,250,246,.55)',
                }}
              >
                AI crawler requests · 7 days
              </div>
              <div className="flex items-center gap-3.5" style={{ marginTop: '10px' }}>
                <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label={`${d.allowedPct}% of crawler requests allowed`}>
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
                  <text x="36" y="41" textAnchor="middle" fontSize="15" fontWeight="800" fill="var(--paper)">
                    {d.totalRequests}
                  </text>
                </svg>
                <div>
                  <div style={{ fontSize: '12px', color: 'rgba(251,250,246,.75)', lineHeight: 1.5 }}>
                    requests from AI bots
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
                    {d.allowedPct}% allowed
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
                OpenAI leads · Google converts best
              </div>
            </div>

            {/* Summary tiles */}
            <div className="grid grid-cols-3 gap-3.5">
              <div
                style={{
                  background: 'var(--paper-raised)',
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div className="dx-eyebrow" style={{ fontSize: '10px' }}>Allowed requests</div>
                <div className="dx-mono" style={{ fontSize: '26px', fontWeight: 900, marginTop: '8px' }}>{d.allowed}</div>
                <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>passed to the site</div>
                <svg width="100%" height="26" viewBox="0 0 120 26" preserveAspectRatio="none" style={{ marginTop: '8px' }} aria-hidden="true">
                  <polyline
                    points={d.spark.map((v, i) => `${i * (120 / (d.spark.length - 1))},${26 - v}`).join(' ')}
                    fill="none"
                    stroke="var(--brand-schwarz)"
                    strokeWidth="1.5"
                  />
                </svg>
              </div>
              <div
                style={{
                  background: 'var(--paper-raised)',
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div className="dx-eyebrow" style={{ fontSize: '10px' }}>Unsuccessful</div>
                <div className="dx-mono" style={{ fontSize: '26px', fontWeight: 900, marginTop: '8px', color: 'var(--brand-rot)' }}>
                  {d.unsuccessful}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>blocked or errored</div>
              </div>
              <div
                style={{
                  background: 'var(--paper-raised)',
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div className="dx-eyebrow" style={{ fontSize: '10px' }}>Total referrals</div>
                <div className="dx-mono" style={{ fontSize: '26px', fontWeight: 900, marginTop: '8px', color: 'var(--status-success)' }}>
                  {d.referrals}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--fg-3)' }}>humans sent back by AI</div>
              </div>
            </div>
          </div>

          {/* Crawler grid */}
          <div className="grid grid-cols-5 gap-3.5">
            {d.crawlers.map((c) => (
              <div
                key={c.operator}
                style={{
                  background: 'var(--paper-raised)',
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px 14px',
                  boxShadow: 'var(--shadow-card)',
                }}
              >
                <div style={{ fontSize: '12px', fontWeight: 800 }}>{c.operator}</div>
                <div style={{ marginTop: '4px' }}>
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 700,
                      background: 'var(--paper-sunk)',
                      border: '1px solid var(--border-hairline)',
                      borderRadius: 'var(--radius-pill)',
                      padding: '1px 7px',
                      color: 'var(--fg-2)',
                    }}
                  >
                    {c.bot}
                    {c.extraBots > 0 ? ` +${c.extraBots}` : ''}
                  </span>
                </div>
                <div className="dx-mono" style={{ fontSize: '20px', fontWeight: 900, marginTop: '8px' }}>{c.allowed}</div>
                <div
                  style={{
                    fontSize: '10px',
                    color: 'var(--fg-3)',
                    marginTop: '6px',
                    borderTop: '1px solid var(--border-hairline)',
                    paddingTop: '5px',
                  }}
                >
                  referrals{' '}
                  <b style={{ color: c.referrals > 0 ? 'var(--status-success)' : 'var(--fg-3)' }}>{c.referrals}</b>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
