'use client';

import { useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { apiGet, apiPost, apiPut } from '@/lib/api';

interface Lesson {
  id: string; scenario_name: string | null; scenario_id: string; proposed: string;
  diff_before: string | null; diff_after: string | null; seen_count: number; status: string;
}
interface PlaybookRow {
  id: string; scenario_id: string; lesson: string; kind: string; approved_at: number;
}

export default function LearningView() {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [playbook, setPlaybook] = useState<PlaybookRow[]>([]);
  const [autoLearning, setAutoLearning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  function reload() {
    return Promise.all([
      apiGet<Lesson[]>('/api/email-tasks/lessons?status=pending'),
      apiGet<PlaybookRow[]>('/api/email-tasks/playbook'),
      apiGet<Record<string, string>>('/api/email-tasks/settings'),
    ]).then(([l, p, s]) => {
      if (l.success) setLessons(l.result ?? []);
      if (p.success) setPlaybook(p.result ?? []);
      if (s.success) setAutoLearning(s.result?.auto_learning === 'on');
    });
  }

  useEffect(() => { reload().finally(() => setLoading(false)); }, []);

  async function decide(id: string, action: 'approve' | 'reject') {
    setBusy(id);
    const r = await apiPost(`/api/email-tasks/lessons/${id}/${action}`, {});
    if (r.success) { setLessons((prev) => prev.filter((l) => l.id !== id)); await reload(); }
    setBusy(null);
  }

  async function toggleAuto() {
    const next = !autoLearning;
    setAutoLearning(next);
    await apiPut('/api/email-tasks/settings', { auto_learning: next ? 'on' : 'off' });
  }

  async function revert(id: string) {
    setBusy(id);
    await apiPost(`/api/email-tasks/playbook/${id}/revert`, {});
    setPlaybook((prev) => prev.filter((p) => p.id !== id));
    setBusy(null);
  }

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={toggleAuto} role="switch" aria-checked={autoLearning} aria-label="Toggle auto-learning" className={`relative inline-block w-14 h-8 rounded-full transition-colors shrink-0 ${autoLearning ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}>
            <span className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${autoLearning ? 'left-[28px]' : 'left-1'}`} />
          </button>
          <div className="text-base font-semibold text-foreground">Auto-learning — {autoLearning ? 'ON' : 'OFF'}</div>
        </div>
        <p className="text-sm text-muted-foreground mt-2">
          {autoLearning
            ? 'ON — repeated, confident lessons (seen ≥3×) apply on their own. The system stops asking you; you can still revert any from the playbook.'
            : 'OFF — every lesson waits for your click. Nothing enters the canon without you.'}
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-foreground">Pending lessons</h2>
          <span className="text-xs text-muted-foreground">from your Safety Gate edits</span>
        </div>
        {lessons.length === 0 && <div className="text-sm text-muted-foreground rounded-lg border border-border p-6 text-center">Nothing pending. The agent is in sync with you.</div>}
        <div className="space-y-3">
          {lessons.map((l) => (
            <div key={l.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">{l.scenario_name ?? l.scenario_id}</span>
                <span className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700">seen {l.seen_count}×</span>
                <span className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-700">Hermes</span>
              </div>
              <div className="text-[11px] font-medium uppercase text-indigo-600 tracking-wide">Proposed lesson</div>
              <div className="text-lg font-medium text-foreground mb-3 leading-snug">{l.proposed}</div>
              {(l.diff_before || l.diff_after) && (
                <div className="rounded-md border border-border overflow-hidden mb-3 text-base">
                  <div className="px-3 py-2 bg-red-50">
                    <div className="text-[11px] font-medium uppercase text-red-600">Hermes wrote</div>
                    <span className="block mt-1 line-through text-red-800/80 font-medium leading-relaxed">{l.diff_before}</span>
                  </div>
                  <div className="px-3 py-2 bg-emerald-50 border-t border-border">
                    <div className="text-[11px] font-medium uppercase text-emerald-600">You sent</div>
                    <span className="block mt-1 text-emerald-800 font-medium leading-relaxed">{l.diff_after}</span>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <button onClick={() => decide(l.id, 'approve')} disabled={busy === l.id} className="flex-1 py-3.5 rounded-md bg-emerald-600 text-white font-semibold text-lg disabled:opacity-50">Approve</button>
                <button onClick={() => decide(l.id, 'reject')} disabled={busy === l.id} className="flex-1 py-3.5 rounded-md border-2 border-red-300 text-red-600 font-semibold text-lg disabled:opacity-50">Reject</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-foreground">Playbook · live canon</h2>
          <span className="text-xs text-muted-foreground">GitHub · versioned · {playbook.length} active</span>
        </div>
        <div className="rounded-lg border border-border overflow-hidden">
          {playbook.length === 0 && <div className="px-4 py-6 text-center text-sm text-muted-foreground">No approved lessons yet.</div>}
          {playbook.map((p) => (
            <div key={p.id} className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border last:border-b-0">
              <div>
                <div className="text-sm text-foreground">{p.lesson}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {p.scenario_id}{p.kind === 'stop_phrase' ? ' · stop-phrase' : ''} · {new Date(p.approved_at * 1000).toISOString().slice(0, 10)}
                </div>
              </div>
              <button onClick={() => revert(p.id)} disabled={busy === p.id} className="text-xs text-muted-foreground bg-muted rounded px-2.5 py-1.5 inline-flex items-center gap-1 shrink-0 disabled:opacity-50">
                <RotateCcw className="h-3 w-3" /> Revert
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
