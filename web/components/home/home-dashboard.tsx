'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import {
  getOperations,
  getPayments,
  getAllNetBalances,
  getFxLatest,
  type Operation,
  type Payment,
  type FxLatest,
} from '@/lib/api';

// =============================================================================
// Helpers
// =============================================================================
function formatDateShort(unixSec?: number | null): string {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  const month = d.toLocaleString('en-US', { month: 'short' });
  return `${d.getDate()} ${month}`;
}

function getMinorFactor(currency: string): number {
  return ['VND', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
}

function formatMoney(minor: number, currency: string): string {
  const factor = getMinorFactor(currency);
  return (minor / factor).toLocaleString('en-US', {
    minimumFractionDigits: factor === 1 ? 0 : 2,
    maximumFractionDigits: factor === 1 ? 0 : 2,
  });
}

function formatUsdCompact(cents: number): string {
  const dollars = Math.round(cents / 100);
  if (Math.abs(dollars) >= 1_000_000) {
    return `$${Math.round(dollars / 1_000_000).toLocaleString('en-US')}M`;
  }
  if (Math.abs(dollars) >= 10_000) {
    return `$${Math.round(dollars / 1_000).toLocaleString('en-US')}K`;
  }
  return `$${dollars.toLocaleString('en-US')}`;
}

function convertToUsdCents(localMinor: number, currency: string, fx: FxLatest | null): number {
  if (!fx) return 0;
  const rate = fx.rates[currency];
  if (!rate) return 0;
  // local_minor -> local_units -> usd_units -> usd_cents
  const localFactor = getMinorFactor(currency);
  const localUnits = localMinor / localFactor;
  const usdUnits = (localUnits * rate.rate_to_usd_nano) / 1_000_000_000;
  return Math.round(usdUnits * 100);
}

function isThisMonth(unixSec: number): boolean {
  const d = new Date(unixSec * 1000);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

// =============================================================================
// Status chip
// =============================================================================
const STATUS_TONES: Record<string, { bg: string; fg: string }> = {
  draft:             { bg: 'rgba(199,122,0,0.10)',  fg: 'var(--status-warning)' },
  issued:            { bg: 'rgba(31,73,125,0.10)',  fg: 'var(--status-info)' },
  order_fulfilment:  { bg: 'rgba(31,73,125,0.10)',  fg: 'var(--status-info)' },
  production:        { bg: 'rgba(31,73,125,0.10)',  fg: 'var(--status-info)' },
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
  const [balances, setBalances] = useState<{ partner_id: string; net_balance_usd_cents: number }[]>([]);
  const [fx, setFx] = useState<FxLatest | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [opsRes, paysRes, balRes, fxRes] = await Promise.all([
          getOperations(),
          getPayments(),
          getAllNetBalances(),
          getFxLatest(),
        ]);
        if (opsRes.success && opsRes.result) setOperations(opsRes.result.operations);
        if (paysRes.success && paysRes.result) setPayments(paysRes.result.payments);
        if (balRes.success && balRes.result) setBalances(balRes.result.balances);
        if (fxRes.success && fxRes.result) setFx(fxRes.result);
      } catch {
        // best-effort load — empty states render fine
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, []);

  // ---------------------------------------------------------------------------
  // Compute headline metrics
  // ---------------------------------------------------------------------------
  const activeOps = operations.filter((o) => o.status !== 'cancelled');
  const opsThisMonth = activeOps.filter((o) => isThisMonth(o.operation_date));

  const revenueUsdCentsThisMonth = opsThisMonth.reduce(
    (sum, o) => sum + convertToUsdCents(o.total_amount, o.currency, fx),
    0
  );

  // Outstanding = sum of positive net balances (partners owe us)
  const outstandingUsdCents = balances.reduce(
    (sum, b) => sum + (b.net_balance_usd_cents > 0 ? b.net_balance_usd_cents : 0),
    0
  );

  // Active partners = those with at least one non-cancelled operation
  const activePartnerIds = new Set(activeOps.map((o) => o.partner_id));
  const totalPartners = balances.length;
  const activePartners = activePartnerIds.size;

  const recentOps = [...activeOps]
    .sort((a, b) => b.operation_date - a.operation_date)
    .slice(0, 5);

  const recentPayments = [...payments]
    .sort((a, b) => b.payment_date - a.payment_date)
    .slice(0, 3);

  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-10 max-w-6xl">

      {/* HEADER ===================================================== */}
      <div>
        <div
          className="dx-eyebrow dx-eyebrow-rot mb-3"
          style={{ fontSize: 'var(--fs-body-sm)' }}
        >
          Pulse
        </div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-xl)',
            fontWeight: 900,
            lineHeight: 1.02,
            color: 'var(--fg-1)',
          }}
        >
          Das Operator
        </h1>
        <p
          className="mt-3"
          style={{
            fontSize: 'var(--fs-body-lg)',
            color: 'var(--fg-2)',
            maxWidth: '560px',
          }}
        >
          Today's snapshot · {fx ? `FX as of ${fx.date}` : 'Loading FX...'}
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      {/* HEADLINE METRICS =========================================== */}
      <section>
        <div className="grid grid-cols-4 gap-4">
          <MetricCard
            label="Operations"
            sublabel="this month"
            value={opsThisMonth.length.toString()}
            tone="default"
            loading={loading}
          />
          <MetricCard
            label="Revenue"
            sublabel="this month · USD equiv"
            value={loading ? '—' : formatUsdCompact(revenueUsdCentsThisMonth)}
            tone="default"
            loading={loading}
          />
          <MetricCard
            label="Outstanding"
            sublabel="partners owe us"
            value={loading ? '—' : formatUsdCompact(outstandingUsdCents)}
            tone={outstandingUsdCents > 0 ? 'rot' : 'muted'}
            loading={loading}
          />
          <MetricCard
            label="Active partners"
            sublabel={`of ${totalPartners} total`}
            value={loading ? '—' : activePartners.toString()}
            tone="default"
            loading={loading}
          />
        </div>
      </section>

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
                    <td className="px-4 py-3 dx-mono" style={{ fontWeight: 700 }}>
                      <Link
                        href={`/partners/${op.partner_id}/operations/${op.id}`}
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
                    <td className="px-4 py-3 dx-mono" style={{ color: 'var(--fg-3)' }}>
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
                    <td className="px-4 py-3 dx-mono text-right" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
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
                    <td className="px-4 py-3 dx-mono" style={{ color: 'var(--fg-3)' }}>
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
                    <td className="px-4 py-3 dx-mono text-right" style={{ color: 'var(--fg-1)', fontWeight: 700 }}>
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
        className="dx-eyebrow"
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
      className="dx-eyebrow"
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
