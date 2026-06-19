'use client';

import { useEffect, useState } from 'react';
import { Loader2, Cpu, Server, Mail } from 'lucide-react';
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

  const active = scenarios.filter((s) => s.enabled);
  const paused = scenarios.filter((s) => !s.enabled);

  const card = (s: Scenario) => (
    <div key={s.id} className={`rounded-lg border border-border bg-card p-4 border-l-4 ${s.enabled ? 'border-l-emerald-500' : 'border-l-muted-foreground/30'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${s.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${s.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`} />
              {s.enabled ? 'Active' : 'Paused'}
            </span>
            <span className="font-semibold text-foreground truncate">{s.name}</span>
          </div>
          <div className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5"><Mail className="h-3.5 w-3.5 shrink-0" /> {s.from_address} · {s.inbox}</div>
          {s.persona_rule && <div className="text-xs text-muted-foreground mt-1">{s.persona_rule}</div>}
          {s.trigger_spec && <div className="text-xs text-muted-foreground mt-0.5">trigger: {s.trigger_spec}</div>}
          <div className="text-xs text-muted-foreground mt-1">{s.schedule_cron}{s.accuracy != null ? ` · accuracy ${s.accuracy}%` : ''}</div>
        </div>
        <button
          onClick={() => patch(s.id, { executor: s.executor === 'hermes' ? 'worker' : 'hermes' })}
          disabled={busy === s.id}
          className={`text-xs font-medium px-2.5 py-1 rounded-full inline-flex items-center gap-1 shrink-0 ${s.executor === 'hermes' ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'}`}
          title="Switch executor"
        >
          {s.executor === 'hermes' ? <Server className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
          {s.executor === 'hermes' ? 'Hermes' : 'Worker'}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-5 mt-4 pt-3 border-t border-border">
        <Toggle label={s.enabled ? 'Live' : 'Paused'} on={!!s.enabled} disabled={busy === s.id} onClick={() => patch(s.id, { enabled: !s.enabled })} />
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="rounded-lg bg-muted/40 px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
        <Mail className="h-4 w-4 shrink-0" />
        Scenarios run on incoming mail only. Each routes to <span className="font-medium text-foreground">Worker</span> (deterministic, high-volume) or <span className="font-medium text-foreground">Hermes</span> (reasons + learns). Sending always goes through emailer-bridge.
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-lg bg-muted/50 px-3 py-2"><div className="text-xs text-muted-foreground">Active</div><div className="text-xl font-semibold text-foreground">{active.length}</div></div>
        <div className="rounded-lg bg-muted/50 px-3 py-2"><div className="text-xs text-muted-foreground">Paused</div><div className="text-xl font-semibold text-foreground">{paused.length}</div></div>
      </div>

      {scenarios.length === 0 && <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">No scenarios yet.</div>}

      {active.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Active</h2>
          {active.map(card)}
        </div>
      )}

      {paused.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Paused</h2>
          {paused.map(card)}
        </div>
      )}
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
