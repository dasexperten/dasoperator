'use client';

// =============================================================================
// SEO cards (Jurgen · Ubersuggest) — moved from the ERP home page to Analytics →
// AI / GEO by the Owner's word 2026-10-06: measurements live in analytics, the home
// page carries the business pulse. Same data (getSiteSeoMetrics), same design.
// =============================================================================

import { useEffect, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { getSiteSeoMetrics } from '@/lib/api';

function formatSeoNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1_000)}k`;
  return Math.round(n).toLocaleString('en-US');
}

type SiteSeoMetrics = {
  domain: string;
  domain_authority: number;
  backlinks: number;
  ref_domains: number;
  organic_traffic: number;
  updated_at: number;
  source: string;
};

const SEO_SEED: SiteSeoMetrics = {
  domain: 'dasexperten.com',
  domain_authority: 11,
  backlinks: 1093,
  ref_domains: 328,
  organic_traffic: 124,
  updated_at: 0,
  source: 'seed',
};

function HomePulseBlock({
  title,
  kicker,
  asOf,
  children,
}: {
  title: string;
  kicker: string;
  asOf: string;
  children: ReactNode;
}) {
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
              <div className="dx-eyebrow-rot">{title}</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-3)', marginTop: '3px' }}>{kicker}</div>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>{asOf}</span>
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}

function MetricCard({
  label,
  sublabel,
  value,
  tone,
  loading,
}: {
  label: string;
  sublabel: string;
  value: string;
  tone: 'default' | 'rot' | 'muted';
  loading: boolean;
}) {
  const valueColor =
    tone === 'rot' ? 'var(--brand-rot)' :
    tone === 'muted' ? 'var(--fg-3)' :
    'var(--fg-1)';

  return (
    <div
      style={{
        backgroundColor: 'var(--paper)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        padding: '20px 22px',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* Two lines are reserved for the label whether it needs them or not, so
          every figure in the row starts at the same height. A one-line label
          next to a two-line one is what knocked the numbers out of line. */}
      <div
        style={{ color: 'var(--fg-2)', lineHeight: 1.25, minHeight: '2.5em' }}
      >
        {label}
      </div>
      <div
        className="dx-num"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(24px, 7vw, 40px)',
          fontWeight: 900,
          lineHeight: 1.05,
          color: valueColor,
          marginTop: '12px',
        }}
      >
        {loading ? <Loader2 className="h-7 w-7 animate-spin inline-block" style={{ color: 'var(--fg-3)' }} /> : value}
      </div>
      <div
        style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-3)', marginTop: 'auto', paddingTop: '8px' }}
      >
        {sublabel}
      </div>
    </div>
  );
}

export default function SiteSeoBlock() {
  const [seo, setSeo] = useState<SiteSeoMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    getSiteSeoMetrics()
      .then((r: any) => setSeo(r && r.success && r.result ? r.result : SEO_SEED))
      .catch(() => setSeo(SEO_SEED))
      .finally(() => setLoading(false));
  }, []);
  const m = seo ?? SEO_SEED;
  const seoAsOf =
    m.updated_at > 0
      ? new Date(m.updated_at * 1000).toISOString().slice(0, 10)
      : 'snapshot';
  return (
      <HomePulseBlock
        title="SEO"
        kicker="Jurgen Witt · Ubersuggest"
        asOf={loading ? 'Loading…' : `as of ${seoAsOf}`}
      >
        <div className="grid grid-cols-4 gap-4 dx-metrics-grid">
          <MetricCard
            label="Domain authority"
            sublabel="dasexperten.com"
            value={String(m.domain_authority)}
            tone="default"
            loading={loading}
          />
          <MetricCard
            label="Backlinks"
            sublabel="dasexperten.com"
            value={loading ? '—' : formatSeoNumber(m.backlinks)}
            tone="default"
            loading={loading}
          />
          <MetricCard
            label="Referring domains"
            sublabel="dasexperten.com"
            value={loading ? '—' : formatSeoNumber(m.ref_domains)}
            tone="default"
            loading={loading}
          />
          <MetricCard
            label="Organic traffic"
            sublabel="dasexperten.com · est."
            value={loading ? '—' : formatSeoNumber(m.organic_traffic)}
            tone="default"
            loading={loading}
          />
        </div>
      </HomePulseBlock>
  );
}
