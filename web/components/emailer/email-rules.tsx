'use client';

import { useState, useEffect } from 'react';
import { Plus, Trash2, Loader2, AlertCircle, Mail, Tag } from 'lucide-react';
import {
  getEmailRules, createEmailRule, updateEmailRule, deleteEmailRule,
  type EmailRule, type EmailRuleAction,
} from '@/lib/api';

const ACTIONS: { value: EmailRuleAction; label: string }[] = [
  { value: 'attention', label: 'В инбокс (внимание)' },
  { value: 'keep', label: 'Оставить' },
  { value: 'exclude', label: 'Исключить' },
  { value: 'delete', label: 'Удалять' },
  { value: 'forward', label: 'Пересылать' },
  { value: 'archive', label: 'В архив' },
];

function actionStyle(a: EmailRuleAction): string {
  if (a === 'attention' || a === 'keep') return 'bg-emerald-50 text-emerald-700';
  if (a === 'forward') return 'bg-indigo-50 text-indigo-700';
  return 'bg-muted text-muted-foreground';
}

export default function EmailRules() {
  const [rules, setRules] = useState<EmailRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<{ match_sender: string; email_type: string; action: EmailRuleAction; target: string }>({
    match_sender: '', email_type: '', action: 'exclude', target: '',
  });
  const [creating, setCreating] = useState(false);

  const fetchRules = async () => {
    setLoading(true); setError(null);
    try {
      const r = await getEmailRules();
      if (r.success && r.result) setRules(r.result.rules || []);
      else setError('Failed to fetch rules');
    } catch (e) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { fetchRules(); }, []);

  const handleCreate = async () => {
    if (!form.match_sender && !form.email_type) { setError('Укажи отправителя, тип или оба'); return; }
    if (form.action === 'forward' && !form.target) { setError('Для пересылки нужен адрес'); return; }
    setCreating(true); setError(null);
    try {
      const r = await createEmailRule({
        match_sender: form.match_sender || undefined,
        email_type: form.email_type || undefined,
        action: form.action,
        target: form.target || undefined,
        source: 'manual',
      });
      if (r.success) { setShowForm(false); setForm({ match_sender: '', email_type: '', action: 'exclude', target: '' }); fetchRules(); }
      else setError('Failed to create rule');
    } catch (e) { setError(e instanceof Error ? e.message : 'Error'); }
    finally { setCreating(false); }
  };

  const toggle = async (rule: EmailRule) => {
    setBusy(rule.id);
    await updateEmailRule(rule.id, { enabled: !rule.enabled });
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
    setBusy(null);
  };

  const remove = async (id: string) => {
    setBusy(id);
    const r = await deleteEmailRule(id);
    if (r.success) setRules((prev) => prev.filter((x) => x.id !== id));
    setBusy(null);
  };

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Обученные и ручные правила. Каждое — по двум осям: отправитель и/или тип письма.</p>
        <button onClick={() => setShowForm((v) => !v)} className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground">
          <Plus className="h-4 w-4" /> Правило
        </button>
      </div>

      {error && <div className="flex items-center gap-2 text-sm text-red-600"><AlertCircle className="h-4 w-4" /> {error}</div>}

      {showForm && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm block">
              <span className="text-muted-foreground">Отправитель (домен/адрес)</span>
              <input value={form.match_sender} onChange={(e) => setForm({ ...form, match_sender: e.target.value })} placeholder="seller.ozon.ru" className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
            </label>
            <label className="text-sm block">
              <span className="text-muted-foreground">Тип письма</span>
              <input value={form.email_type} onChange={(e) => setForm({ ...form, email_type: e.target.value })} placeholder="acceptance / news / promo" className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
            </label>
            <label className="text-sm block">
              <span className="text-muted-foreground">Действие</span>
              <select value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value as EmailRuleAction })} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm">
                {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
            {form.action === 'forward' && (
              <label className="text-sm block">
                <span className="text-muted-foreground">Кому пересылать</span>
                <input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="email@example.com" className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm" />
              </label>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleCreate} disabled={creating} className="text-sm font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground inline-flex items-center gap-1.5">
              {creating && <Loader2 className="h-4 w-4 animate-spin" />} Создать
            </button>
            <button onClick={() => setShowForm(false)} className="text-sm text-muted-foreground px-3 py-1.5">Отмена</button>
          </div>
          <p className="text-xs text-muted-foreground">Отправитель + тип = точечное (Ozon×приёмка). Только отправитель = весь отправитель. Только тип = тип у всех.</p>
        </div>
      )}

      {rules.length === 0 && <div className="text-sm text-muted-foreground">Правил пока нет. Они появятся из триажа инбокса (кнопка «спам / не ценное») или создай вручную.</div>}

      <div className="space-y-2">
        {rules.map((r) => (
          <div key={r.id} className={`rounded-lg border border-border bg-card p-3 border-l-4 ${r.enabled ? 'border-l-emerald-500' : 'border-l-muted-foreground/30'}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <button onClick={() => toggle(r)} disabled={busy === r.id} title={r.enabled ? 'Live' : 'Paused'}
                  className={`relative h-5 w-9 rounded-full transition-colors shrink-0 ${r.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${r.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  {r.match_sender && <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-foreground"><Mail className="h-3 w-3" /> {r.match_sender}</span>}
                  {r.email_type && <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-foreground"><Tag className="h-3 w-3" /> {r.email_type}</span>}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${actionStyle(r.action)}`}>{r.action}{r.action === 'forward' && r.target ? ` → ${r.target}` : ''}</span>
                  <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${r.source === 'learned' ? 'bg-amber-50 text-amber-700' : 'bg-muted text-muted-foreground'}`}>{r.source}</span>
                  {r.match_count > 0 && <span className="text-[10px] text-muted-foreground">×{r.match_count}</span>}
                </div>
              </div>
              <button onClick={() => remove(r.id)} disabled={busy === r.id} title="Удалить правило" className="text-muted-foreground hover:text-red-600 shrink-0 p-1">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
