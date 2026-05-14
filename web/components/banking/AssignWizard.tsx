'use client';

// =============================================================================
// AssignWizard — universal two-step assignment for bank transactions.
//
// Source-agnostic — works on any bank_transactions.id, regardless of how the
// row entered the system (modulbank_api, wio_api, email_inbox, manual_upload,
// or any future source).
//
// Step 1 — Partner. Backend auto-matches by ИНН (Tier 1: rules, Tier 2: tax_id)
// then IBAN, then fuzzy name. If a high-confidence match exists, it shows as
// a one-click Suggested banner. Otherwise the user picks via search or creates.
//
// Step 2 — Operation. For the selected partner, backend returns open ops in a
// ±90 day / ±5% amount window. User picks one (attach) or creates a fresh
// operation (assign-partner with just partner_id).
//
// On any successful Step 2 action, the backend silently writes a partner ↔ INN
// rule into bank_match_rules so the next matching counterparty is recognised
// instantly via Tier 1 auto-match.
// =============================================================================

import { useEffect, useState, useCallback } from 'react';
import {
  AlertCircle, ArrowRight, Check, ChevronLeft, Loader2, Plus, Search,
  Sparkles, X,
} from 'lucide-react';

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  'https://dasoperator-api.dasexperten.workers.dev';

// ----- types -----

export interface AssignWizardItem {
  id: string;
  direction: 'incoming' | 'outgoing';
  amount: number; // minor units (kopeks)
  currency: string;
  executed_at: number;
  contragent_name: string;
  contragent_inn: string;
  payment_purpose?: string;
}

interface MatchSuggestion {
  partner_id: string;
  trade_name: string;
  kind: string | null;
  confidence: 'high' | 'medium' | 'low';
  via: 'rule' | 'inn' | 'iban' | 'name';
  matched_field: string;
  hit_count?: number;
}

interface OperationCandidate {
  id: string;
  reference: string;
  total_amount: number;
  currency: string;
  operation_date: number;
  status: string;
  partner_name: string;
}

interface SearchResult {
  id: string;
  trade_name: string;
  kind: string;
  tax_id: string;
}

interface SelectedPartner {
  id: string;
  trade_name: string;
  kind: string | null;
}

const PARTNER_KIND_OPTIONS = [
  { value: 'service_provider', label: 'Service provider' },
  { value: '3pl',              label: '3PL / warehouse' },
  { value: 'shipper',          label: 'Shipper / freight forwarder' },
  { value: 'manufacturer',     label: 'Manufacturer / goods supplier' },
  { value: 'buyer',            label: 'Buyer / customer' },
  { value: 'other',            label: 'Other' },
];

// ----- formatters -----

