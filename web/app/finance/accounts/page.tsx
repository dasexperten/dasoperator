'use client';

export const runtime = 'edge';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, ChevronLeft, RefreshCw, Copy, CheckCircle2, ListOrdered, Hourglass } from 'lucide-react';
import { getBankAccounts, syncBankHistory, type BankAccount } from '@/lib/api';

// Hard-coded entity list — the four Das Experten companies. Activation status comes from
// whether any returned BankAccount belongs to this entity with api_enabled = 1.
const ENTITIES = [
  { abbr: 'DEE',     name: 'Das Experten Eurasia LLC' },
  { abbr: 'DEI',     name: 'Das Experten International LLC' },
  { abbr: 'DEASEAN', name: 'Das Experten ASEAN Co. Ltd.' },
  { abbr: 'DEC',     name: 'Das Experten Corporation' },
] as const;

function formatLastSync(unix: number | null): string {
  if (!unix) return 'Never';
  const date = new Date(unix * 1000);
  const now = Date.now();
  const diff = (now - date.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return date.toISOString().split('T')[0]!;
}

function CopyableRow({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);

  if (!value) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not available */
    }
  }

  return (
    <div
      onClick={handleCopy}
      className="flex items-center justify-between py-2 cursor-pointer group"
      style={{ borderBottom: '1px solid var(--line-1)' }}
    >
      <div style={{ fontSize: '14px', color: 'var(--fg-2)', fontWeight: 700, minWidth: '140px' }}>
        {label}
      </div>
      <div className="flex items-center gap-2">
        <div style={{
          fontSize: '14px',
          fontFamily: 'Manrope, sans-serif',
          fontWeight: 700,
          color: 'var(--fg-1)',
        }}>
          {value}
        </div>
        {copied
          ? <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--status-success)' }} />
          : <Copy className="h-4 w-4 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--fg-3)' }} />}
      </div>
    </div>
  );
}

