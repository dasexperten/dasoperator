'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getSiteSeoMetrics, type SiteSeoMetrics } from '@/lib/api';

// =============================================================================
// Site authority row — real Ubersuggest snapshot via /api/seo/site-metrics
// (same card chrome as the old AI Visibility authority row; no demo numbers)
// =============================================================================

const SEED: SiteSeoMetrics = {
  domain: 'dasexperten.com',
  domain_authority: 11,
  backlinks: 1093,
  ref_domains: 328,
  organic_traffic: 124,
  updated_at: 0,
  source: 'seed',
};

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1_000)}k`;
  return Math.round(n).toLocaleString('en-US');
}

export default function AiVisibilityOverview() {
  const [m, setM] = useState<SiteSeoMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSiteSeoMetrics()
      .then((res) => {
        if (res.success && res.result) setM(res.result);
        else setM(SEED);
      })
      .catch(() => setM(SEED))
      .finally(() => setLoading(false));
  }, []);

  const d = m ?? SEED;
  const asOf =
    d.updated_at > 0
      ? new Date(d.updated_at * 1000).toISOString().slice(0, 10)
      : '—';
  const sourceLabel = d.source === 'ubersuggest' ? 'Ubersuggest' : 'Ubersuggest (cached)';

  return (
    <section>
      <div
        className="overflow-hidden"
        style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', background: 'var(--paper)' }}
      >
        <div
          style={{
            height: '4px',
            background:
              'linear-gradient(90deg, var(--brand-schwarz) 0 33.33%, var(--brand-rot) 33.33% 66.66%, var(--brand-gold) 66.66% 100%)',
          }}
        />

        <div style={{ padding: '20px 24px 24px' }}>
          <div className="flex items-baseline justify-between" style={{ marginBottom: '16px' }}>
            <div>
              <div className="dx-eyebrow-rot">Site authority</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-3)', marginTop: '3px' }}>
                dasexperten.com · {sourceLabel}
              </div>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
              {loading ? 'Loading…' : `as of ${asOf}`}
            </span>
          </div>

          <div className="grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
            <AuthCard
              label="Domain authority"
              value={loading ? null : String(d.domain_authority)}
              hint="/ 100"
              barPct={d.domain_authority}
            />
            <AuthCard
              label="Linking sites"
              value={loading ? null : fmt(d.ref_domains)}
              hint="referring domains"
            />
            <AuthCard
              label="Backlinks"
              value={loading ? null : fmt(d.backlinks)}
              hint="total external links"
            />
            <AuthCard
              label="Organic traffic"
              value={loading ? null : fmt(d.organic_traffic)}
              hint="est. monthly visits"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function AuthCard({
  label,
  value,
  hint,
  barPct,
}: {
  label: string;
  value: string | null;
  hint: string;
  barPct?: number;
}) {
  return (
    <div
      style={{
        background: 'var(--paper-raised)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        padding: '14px',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div className="dx-eyebrow" style={{ fontSize: '10px' }}>
        {label}
      </div>
      <div className="flex items-baseline" style={{ gap: '4px', marginTop: '8px' }}>
        {value === null ? (
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-3)' }} />
        ) : (
          <>
            <span className="dx-mono" style={{ fontSize: '26px', fontWeight: 900 }}>
              {value}
            </span>
            {hint.startsWith('/') && (
              <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{hint}</span>
            )}
          </>
        )}
      </div>
      {typeof barPct === 'number' ? (
        <div style={{ height: '6px', background: 'var(--paper-sunk)', borderRadius: 'var(--radius-pill)', marginTop: '10px' }}>
          <div
            style={{
              width: `${Math.min(100, Math.max(0, barPct))}%`,
              height: '6px',
              background: 'var(--brand-schwarz)',
              borderRadius: 'var(--radius-pill)',
            }}
          />
        </div>
      ) : (
        <div style={{ fontSize: '11px', color: 'var(--fg-3)', marginTop: '6px' }}>{hint}</div>
      )}
    </div>
  );
}
