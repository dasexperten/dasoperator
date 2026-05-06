'use client';

import { useEffect, useState } from 'react';
import { Loader2, ShoppingCart, CheckCircle2, XCircle, Clock, RefreshCw } from 'lucide-react';
import {
  getMarketplaceHealth, getMarketplaceSyncLog,
  type MarketplaceHealthResponse, type MarketplaceSyncLogEntry,
} from '@/lib/api';

export default function MarketplacesPage() {
  const [health, setHealth] = useState<MarketplaceHealthResponse | null>(null);
  const [log, setLog] = useState<MarketplaceSyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [hRes, lRes] = await Promise.all([
        getMarketplaceHealth(),
        getMarketplaceSyncLog(20),
      ]);
      if (hRes.success && hRes.result) setHealth(hRes.result);
      if (lRes.success && lRes.result) setLog(lRes.result.log);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-8 max-w-full">
      <div>
        <div className="dx-eyebrow-rot mb-2">Sales channels</div>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--fs-display-md)',
            fontWeight: 900,
            color: 'var(--fg-1)',
          }}
        >
          Marketplaces
        </h1>
        <p className="mt-2" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
          Wildberries and Ozon stocks, sales, and analytics.
        </p>
      </div>

      <div className="dx-ribbon-rule" />

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      ) : error ? (
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          Error: {error}
        </div>
      ) : (
        <>
          {/* Last sync summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SyncCard
              title="Ozon"
              tint="rgba(0, 91, 255, 0.06)"
              entry={health?.ozon ?? null}
            />
            <SyncCard
              title="Wildberries"
              tint="rgba(203, 17, 122, 0.06)"
              entry={health?.wb ?? null}
            />
          </div>

          {/* Sync schedule note */}
          <div
            className="flex items-start gap-3 p-4"
            style={{
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '14px',
              color: 'var(--fg-2)',
            }}
          >
            <Clock className="h-5 w-5 mt-0.5 flex-shrink-0" style={{ color: 'var(--fg-muted)' }} />
            <div>
              <div style={{ color: 'var(--fg-1)', fontWeight: 700 }}>Auto sync schedule</div>
              <div className="mt-1">
                Marketplace stocks refresh every hour (00 minutes UTC). WB has a strict rate limit, so syncs run sequentially: Ozon first, then WB after a brief pause.
              </div>
            </div>
          </div>

          {/* Recent syncs table */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 style={{ fontSize: '20px', fontWeight: 700, color: 'var(--fg-1)' }}>
                Recent syncs
              </h2>
              <button
                onClick={() => load()}
                className="flex items-center gap-2 px-3 py-1.5 transition-colors"
                style={{
                  backgroundColor: 'var(--paper-sunk)',
                  border: '1px solid var(--border-hairline)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: '14px',
                  color: 'var(--fg-1)',
                  cursor: 'pointer',
                }}
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
            </div>

            <div className="bg-card overflow-x-auto" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
              <table className="w-full text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Marketplace</Th>
                    <Th>Status</Th>
                    <Th>Duration</Th>
                    <Th right>Rows synced</Th>
                    <Th>Error</Th>
                  </tr>
                </thead>
                <tbody>
                  {log.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center py-12" style={{ color: 'var(--fg-3)' }}>
                        No syncs recorded yet
                      </td>
                    </tr>
                  ) : (
                    log.map((entry) => (
                      <tr key={entry.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                        <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-1)' }}>
                          {formatTimestamp(entry.started_at)}
                        </td>
                        <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-1)', fontWeight: 700 }}>
                          {marketplaceLabel(entry.marketplace)}
                        </td>
                        <td className="px-3 py-2">
                          <StatusPill status={entry.status} />
                        </td>
                        <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                          {formatDuration(entry.started_at, entry.finished_at)}
                        </td>
                        <td className="px-3 py-2 text-right" style={{ fontSize: '14px', color: entry.rows_synced ? 'var(--fg-1)' : 'var(--fg-muted)' }}>
                          {entry.rows_synced != null ? entry.rows_synced.toLocaleString('en-US') : '—'}
                        </td>
                        <td className="px-3 py-2" style={{ fontSize: '14px', color: 'var(--brand-rot)', maxWidth: '320px' }}>
                          {entry.error_message ? truncate(entry.error_message, 80) : ''}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Components
// =============================================================================

function SyncCard({
  title, tint, entry,
}: {
  title: string;
  tint: string;
  entry: import('@/lib/api').MarketplaceSyncEntry | null;
}) {
  return (
    <div
      style={{
        backgroundColor: tint,
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        padding: '16px 18px',
      }}
    >
      <div className="flex items-center gap-2" style={{ fontSize: '16px', fontWeight: 700, color: 'var(--fg-1)' }}>
        <ShoppingCart className="h-4 w-4" />
        {title}
      </div>
      {entry == null ? (
        <div className="mt-3" style={{ fontSize: '14px', color: 'var(--fg-muted)' }}>
          No syncs recorded yet
        </div>
      ) : (
        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <StatusPill status={entry.status} />
            <span style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
              {formatRelative(entry.finished_at ?? entry.started_at)}
            </span>
          </div>
          {entry.status === 'ok' && entry.rows_synced != null && (
            <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
              {entry.rows_synced} rows synced
            </div>
          )}
          {entry.status === 'error' && entry.error_message && (
            <div style={{ fontSize: '14px', color: 'var(--brand-rot)' }}>
              {truncate(entry.error_message, 100)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: 'running' | 'ok' | 'error' }) {
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5"
        style={{
          backgroundColor: 'rgba(34,139,69,0.10)',
          color: 'rgb(34,139,69)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '14px',
          fontWeight: 700,
        }}>
        <CheckCircle2 className="h-3.5 w-3.5" />
        OK
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5"
        style={{
          backgroundColor: 'rgba(229,32,44,0.10)',
          color: 'var(--brand-rot)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '14px',
          fontWeight: 700,
        }}>
        <XCircle className="h-3.5 w-3.5" />
        Error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5"
      style={{
        backgroundColor: 'var(--paper-sunk)',
        color: 'var(--fg-2)',
        borderRadius: 'var(--radius-sm)',
        fontSize: '14px',
        fontWeight: 700,
      }}>
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Running
    </span>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`px-3 py-3 ${right ? 'text-right' : 'text-left'}`}
      style={{
        fontSize: '14px',
        color: 'var(--fg-3)',
        backgroundColor: 'var(--paper-sunk)',
        borderBottom: '1px solid var(--border-hairline)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

// =============================================================================
// Formatters
// =============================================================================

function marketplaceLabel(m: string): string {
  if (m === 'ozon') return 'Ozon';
  if (m === 'wb') return 'Wildberries';
  return m;
}

function formatTimestamp(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function formatRelative(unix: number): string {
  const diff = Date.now() / 1000 - unix;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatDuration(start: number, end: number | null): string {
  if (end == null) return '—';
  const seconds = end - start;
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.substring(0, max - 1) + '…';
}