function formatMoney(minor: number, currency: string): string {
  const major = minor / 100;
  return `${major.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function formatMoneyMajor(major: number, currency: string): string {
  return `${major.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function formatDate(unix: number): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function cleanContragent(name: string): string {
  if (!name) return '—';
  return name
    .replace(/^ОБЩЕСТВО\s+С\s+ОГРАНИЧЕННОЙ\s+ОТВЕТСТВЕННОСТЬЮ\s*/i, 'ООО ')
    .replace(/^ИНДИВИДУАЛЬНЫЙ\s+ПРЕДПРИНИМАТЕЛЬ\s*/i, 'ИП ')
    .replace(/"/g, '')
    .trim();
}

// ----- component -----

export default function AssignWizard({
  item, onResolved, onCancel,
}: {
  item: AssignWizardItem;
  onResolved: () => void;
  onCancel?: () => void;
}) {
  // step machine
  const [step, setStep] = useState<1 | 2>(1);
  const [partner, setPartner] = useState<SelectedPartner | null>(null);

  // global busy/error
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 — auto-match suggestions
  const [autoMatch, setAutoMatch] = useState<MatchSuggestion[] | null>(null);
  const [autoLoading, setAutoLoading] = useState(true);
  const [step1Mode, setStep1Mode] = useState<'pick' | 'create'>('pick');

  // Step 1 — search-existing fields
  const [search, setSearch] = useState('');
  const [allPartners, setAllPartners] = useState<SearchResult[]>([]);
  const [allPartnersLoading, setAllPartnersLoading] = useState(false);

  // Step 1 — create-new fields
  const [newName, setNewName] = useState(cleanContragent(item.contragent_name));
  const [newKind, setNewKind] = useState(
    item.direction === 'incoming' ? 'buyer' : 'service_provider',
  );
  const [newInn, setNewInn] = useState(item.contragent_inn || '');

  // Step 2 — operation candidates
  const [operations, setOperations] = useState<OperationCandidate[] | null>(null);
  const [opsLoading, setOpsLoading] = useState(false);

  // Load auto-match on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAutoLoading(true);
      try {
        const r = await fetch(`${API_BASE}/api/inbox/banking/${item.id}/auto-match`);
        const d = await r.json();
        if (!cancelled && d.success) {
          setAutoMatch((d.result?.suggestions || []) as MatchSuggestion[]);
        } else if (!cancelled) {
          setAutoMatch([]);
        }
      } catch {
        if (!cancelled) setAutoMatch([]);
      } finally {
        if (!cancelled) setAutoLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [item.id]);

  // Load all partners once on mount for the always-visible picker list
  useEffect(() => {
    let alive = true;
    (async () => {
      setAllPartnersLoading(true);
      try {
        const r = await fetch(`${API_BASE}/api/partners?limit=200`);
        const d = await r.json();
        if (!alive) return;
        if (d.success) {
          const items = Array.isArray(d.result) ? d.result : (d.result?.partners || d.result?.items || []);
          setAllPartners(items.map((p: { id: string; trade_name: string; kind?: string; tax_id?: string }) => ({
            id: p.id, trade_name: p.trade_name, kind: p.kind || '', tax_id: p.tax_id || '',
          })));
        }
      } catch {
        // silent — list will just be empty
      } finally {
        if (alive) setAllPartnersLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Load operations for the selected partner (Step 2)
  const loadOperations = useCallback(async (p: SelectedPartner) => {
    setOpsLoading(true);
    setOperations(null);
    try {
      const r = await fetch(
        `${API_BASE}/api/inbox/banking/${item.id}/suggestions?partner_id=${encodeURIComponent(p.id)}`,
      );
      const d = await r.json();
      if (d.success) {
        setOperations((d.result?.candidates || []) as OperationCandidate[]);
      } else {
        setOperations([]);
      }
    } catch {
      setOperations([]);
    } finally {
      setOpsLoading(false);
    }
  }, [item.id]);

  // Go to Step 2 with a selected partner
  const pickPartner = useCallback((p: SelectedPartner) => {
    setPartner(p);
    setError(null);
    setStep(2);
    void loadOperations(p);
  }, [loadOperations]);

  // Step 1 — create brand-new partner. assign-partner endpoint creates partner
  // AND fresh draft operation in one transaction, so the wizard resolves now.
  const createPartnerAndOperation = useCallback(async () => {
    if (!newName.trim()) {
      setError('Trade name required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/inbox/banking/${item.id}/assign-partner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trade_name: newName.trim(),
          kind: newKind,
          tax_id: newInn.trim() || undefined,
          currency: item.currency,
        }),
      });
      const d = await r.json();
      if (d.success) onResolved();
      else setError(d.errors?.[0]?.message || 'Failed to create partner');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [newName, newKind, newInn, item.id, item.currency, onResolved]);

  // Step 2 — attach to existing operation
  const attachToOperation = useCallback(async (opId: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/inbox/banking/${item.id}/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation_id: opId }),
      });
      const d = await r.json();
      if (d.success) onResolved();
      else setError(d.errors?.[0]?.message || 'Failed to attach');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [item.id, onResolved]);

  // Step 2 — create a new operation for the existing partner
  const createOperationForPartner = useCallback(async () => {
    if (!partner) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/inbox/banking/${item.id}/assign-partner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partner_id: partner.id }),
      });
      const d = await r.json();
      if (d.success) onResolved();
      else setError(d.errors?.[0]?.message || 'Failed to create operation');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [partner, item.id, onResolved]);

  // ----- presentational helpers -----

  const topSuggestion = autoMatch && autoMatch.length > 0 ? autoMatch[0] : null;

  const amountSign = item.direction === 'incoming' ? '+' : '-';
  const txSummary = `${amountSign}${formatMoney(item.amount, item.currency)} · ${formatDate(item.executed_at)}${item.contragent_inn ? ` · ИНН ${item.contragent_inn}` : ''}`;

  // ----- render -----

  return (
    <div style={{
      background: 'var(--paper-base, #fff)',
      border: '1px solid var(--paper-divider, rgba(0,0,0,0.08))',
      borderRadius: 4,
      padding: 16,
    }}>
      {error && (
        <div style={{
          background: 'rgba(229,32,44,0.08)',
          color: '#A82029',
          fontSize: 14,
          padding: '10px 12px',
          borderRadius: 4,
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* Step header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            fontSize: 14, fontWeight: 700,
            background: 'rgba(13,25,158,0.08)',
            color: '#0D199E',
            padding: '3px 10px',
            borderRadius: 999,
          }}>
            Step {step} of 2
          </span>
          <span style={{ fontSize: 14, color: 'var(--fg-2)' }}>
            {step === 1 ? 'Partner' : 'Operation'}
          </span>
        </div>
        <span style={{ fontSize: 14, color: 'var(--fg-3)', fontWeight: 700 }}>
          {txSummary}
        </span>
      </div>

      {/* Step 1 — Partner */}
      {step === 1 && (
        <div>
          {/* Auto-match suggested banner */}
          {autoLoading && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              color: 'var(--fg-3)', fontSize: 14,
              padding: '10px 0',
            }}>
              <Loader2 size={14} className="animate-spin" />
              Looking for known counterparties…
            </div>
          )}

          {/* Suggested partner banner — always visible in pick mode */}
          {!autoLoading && topSuggestion && step1Mode === 'pick' && (
            <div style={{
              background: 'rgba(13,25,158,0.04)',
              border: '1px solid rgba(13,25,158,0.18)',
              borderRadius: 4,
              padding: '12px 14px',
              marginBottom: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 14, color: '#0D199E', fontWeight: 700,
                  marginBottom: 4,
                }}>
                  <Sparkles size={14} />
                  Suggested · {topSuggestion.matched_field}
                </div>
                <div style={{
                  fontSize: 16, fontWeight: 700, color: 'var(--fg-1)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {topSuggestion.trade_name}
                </div>
                {topSuggestion.kind && (
                  <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 2 }}>
                    {topSuggestion.kind}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => pickPartner({
                  id: topSuggestion.partner_id,
                  trade_name: topSuggestion.trade_name,
                  kind: topSuggestion.kind,
                })}
                style={{
                  background: '#0D199E', color: 'white', border: 'none',
                  padding: '8px 16px', borderRadius: 4,
                  fontSize: 14, fontWeight: 700,
                  cursor: busy ? 'default' : 'pointer',
                  display: 'flex', alignItems: 'center', gap: 6,
                  flexShrink: 0,
                }}
              >
                Accept <ArrowRight size={14} />
              </button>
            </div>
          )}

          {/* Action: switch to create-new-partner mode */}
          {step1Mode === 'pick' && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => setStep1Mode('create')}
                style={{
                  background: 'var(--paper-base, #fff)',
                  color: 'var(--fg-2)',
                  border: '1px solid var(--paper-divider, rgba(0,0,0,0.12))',
                  padding: '6px 12px', borderRadius: 4,
                  fontSize: 14, fontWeight: 700,
                  display: 'flex', alignItems: 'center', gap: 6,
                  cursor: 'pointer',
                }}
              >
                <Plus size={14} /> Create new partner
              </button>
            </div>
          )}

          {/* Always-visible partner picker — search filters the list in place */}
          {step1Mode === 'pick' && (
            <div style={{
              background: 'var(--paper-sunk)',
              borderRadius: 4, padding: 12,
            }}>
              <div style={{ position: 'relative', marginBottom: 8 }}>
                <Search size={14} style={{
                  position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                  color: 'var(--fg-3)', pointerEvents: 'none',
                }} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter partners by name or ИНН…"
                  style={{
                    width: '100%', padding: '8px 10px 8px 30px', borderRadius: 4,
                    border: '1px solid var(--paper-divider, rgba(0,0,0,0.15))',
                    fontSize: 14, fontWeight: 700,
                  }}
                />
              </div>

              {allPartnersLoading && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  color: 'var(--fg-3)', fontSize: 14, padding: '8px 4px',
                }}>
                  <Loader2 size={14} className="animate-spin" /> Loading partners…
                </div>
              )}

              {!allPartnersLoading && (() => {
                const q = search.trim().toLowerCase();
                const suggestedId = topSuggestion?.partner_id;
                const list = allPartners
                  .filter((p) => !suggestedId || p.id !== suggestedId)
                  .filter((p) => {
                    if (!q) return true;
                    return (
                      (p.trade_name || '').toLowerCase().includes(q) ||
                      (p.tax_id || '').toLowerCase().includes(q) ||
                      (p.kind || '').toLowerCase().includes(q)
                    );
                  });
                if (list.length === 0) {
                  return (
                    <div style={{ fontSize: 14, color: 'var(--fg-3)', padding: '8px 4px' }}>
                      No partners match. Try <span style={{ fontWeight: 700 }}>Create new partner</span> instead.
                    </div>
                  );
                }
                return (
                  <div style={{
                    display: 'flex', flexDirection: 'column', gap: 4,
                    maxHeight: 320, overflowY: 'auto',
                  }}>
                    {list.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        disabled={busy}
                        onClick={() => pickPartner({ id: p.id, trade_name: p.trade_name, kind: p.kind })}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '8px 10px', borderRadius: 4,
                          background: 'var(--paper-base, #fff)',
                          border: '1px solid var(--paper-divider, rgba(0,0,0,0.08))',
                          fontSize: 14, textAlign: 'left',
                          cursor: busy ? 'default' : 'pointer',
                        }}
                      >
                        <span style={{ minWidth: 0, marginRight: 8 }}>
                          <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{p.trade_name}</span>
                          {p.kind && <span style={{ color: 'var(--fg-3)', marginLeft: 8 }}>{p.kind}</span>}
                        </span>
                        {p.tax_id && (
                          <span style={{ color: 'var(--fg-3)', fontSize: 14, fontWeight: 700, flexShrink: 0 }}>
                            ИНН {p.tax_id}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Step 1 — Create new partner panel */}
          {step1Mode === 'create' && (
            <div style={{
              background: 'var(--paper-sunk)',
              borderRadius: 4, padding: 12, marginTop: 8,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <Field label="Trade name">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                  style={inputStyle}
                />
              </Field>
              <Field label="Category">
                <select
                  value={newKind}
                  onChange={(e) => setNewKind(e.target.value)}
                  style={inputStyle}
                >
                  {PARTNER_KIND_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="ИНН (optional)">
                <input
                  type="text"
                  value={newInn}
                  onChange={(e) => setNewInn(e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <button
                type="button"
                disabled={busy}
                onClick={createPartnerAndOperation}
                style={{
                  alignSelf: 'flex-start',
                  background: 'var(--fg-1)', color: 'white', border: 'none',
                  padding: '8px 16px', borderRadius: 4,
                  fontSize: 14, fontWeight: 700,
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {busy
                  ? <><Loader2 size={14} className="animate-spin" /> Creating…</>
                  : <><Check size={14} /> Create partner and operation</>}
              </button>
              <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                Creates the partner and a draft operation matching this transaction in one step.
                You can refine the operation later from the partner page.
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 2 — Operation */}
      {step === 2 && partner && (
        <div>
          <div style={{
            background: 'rgba(13,25,158,0.04)',
            border: '1px solid rgba(13,25,158,0.18)',
            borderRadius: 4,
            padding: '10px 12px',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 14, color: '#0D199E', fontWeight: 700, marginBottom: 2 }}>
                Partner
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-1)' }}>
                {partner.trade_name}
              </div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setStep(1); setPartner(null); setError(null); }}
              style={{
                background: 'transparent', color: '#0D199E',
                border: '1px solid rgba(13,25,158,0.3)',
                padding: '6px 12px', borderRadius: 4,
                fontSize: 14, fontWeight: 700,
                cursor: busy ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <ChevronLeft size={14} /> Change
            </button>
          </div>

          {opsLoading && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              color: 'var(--fg-3)', fontSize: 14,
              padding: '10px 0',
            }}>
              <Loader2 size={14} className="animate-spin" />
              Loading open operations of this partner…
            </div>
          )}

          {!opsLoading && operations && operations.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 14, color: 'var(--fg-3)', marginBottom: 6, fontWeight: 700 }}>
                Open operations · ±90 days · ±5% amount
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {operations.map((op) => (
                  <button
                    key={op.id}
                    type="button"
                    disabled={busy}
                    onClick={() => attachToOperation(op.id)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '100px 1fr 130px 110px 18px',
                      gap: 12, alignItems: 'center',
                      padding: '10px 12px', borderRadius: 4,
                      background: 'var(--paper-sunk)',
                      border: '1px solid transparent',
                      fontSize: 14, textAlign: 'left',
                      cursor: busy ? 'default' : 'pointer',
                    }}
                  >
                    <span style={{ fontWeight: 700, color: 'var(--line-innoweiss, #0D199E)' }}>
                      {op.reference}
                    </span>
                    <span style={{
                      color: 'var(--fg-2)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {op.status}
                    </span>
                    <span style={{ fontWeight: 700, color: 'var(--fg-1)', textAlign: 'right' }}>
                      {formatMoneyMajor(op.total_amount, op.currency)}
                    </span>
                    <span style={{ color: 'var(--fg-3)', fontSize: 14, fontWeight: 700, textAlign: 'right' }}>
                      {formatDate(op.operation_date)}
                    </span>
                    <ArrowRight size={14} style={{ color: 'var(--fg-3)' }} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {!opsLoading && operations && operations.length === 0 && (
            <div style={{
              fontSize: 14, color: 'var(--fg-3)',
              padding: '12px 0', marginBottom: 8,
            }}>
              No open operations match this transaction. Create a fresh one below.
            </div>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={createOperationForPartner}
            style={{
              width: '100%',
              background: 'var(--paper-base, #fff)',
              color: 'var(--fg-1)',
              border: '1px dashed var(--paper-divider, rgba(0,0,0,0.25))',
              padding: '10px 12px', borderRadius: 4,
              fontSize: 14, fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy
              ? <><Loader2 size={14} className="animate-spin" /> Creating…</>
              : <><Plus size={14} /> Create new operation for this partner</>}
          </button>
        </div>
      )}

      {/* Footer with cancel */}
      {onCancel && (
        <div style={{
          marginTop: 16, paddingTop: 12,
          borderTop: '1px solid var(--paper-divider, rgba(0,0,0,0.08))',
          display: 'flex', justifyContent: 'flex-end',
        }}>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={{
              background: 'transparent',
              color: 'var(--fg-3)',
              border: 'none',
              fontSize: 14, fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <X size={14} /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ----- inline helpers -----

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 4,
  border: '1px solid var(--paper-divider, rgba(0,0,0,0.15))',
  fontSize: 14, fontWeight: 700,
  background: 'var(--paper-base, #fff)',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 14, color: 'var(--fg-3)', fontWeight: 700 }}>
        {label}
      </label>
      {children}
    </div>
  );
}
