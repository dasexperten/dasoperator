'use client';

import { useEffect, useState } from 'react';
import { Loader2, Cpu, Server } from 'lucide-react';
import { apiGet, apiPatch } from '@/lib/api';

interface Scenario {
  id: string; name: string; executor: string; inbox: string; from_address: string;
  schedule_cron: string; persona_rule: string | null; trigger_spec: string | null;
  enabled: number; auto_learning: number; accuracy: number | null;
}

export default function ScenariosView() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Scenario[]>('/api/email-tasks/scenarios')
      .then((r) => { if (r.success) setScenarios(r.result ?? []); })
      .finally(() => setLoading(false));
  }, []);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    const r = await apiPatch<Scenario>(`/api/email-tasks/scenarios/${id}`, body);
    if (r.success && r.result) {
      setScenarios((prev) => prev.map((s) => (s.id === id ? { ...s, ...r.result } : s)));
    }
    setBusy(null);
  }

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Each scenario is a cron job. Route it to <span className="font-medium">Worker</span> (deterministic, high-volume) or <span className="font-medium">Hermes</span> (reasons + learns). Sending always goes through emailer-bridge.</p>
      {scenarios.map((s) => (
        <div key={s.id} className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-foreground">{s.name}</div>
              <div className="text-sm text-muted-foreground mt-0.5">✉ {s.from_address} · {s.inbox}</div>
              {s.persona_rule && <div className="text-xs text-muted-foreground mt-1">{s.persona_rule}</div>}
              {s.trigger_spec && <div className="text-xs text-muted-foreground mt-0.5">trigger: {s.trigger_spec}</div>}
              <div className="text-xs text-muted-foreground mt-1">{s.schedule_cron}{s.accuracy != null ? ` · accuracy ${s.accuracy}%` : ''}</div>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <button
                onClick={() => patch(s.id, { executor: s.executor === 'hermes' ? 'worker' : 'hermes' })}
                disabled={busy === s.id}
                className={`text-xs font-medium px-2.5 py-1 rounded-full inline-flex items-center gap-1 ${s.executor === 'hermes' ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'}`}
                title="Switch executor"
              >
                {s.executor === 'hermes' ? <Server className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
                {s.executor === 'hermes' ? 'Hermes' : 'Worker'}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-5 mt-4 pt-3 border-t border-border">
            <Toggle label="Live" on={!!s.enabled} disabled={busy === s.id} onClick={() => patch(s.id, { enabled: !s.enabled })} />
            <Toggle label="Auto-learning" on={!!s.auto_learning} disabled={busy === s.id} onClick={() => patch(s.id, { auto_learning: !s.auto_learning })} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Toggle({ label, on, onClick, disabled }: { label: string; on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex items-center gap-2 text-sm">
      <span className={`relative inline-block w-10 h-6 rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <span className={on ? 'text-foreground font-medium' : 'text-muted-foreground'}>{label}</span>
    </button>
  );
}
