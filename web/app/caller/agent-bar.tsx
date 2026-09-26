'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Phone, Send, X } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { AVATAR_BASE, CALL_ACCOUNTS, CALLER_AGENTS, NO_PORTRAIT, initials, type CallChannel, type CallerAgent } from './agents';

// Owner 2026-09-26: a row of small agent avatars with names on top of Caller. A click opens a
// small popup: the account the agent calls from and the last 10 numbers it called. On the
// Telegram tab the popup shows the Telegram account; on WhatsApp — the WhatsApp number.

interface Recipient { phone: string; label: string | null; last_at: number; calls: number }

function when(value: number) {
  return new Date(value * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Yerevan', dateStyle: 'medium', timeStyle: 'short' });
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
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(null); };
    const onClick = (event: MouseEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, [open]);

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
          <div className="flex items-start gap-3">
            <Avatar agent={open} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-extrabold text-foreground">{open.name}</p>
              {open.role && <p className="truncate text-sm font-semibold text-stone-500">{open.role}</p>}
            </div>
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
                      <span className="block whitespace-nowrap font-bold text-foreground">+{r.phone}</span>
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
