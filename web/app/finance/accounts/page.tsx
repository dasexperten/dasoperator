'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, ChevronLeft, CheckCircle2, Circle, RefreshCw } from 'lucide-react';
import { getBankAccounts, syncBankHistory, type BankAccount } from '@/lib/api';

function formatBalance(minor: number, currency: string): string {
  const factor = ['VND', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
  return (minor / factor).toLocaleString('en-US', {
    minimumFractionDigits: factor === 1 ? 0 : 2,
    maximumFractionDigits: factor === 1 ? 0 : 2,
  });
}

function formatLastSync(unix: number | null): string {
  if (!unix) return '—';
  const date = new Date(unix * 1000);
  const now = Date.now();
  const diff = (now - date.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return date.toISOString().split('T')[0]!;
}

export default function BankAccountsPage() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null); // 'all' | account_id | null
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  async function loadAccounts() {
    setLoading(true);
    try {
      const res = await getBankAccounts();
      if (res.success && res.result) {
        setAccounts(res.result.accounts);
        setError(null);
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to load');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAccounts(); }, []);

  async function handleSync(accountId?: string) {
    setSyncing(accountId ?? 'all');
    setSyncMessage(null);
    try {
      const res = await syncBankHistory(accountId ? { account_id: accountId } : {});
      if (res.success && res.result) {
        const r = res.result;
        setSyncMessage(
          `Synced ${r.accounts_synced} account${r.accounts_synced === 1 ? '' : 's'}: ` +
          `${r.total_inserted} new, ${r.total_updated} updated, ${r.total_fetched} fetched total.`
        );
        await loadAccounts();
      } else {
        setSyncMessage(`Sync failed: ${res.errors?.[0]?.message ?? 'unknown error'}`);
      }
    } catch (e) {
      setSyncMessage(`Sync error: ${e instanceof Error ? e.message : 'network'}`);
    } finally {
      setSyncing(null);
    }
  }

  return (
    <div className="px-8 py-6 max-w-7xl">
      <div className="mb-4">
        <Link
          href="/finance"
          className="inline-flex items-center gap-1"
          style={{ fontSize: '14px', color: 'var(--fg-2)' }}
        >
          <ChevronLeft className="h-4 w-4" />
          Finance
        </Link>
      </div>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 style={{
            fontFamily: 'Plus Jakarta Sans, sans-serif',
            fontSize: '24px',
            fontWeight: 700,
            color: 'var(--fg-1)',
            textTransform: 'uppercase',
            letterSpacing: 0,
            marginBottom: '8px',
          }}>
            Bank Accounts
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            Bank accounts linked through API integration. Webhook receives new transactions automatically.
          </p>
        </div>
        <button
          onClick={() => handleSync()}
          disabled={syncing !== null}
          className="flex items-center gap-2 px-4 py-2"
          style={{
            border: '1px solid var(--line-1)',
            borderRadius: 'var(--radius-sm)',
            backgroundColor: 'var(--paper)',
            color: 'var(--fg-1)',
            fontSize: '14px',
            fontWeight: 700,
            cursor: syncing !== null ? 'not-allowed' : 'pointer',
            opacity: syncing !== null ? 0.6 : 1,
          }}
        >
          {syncing === 'all' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Sync All History
        </button>
      </div>

      {syncMessage && (
        <div
          className="mb-4 px-4 py-3"
          style={{
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--line-1)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '14px',
            color: 'var(--fg-1)',
          }}
        >
          {syncMessage}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2" style={{ color: 'var(--fg-2)' }}>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span style={{ fontSize: '14px' }}>Loading accounts...</span>
        </div>
      )}

      {error && (
        <div style={{ color: 'var(--status-danger)', fontSize: '14px' }}>
          Error: {error}
        </div>
      )}

      {!loading && !error && accounts.length === 0 && (
        <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
          No bank accounts with API integration yet.
        </div>
      )}

      {!loading && accounts.length > 0 && (
        <div style={{
          border: '1px solid var(--line-1)',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper)',
          overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--paper-sunk)', borderBottom: '1px solid var(--line-1)' }}>
                <th style={{ textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700 }}>Entity</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700 }}>Bank</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700 }}>Account</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700 }}>Currency</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700 }}>API</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700 }}>Last Sync</th>
                <th style={{ textAlign: 'right', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((acc) => (
                <tr key={acc.id} style={{ borderBottom: '1px solid var(--line-1)' }}>
                  <td style={{ padding: '12px 16px', fontWeight: 700, color: 'var(--fg-1)' }}>
                    {acc.company_abbreviation}
                  </td>
                  <td style={{ padding: '12px 16px', color: 'var(--fg-1)' }}>
                    {acc.bank_provider_id === 'bp_modulbank' ? 'Modulbank' : acc.bank_provider_id ?? '—'}
                  </td>
                  <td style={{ padding: '12px 16px', fontFamily: 'Manrope, sans-serif', color: 'var(--fg-1)' }}>
                    {acc.account_number}
                  </td>
                  <td style={{ padding: '12px 16px', fontWeight: 700, color: 'var(--fg-1)' }}>
                    {acc.currency}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    {acc.api_enabled ? (
                      <span className="inline-flex items-center gap-1" style={{ color: 'var(--status-success)' }}>
                        <CheckCircle2 className="h-4 w-4" />
                        Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1" style={{ color: 'var(--fg-3)' }}>
                        <Circle className="h-4 w-4" />
                        Manual
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', color: 'var(--fg-2)' }}>
                    {formatLastSync(acc.last_sync_at)}
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                    {acc.api_enabled ? (
                      <button
                        onClick={() => handleSync(acc.id)}
                        disabled={syncing !== null}
                        className="inline-flex items-center gap-1 px-3 py-1"
                        style={{
                          border: '1px solid var(--line-1)',
                          borderRadius: 'var(--radius-sm)',
                          backgroundColor: 'var(--paper)',
                          color: 'var(--fg-1)',
                          fontSize: '14px',
                          cursor: syncing !== null ? 'not-allowed' : 'pointer',
                          opacity: syncing !== null ? 0.6 : 1,
                        }}
                      >
                        {syncing === acc.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Sync
                      </button>
                    ) : (
                      <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
