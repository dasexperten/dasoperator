'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, PhoneCall, PhoneIncoming, PhoneOutgoing, RefreshCw, X } from 'lucide-react';
import { apiGet } from '@/lib/api';

// Caller (Owner 2026-09-26): every agent's voice call. The WhatsApp voice bridge writes rows
// into D1 call_transcripts; this page only displays them. Click a row for the full transcript.

interface CallRow {
  id: string;
  seat_slug: string;
  seat_name: string;
  recipient_phone: string;
  recipient_label: string | null;
  call_type: 'outgoing' | 'incoming';
  channel: string;
  engine: string;
  status: 'completed' | 'no_answer' | 'failed';
  deal_status: DealStatus;
  call_purpose: CallPurpose;
  summary: string | null;
  started_at: number;
  ended_at: number | null;
  duration_seconds: number | null;
}
type DealStatus = 'agreed' | 'interested' | 'callback' | 'no_decision' | 'not_interested' | 'not_reached';
type CallPurpose = 'sales' | 'follow_up' | 'support' | 'owner_briefing' | 'test' | 'other';

// Owner 26.09: "status" is the deal position, "type" is the call purpose.
const DEAL_LABEL: Record<DealStatus, string> = {
  agreed: 'Agreed',
  interested: 'Interested',
  callback: 'Call back',
  no_decision: 'No decision',
  not_interested: 'Not interested',
  not_reached: 'Not reached',
};
const DEAL_CLASS: Record<DealStatus, string> = {
  agreed: 'text-success',
  interested: 'text-success',
  callback: 'text-warning',
  no_decision: 'text-muted-foreground',
  not_interested: 'text-rot',
  not_reached: 'text-stone-500',
};
const PURPOSE_LABEL: Record<CallPurpose, string> = {
  sales: 'Sales',
  follow_up: 'Follow-up',
  support: 'Support',
  owner_briefing: 'Owner briefing',
  test: 'Test call',
  other: 'Other',
};

interface TranscriptTurn { speaker: 'agent' | 'recipient'; text: string; at?: number }

// Connection outcome, shown in the transcript window.
const STATUS_LABEL: Record<CallRow['status'], string> = {
  completed: 'Connected',
  no_answer: 'No answer',
  failed: 'Failed',
};
const STATUS_CLASS: Record<CallRow['status'], string> = {
  completed: 'text-success',
  no_answer: 'text-warning',
  failed: 'text-rot',
};

function when(value: number | null | undefined) {
  if (!value) return '—';
  return new Date(value * 1000).toLocaleString('en-GB', {
    timeZone: 'Asia/Yerevan', dateStyle: 'medium', timeStyle: 'short',
  });
}

