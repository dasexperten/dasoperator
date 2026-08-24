'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

// =============================================================================
// GEO row — Julian Farah's four numbers (Owner 2026-08-24).
// Replaces the duplicate Ubersuggest "Site authority" strip. Headline SEO
// cards above stay Jurgen's. Source: same formula as the GEO letter
// (geo_gsc_daily + geo_bot_status), served by jurgen-seo /home-geo.
// =============================================================================

const GEO_PULSE = 'https://jurgen-seo.dasexperten.workers.dev/home-geo';

type GeoCard = {
  id: string;
  label: string;
  value: number;
  hint: string;
};

type GeoPulse = {
  ok: boolean;
  day_gsc?: string | null;
  day_bots?: string | null;
  cards: GeoCard[];
};

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

export default function AiVisibilityOverview() {
  const [pulse, setPulse] = useState<GeoPulse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(GEO_PULSE)
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok && Array.isArray(j.cards)) setPulse(j);
        else setPulse({ ok: false, cards: [] });
      })
      .catch(() => setPulse({ ok: false, cards: [] }))
      .finally(() => setLoading(false));
  }, []);

  const cards = pulse?.cards ?? [];
  const asOf = pulse?.day_gsc || pulse?.day_bots || '—';

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
              <div className="dx-eyebrow-rot">GEO</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-3)', marginTop: '3px' }}>
                Julian Farah · Search Console + AI crawlers
              </div>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
              {loading ? 'Loading…' : `as of ${asOf}`}
            </span>
          </div>

          <div className="grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
            {loading &&
              [0, 1, 2, 3].map((i) => (
                <AuthCard key={i} label="…" value={null} hint="" />
              ))}
            {!loading &&
              cards.map((c) => (
                <AuthCard
                  key={c.id}
                  label={c.label}
                  value={fmt(c.value)}
                  hint={c.hint}
                />
              ))}
            {!loading && cards.length === 0 && (
              <div style={{ gridColumn: '1 / -1', fontSize: '13px', color: 'var(--fg-3)' }}>
                GEO pulse pending — Julian&apos;s snapshot has not landed a row yet.
              </div>
            )}
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
}: {
  label: string;
  value: string | null;
  hint: string;
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
          <span className="dx-mono" style={{ fontSize: '26px', fontWeight: 900 }}>
            {value}
          </span>
        )}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--fg-3)', marginTop: '6px' }}>{hint}</div>
    </div>
  );
}
