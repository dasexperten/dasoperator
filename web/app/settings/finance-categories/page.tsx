'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Plus, X, Loader2, Tag, Trash2, Pencil, AlertTriangle, Check,
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight,
} from 'lucide-react';
import {
  getFinanceCategories, createFinanceCategory, updateFinanceCategory, deleteFinanceCategory,
  type FinanceCategory,
} from '@/lib/api';

const OPERATION_TYPES = [
  { value: 'sale',      label: 'Sale' },
  { value: 'purchase',  label: 'Purchase' },
  { value: 'transfer',  label: 'Transfer' },
  { value: 'bundling',  label: 'Bundling' },
] as const;

const DIRECTION_ICONS: Record<string, any> = {
  incoming: ArrowDownLeft,
  outgoing: ArrowUpRight,
  any: ArrowLeftRight,
};

export default function FinanceCategoriesPage() {
  const [categories, setCategories] = useState<FinanceCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    try {
      const res = await getFinanceCategories();
      if (res.success && res.result) setCategories(res.result.categories);
      else setError(res.errors?.[0]?.message ?? 'Load failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

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
            Finance Categories
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            {categories.length} categories. Used by the classifier to label transactions and route them to operations.
          </p>
        </div>

        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 px-4 py-2"
          style={{
            backgroundColor: 'var(--fg-1)', color: 'var(--paper)',
            borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700,
          }}
        >
          <Plus className="h-4 w-4" />
          Add Category
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2" style={{ color: 'var(--fg-2)' }}>
          <Loader2 className="h-4 w-4 animate-spin" />
          <span style={{ fontSize: '14px' }}>Loading...</span>
        </div>
      )}
      {error && <div style={{ color: 'var(--status-danger)', fontSize: '14px', marginBottom: '12px' }}>Error: {error}</div>}

      {!loading && categories.length > 0 && (
        <div style={{
          border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--paper)', overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--paper-sunk)', borderBottom: '1px solid var(--line-1)' }}>
                <th style={th}>Code</th>
                <th style={th}>Label</th>
                <th style={{ ...th, textAlign: 'center' }}>Direction</th>
                <th style={{ ...th, textAlign: 'center' }}>Type</th>
                <th style={{ ...th, textAlign: 'center' }}>Always confirm</th>
                <th style={{ ...th, textAlign: 'right' }}>Rules</th>
                <th style={{ ...th, textAlign: 'right' }}>Txs</th>
                <th style={{ ...th, width: '90px' }}></th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => {
                const DirIcon = DIRECTION_ICONS[c.direction];
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--line-1)' }}>
                    <td style={td}>
                      <span style={{
                        fontSize: '14px', color: 'var(--fg-3)', fontFamily: 'Manrope, monospace',
                      }}>{c.code}</span>
                    </td>
                    <td style={td}>
                      <div className="flex items-center gap-2">
                        {c.color && (
                          <span style={{
                            width: '10px', height: '10px', borderRadius: '50%',
                            backgroundColor: c.color, display: 'inline-block', flexShrink: 0,
                          }} />
                        )}
                        <div>
                          <div style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{c.label}</div>
                          {c.description && (
                            <div style={{ fontSize: '14px', color: 'var(--fg-3)', marginTop: '2px' }}>
                              {c.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      {DirIcon && <DirIcon className="h-4 w-4 inline" style={{ color: 'var(--fg-2)' }} />}
                      <span style={{ marginLeft: '4px', fontSize: '14px', color: 'var(--fg-2)' }}>{c.direction}</span>
                    </td>
                    <td style={{ ...td, textAlign: 'center', fontWeight: 700 }}>{c.default_operation_type}</td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      {c.always_confirm ? (
                        <span title="Always require manual confirmation" style={{ color: 'var(--status-warning, #7D481C)', fontWeight: 700 }}>
                          <AlertTriangle className="h-4 w-4 inline" /> Yes
                        </span>
                      ) : (
                        <span style={{ color: 'var(--fg-3)' }}>—</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{c.rule_count ?? 0}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{c.tx_count ?? 0}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button onClick={() => setEditingId(c.id)} style={iconBtn} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={async () => {
                          if (!confirm(`Delete category "${c.label}"?\n${c.rule_count ?? 0} rules and ${c.tx_count ?? 0} transactions reference it; their links will be cleared.`)) return;
                          await deleteFinanceCategory(c.id);
                          load();
                        }}
                        style={{ ...iconBtn, color: 'var(--status-danger)' }}
                        title="Delete"
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

      {(creating || editingId) && (
        <CategoryEditor
          mode={creating ? 'create' : 'edit'}
          category={editingId ? categories.find((c) => c.id === editingId) || null : null}
          onClose={() => { setCreating(false); setEditingId(null); }}
          onSaved={() => { setCreating(false); setEditingId(null); load(); }}
        />
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '12px 16px', color: 'var(--fg-2)', fontWeight: 700, fontSize: '14px' };
const td: React.CSSProperties = { padding: '12px 16px', color: 'var(--fg-1)' };
const iconBtn: React.CSSProperties = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--fg-2)', padding: '4px', marginLeft: '4px' };

function CategoryEditor({
  mode, category, onClose, onSaved,
}: {
  mode: 'create' | 'edit';
  category: FinanceCategory | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(category?.code ?? '');
  const [label, setLabel] = useState(category?.label ?? '');
  const [description, setDescription] = useState(category?.description ?? '');
  const [direction, setDirection] = useState<'incoming' | 'outgoing' | 'any'>(category?.direction ?? 'outgoing');
  const [opType, setOpType] = useState(category?.default_operation_type ?? 'purchase');
  const [alwaysConfirm, setAlwaysConfirm] = useState(category?.always_confirm === 1);
  const [color, setColor] = useState(category?.color ?? '#5B4A2F');
  const [sortOrder, setSortOrder] = useState(category?.sort_order ?? 100);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const payload = {
        code, label, description: description || null,
        direction, default_operation_type: opType as any,
        always_confirm: alwaysConfirm,
        color, sort_order: sortOrder,
      };
      const res = mode === 'create'
        ? await createFinanceCategory(payload)
        : await updateFinanceCategory(category!.id, payload);
      if (res.success) onSaved();
      else setErr(res.errors?.[0]?.message ?? 'Save failed');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Network');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, backgroundColor: 'rgba(15,15,15,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '24px',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        backgroundColor: 'var(--paper)', borderRadius: 'var(--radius-md)',
        border: '1px solid var(--line-1)', padding: '24px',
        width: '560px', maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div className="flex items-center justify-between mb-4">
          <h2 style={{
            fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '20px',
            fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase',
          }}>
            {mode === 'create' ? 'New Category' : 'Edit Category'}
          </h2>
          <button onClick={onClose} style={{ color: 'var(--fg-3)' }}><X className="h-5 w-5" /></button>
        </div>

        <div style={{ display: 'grid', gap: '12px' }}>
          <Field label="Code (machine identifier, lowercase, underscores)">
            <input
              type="text" value={code} disabled={mode === 'edit'}
              onChange={(e) => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
              style={input}
            />
          </Field>
          <Field label="Label">
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} style={input} />
          </Field>
          <Field label="Description">
            <input type="text" value={description || ''} onChange={(e) => setDescription(e.target.value)} style={input} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Field label="Direction">
              <select value={direction} onChange={(e) => setDirection(e.target.value as any)} style={input}>
                <option value="any">Any</option>
                <option value="incoming">Incoming</option>
                <option value="outgoing">Outgoing</option>
              </select>
            </Field>
            <Field label="Default operation type">
              <select value={opType} onChange={(e) => setOpType(e.target.value as any)} style={input}>
                {OPERATION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <Field label="Color">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ ...input, height: '40px', padding: '4px' }} />
            </Field>
            <Field label="Sort order">
              <input type="number" value={sortOrder} onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 100)} style={input} />
            </Field>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: 'var(--fg-1)', fontWeight: 700 }}>
            <input type="checkbox" checked={alwaysConfirm} onChange={(e) => setAlwaysConfirm(e.target.checked)} />
            Always require manual confirmation (don't auto-classify)
          </label>
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
          <button onClick={save} disabled={saving || !code || !label} style={{
            ...btnPrimary,
            opacity: (saving || !code || !label) ? 0.5 : 1,
            cursor: (saving || !code || !label) ? 'not-allowed' : 'pointer',
          }}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
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
  display: 'inline-flex', alignItems: 'center', gap: '8px',
};
