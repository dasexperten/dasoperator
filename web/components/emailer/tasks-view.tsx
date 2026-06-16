'use client';

import { useEffect, useState } from 'react';
import { Loader2, Cpu, Server } from 'lucide-react';
import { apiGet } from '@/lib/api';

interface Summary {
  in_queue: number; awaiting_ok: number; sent_today: number;
  pending_lessons: number; agent_accuracy: number | null;
}
interface Scenario {
  id: string; name: string; executor: string; inbox: string; from_address: string;
  schedule_cron: string; persona_rule: string | null; enabled: number;
  sent_clean: number; edited: number; last_run_at: number | null;
  next_run_at: number | null; accuracy: number | null;
}
interface Task {
  id: string; scenario_name: string | null; subject: string | null; sender: string | null;
  status: string; confidence: number | null; created_at: number;
}

const STATUS_LABEL: Record<string, string> = {
  researching: 'Researching', draft_ready: 'Draft ready', awaiting_ok: 'Awaiting your OK',
  sent: 'Sent', rejected: 'Rejected', skipped: 'Skipped',
};
const STATUS_CLASS: Record<string, string> = {
  awaiting_ok: 'bg-amber-50 text-amber-700', draft_ready: 'bg-indigo-50 text-indigo-700',
  researching: 'bg-muted text-muted-foreground', sent: 'bg-emerald-50 text-emerald-700',
  rejected: 'bg-red-50 text-red-700', skipped: 'bg-muted text-muted-foreground',
};

function ago(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function hhmm(ts: number | null): string {
  return ts ? new Date(ts * 1000).toISOString().slice(11, 16) : '—';
}

export default function TasksView() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet<Summary>('/api/email-tasks/summary'),
      apiGet<Scenario[]>('/api/email-tasks/scenarios'),
      apiGet<Task[]>('/api/email-tasks/queue'),
    ]).then(([s, sc, t]) => {
      if (s.success) setSummary(s.result);
      if (sc.success) setScenarios(sc.result ?? []);
      if (t.success) setTasks(t.result ?? []);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  }

  const metrics = [
    { label: 'In queue', value: summary?.in_queue ?? 0, accent: '' },
    { label: 'Awaiting your OK', value: summary?.awaiting_ok ?? 0, accent: 'text-amber-600' },
    { label: 'Sent today', value: summary?.sent_today ?? 0, accent: '' },
    { label: 'Agent accuracy', value: summary?.agent_accuracy != null ? `${summary.agent_accuracy}%` : '—', accent: '' },
  ];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-md bg-muted/40 px-4 py-3">
            <div className="text-sm text-muted-foreground">{m.label}</div>
            <div className={`text-2xl font-medium mt-1 ${m.accent}`}>{m.value}</div>
          </div>
        ))}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-foreground">Active scenarios</h2>
          <span className="text-xs text-muted-foreground">cron · every 3h @ :23 UTC</span>
        </div>
        <div className="space-y-2">
          {scenarios.map((s) => {
            const total = s.sent_clean + s.edited;
            const hit = total > 0 ? Math.round((s.sent_clean / total) * 100) : 0;
            return (
              <div key={s.id} className="rounded-lg border border-border bg-card px-4 py-3 flex flex-col md:flex-row md:items-center gap-3 md:gap-5">
                {/* name + meta */}
                <div className="min-w-0 md:flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground truncate">{s.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${s.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>{s.enabled ? 'Live' : 'Paused'}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 truncate">✉ {s.from_address} · {s.inbox} · {s.schedule_cron}</div>
                </div>

                {/* accuracy bar */}
                <div className="w-full md:w-44 shrink-0">
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden flex">
                    <div className="bg-emerald-500 h-full" style={{ width: `${hit}%` }} />
                    <div className="bg-red-500 h-full" style={{ width: `${100 - hit}%` }} />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>clean {s.sent_clean}</span><span>edited {s.edited}</span>
                  </div>
                </div>

                {/* run times */}
                <div className="text-xs text-muted-foreground md:w-36 shrink-0 md:text-right">
                  last run {ago(s.last_run_at)}<span className="hidden md:inline"><br /></span><span className="md:hidden"> · </span>next {hhmm(s.next_run_at)}
                </div>

                {/* executor */}
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full inline-flex items-center gap-1 shrink-0 self-start md:self-center ${s.executor === 'hermes' ? 'bg-amber-50 text-amber-700' : 'bg-indigo-50 text-indigo-700'}`}>
                  {s.executor === 'hermes' ? <Server className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
                  {s.executor === 'hermes' ? 'Hermes' : 'Worker'}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-foreground">Task queue</h2>
          <span className="text-xs text-muted-foreground">agent → draft → your OK → send via emailer-bridge</span>
        </div>
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground">
                <th className="text-left font-medium px-4 py-2.5">Task</th>
                <th className="text-left font-medium px-4 py-2.5">Scenario</th>
                <th className="text-left font-medium px-4 py-2.5">Status</th>
                <th className="text-left font-medium px-4 py-2.5">Agent</th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">No tasks yet — scenarios will fill this on the next tick.</td></tr>
              )}
              {tasks.map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{t.subject ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">{t.sender ?? ''} · {ago(t.created_at)}</div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{t.scenario_name ?? '—'}</td>
                  <td className="px-4 py-3"><span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_CLASS[t.status] ?? 'bg-muted'}`}>{STATUS_LABEL[t.status] ?? t.status}</span></td>
                  <td className="px-4 py-3 font-medium">{t.confidence != null ? t.confidence.toFixed(2) : '…'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground mt-3">Hard rules wired in: from = dasexperten@gmail.com on cron sends (SPF) · participants dedup · no fabricated identifiers · Germany-silence in body.</p>
      </div>
    </div>
  );
}
