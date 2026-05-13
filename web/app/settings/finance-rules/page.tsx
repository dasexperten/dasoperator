'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Plus, X, Loader2, Trash2, Pencil, FileSliders, Check,
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight, Beaker,
} from 'lucide-react';
import {
  getFinanceCategories, getBankMatchRules, createBankMatchRule, deleteBankMatchRule,
  previewRuleClassification,
  type FinanceCategory, type BankMatchRule,
} from '@/lib/api';

const DIRECTION_ICONS: Record<string, any> = {
  incoming: ArrowDownLeft,
  outgoing: ArrowUpRight,
  any: ArrowLeftRight,
};

export default function FinanceRulesPage() {
  const [rules, setRules] = useState<BankMatchRule[]>([]);
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [testOpen, setTestOpen] = useState(false);

  const load = async () => {
    try {
      const [rRes, cRes] = await Promise.all([getBankMatchRules(), getFinanceCategories()]);
      if (rRes.success && rRes.result) setRules(rRes.result.rules);
      if (cRes.success && cRes.result) setCategories(cRes.result.categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const categoryMap: Record<string, FinanceCategory> = {};
  categories.forEach((c) => { categoryMap[c.id] = c; });

  return (
    <div className="px-8 py-6 max-w-screen-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/settings" className="inline-flex items-center gap-1 mb-2" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            <ArrowLeft className="h-4 w-4" /> Settings
          </Link>
          <h1 style={{
            fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '24px',
            fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase', marginBottom: '4px',
          }}>
            Finance Rules
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            {rules.length} rules · classify transactions by counterparty + purpose pattern → category
          </p>
        </div>

        <div className="flex gap-2">
          <button onClick={() => setTestOpen(true)} style={btnSecondary}>
            <Beaker className="h-4 w-4 inline mr-1" /> Test classifier
          </button>
          <button onClick={() => setCreating(true)} style={btnPrimary}>
            <Plus className="h-4 w-4" />
            Add Rule
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2" style={{ color: 'var(--fg-2)' }}>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span style={{ fontSize: '14px' }}>Loading...</span>
        </div>
      )}
      {error && <div style={{ color: 'var(--status-danger)', fontSize: '14px', marginBottom: '12px' }}>Error: {error}</div>}

      {!loading && rules.length === 0 && (
        <div style={{
          padding: '32px', textAlign: 'center', fontSize: '14px', color: 'var(--fg-2)',
          border: '1px dashed var(--line-1)', borderRadius: 'var(--radius-md)',
        }}>
          No rules yet. Rules can also be created in <b>Inbox → Banking</b> after manually assigning a transaction.
        </div>
      )}

      {!loading && rules.length > 0 && (
        <div style={{
          border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--paper-sunk)', borderBottom: '1px solid var(--line-1)' }}>
                <th style={th}>Category</th>
                <th style={th}>Match by</th>
                <th style={th}>Partner</th>
                <th style={{ ...th, textAlign: 'center' }}>Dir</th>
                <th style={{ ...th, textAlign: 'right' }}>Hits</th>
                <th style={{ ...th, width: '60px' }}></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const cat = r.category_id ? categoryMap[r.category_id] : null;
                const DirIcon = DIRECTION_ICONS[r.direction];
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--line-1)' }}>
                    <td style={td}>
                      <div className="flex items-center gap-2">
                        {cat?.color && (
                          <span style={{
                            width: '10px', height: '10px', borderRadius: '50%',
                            backgroundColor: cat.color, display: 'inline-block', flexShrink: 0,
                          }} />
                        )}
                        <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>
                          {cat?.label || r.category_label || '(deleted)'}
                        </span>
                      </div>
                    </td>
                    <td style={td}>
                      <div style={{ display: 'grid', gap: '2px', fontSize: '14px' }}>
                        {r.contragent_inn && (
                          <div><span style={{ color: 'var(--fg-3)' }}>INN:</span> <span style={{ fontWeight: 700 }}>{r.contragent_inn}</span></div>
                        )}
                        {r.contragent_iban && (
                          <div><span style={{ color: 'var(--fg-3)' }}>IBAN:</span> <span style={{ fontWeight: 700 }}>{r.contragent_iban}</span></div>
                        )}
                        {r.purpose_pattern && (
                          <div><span style={{ color: 'var(--fg-3)' }}>Purpose contains:</span> <span style={{ fontWeight: 700, fontFamily: 'Manrope, monospace' }}>"{r.purpose_pattern}"</span></div>
                        )}
                        {!r.contragent_inn && !r.contragent_iban && !r.purpose_pattern && (
                          <span style={{ color: 'var(--fg-3)' }}>—</span>
                        )}
                      </div>
                    </td>
                    <td style={td}>
                      <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>
                        {r.partner_name || (r.partner_id ? `(${r.partner_id.slice(0, 8)})` : '—')}
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      {DirIcon && <DirIcon className="h-4 w-4 inline" style={{ color: 'var(--fg-2)' }} />}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{r.hit_count}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button
                        onClick={async () => {
                          if (!confirm('Delete this rule?')) return;
                          await deleteBankMatchRule(r.id);
                          load();
                        }}
                        style={{ ...iconBtn, color: 'var(--status-danger)' }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <RuleEditor categories={categories} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />
      )}

      {testOpen && (
        <ClassifierTestDialog onClose={() => setTestOpen(false)} categories={categories} />
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700, fontSize: '14px' };
const td: React.CSSProperties = { padding: '12px 16px', color: 'var(--fg-1)' };
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-2)', padding: '4px' };

function RuleEditor({ categories, onClose, onSaved }: {
  categories: FinanceCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [categoryId, setCategoryId] = useState('');
  const [inn, setInn] = useState('');
  const [iban, setIban] = useState('');
  const [pattern, setPattern] = useState('');
  const [direction, setDirection] = useState<'incoming' | 'outgoing' | 'any'>('outgoing');
  const [partnerId, setPartnerId] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const res = await createBankMatchRule({
        category_id: categoryId,
        contragent_inn: inn || null,
        contragent_iban: iban || null,
        purpose_pattern: pattern || null,
        direction,
        partner_id: partnerId || null,
      } as any);
      if (res.success) onSaved();
      else setErr(res.errors?.[0]?.message ?? 'Save failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network');
    } finally {
      setSaving(false);
    }
  };

  const hasAnyMatcher = inn || iban || pattern;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(15,15,15,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '24px',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        backgroundColor: 'var(--paper)', borderRadius: 'var(--radius-md)',
        border: '1px solid var(--line-1)', padding: '24px',
        width: '560px', maxWidth: '95vw',
      }}>
        <div className="flex items-center justify-between mb-4">
          <h2 style={{
            fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '20px',
            fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase',
          }}>
            New Rule
          </h2>
          <button onClick={onClose} style={{ color: 'var(--fg-3)' }}><X className="h-5 w-5" /></button>
        </div>

        <div style={{ display: 'grid', gap: '12px' }}>
          <Field label="Category">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={input}>
              <option value="">— Select category —</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </Field>

          <div style={{ padding: '12px', backgroundColor: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)', fontSize: '14px', color: 'var(--fg-2)' }}>
            <b>At least one matcher required.</b> Fill what makes this rule unique:
          </div>

          <Field label="Counterparty INN (for Russian counterparties)">
            <input type="text" value={inn} onChange={(e) => setInn(e.target.value)} style={input} placeholder="e.g. 9704117379" />
          </Field>
          <Field label="Counterparty IBAN (for foreign counterparties)">
            <input type="text" value={iban} onChange={(e) => setIban(e.target.value)} style={input} placeholder="e.g. AE040860000009012819406" />
          </Field>
          <Field label='Payment purpose substring (e.g. "Accounting Services")'>
            <input type="text" value={pattern} onChange={(e) => setPattern(e.target.value)} style={input} />
          </Field>
          <Field label="Direction">
            <select value={direction} onChange={(e) => setDirection(e.target.value as any)} style={input}>
              <option value="any">Any</option>
              <option value="incoming">Incoming</option>
              <option value="outgoing">Outgoing</option>
            </select>
          </Field>
          <Field label="Partner ID (optional — links rule to existing partner for auto-attach)">
            <input type="text" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} style={input} placeholder="partner_..." />
          </Field>
        </div>

        {err && (
          <div style={{
            marginTop: '12px', padding: '12px',
            background: 'rgba(229,32,44,0.10)', color: '#A82029',
            borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700,
          }}>
            {err}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button
            onClick={save}
            disabled={saving || !categoryId || !hasAnyMatcher}
            style={{
              ...btnPrimary,
              opacity: (saving || !categoryId || !hasAnyMatcher) ? 0.5 : 1,
              cursor: (saving || !categoryId || !hasAnyMatcher) ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Create rule
          </button>
        </div>
      </div>
    </div>
  );
}

function ClassifierTestDialog({ onClose, categories }: { onClose: () => void; categories: FinanceCategory[] }) {
  const [inn, setInn] = useState('');
  const [iban, setIban] = useState('');
  const [purpose, setPurpose] = useState('');
  const [direction, setDirection] = useState<'incoming' | 'outgoing'>('outgoing');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const test = async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await previewRuleClassification({
        contragent_inn: inn || null,
        contragent_iban: iban || null,
        payment_purpose: purpose || null,
        direction,
      });
      setResult(res);
    } catch (e) {
      setResult({ success: false, errors: [{ message: String(e) }] });
    } finally {
      setLoading(false);
    }
  };

  const cat = result?.result?.category;
  const decision = result?.result?.decision;
  const classification = result?.result?.result;

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(15,15,15,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '24px',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        backgroundColor: 'var(--paper)', borderRadius: 'var(--radius-md)',
        border: '1px solid var(--line-1)', padding: '24px',
        width: '560px', maxWidth: '95vw',
      }}>
        <div className="flex items-center justify-between mb-4">
          <h2 style={{
            fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '20px',
            fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase',
          }}>
            Test classifier
          </h2>
          <button onClick={onClose} style={{ color: 'var(--fg-3)' }}><X className="h-5 w-5" /></button>
        </div>

        <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '16px' }}>
          Simulate a transaction and see what the classifier would do.
        </p>

        <div style={{ display: 'grid', gap: '12px' }}>
          <Field label="Counterparty INN"><input type="text" value={inn} onChange={(e) => setInn(e.target.value)} style={input} /></Field>
          <Field label="Counterparty IBAN"><input type="text" value={iban} onChange={(e) => setIban(e.target.value)} style={input} /></Field>
          <Field label="Payment purpose"><input type="text" value={purpose} onChange={(e) => setPurpose(e.target.value)} style={input} /></Field>
          <Field label="Direction">
            <select value={direction} onChange={(e) => setDirection(e.target.value as any)} style={input}>
              <option value="incoming">Incoming</option>
              <option value="outgoing">Outgoing</option>
            </select>
          </Field>
        </div>

        <div className="flex justify-end mt-4">
          <button onClick={test} disabled={loading} style={btnPrimary}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Beaker className="h-4 w-4" />}
            Run classifier
          </button>
        </div>

        {result && (
          <div style={{
            marginTop: '16px', padding: '16px',
            backgroundColor: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)', marginBottom: '8px', textTransform: 'uppercase' }}>
              Result
            </div>
            {!result.success && (
              <div style={{ color: 'var(--status-danger)', fontSize: '14px', fontWeight: 700 }}>
                {result.errors?.[0]?.message}
              </div>
            )}
            {result.success && (
              <div style={{ display: 'grid', gap: '6px', fontSize: '14px' }}>
                <div>
                  <span style={{ color: 'var(--fg-2)' }}>Action:</span>{' '}
                  <span style={{ fontWeight: 700, color: decision?.action === 'auto_classify' ? 'var(--status-success)' : 'var(--fg-1)' }}>
                    {decision?.action || 'none'}
                  </span>
                </div>
                {cat && (
                  <div>
                    <span style={{ color: 'var(--fg-2)' }}>Category:</span>{' '}
                    <span style={{ fontWeight: 700 }}>{cat.label}</span>
                  </div>
                )}
                {classification && (
                  <>
                    <div>
                      <span style={{ color: 'var(--fg-2)' }}>Confidence:</span>{' '}
                      <span style={{ fontWeight: 700 }}>{Math.round((classification.confidence ?? 0) * 100)}%</span>
                    </div>
                    <div>
                      <span style={{ color: 'var(--fg-2)' }}>Source:</span>{' '}
                      <span style={{ fontWeight: 700 }}>{classification.source || '—'}</span>
                    </div>
                    <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '4px', fontStyle: 'italic' }}>
                      {classification.reason}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: '14px', color: 'var(--fg-2)', fontWeight: 700, display: 'block', marginBottom: '4px' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const input: React.CSSProperties = {
  width: '100%', padding: '8px 12px', fontSize: '14px', fontWeight: 700,
  border: '1px solid var(--line-1)', borderRadius: 'var(--radius-sm)',
  backgroundColor: 'var(--paper)', color: 'var(--fg-1)',
};
const btnSecondary: React.CSSProperties = {
  padding: '8px 16px', border: '1px solid var(--line-1)',
  borderRadius: 'var(--radius-sm)', backgroundColor: 'var(--paper)',
  color: 'var(--fg-1)', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
};
const btnPrimary: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 'var(--radius-sm)',
  backgroundColor: 'var(--fg-1)', color: 'var(--paper)',
  fontSize: '14px', fontWeight: 700,
  display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
};