export default function BankReferencePage() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [activeEntity, setActiveEntity] = useState<string>('DEE');
  const [activeCurrency, setActiveCurrency] = useState<string | null>(null);

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

  // Group accounts by entity to compute activation status
  const accountsByEntity = useMemo(() => {
    const map: Record<string, BankAccount[]> = {};
    for (const acc of accounts) {
      const key = acc.company_abbreviation;
      if (!map[key]) map[key] = [];
      map[key].push(acc);
    }
    return map;
  }, [accounts]);

  // Accounts of the currently selected entity
  const entityAccounts = accountsByEntity[activeEntity] ?? [];

  // Default-select the first currency once data lands
  useEffect(() => {
    if (entityAccounts.length > 0 && !activeCurrency) {
      const defaultAcc = entityAccounts.find((a) => a.is_default) ?? entityAccounts[0]!;
      setActiveCurrency(defaultAcc.currency);
    }
    if (entityAccounts.length > 0 && activeCurrency &&
        !entityAccounts.some((a) => a.currency === activeCurrency)) {
      setActiveCurrency(entityAccounts[0]!.currency);
    }
  }, [entityAccounts, activeCurrency]);

  const selectedAccount = entityAccounts.find((a) => a.currency === activeCurrency) ?? null;

  async function handleSync(accountId?: string) {
    setSyncing(accountId ?? 'all');
    setSyncMessage(null);
    try {
      const res = await syncBankHistory(accountId ? { account_id: accountId } : {});
      if (res.success && res.result) {
        const r = res.result;
        setSyncMessage(
          `Synced ${r.accounts_synced} account${r.accounts_synced === 1 ? '' : 's'}: ` +
          `${r.total_inserted} new, ${r.total_updated} updated.`
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

  const activeEntityInfo = ENTITIES.find((e) => e.abbr === activeEntity)!;

  return (
    <div className="px-8 py-6 max-w-6xl">
      <div className="mb-4">
        <Link
          href="/finance"
          className="inline-flex items-center gap-1"
          style={{ fontSize: '14px', color: 'var(--fg-2)' }}
        >
          <ChevronLeft className="h-4 w-4" />
          Transactions
        </Link>
      </div>

      <div className="mb-6">
        <h1 style={{
          fontFamily: 'Plus Jakarta Sans, sans-serif',
          fontSize: '24px',
          fontWeight: 700,
          color: 'var(--fg-1)',
          textTransform: 'uppercase',
          letterSpacing: 0,
          marginBottom: '8px',
        }}>
          Bank Reference
        </h1>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
          Bank account details for each entity. Click any value to copy.
        </p>
      </div>

      {/* Entity selector — row of buttons */}
      <div className="mb-6 flex flex-wrap gap-2">
        {ENTITIES.map((ent) => {
          const entAccounts = accountsByEntity[ent.abbr] ?? [];
          const hasAccounts = entAccounts.length > 0;
          const hasLiveApi = entAccounts.some((a) => a.api_enabled === 1);
          const activated = hasAccounts;
          const isActive = ent.abbr === activeEntity;

          // Status label: Live API (Modulbank), Manual (Wio pre-approval), Not activated
          const statusLabel = hasLiveApi
            ? 'Live API'
            : hasAccounts
              ? 'Manual entry'
              : 'Not activated';
          const statusColor = hasLiveApi
            ? 'var(--status-success)'
            : hasAccounts
              ? 'var(--line-innoweiss)'
              : 'var(--fg-3)';

          return (
            <button
              key={ent.abbr}
              onClick={() => { setActiveEntity(ent.abbr); setActiveCurrency(null); }}
              disabled={!activated}
              className="flex flex-col items-start px-5 py-3 transition-colors"
              style={{
                border: isActive ? '2px solid var(--brand-rot)' : '1px solid var(--line-1)',
                borderRadius: 'var(--radius-md)',
                backgroundColor: isActive ? 'var(--paper)' : (activated ? 'var(--paper)' : 'var(--paper-sunk)'),
                color: activated ? 'var(--fg-1)' : 'var(--fg-3)',
                fontSize: '14px',
                cursor: activated ? 'pointer' : 'not-allowed',
                opacity: activated ? 1 : 0.6,
                minWidth: '160px',
              }}
            >
              <div style={{
                fontSize: '18px',
                fontWeight: 700,
                color: isActive ? 'var(--brand-rot)' : (activated ? 'var(--fg-1)' : 'var(--fg-3)'),
              }}>
                {ent.abbr}
              </div>
              <div style={{ fontSize: '14px', color: statusColor, marginTop: '2px', fontWeight: 700 }}>
                {statusLabel}
              </div>
            </button>
          );
        })}
      </div>

      {syncMessage && (
        <div className="mb-4 px-4 py-3" style={{
          backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--line-1)',
          borderRadius: 'var(--radius-sm)', fontSize: '14px', color: 'var(--fg-1)',
        }}>
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
        <div style={{ color: 'var(--status-danger)', fontSize: '14px' }}>Error: {error}</div>
      )}

      {/* Entity card */}
      {!loading && (() => {
        const authMethod = selectedAccount?.bank_auth_method ?? null;
        const isLiveApi = authMethod === 'static_token' || authMethod === 'oauth2';
        const isManual = authMethod === 'manual';

        return (
        <div style={{
          border: '1px solid var(--line-1)',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper)',
          padding: '24px',
        }}>
          {/* Company header */}
          <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
            <div>
              <div style={{
                fontFamily: 'Plus Jakarta Sans, sans-serif',
                fontSize: '18px',
                fontWeight: 700,
                color: 'var(--fg-1)',
                textTransform: 'uppercase',
              }}>
                {activeEntityInfo.name}
              </div>
              {selectedAccount?.company_tax_id && (
                <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '4px' }}>
                  INN {selectedAccount.company_tax_id}
                  {selectedAccount.company_kpp && ` · KPP ${selectedAccount.company_kpp}`}
                  {selectedAccount.company_ogrn && ` · OGRN ${selectedAccount.company_ogrn}`}
                </div>
              )}
              {selectedAccount?.bank_name && (
                <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginTop: '2px' }}>
                  Bank: <strong>{selectedAccount.bank_name}</strong>
                  {selectedAccount.bank_legal_name_ru && ` (${selectedAccount.bank_legal_name_ru})`}
                  {selectedAccount.bank_country && ` · ${selectedAccount.bank_country}`}
                </div>
              )}
            </div>

            {/* Sync All button only for live API providers */}
            {isLiveApi && (
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
                {syncing === 'all'
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <RefreshCw className="h-4 w-4" />}
                Sync All History
              </button>
            )}

            {/* Manual badge for manual-mode providers (Wio etc.) */}
            {isManual && (
              <div className="flex items-center gap-2 px-4 py-2" style={{
                border: '1px solid var(--line-innoweiss)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'rgba(13,25,158,0.06)',
                color: 'var(--line-innoweiss)',
                fontSize: '14px',
                fontWeight: 700,
              }}>
                <Hourglass className="h-4 w-4" />
                Manual entry — API access pending
              </div>
            )}
          </div>

          {/* Empty state — entity has no accounts at all */}
          {entityAccounts.length === 0 && (
            <div style={{
              padding: '24px',
              backgroundColor: 'var(--paper-sunk)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '14px',
              color: 'var(--fg-2)',
              textAlign: 'center',
            }}>
              This entity is not activated yet. Bank API integration will be added when its bank provides API access.
            </div>
          )}

          {/* Currency tabs + reference card */}
          {entityAccounts.length > 0 && (
            <>
              <div className="flex flex-wrap gap-2 mb-4">
                {entityAccounts.map((acc) => {
                  const isCurActive = acc.currency === activeCurrency;
                  return (
                    <button
                      key={acc.id}
                      onClick={() => setActiveCurrency(acc.currency)}
                      className="px-4 py-2"
                      style={{
                        border: isCurActive ? '1px solid var(--brand-rot)' : '1px solid var(--line-1)',
                        borderRadius: 'var(--radius-sm)',
                        backgroundColor: isCurActive ? 'var(--brand-rot)' : 'var(--paper)',
                        color: isCurActive ? 'var(--paper)' : 'var(--fg-1)',
                        fontSize: '14px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        minWidth: '60px',
                      }}
                    >
                      {acc.currency}
                    </button>
                  );
                })}
              </div>

              {/* Three-line reference card for selected currency */}
              {selectedAccount && (
                <div style={{
                  backgroundColor: 'var(--paper-sunk)',
                  border: '1px solid var(--line-1)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '16px 20px',
                }}>
                  <CopyableRow label="Account number" value={selectedAccount.account_number} />
                  <CopyableRow label="BIC" value={selectedAccount.bank_bic} />
                  <CopyableRow label="SWIFT" value={selectedAccount.bank_swift} />
                  <CopyableRow label="Correspondent account" value={selectedAccount.bank_correspondent_account} />

                  {/* Notes for manual accounts */}
                  {isManual && selectedAccount.notes && (
                    <div style={{
                      marginTop: '12px',
                      padding: '10px 12px',
                      backgroundColor: 'rgba(13,25,158,0.04)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '14px',
                      color: 'var(--fg-2)',
                      lineHeight: 1.5,
                    }}>
                      <strong>Note:</strong> {selectedAccount.notes}
                    </div>
                  )}

                  {/* Status footer — different for live API vs manual */}
                  <div className="flex items-center justify-between pt-3 mt-2" style={{ borderTop: '1px solid var(--line-1)' }}>
                    {isLiveApi && (
                      <>
                        <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                          Last sync: <strong>{formatLastSync(selectedAccount.last_sync_at)}</strong>
                        </div>
                        <button
                          onClick={() => handleSync(selectedAccount.id)}
                          disabled={syncing !== null}
                          className="flex items-center gap-1 px-3 py-1"
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
                          {syncing === selectedAccount.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <RefreshCw className="h-3 w-3" />}
                          Sync this currency
                        </button>
                      </>
                    )}
                    {isManual && (
                      <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                        Sync via API not available yet. Once <strong>{selectedAccount.bank_name}</strong> approves API access, this account will become live.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Quick link to filtered transactions — only for live API */}
              {selectedAccount && isLiveApi && (
                <div className="mt-4">
                  <Link
                    href={`/finance?account=${selectedAccount.id}`}
                    className="inline-flex items-center gap-2 text-sm"
                    style={{ color: 'var(--brand-rot)', fontSize: '14px', fontWeight: 700 }}
                  >
                    <ListOrdered className="h-4 w-4" />
                    View transactions for this account
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
        );
      })()}
    </div>
  );
}
