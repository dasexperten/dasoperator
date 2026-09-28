'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Phone, Send, X } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api';
import { AVATAR_BASE, CALL_ACCOUNTS, CALLER_AGENTS, NO_PORTRAIT, initials, type CallChannel, type CallerAgent } from './agents';

// Owner 2026-09-26: a row of small agent avatars with names on top of Caller. A click opens a
// small popup: the account the agent calls from and the last 10 numbers it called. On the
// Telegram tab the popup shows the Telegram account; on WhatsApp — the WhatsApp number.

interface Recipient { phone: string; label: string | null; last_at: number; calls: number }

function when(value: number) {
  return new Date(value * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Yerevan', dateStyle: 'medium', timeStyle: 'short' });
}

// Brand glyphs, drawn inline (no external icon hosts).
function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="11" fill="#229ED9" />
      <path fill="#FFFFFF" d="M5.6 11.7l10.9-4.2c.5-.2 1 .1.8.9l-1.9 8.8c-.1.6-.5.8-1 .5l-2.8-2.1-1.4 1.3c-.2.2-.3.3-.6.3l.2-2.9 5.2-4.7c.2-.2 0-.3-.3-.1l-6.4 4-2.8-.9c-.6-.2-.6-.6.1-.9z" />
    </svg>
  );
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path fill="#25D366" d="M12 1.5A10.4 10.4 0 0 0 3 17.1L1.6 22.4l5.4-1.4A10.4 10.4 0 1 0 12 1.5z" />
      <path fill="#FFFFFF" d="M8.6 6.8c-.2-.5-.4-.5-.6-.5h-.5c-.2 0-.5.1-.7.3-.3.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.9 4.5 4 2.2.9 2.7.7 3.2.6.5 0 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.2-.2-.5-.3l-1.8-.9c-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.5-1.4-1.8-.2-.3 0-.4.1-.5l.4-.5c.1-.2.2-.3.3-.5.1-.2 0-.4 0-.5l-.8-2z" />
    </svg>
  );
}

type DialStatus = 'pending' | 'dialing' | 'connected' | 'completed' | 'no_answer' | 'failed' | 'cancelled';
const DIAL_TEXT: Record<DialStatus, string> = {
  pending: 'Waiting for the call service on the Mac…',
  dialing: 'Calling…',
  connected: 'Connected — the agent is talking.',
  completed: 'Call ended. The transcript is in the list.',
  no_answer: 'No answer.',
  failed: 'The call failed.',
  cancelled: 'Cancelled.',
};
const DIAL_DONE = new Set<DialStatus>(['completed', 'no_answer', 'failed', 'cancelled']);

