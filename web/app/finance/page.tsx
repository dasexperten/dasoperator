'use client';

export const runtime = 'edge';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Loader2, ArrowDownLeft, ArrowUpRight, CheckCircle2, AlertCircle, Search,
  Upload, Plus, X, Mail, Building2, Trash2,
} from 'lucide-react';
import {
  getBankTransactions, getBankAccounts, getBankStatementSources,
  createBankStatementSource, deleteBankStatementSource,
  uploadBankStatement,
  type BankTransaction, type BankAccount, type BankStatementSource,
  type UploadStatementResult,
} from '@/lib/api';
import AssignWizard from '@/components/banking/AssignWizard';

function formatAmount(minor: number, currency: string): string {
  const factor = ['VND', 'JPY', 'KRW'].includes(currency) ? 1 : 100;
  return (minor / factor).toLocaleString('en-US', {
    minimumFractionDigits: factor === 1 ? 0 : 2,
    maximumFractionDigits: factor === 1 ? 0 : 2,
  });
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  Executed:        { bg: 'rgba(229,32,44,0.10)', fg: '#A82029' },
  Received:        { bg: 'rgba(46,125,79,0.10)', fg: '#2E7D4F' },
  PayReceived:     { bg: 'rgba(46,125,79,0.10)', fg: '#2E7D4F' },
  SendToBank:      { bg: 'rgba(125,72,28,0.10)', fg: '#7D481C' },
  Draft:           { bg: 'var(--paper-sunk)',    fg: 'var(--fg-3)' },
  RejectByBank:    { bg: 'rgba(229,32,44,0.10)', fg: '#A82029' },
  Canceled:        { bg: 'var(--paper-sunk)',    fg: 'var(--fg-3)' },
};

const ENTITY_OPTIONS: Array<{ id: 'dee' | 'dei' | 'dasean' | 'dec'; label: string }> = [
  { id: 'dee',    label: 'DEE — Das Experten Eurasia LLC' },
  { id: 'dei',    label: 'DEI — Das Experten International LLC' },
  { id: 'dasean', label: 'DEASEAN — Das Experten ASEAN' },
  { id: 'dec',    label: 'DEC — Das Experten Corporation' },
];

