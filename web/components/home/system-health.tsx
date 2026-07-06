'use client';

// =============================================================================
// SystemHealth — compact horizontal strip showing the live status of critical
// integrations (Modulbank webhooks, FX feed, etc). Lazy-loads each probe in
// parallel and shows a traffic-light dot per integration.
//
// Design: thin, non-intrusive. Only blooms (with color) if something is red
// or yellow; in normal green state, it's quiet and just shows "All systems
// nominal — last sync Xh ago".
// =============================================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, AlertTriangle } from 'lucide-react';

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev';

interface HealthCheck {
  label: string;
  status: 'green' | 'yellow' | 'red' | 'unknown';
  message: string;
  detail?: string;
  href?: string;
}

const TONE: Record<HealthCheck['status'], { bg: string; fg: string; dot: string; border: string }> = {
  green:   { bg: 'rgba(46,125,79,0.06)',  fg: '#1f5d3a', dot: '#2e7d4f', border: 'rgba(46,125,79,0.18)' },
  yellow:  { bg: 'rgba(199,122,0,0.08)',  fg: '#7a4a00', dot: '#c77a00', border: 'rgba(199,122,0,0.3)'  },
  red:     { bg: 'rgba(229,32,44,0.08)',  fg: '#a82029', dot: '#e5202c', border: 'rgba(229,32,44,0.3)'  },
  unknown: { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)', dot: 'var(--fg-muted)', border: 'var(--border-hairline)' },
};

export default function SystemHealth() {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const run = async () => {
      const probes: Promise<HealthCheck>[] = [
        // Modulbank webhook health
        fetch(`${API_BASE}/api/banks/modulbank/health`)
          .then((r) => r.json())
          .then((data): HealthCheck => {
            const r = data?.result;
            if (!r) {
              return { label: 'Modulbank sync', status: 'unknown', message: 'No data' };
            }
            // Show how long ago we verified against the bank API (not last txn age).
            let detail: string | undefined;
            if (r.computed_at) {
              const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - r.computed_at);
              if (ageSec < 60) detail = 'verified just now';
              else if (ageSec < 3600) detail = `verified ${Math.round(ageSec / 60)}min ago`;
              else detail = `verified ${(ageSec / 3600).toFixed(1)}h ago`;
            }
            return {
              label: 'Modulbank sync',
              status: r.status,
              message: r.message,
              detail,
              href: '/finance',
            };
          })
          .catch((): HealthCheck => ({
            label: 'Modulbank sync',
            status: 'unknown',
            message: 'Probe failed',
          })),
      ];

      const results = await Promise.all(probes);
      setChecks(results);
      setLoading(false);
    };
    run();
  }, []);

  if (loading) return null;

  // If everything is green, show a single quiet line. If anything is non-green,
  // show full cards stripe to draw attention.
  const hasIssue = checks.some((c) => c.status === 'red' || c.status === 'yellow');

  if (!hasIssue) {
    return (
      <div
        className="flex items-center gap-2 px-4 py-2"
        style={{
          background: TONE.green.bg,
          border: `1px solid ${TONE.green.border}`,
          borderRadius: 'var(--radius-sm)',
          fontSize: 12,
          color: TONE.green.fg,
        }}
      >
        <Activity size={12} />
        <span style={{ fontWeight: 600 }}>All systems nominal</span>
        <span style={{ color: 'var(--fg-3)', marginLeft: 4 }}>
          · {checks.map((c) => `${c.label}: ${c.detail ?? 'ok'}`).join(' · ')}
        </span>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
      {checks.map((c) => {
        const tone = TONE[c.status];
        const inner = (
          <div
            className="flex items-start gap-2 px-3 py-2"
            style={{
              background: tone.bg,
              border: `1px solid ${tone.border}`,
              borderRadius: 'var(--radius-sm)',
              color: tone.fg,
              cursor: c.href ? 'pointer' : 'default',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: tone.dot,
                marginTop: 4,
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="flex items-center gap-1.5">
                {c.status === 'red' && <AlertTriangle size={12} />}
                <span style={{ fontSize: 12, fontWeight: 700 }}>{c.label}</span>
              </div>
              <div style={{ fontSize: 11, color: tone.fg, opacity: 0.9, marginTop: 2 }}>
                {c.message}
              </div>
            </div>
          </div>
        );
        return c.href ? (
          <Link key={c.label} href={c.href}>{inner}</Link>
        ) : (
          <div key={c.label}>{inner}</div>
        );
      })}
    </div>
  );
}
