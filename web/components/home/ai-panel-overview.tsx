'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

// =============================================================================
// Panel row — Julian Farah's AI answer panel (Owner 2026-08-26).
// Same shape as the Geo row above: four cards at the 40px display size, then a
// language strip. The strip exists so a market never scrolls off the page: a
// language that stopped being measured shows its age instead of its absence,
// and Russian leads it because Russian leads the rotation.
// Nothing is stored in the ERP — the worker computes this from geo_ai_panel on
// the request, the same way the Geo row does.
// =============================================================================

const PANEL_PULSE = 'https://julian-geo.dasexperten.workers.dev/home-panel';

type Tone = 'good' | 'bad' | 'neutral' | string;

type PanelCard = {
  id: string;
  label: string;
  value: number | string;
  hint: string;
  hint_ru?: string;
  tone?: Tone;
};

type StripRow = {
  lang: string;
  label: string;
  last_day: string;
  days_ago: number | null;
  asked: number;
  named: number;
  pct: number | null;
  cls: string;
  lead: boolean;
  stale: boolean;
};

type PanelPulse = {
  ok: boolean;
  day?: string | null;
  engine?: string;
  langs_today?: string;
  cards: PanelCard[];
  strip: StripRow[];
};

function fmt(v: number | string): string {
  if (typeof v === 'string') return v;
  if (!Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

function hintColor(tone?: Tone): string {
  if (tone === 'good') return 'var(--status-success)';
  if (tone === 'bad') return 'var(--brand-rot)';
  return 'var(--fg-3)';
}

export default function AiPanelOverview() {
  const [pulse, setPulse] = useState<PanelPulse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(PANEL_PULSE)
      .then((r) => r.json())
      .then((j) => {
        if (j && j.ok && Array.isArray(j.cards)) setPulse(j);
        else setPulse({ ok: false, cards: [], strip: [] });
      })
      .catch(() => setPulse({ ok: false, cards: [], strip: [] }))
      .finally(() => setLoading(false));
  }, []);

  const cards = pulse?.cards ?? [];
  const strip = pulse?.strip ?? [];
  const asOf = pulse?.day || '—';
  const kicker = `Julian Farah · ${pulse?.engine ?? 'AI answers'}${
    pulse?.langs_today ? ` · ${pulse.langs_today}` : ''
  }`;

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
              <div className="dx-eyebrow-rot">Panel</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-3)', marginTop: '3px' }}>
                {loading ? 'Julian Farah · AI answers' : kicker}
              </div>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
              {loading ? 'Loading…' : `as of ${asOf}`}
            </span>
          </div>

          <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
            {loading && [0, 1, 2, 3].map((i) => <PanelCardView key={i} label="…" value={null} hint="" />)}
            {!loading &&
              cards.map((c) => (
                <PanelCardView
                  key={c.id}
                  label={c.label}
                  value={fmt(c.value)}
                  hint={c.hint}
                  tone={c.tone}
                  small={typeof c.value === 'string'}
                />
              ))}
            {!loading && cards.length === 0 && (
              <div style={{ gridColumn: '1 / -1', fontSize: '13px', color: 'var(--fg-3)' }}>
                Panel pending — no answers recorded for today yet.
              </div>
            )}
          </div>

          {!loading && strip.length > 0 && (
            <div style={{ marginTop: '24px' }}>
              <div style={{ fontSize: '12px', color: 'var(--fg-3)', marginBottom: '8px' }}>
                Last reading by language
              </div>
              <div
                style={{
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                }}
              >
                <table className="w-full" style={{ fontSize: 'var(--fs-body-sm)' }}>
                  <tbody>
                    {strip.map((s, idx) => (
                      <tr
                        key={s.lang}
                        style={{
                          borderBottom:
                            idx === strip.length - 1 ? 'none' : '1px solid var(--border-hairline)',
                          backgroundColor: s.lead ? 'rgba(229,32,44,0.06)' : 'transparent',
                        }}
                      >
                        <td
                          className="px-4 py-2.5"
                          style={{ fontWeight: s.lead ? 700 : 600, color: 'var(--fg-1)' }}
                        >
                          {s.label}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--fg-3)' }}>
                          {s.cls === 'measure' ? 'замер' : 'разведка'}
                        </td>
                        <td
                          className="px-4 py-2.5"
                          style={{ color: s.stale ? 'var(--brand-rot)' : 'var(--fg-3)' }}
                        >
                          {s.last_day}
                          {s.days_ago && s.days_ago > 0 ? ` · ${s.days_ago} дн. назад` : ' · сегодня'}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--fg-2)' }}>
                          {s.named} из {s.asked}
                        </td>
                        <td
                          className="px-4 py-2.5 text-right"
                          style={{ fontWeight: 700, color: 'var(--fg-1)' }}
                        >
                          {s.pct === null ? '—' : `${s.pct}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function PanelCardView({
  label,
  value,
  hint,
  tone,
  small,
}: {
  label: string;
  value: string | null;
  hint: string;
  tone?: Tone;
  small?: boolean;
}) {
  return (
    <div
      style={{
        backgroundColor: 'var(--paper)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        padding: '20px 22px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ color: 'var(--fg-2)' }}>{label}</div>
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: small ? '28px' : '40px',
          fontWeight: 900,
          lineHeight: 1.05,
          color: 'var(--fg-1)',
          marginTop: '12px',
        }}
      >
        {value === null ? (
          <Loader2 className="h-7 w-7 animate-spin inline-block" style={{ color: 'var(--fg-3)' }} />
        ) : (
          value
        )}
      </div>
      {hint ? (
        <div className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: hintColor(tone), fontWeight: 600 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