// =============================================================================
// MODAL: Add Source
// =============================================================================
function AddSourceModal({
  open, onClose, onCreated,
}: {
  open: boolean; onClose: () => void; onCreated: () => void;
}) {
  const [sourceType, setSourceType] = useState<'email_inbox' | 'telegram_contact'>('email_inbox');
  const [address, setAddress] = useState('');
  const [companyId, setCompanyId] = useState<'dee' | 'dei' | 'dasean' | 'dec'>('dee');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const placeholder = sourceType === 'email_inbox'
    ? 'bank-statements@dasexperten.ru'
    : '@username, +phone, or paste t.me link';

  const description = sourceType === 'email_inbox'
    ? 'Email inbox where bank sends statements. Linked to entity for auto-import.'
    : 'Telegram contact who forwards bank statements as attachments. Linked to entity for auto-import.';

  const submit = async () => {
    const a = address.trim();
    if (!a) {
      setError(sourceType === 'email_inbox' ? 'Email is required' : 'Telegram handle is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await createBankStatementSource({
        source_type: sourceType,
        address: a,
        company_id: companyId,
      });
      if (res.success) {
        setAddress('');
        setSourceType('email_inbox');
        setCompanyId('dee');
        onCreated();
        onClose();
      } else {
        setError(res.errors?.[0]?.message ?? 'Failed to create source');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  };


  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(15,15,15,0.50)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--paper)', borderRadius: 'var(--radius-md)',
          padding: '24px', width: '480px', maxWidth: '90vw',
          border: '1px solid var(--line-1)',
          boxShadow: '0 8px 24px rgba(15,15,15,0.12)',
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 style={{
              fontFamily: 'Plus Jakarta Sans, sans-serif',
              fontSize: '18px', fontWeight: 700, color: 'var(--fg-1)',
              textTransform: 'uppercase', letterSpacing: 0, marginBottom: '4px',
            }}>
              Add Source
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>{description}</p>
          </div>
          <button onClick={onClose} style={{ color: 'var(--fg-3)' }}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Source-type picker */}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={() => { setSourceType('email_inbox'); setError(null); }}
              style={{
                flex: 1,
                padding: '8px 12px',
                fontSize: '14px',
                fontWeight: 700,
                border: '1px solid ' + (sourceType === 'email_inbox' ? 'var(--fg-1)' : 'var(--line-1)'),
                background: sourceType === 'email_inbox' ? 'var(--fg-1)' : 'var(--paper)',
                color: sourceType === 'email_inbox' ? 'var(--paper)' : 'var(--fg-2)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <Mail className="h-4 w-4" />
              Email inbox
            </button>
            <button
              type="button"
              onClick={() => { setSourceType('telegram_contact'); setError(null); }}
              style={{
                flex: 1,
                padding: '8px 12px',
                fontSize: '14px',
                fontWeight: 700,
                border: '1px solid ' + (sourceType === 'telegram_contact' ? 'var(--fg-1)' : 'var(--line-1)'),
                background: sourceType === 'telegram_contact' ? 'var(--fg-1)' : 'var(--paper)',
                color: sourceType === 'telegram_contact' ? 'var(--paper)' : 'var(--fg-2)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M21.5 4.5L2.5 11.5c-.8.3-.8 1.4 0 1.7l4.6 1.6 1.7 5.4c.2.6 1 .8 1.4.3l2.5-2.6 4.7 3.4c.6.4 1.3.1 1.5-.6l3.4-15c.2-.7-.5-1.4-1.3-1.2zM9.5 14.6l8.4-6.7-7.1 7.4-1.3 4.1-.9-3.2L9.5 14.6z"/>
              </svg>
              Telegram
            </button>
          </div>

          <div>
            <label style={{
              display: 'block', fontSize: '14px', fontWeight: 700,
              color: 'var(--fg-2)', marginBottom: '6px',
            }}>
              {sourceType === 'email_inbox' ? (
                <>
                  <Mail className="h-4 w-4 inline mr-1" />
                  Email
                </>
              ) : (
                <>Contact (Telegram @username or +phone)</>
              )}
            </label>
            <input
              type={sourceType === 'email_inbox' ? 'email' : 'text'}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={placeholder}
              style={{
                width: '100%', border: '1px solid var(--line-1)',
                borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper)',
                padding: '8px 12px', fontSize: '14px', fontWeight: 700,
                color: 'var(--fg-1)',
              }}
            />
            {sourceType === 'telegram_contact' && (
              <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: 4 }}>
                Accepts: @username · +phone · t.me link (whole group or specific topic) · -100GROUP_ID · -100GROUP#TOPIC. Auto-ingest of .pdf/.csv/.xlsx.
              </div>
            )}
          </div>

          <div>
            <label style={{
              display: 'block', fontSize: '14px', fontWeight: 700,
              color: 'var(--fg-2)', marginBottom: '6px',
            }}>
              <Building2 className="h-4 w-4 inline mr-1" />
              Entity
            </label>
            <select
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value as 'dee' | 'dei' | 'dasean' | 'dec')}
              style={{
                width: '100%', border: '1px solid var(--line-1)',
                borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper)',
                padding: '8px 12px', fontSize: '14px', fontWeight: 700,
                color: 'var(--fg-1)',
              }}
            >
              <option value="dee">DEE — Das Experten Eurasia LLC</option>
              <option value="dei">DEI — Das Experten International LLC</option>
              <option value="dasean">DASEAN — Das Experten ASEAN</option>
              <option value="dec">DEC — Das Experten Crypto</option>
            </select>
          </div>

          {error && (
            <div style={{ color: 'var(--status-danger)', fontSize: '14px', fontWeight: 700 }}>
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              style={{
                padding: '8px 16px', fontSize: '14px', fontWeight: 700,
                color: 'var(--fg-2)', background: 'transparent',
                border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              style={{
                padding: '8px 16px', fontSize: '14px', fontWeight: 700,
                color: 'var(--paper)', background: 'var(--fg-1)',
                border: '1px solid var(--fg-1)', borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function UploadStatementModal({
  open, onClose, onImported,
}: {
  open: boolean; onClose: () => void; onImported?: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [companyId, setCompanyId] = useState<'dee' | 'dei' | 'dasean' | 'dec'>('dee');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<UploadStatementResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) setFile(dropped);
  };

  const handleClose = () => {
    setFile(null);
    setResult(null);
    setError(null);
    setImporting(false);
    onClose();
  };

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const res = await uploadBankStatement(file, companyId);
      if (res.success && res.result) {
        setResult(res.result);
        if (onImported) onImported();
      } else {
        setError(res.errors?.[0]?.message ?? 'Upload failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div
      onClick={handleClose}
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(15,15,15,0.50)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--paper)', borderRadius: 'var(--radius-md)',
          padding: '24px', width: '520px', maxWidth: '90vw',
          border: '1px solid var(--line-1)',
          boxShadow: '0 8px 24px rgba(15,15,15,0.12)',
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 style={{
              fontFamily: 'Plus Jakarta Sans, sans-serif',
              fontSize: '18px', fontWeight: 700, color: 'var(--fg-1)',
              textTransform: 'uppercase', letterSpacing: 0, marginBottom: '4px',
            }}>
              Upload Bank Statement
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
              Drop a CSV, Excel, or PDF statement file. Parsing will run on next step.
            </p>
          </div>
          <button onClick={handleClose} style={{ color: 'var(--fg-3)' }}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <div
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          style={{
            border: `2px dashed ${dragOver ? 'var(--fg-1)' : 'var(--line-1)'}`,
            borderRadius: 'var(--radius-md)',
            backgroundColor: dragOver ? 'var(--paper-sunk)' : 'var(--paper)',
            padding: '48px 24px', textAlign: 'center',
            transition: 'all 150ms ease',
          }}
        >
          <Upload className="h-8 w-8 mx-auto mb-3" style={{ color: 'var(--fg-3)' }} />
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', marginBottom: '8px' }}>
            {file ? file.name : 'Drop file here or click to browse'}
          </div>
          {file && (
            <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '12px' }}>
              {(file.size / 1024).toFixed(1)} KB
            </div>
          )}
          <input
            type="file"
            accept=".csv,.pdf,.xlsx,.xls,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/pdf,text/csv,text/plain"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ display: 'none' }}
            id="statement-file-input"
          />
          <label
            htmlFor="statement-file-input"
            style={{
              display: 'inline-block', padding: '8px 16px',
              border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)', color: 'var(--fg-1)',
              fontSize: '14px', fontWeight: 700, cursor: 'pointer',
            }}
          >
            Browse
          </label>
        </div>

        {/* Entity selector */}
        <div style={{ marginTop: '12px', marginBottom: '12px' }}>
          <label style={{ fontSize: '14px', color: 'var(--fg-2)', fontWeight: 700, display: 'block', marginBottom: '4px' }}>
            Entity (hint for account matching)
          </label>
          <select
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value as 'dee' | 'dei' | 'dasean' | 'dec')}
            style={{
              width: '100%', padding: '8px 12px', fontSize: '14px', fontWeight: 700,
              border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)', color: 'var(--fg-1)',
            }}
          >
            {ENTITY_OPTIONS.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            marginTop: '12px', padding: '12px',
            border: '1px solid var(--status-danger)', borderRadius: 'var(--radius-sm)',
            backgroundColor: 'rgba(229,32,44,0.10)', color: '#A82029',
            fontSize: '14px', fontWeight: 700,
          }}>
            {error}
          </div>
        )}

        {/* Result panel */}
        {result && (
          <div style={{
            marginTop: '12px', padding: '12px',
            backgroundColor: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)',
            fontSize: '14px', color: 'var(--fg-1)',
          }}>
            <div style={{ fontWeight: 700, marginBottom: '8px', textTransform: 'uppercase' }}>
              Import summary
            </div>
            <div style={{ display: 'grid', gap: '4px' }}>
              <div><span style={{ color: 'var(--fg-2)' }}>File:</span> <span style={{ fontWeight: 700 }}>{result.filename}</span></div>
              {result.account_number && (
                <div><span style={{ color: 'var(--fg-2)' }}>Account:</span> <span style={{ fontWeight: 700 }}>{result.account_number}</span></div>
              )}
              {result.period_from && result.period_to && (
                <div><span style={{ color: 'var(--fg-2)' }}>Period:</span> <span style={{ fontWeight: 700 }}>{result.period_from} → {result.period_to}</span></div>
              )}
              <div>
                <span style={{ color: 'var(--fg-2)' }}>Parsed:</span> <span style={{ fontWeight: 700 }}>{result.summary.total}</span>{' · '}
                <span style={{ color: 'var(--fg-2)' }}>Inserted:</span> <span style={{ fontWeight: 700, color: 'var(--status-success)' }}>{result.summary.inserted}</span>{' · '}
                <span style={{ color: 'var(--fg-2)' }}>Skipped:</span> <span style={{ fontWeight: 700 }}>{result.summary.skipped}</span>{' · '}
                <span style={{ color: 'var(--fg-2)' }}>Errors:</span> <span style={{ fontWeight: 700, color: result.summary.errors > 0 ? 'var(--status-danger)' : 'var(--fg-1)' }}>{result.summary.errors}</span>
              </div>
              <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px' }}>
                Match: <span style={{ fontWeight: 700 }}>{result.summary.account_match_method}</span>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-6">
          {result ? (
            <button
              onClick={handleClose}
              style={{
                padding: '8px 16px', borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--fg-1)', color: 'var(--paper)',
                fontSize: '14px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              Done
            </button>
          ) : (
            <>
              <button
                onClick={handleClose}
                style={{
                  padding: '8px 16px', border: '1px solid var(--line-1)',
                  borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper)',
                  color: 'var(--fg-1)', fontSize: '14px', fontWeight: 700,
                }}
              >
                Cancel
              </button>
              <button
                disabled={!file || importing}
                onClick={handleImport}
                style={{
                  padding: '8px 16px', borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'var(--fg-1)', color: 'var(--paper)',
                  fontSize: '14px', fontWeight: 700,
                  opacity: file && !importing ? 1 : 0.4,
                  cursor: file && !importing ? 'pointer' : 'not-allowed',
                  display: 'inline-flex', alignItems: 'center', gap: '8px',
                }}
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {importing ? 'Parsing & importing...' : 'Import'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MODAL: Manage Sources (list + delete)
// =============================================================================
function SourcesListModal({
  open, onClose, sources, onRefresh,
}: {
  open: boolean; onClose: () => void;
  sources: BankStatementSource[]; onRefresh: () => void;
}) {
  if (!open) return null;

  const remove = async (id: string) => {
    if (!confirm('Remove this source?')) return;
    await deleteBankStatementSource(id);
    onRefresh();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(15,15,15,0.50)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--paper)', borderRadius: 'var(--radius-md)',
          padding: '24px', width: '560px', maxWidth: '90vw', maxHeight: '80vh',
          overflowY: 'auto', border: '1px solid var(--line-1)',
          boxShadow: '0 8px 24px rgba(15,15,15,0.12)',
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <h2 style={{
            fontFamily: 'Plus Jakarta Sans, sans-serif',
            fontSize: '18px', fontWeight: 700, color: 'var(--fg-1)',
            textTransform: 'uppercase', letterSpacing: 0,
          }}>
            Bank Statement Sources
          </h2>
          <button onClick={onClose} style={{ color: 'var(--fg-3)' }}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {sources.length === 0 ? (
          <div style={{ fontSize: '14px', color: 'var(--fg-2)', padding: '16px 0' }}>
            No sources yet. Add one via the + Add Source button.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line-1)' }}>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--fg-2)', fontWeight: 700, width: '110px' }}>Type</th>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--fg-2)', fontWeight: 700 }}>Address</th>
                <th style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--fg-2)', fontWeight: 700 }}>Entity</th>
                <th style={{ width: '40px' }}></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--line-1)' }}>
                  <td style={{ padding: '12px', color: 'var(--fg-2)', fontWeight: 700 }}>
                    {s.source_type === 'telegram_contact' ? 'Telegram' : 'Email'}
                  </td>
                  <td style={{ padding: '12px', color: 'var(--fg-1)', fontWeight: 700 }}>{s.address ?? s.email}</td>
                  <td style={{ padding: '12px', color: 'var(--fg-1)', fontWeight: 700 }}>{s.company_abbreviation}</td>
                  <td style={{ padding: '12px', textAlign: 'center' }}>
                    <button onClick={() => remove(s.id)} style={{ color: 'var(--fg-3)' }}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================
export default function FinanceTransactionsPage() {
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [assignTx, setAssignTx] = useState<BankTransaction | null>(null);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [sources, setSources] = useState<BankStatementSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [directionFilter, setDirectionFilter] = useState<'all' | 'incoming' | 'outgoing'>('all');
  const [matchedFilter, setMatchedFilter] = useState<'all' | 'matched' | 'unmatched'>('all');
  const [search, setSearch] = useState('');

  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [sourcesListOpen, setSourcesListOpen] = useState(false);

  const reloadSources = async () => {
    const r = await getBankStatementSources();
    if (r.success && r.result) setSources(r.result.sources);
  };

  useEffect(() => {
    const load = async () => {
      try {
        const [txRes, accRes, srcRes] = await Promise.all([
          getBankTransactions({ limit: 200 }),
          getBankAccounts(),
          getBankStatementSources(),
        ]);
        if (txRes.success && txRes.result) setTransactions(txRes.result.transactions);
        if (accRes.success && accRes.result) setAccounts(accRes.result.accounts);
        if (srcRes.success && srcRes.result) setSources(srcRes.result.sources);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const refreshAll = async () => {
    try {
      const [txRes, accRes] = await Promise.all([
        getBankTransactions({ limit: 200 }),
        getBankAccounts(),
      ]);
      if (txRes.success && txRes.result) setTransactions(txRes.result.transactions);
      if (accRes.success && accRes.result) setAccounts(accRes.result.accounts);
    } catch (e) {
      console.error('refreshAll failed', e);
    }
  };

  const filtered = useMemo(() => {
    return transactions.filter((tx) => {
      if (accountFilter !== 'all' && tx.company_bank_account_id !== accountFilter) return false;
      if (directionFilter !== 'all' && tx.direction !== directionFilter) return false;
      // 3-state rule (CEMENTED 2026-05-28): match_status comes from v_bank_tx_status.
      // 'matched' = attached to op. 'pending' = INN has history of matches, this row waits.
      // 'assign' = no history → human action. Filter chip 'unmatched' = Assign only.
      if (matchedFilter === 'matched' && tx.match_status !== 'matched') return false;
      if (matchedFilter === 'unmatched' && tx.match_status !== 'assign') return false;
      if (search) {
        const q = search.toLowerCase();
        const haystack = [
          tx.contragent_name, tx.contragent_inn, tx.payment_purpose,
          tx.external_doc_number, tx.account_number,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [transactions, accountFilter, directionFilter, matchedFilter, search]);

  const totals = useMemo(() => {
    const incoming = filtered
      .filter((t) => t.direction === 'incoming')
      .reduce((acc, t) => { acc[t.currency] = (acc[t.currency] ?? 0) + t.amount; return acc; }, {} as Record<string, number>);
    const outgoing = filtered
      .filter((t) => t.direction === 'outgoing')
      .reduce((acc, t) => { acc[t.currency] = (acc[t.currency] ?? 0) + t.amount; return acc; }, {} as Record<string, number>);
    return { incoming, outgoing };
  }, [filtered]);

  return (
    <div className="px-8 py-6 max-w-screen-2xl">
      <div className="mb-6 flex items-end justify-between gap-4 flex-wrap">
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
            Transactions
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            Bank movements from connected accounts. Match status indicates whether the transaction has been linked to a payment in ERP.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setSourcesListOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2"
            style={{
              border: '1px solid var(--line-1)',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)',
              color: 'var(--fg-2)',
              fontSize: '14px',
              fontWeight: 700,
            }}
            title="Manage existing sources"
          >
            {sources.length} {sources.length === 1 ? 'source' : 'sources'}
          </button>

          <button
            onClick={() => setAddSourceOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2"
            style={{
              border: '1px solid var(--line-1)',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)',
              color: 'var(--fg-1)',
              fontSize: '14px',
              fontWeight: 700,
            }}
          >
            <Plus className="h-4 w-4" />
            Add Source
          </button>

          <button
            onClick={() => setUploadOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2"
            style={{
              border: '1px solid var(--line-1)',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--fg-1)',
              color: 'var(--paper)',
              fontSize: '14px',
              fontWeight: 700,
            }}
          >
            <Upload className="h-4 w-4" />
            Upload Bank Statement
          </button>
        </div>
      </div>

      {!loading && (
        <div className="mb-4 flex flex-wrap gap-3">
          {Object.entries(totals.incoming).map(([cur, amt]) => (
            <div key={`in-${cur}`} className="px-4 py-3" style={{
              border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)', minWidth: '180px',
            }}>
              <div className="flex items-center gap-1" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                <ArrowDownLeft className="h-4 w-4" style={{ color: 'var(--status-success)' }} />
                Incoming {cur}
              </div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--fg-1)', marginTop: '4px' }}>
                {formatAmount(amt, cur)}
              </div>
            </div>
          ))}
          {Object.entries(totals.outgoing).map(([cur, amt]) => (
            <div key={`out-${cur}`} className="px-4 py-3" style={{
              border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)', minWidth: '180px',
            }}>
              <div className="flex items-center gap-1" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                <ArrowUpRight className="h-4 w-4" style={{ color: 'var(--status-danger)' }} />
                Outgoing {cur}
              </div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--fg-1)', marginTop: '4px' }}>
                {formatAmount(amt, cur)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4" style={{ color: 'var(--fg-3)' }} />
          <input
            type="text"
            placeholder="Search counterparty, INN, purpose..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--paper)', padding: '8px 12px 8px 36px',
              fontSize: '14px', fontWeight: 700, width: '320px', color: 'var(--fg-1)',
            }}
          />
        </div>

        <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)} style={{
          border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
          backgroundColor: 'var(--paper)', padding: '8px 12px',
          fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)',
        }}>
          <option value="all">All accounts</option>
          {accounts.map((acc) => (
            <option key={acc.id} value={acc.id}>
              {acc.company_abbreviation} {acc.currency} — {acc.account_number}
            </option>
          ))}
        </select>

        {/* Chip filter — replaces direction + matched selects. Single source of truth: chipFilter. */}
        {(() => {
          // Map chip → (direction, matched) — set both via existing state setters
          const chips: Array<{ id: 'all' | 'incoming' | 'outgoing' | 'unmatched'; label: string }> = [
            { id: 'all',        label: 'All' },
            { id: 'incoming',   label: 'Incoming' },
            { id: 'outgoing',   label: 'Outgoing' },
            { id: 'unmatched',  label: 'Unmatched' },
          ];
          // Derive current chip from existing filter state
          let activeChip: typeof chips[number]['id'] = 'all';
          if (matchedFilter === 'unmatched') activeChip = 'unmatched';
          else if (directionFilter === 'incoming') activeChip = 'incoming';
          else if (directionFilter === 'outgoing') activeChip = 'outgoing';
          const setChip = (id: typeof chips[number]['id']) => {
            if (id === 'unmatched') {
              setDirectionFilter('all');
              setMatchedFilter('unmatched');
            } else {
              setDirectionFilter(id as 'all' | 'incoming' | 'outgoing');
              setMatchedFilter('all');
            }
          };
          return chips.map((chip) => {
            const isActive = activeChip === chip.id;
            return (
              <button
                key={chip.id}
                type="button"
                onClick={() => setChip(chip.id)}
                style={{
                  border: '1px solid var(--line-1)',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: isActive ? 'var(--fg-1)' : 'var(--paper)',
                  color: isActive ? 'var(--paper)' : 'var(--fg-1)',
                  padding: '8px 14px',
                  fontSize: '14px',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                {chip.label}
                {chip.id === 'unmatched' && (
                  <span style={{
                    marginLeft: '6px',
                    backgroundColor: isActive ? 'var(--paper)' : 'var(--paper-sunk)',
                    color: isActive ? 'var(--fg-1)' : 'var(--fg-2)',
                    padding: '1px 7px',
                    borderRadius: '999px',
                    fontSize: '12px',
                    fontWeight: 700,
                  }}>
                    {transactions.filter((t) => t.match_status === 'assign').length}
                  </span>
                )}
              </button>
            );
          });
        })()}

        <div style={{ fontSize: '14px', color: 'var(--fg-2)', marginLeft: 'auto' }}>
          {filtered.length} of {transactions.length}
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2" style={{ color: 'var(--fg-2)' }}>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span style={{ fontSize: '14px' }}>Loading transactions...</span>
        </div>
      )}

      {error && <div style={{ color: 'var(--status-danger)', fontSize: '14px' }}>Error: {error}</div>}

      {!loading && filtered.length > 0 && (
        <div style={{
          border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--paper-sunk)', borderBottom: '1px solid var(--line-1)' }}>
                <th style={{ textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700, width: '110px' }}>Date</th>
                <th style={{ textAlign: 'center', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700, width: '60px' }}>Dir</th>
                <th style={{ textAlign: 'right', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700, width: '160px' }}>Amount</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700 }}>Counterparty</th>
                <th style={{ textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700 }}>Purpose</th>
                <th style={{ textAlign: 'center', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700, width: '100px' }}>Status</th>
                <th style={{ textAlign: 'center', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700, width: '80px' }}>Match</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tx) => {
                const statusStyle = STATUS_COLORS[tx.status] ?? { bg: 'var(--paper-sunk)', fg: 'var(--fg-2)' };
                return (
                  <tr key={tx.id} style={{ borderBottom: '1px solid var(--line-1)' }}>
                    <td style={{ padding: '12px 16px', color: 'var(--fg-1)' }}>{formatDate(tx.executed_at)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                      {tx.direction === 'incoming'
                        ? <ArrowDownLeft className="h-4 w-4 inline" style={{ color: 'var(--status-success)' }} />
                        : <ArrowUpRight className="h-4 w-4 inline" style={{ color: 'var(--status-danger)' }} />}
                    </td>
                    <td style={{
                      padding: '12px 16px', textAlign: 'right', fontWeight: 700,
                      color: tx.direction === 'incoming' ? 'var(--status-success)' : 'var(--fg-1)',
                      fontFamily: 'Manrope, sans-serif',
                    }}>
                      {tx.direction === 'incoming' ? '+' : '−'}{formatAmount(tx.amount, tx.currency)} {tx.currency}
                    </td>
                    <td style={{ padding: '12px 16px', color: 'var(--fg-1)' }}>
                      <div style={{ fontWeight: 700 }}>{tx.contragent_name ?? '—'}</div>
                      {tx.contragent_inn && (
                        <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '2px' }}>
                          INN {tx.contragent_inn}
                        </div>
                      )}
                    </td>
                    <td style={{
                      padding: '12px 16px', color: 'var(--fg-2)',
                      maxWidth: '400px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} title={tx.payment_purpose ?? undefined}>
                      {tx.payment_purpose ?? '—'}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                      <span style={{
                        backgroundColor: statusStyle.bg, color: statusStyle.fg,
                        padding: '2px 8px', borderRadius: 'var(--radius-sm)',
                        fontSize: '14px', fontWeight: 700,
                      }}>
                        {tx.status}
                      </span>
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                      {tx.match_status === 'matched' ? (
                        <CheckCircle2 size={16} style={{ color: '#3B6D11' }} />
                      ) : tx.match_status === 'pending' ? (
                        <span
                          title="INN has history of matches; this payment waits for its operation (e.g. monthly report/act)"
                          style={{
                            fontSize: '12px',
                            fontWeight: 500,
                            color: '#854F0B',
                            background: 'rgba(186,117,23,0.14)',
                            padding: '3px 10px',
                            borderRadius: 'var(--radius-md, 6px)',
                            cursor: 'help',
                          }}
                        >
                          Pending
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setAssignTx(tx)}
                          title="Assign to operation"
                          style={{
                            fontSize: '12px',
                            fontWeight: 500,
                            color: '#A32D2D',
                            background: 'rgba(163,45,45,0.14)',
                            padding: '3px 10px',
                            borderRadius: 'var(--radius-md, 6px)',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          Assign
                        </button>
                      )} />
                        : (
                          <button
                            type="button"
                            onClick={() => setAssignTx(tx)}
                            title="Assign to operation"
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: '4px',
                              padding: '4px 8px', borderRadius: 'var(--radius-sm)',
                              border: '1px solid var(--line-1)',
                              fontSize: '14px', fontWeight: 700,
                              color: 'var(--fg-1)', background: 'transparent', cursor: 'pointer',
                            }}
                          >
                            <AlertCircle className="h-3 w-3" style={{ color: '#A82029' }} />
                            Assign
                          </button>
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && filtered.length === 0 && transactions.length > 0 && (
        <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>No transactions match your filters.</div>
      )}

      {!loading && transactions.length === 0 && (
        <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
          No transactions yet. Run a sync from Bank Reference page to pull history.
        </div>
      )}

      <AddSourceModal
        open={addSourceOpen}
        onClose={() => setAddSourceOpen(false)}
        onCreated={reloadSources}
      />
      <UploadStatementModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onImported={refreshAll}
      />
      <SourcesListModal
        open={sourcesListOpen}
        onClose={() => setSourcesListOpen(false)}
        sources={sources}
        onRefresh={reloadSources}
      />
      {assignTx && (
        <div
          onClick={() => setAssignTx(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 80,
            background: 'rgba(15,15,15,0.5)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '64px 24px 24px',
            overflowY: 'auto',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '720px', maxWidth: '95vw',
              background: 'var(--paper-base, #fff)',
              borderRadius: 'var(--radius-md, 6px)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
            }}
          >
            <AssignWizard
              item={{
                id: assignTx.id,
                direction: assignTx.direction,
                amount: assignTx.amount,
                currency: assignTx.currency,
                executed_at: assignTx.executed_at,
                contragent_name: assignTx.contragent_name ?? '',
                contragent_inn: assignTx.contragent_inn ?? '',
                payment_purpose: assignTx.payment_purpose ?? '',
              }}
              onResolved={() => {
                setAssignTx(null);
                void (async () => {
                  const r = await getBankTransactions();
                  if (r.success && r.result) setTransactions(r.result.transactions);
                })();
              }}
              onCancel={() => setAssignTx(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