function DialPopup({ agent, channel, onClose }: { agent: CallerAgent; channel: CallChannel; onClose: () => void }) {
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<{ id: string; status: DialStatus; detail?: string | null; target: string } | null>(null);
  const [sending, setSending] = useState(false);
  const telegram = channel === 'telegram';

  useEffect(() => {
    if (!request || DIAL_DONE.has(request.status)) return;
    const timer = setInterval(async () => {
      const res = await apiGet<{ status: DialStatus; detail: string | null; target: string }>(`/api/calls/requests/${request.id}`);
      if (res.success && res.result) setRequest((r) => (r ? { ...r, status: res.result!.status, detail: res.result!.detail } : r));
    }, 1500);
    return () => clearInterval(timer);
  }, [request]);

  async function dial(event: React.FormEvent) {
    event.preventDefault();
    setSending(true);
    setError(null);
    const res = await apiPost<{ id: string; status: DialStatus; target: string }>('/api/calls/requests', {
      seat_slug: agent.slug, channel, target,
    });
    setSending(false);
    if (!res.success || !res.result) { setError(res.errors[0]?.message || 'The call could not be requested.'); return; }
    setRequest({ id: res.result.id, status: res.result.status, target: res.result.target });
  }

  async function cancel() {
    if (request) await apiPost(`/api/calls/requests/${request.id}/cancel`, {});
    setRequest((r) => (r ? { ...r, status: 'cancelled' } : r));
  }

  const Icon = telegram ? TelegramIcon : WhatsAppIcon;
  return (
    <div className="absolute inset-x-0 top-0 z-50 rounded-lg border border-border bg-card p-4 shadow-card" role="dialog" aria-label={`${agent.name} calls via ${CALL_ACCOUNTS[channel].label}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-extrabold text-foreground">
          <Icon className="h-5 w-5" /> {agent.name.split(' ')[0]} calls via {CALL_ACCOUNTS[channel].label}
        </p>
        <button type="button" onClick={onClose} aria-label="Back" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-sm border border-border text-muted-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      {!request ? (
        <form onSubmit={dial} className="mt-3 space-y-3">
          <label htmlFor="dial-target" className="block text-sm font-bold text-muted-foreground">
            {telegram ? 'Phone number or Telegram @username' : 'WhatsApp phone number'}
          </label>
          <input
            id="dial-target"
            autoFocus
            value={target}
            onChange={(e) => { setTarget(e.target.value); setError(null); }}
            placeholder={telegram ? '+374 94 004004 or @username' : '+374 94 004004'}
            className="min-h-11 w-full rounded-sm border border-border bg-card px-3 font-semibold text-foreground outline-none focus:ring-2 focus:ring-gold"
          />
          {error && <p className="text-sm font-bold text-rot">{error}</p>}
          <button type="submit" disabled={sending || !target.trim()} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-sm bg-rot px-4 font-extrabold text-paper disabled:opacity-40">
            {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Phone className="h-5 w-5" />} Call now
          </button>
          <p className="text-xs font-semibold text-stone-500">
            {agent.name.split(' ')[0]} calls from {CALL_ACCOUNTS[channel].account} right away. The transcript appears in the list after the call.
          </p>
        </form>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="whitespace-nowrap font-bold text-foreground">{request.target}</p>
          <p className={`flex items-center gap-2 text-sm font-bold ${request.status === 'failed' ? 'text-rot' : request.status === 'completed' || request.status === 'connected' ? 'text-success' : 'text-muted-foreground'}`}>
            {!DIAL_DONE.has(request.status) && <Loader2 className="h-4 w-4 animate-spin" />}
            {DIAL_TEXT[request.status]}
          </p>
          {request.detail && <p className="text-xs font-semibold text-stone-500">{request.detail}</p>}
          {request.status === 'pending' && (
            <button type="button" onClick={() => void cancel()} className="min-h-11 rounded-sm border border-border px-4 font-extrabold text-muted-foreground">Cancel</button>
          )}
        </div>
      )}
    </div>
  );
}

function Avatar({ agent, size }: { agent: CallerAgent; size: 'sm' | 'md' }) {
  const [failed, setFailed] = useState(false);
  const box = size === 'sm' ? 'h-10 w-10 text-sm' : 'h-12 w-12 text-base';
  if (NO_PORTRAIT.has(agent.slug) || failed) {
    return (
      <span className={`${box} inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-extrabold text-muted-foreground`}>
        {initials(agent.name)}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${AVATAR_BASE}/${agent.slug}.png`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={`${box} shrink-0 rounded-full border border-border object-cover`}
    />
  );
}

export default function AgentBar({ channel }: { channel: CallChannel | null }) {
  const [open, setOpen] = useState<CallerAgent | null>(null);
  const [dial, setDial] = useState<CallChannel | null>(null);
  const [recipients, setRecipients] = useState<Record<string, Recipient[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => { setRecipients(null); }, [channel]);

  useEffect(() => {
    if (!open || recipients) return;
    let cancelled = false;
    setError(null);
    apiGet<{ agents: Record<string, Recipient[]> }>(`/api/calls/agents${channel ? `?channel=${channel}` : ''}`).then((res) => {
      if (cancelled) return;
      if (res.success && res.result) setRecipients(res.result.agents);
      else setError(res.errors[0]?.message || 'Could not load numbers.');
    });
    return () => { cancelled = true; };
  }, [open, recipients, channel]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (dial) setDial(null); else setOpen(null); } };
    const onClick = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, [open, dial]);

  useEffect(() => { setDial(null); }, [open]);

  const accounts = channel ? [channel] : (Object.keys(CALL_ACCOUNTS) as CallChannel[]);
  const list = open && recipients ? recipients[open.slug] || [] : [];

  return (
    <div className="relative mx-auto max-w-6xl">
      <ul className="flex gap-3 overflow-x-auto pb-2" aria-label="Agents">
        {CALLER_AGENTS.map((agent) => (
          <li key={agent.slug} className="shrink-0">
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); setOpen(open?.slug === agent.slug ? null : agent); }}
              aria-expanded={open?.slug === agent.slug}
              className={`flex w-16 flex-col items-center gap-1 rounded-sm p-1 focus:outline-none focus:ring-2 focus:ring-gold ${
                open?.slug === agent.slug ? 'bg-muted' : 'hover:bg-muted'
              }`}
            >
              <Avatar agent={agent} size="sm" />
              <span className="w-full truncate text-center text-xs font-bold text-muted-foreground">{agent.name.split(' ')[0]}</span>
            </button>
          </li>
        ))}
      </ul>

      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={`${open.name} calls`}
          className="absolute left-0 right-0 top-full z-40 mx-auto mt-1 w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-card sm:left-auto sm:right-auto"
        >
          {dial && <DialPopup agent={open} channel={dial} onClose={() => setDial(null)} />}
          <div className="flex items-start gap-2">
            <Avatar agent={open} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-extrabold text-foreground">{open.name}</p>
              {open.role && <p className="truncate text-sm font-semibold text-stone-500">{open.role}</p>}
            </div>
            <button type="button" onClick={() => setDial('telegram')} aria-label={`${open.name} calls via Telegram`} title="Call via Telegram" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-sm border border-border">
              <TelegramIcon className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setDial('whatsapp')} aria-label={`${open.name} calls via WhatsApp`} title="Call via WhatsApp" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-sm border border-border">
              <WhatsAppIcon className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setOpen(null)} aria-label="Close" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-sm border border-border text-muted-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 space-y-2">
            <p className="text-xs font-extrabold uppercase text-stone-500">Calls from</p>
            {accounts.map((key) => {
              const acc = CALL_ACCOUNTS[key];
              const Icon = key === 'telegram' ? Send : Phone;
              return (
                <p key={key} className="flex items-center gap-2 text-sm font-bold text-foreground">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <span>{acc.label}</span>
                  <span className="whitespace-nowrap">{acc.account}</span>
                  <span className="truncate font-semibold text-stone-500">· {acc.detail}</span>
                </p>
              );
            })}
          </div>

          <div className="mt-4">
            <p className="text-xs font-extrabold uppercase text-stone-500">
              Last numbers called{channel ? ` · ${CALL_ACCOUNTS[channel].label}` : ''}
            </p>
            {!recipients && !error && <p className="mt-2 flex items-center gap-2 text-sm font-semibold text-stone-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading</p>}
            {error && <p className="mt-2 text-sm font-bold text-rot">{error}</p>}
            {recipients && list.length === 0 && <p className="mt-2 text-sm font-semibold text-stone-500">No calls yet.</p>}
            {list.length > 0 && (
              <ol className="mt-2 divide-y divide-border">
                {list.map((r) => (
                  <li key={r.phone} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block whitespace-nowrap font-bold text-foreground">{/^\d+$/.test(r.phone) ? `+${r.phone}` : r.phone}</span>
                      {r.label && <span className="block truncate text-xs font-semibold text-stone-500">{r.label}</span>}
                    </span>
                    <span className="shrink-0 text-right text-xs font-bold text-stone-500">
                      {when(r.last_at)}<br />{r.calls}&nbsp;{r.calls === 1 ? 'call' : 'calls'}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