function duration(seconds: number | null) {
  if (!seconds && seconds !== 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m} min ${s} s` : `${s} s`;
}

const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram' };
function channelLabel(channel: string) {
  return CHANNEL_LABEL[channel] || channel;
}

function recipient(row: CallRow) {
  return row.recipient_label ? `${row.recipient_label} · +${row.recipient_phone}` : `+${row.recipient_phone}`;
}

function PurposeCell({ row }: { row: CallRow }) {
  const Icon = row.call_type === 'incoming' ? PhoneIncoming : PhoneOutgoing;
  return (
    <span className="inline-flex items-center gap-2 font-bold text-muted-foreground">
      <Icon className="h-4 w-4" aria-label={row.call_type === 'incoming' ? 'Incoming' : 'Outgoing'} />
      {PURPOSE_LABEL[row.call_purpose] || row.call_purpose}
      <span className="text-stone-500">· {channelLabel(row.channel)}</span>
    </span>
  );
}

export default function CallList({ channel = null, title = 'Caller', subtitle = 'Every agent call with its transcript. Click a call to read the full conversation.', eyebrow = 'Emailer · voice' }: {
  channel?: 'whatsapp' | 'telegram' | null; title?: string; subtitle?: string; eyebrow?: string;
}) {
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<CallRow | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[] | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiGet<{ calls: CallRow[] }>(`/api/calls?limit=200${channel ? `&channel=${channel}` : ''}`);
    if (res.success && res.result) setCalls(res.result.calls);
    else setError(res.errors[0]?.message || 'Could not load calls.');
    setLoading(false);
  }, [channel]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function openCall(row: CallRow) {
    setOpen(row);
    setTranscript(null);
    setTranscriptError(null);
    const res = await apiGet<{ call: CallRow; transcript: TranscriptTurn[] }>(`/api/calls/${encodeURIComponent(row.id)}`);
    if (res.success && res.result) setTranscript(res.result.transcript);
    else setTranscriptError(res.errors[0]?.message || 'Could not load the transcript.');
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-extrabold uppercase text-stone-500">{eyebrow}</p>
          <h1 className="mt-1 text-3xl font-extrabold text-foreground">{title}</h1>
          <p className="mt-2 max-w-2xl text-base font-semibold text-muted-foreground">
            {subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-border bg-card px-4 font-bold text-muted-foreground"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </header>

      {error && (
        <p className="flex gap-2 rounded-lg border border-border bg-card p-4 text-sm font-bold text-rot">
          <AlertCircle className="h-5 w-5 shrink-0" />{error}
        </p>
      )}

      <section className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        <div className="hidden grid-cols-[1.3fr_0.8fr_1fr_1fr_1fr_1.4fr] gap-4 border-b border-border px-5 py-3 text-sm font-extrabold text-stone-500 md:grid">
          <span>Recipient</span><span>Status</span><span>Call type</span><span>Agent</span><span>Time</span><span>Outcome</span>
        </div>
        {loading && calls.length === 0 && (
          <p className="flex items-center justify-center gap-2 py-10 font-semibold text-stone-500">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading calls
          </p>
        )}
        {!loading && calls.length === 0 && !error && (
          <p className="py-10 text-center font-semibold text-stone-500">No calls recorded yet.</p>
        )}
        <ul className="divide-y divide-border">
          {calls.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => void openCall(row)}
                className="grid w-full gap-1 px-5 py-4 text-left hover:bg-muted focus:bg-muted focus:outline-none md:grid-cols-[1.3fr_0.8fr_1fr_1fr_1fr_1.4fr] md:items-center md:gap-4"
              >
                <span className="font-extrabold text-foreground">{recipient(row)}</span>
                <span className={`text-sm font-extrabold ${DEAL_CLASS[row.deal_status] || 'text-muted-foreground'}`}>
                  {DEAL_LABEL[row.deal_status] || row.deal_status}
                </span>
                <span className="text-sm"><PurposeCell row={row} /></span>
                <span className="text-sm font-bold text-foreground">{row.seat_name}</span>
                <span className="text-sm font-bold text-stone-500">{when(row.started_at)}</span>
                <span className="text-sm font-semibold text-muted-foreground">{row.summary || '—'}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6"
          onClick={() => setOpen(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="caller-dialog-title"
            onClick={(event) => event.stopPropagation()}
            className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-t-lg border border-border bg-card shadow-card sm:rounded-lg"
          >
            <div className="flex items-start justify-between gap-4 border-b border-border p-5">
              <div>
                <p className="flex items-center gap-2 text-sm font-extrabold text-stone-500">
                  <PhoneCall className="h-4 w-4" /> {open.seat_name} → {recipient(open)}
                </p>
                <h2 id="caller-dialog-title" className="mt-1 text-xl font-extrabold text-foreground">
                  {open.summary || 'Call transcript'}
                </h2>
                <p className="mt-1 text-sm font-bold text-stone-500">
                  <span className={DEAL_CLASS[open.deal_status]}>{DEAL_LABEL[open.deal_status]}</span>
                  {' · '}{PURPOSE_LABEL[open.call_purpose]} · {open.call_type === 'incoming' ? 'Incoming' : 'Outgoing'} {channelLabel(open.channel)}
                  {' · '}{when(open.started_at)} · <span className={STATUS_CLASS[open.status]}>{STATUS_LABEL[open.status]}</span>
                  {open.duration_seconds ? ` · ${duration(open.duration_seconds)}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(null)}
                aria-label="Close"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm border border-border text-muted-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto p-5">
              {!transcript && !transcriptError && (
                <p className="flex items-center gap-2 font-semibold text-stone-500"><Loader2 className="h-5 w-5 animate-spin" /> Loading transcript</p>
              )}
              {transcriptError && <p className="font-bold text-rot">{transcriptError}</p>}
              {transcript && transcript.length === 0 && <p className="font-semibold text-stone-500">No speech was recorded on this call.</p>}
              {transcript && transcript.length > 0 && (
                <ol className="space-y-3">
                  {transcript.map((turn, index) => (
                    <li key={index} className={`flex ${turn.speaker === 'agent' ? 'justify-start' : 'justify-end'}`}>
                      <div className={`max-w-[85%] rounded-lg px-4 py-3 ${turn.speaker === 'agent' ? 'bg-muted' : 'border border-border bg-card'}`}>
                        <p className="text-xs font-extrabold text-stone-500">
                          {turn.speaker === 'agent' ? open.seat_name : recipient(open)}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap font-semibold text-foreground">{turn.text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
