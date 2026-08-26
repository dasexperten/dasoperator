'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { getUser } from '@/lib/auth';
import {
  getOperations,
  getPayments,
  getSiteSeoMetrics,
  type Operation,
  type Payment,
} from '@/lib/api';
import MarketplacePulse from './marketplace-pulse';
import SystemHealth from './system-health';
import AiVisibilityOverview from './ai-visibility-overview';
import AiPanelOverview from './ai-panel-overview';

// =============================================================================
// Helpers
// =============================================================================
function formatDateShort(unixSec?: number | null): string {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  const month = d.toLocaleString('en-US', { month: 'short' });
  return `${d.getDate()} ${month}`;
}

function formatMoney(amount: number, currency: string): string {
  const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(currency);
  const fractionDigits = isZeroDecimal ? 0 : 2;
  return amount.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

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

// =============================================================================
// Status chip
// =============================================================================
const STATUS_TONES: Record<string, { bg: string; fg: string }> = {
  draft:             { bg: 'rgba(199,122,0,0.10)',  fg: 'var(--status-warning)' },
  issued:            { bg: 'rgba(31,73,125,0.10)',  fg: 'var(--status-info)' },
  order_fulfilment:  { bg: 'rgba(31,73,125,0.10)',  fg: 'var(--status-info)' },
  production:        { bg: 'rgba(31,73,125,0.10)',  fg: 'var(--status-info)' },
  stocked:           { bg: 'rgba(31,73,125,0.10)',  fg: 'var(--status-info)' },
  shipped:           { bg: 'rgba(31,73,125,0.10)',  fg: 'var(--status-info)' },
  delivered:         { bg: 'rgba(46,125,79,0.10)',  fg: 'var(--status-success)' },
  cancelled:         { bg: 'rgba(229,32,44,0.10)',  fg: 'var(--brand-rot)' },
};

function StatusChip({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? STATUS_TONES.draft!;
  return (
    <span
      className="inline-flex items-center px-2.5 py-1"
      style={{
        backgroundColor: tone.bg,
        color: tone.fg,
        borderRadius: '999px',
        fontSize: '14px',
        fontWeight: 600,
      }}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

// =============================================================================
// Main component
// =============================================================================
export default function HomeDashboard() {
  const [operations, setOperations] = useState<Operation[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [seo, setSeo] = useState<SiteSeoMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [greetName, setGreetName] = useState('');
  const [greetWord, setGreetWord] = useState('Guten Tag');
  const [greetDate, setGreetDate] = useState('');

  useEffect(() => {
    const u: any = getUser();
    setGreetName(u && u.name ? String(u.name).split(' ')[0] : '');
    const h = new Date().getHours();
    setGreetWord(h < 12 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend');
    setGreetDate(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  }, []);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [opsRes, paysRes, seoRes] = await Promise.all([
          getOperations({ compact: true }),
          getPayments(),
          getSiteSeoMetrics(),
        ]);
        if (opsRes.success && opsRes.result) setOperations(opsRes.result.operations);
        if (paysRes.success && paysRes.result) setPayments(paysRes.result.payments);
        if (seoRes.success && seoRes.result) setSeo(seoRes.result);
        else setSeo(SEO_SEED);
      } catch {
        setSeo(SEO_SEED);
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, []);

  // ---------------------------------------------------------------------------
  // Headline KPIs = SEO snapshot (same 4-card design); tables use ops/payments
  // ---------------------------------------------------------------------------
  const activeOps = operations.filter((o) => o.status !== 'cancelled');

  const recentOps = [...activeOps]
    .sort((a, b) => b.operation_date - a.operation_date)
    .slice(0, 5);

  const recentPayments = [...payments]
    .sort((a, b) => b.payment_date - a.payment_date)
    .slice(0, 3);

  const m = seo ?? SEO_SEED;
  const seoAsOf =
    m.updated_at > 0
      ? new Date(m.updated_at * 1000).toISOString().slice(0, 10)
      : 'snapshot';

  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-10 max-w-6xl">

      {/* HEADER ===================================================== */}
      <div>
        <div
          className="dx-eyebrow-rot mb-3"
          style={{ fontSize: 'var(--fs-body-sm)' }}
        >
          {greetDate || 'Pulse'}
        </div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-xl)',
            fontWeight: 900,
            lineHeight: 1.02,
            color: 'var(--fg-1)',
          }}
        className="dx-home-greeting"
        >
          {greetWord}{greetName ? <>{', '}<span style={{ color: 'var(--brand-rot)' }}>{greetName}</span></> : ''}
        </h1>
      </div>

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

      <AiVisibilityOverview />

      <AiPanelOverview />

      <div className="dx-eyebrow-rot">Остальные показатели</div>

      {/* MARKETPLACE PULSE ========================================== */}
      <MarketplacePulse />

      {/* SYSTEM HEALTH ============================================== */}
      <SystemHealth />

      {/* RECENT OPERATIONS ========================================== */}
      <section>
        <SectionHeader
          title="Recent operations"
          subtitle={`${activeOps.length} active total`}
          link="/operations"
        />
        <div
          className="overflow-hidden"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {loading ? (
            <LoadingRow colSpan={5} />
          ) : recentOps.length === 0 ? (
            <EmptyRow colSpan={5} message="No operations yet — create one from a partner page" />
          ) : (
            <table className="w-full" style={{ fontSize: 'var(--fs-body-sm)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
                  <Th>Reference</Th>
                  <Th>Date</Th>
                  <Th>Partner</Th>
                  <Th align="right">Total</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {recentOps.map((op, idx) => (
                  <tr
                    key={op.id}
                    style={{
                      borderBottom: idx === recentOps.length - 1 ? 'none' : '1px solid var(--border-hairline)',
                    }}
                  >
                    <td className="px-4 py-3" style={{ fontWeight: 700 }}>
                      <Link
                        href={`/operations/${op.id}`}
                        style={{
                          color: 'var(--fg-1)',
                          textDecoration: 'underline',
                          textDecorationColor: 'var(--border-hairline)',
                          textUnderlineOffset: '3px',
                        }}
                      >
                        {op.reference ?? op.id.slice(0, 12)}
                      </Link>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--fg-3)' }}>
                      {formatDateShort(op.operation_date)}
                    </td>
                    <td className="px-4 py-3" style={{ fontWeight: 700 }}>
                      <Link
                        href={`/partners/${op.partner_id}`}
                        style={{ color: 'var(--fg-1)' }}
                      >
                        {op.partner_trade_name ?? op.partner_id}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
                      {formatMoney(op.total_amount, op.currency)} {op.currency}
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip status={op.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* RECENT PAYMENTS ============================================ */}
      <section>
        <SectionHeader
          title="Recent payments"
          subtitle={`${payments.length} total recorded`}
        />
        <div
          className="overflow-hidden"
          style={{
            backgroundColor: 'var(--paper)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {loading ? (
            <LoadingRow colSpan={4} />
          ) : recentPayments.length === 0 ? (
            <EmptyRow colSpan={4} message="No payments recorded yet" />
          ) : (
            <table className="w-full" style={{ fontSize: 'var(--fs-body-sm)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
                  <Th>Date</Th>
                  <Th>Partner</Th>
                  <Th>Direction</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {recentPayments.map((p, idx) => (
                  <tr
                    key={p.id}
                    style={{
                      borderBottom: idx === recentPayments.length - 1 ? 'none' : '1px solid var(--border-hairline)',
                    }}
                  >
                    <td className="px-4 py-3" style={{ color: 'var(--fg-3)' }}>
                      {formatDateShort(p.payment_date)}
                    </td>
                    <td className="px-4 py-3" style={{ fontWeight: 700 }}>
                      <Link
                        href={`/partners/${p.partner_id}`}
                        style={{ color: 'var(--fg-1)' }}
                      >
                        {p.partner_trade_name ?? p.partner_id}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <DirectionChip direction={p.direction} />
                    </td>
                    <td className="px-4 py-3 text-right" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
                      {formatMoney(p.amount, p.currency)} {p.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================
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
      }}
    >
      <div
       
        style={{ color: 'var(--fg-2)' }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '40px',
          fontWeight: 900,
          lineHeight: 1.05,
          color: valueColor,
          marginTop: '12px',
        }}
      >
        {loading ? <Loader2 className="h-7 w-7 animate-spin inline-block" style={{ color: 'var(--fg-3)' }} /> : value}
      </div>
      <div
        className="mt-2"
        style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-3)' }}
      >
        {sublabel}
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  subtitle,
  link,
}: {
  title: string;
  subtitle: string;
  link?: string;
}) {
  return (
    <div className="flex items-baseline justify-between mb-4">
      <div>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '22px',
            fontWeight: 800,
            color: 'var(--fg-1)',
          }}
        >
          {title}
        </h2>
        <p
          className="mt-1"
          style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-3)' }}
        >
          {subtitle}
        </p>
      </div>
      {link && (
        <Link
          href={link}
          className="inline-flex items-center gap-1.5 transition-colors"
          style={{
            color: 'var(--brand-rot)',
            fontSize: 'var(--fs-body-sm)',
            fontWeight: 600,
          }}
        >
          View all
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
     
      style={{
        textAlign: align ?? 'left',
        padding: '12px 16px',
        color: 'var(--fg-3)',
      }}
    >
      {children}
    </th>
  );
}

function LoadingRow({ colSpan }: { colSpan: number }) {
  return (
    <table className="w-full">
      <tbody>
        <tr>
          <td colSpan={colSpan} className="text-center" style={{ padding: '40px' }}>
            <Loader2 className="h-5 w-5 animate-spin inline-block" style={{ color: 'var(--fg-3)' }} />
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <table className="w-full">
      <tbody>
        <tr>
          <td colSpan={colSpan} className="text-center" style={{ padding: '32px', color: 'var(--fg-3)' }}>
            {message}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function DirectionChip({ direction }: { direction: 'incoming' | 'outgoing' }) {
  const incoming = direction === 'incoming';
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        color: incoming ? 'var(--status-success)' : 'var(--brand-rot)',
        fontWeight: 600,
        fontSize: 'var(--fs-body-sm)',
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          backgroundColor: incoming ? 'var(--status-success)' : 'var(--brand-rot)',
        }}
      />
      {incoming ? 'Incoming' : 'Outgoing'}
    </span>
  );
}

