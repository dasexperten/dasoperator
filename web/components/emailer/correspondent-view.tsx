'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, AlertCircle, UserPlus, ExternalLink } from 'lucide-react';
import { getMailboxes, getMailboxMessages, getPartners } from '@/lib/api';
import {
  type MailEntry,
  correspondent,
  displayName,
  dotColor,
  emailAddr,
  fmtRelative,
  fmtDate,
  originOf,
} from './shared';

const PAGE = 20;

// "Re: Re: Fwd: Offer" and "Offer" are the same conversation.
function normSubject(s: string | undefined): string {
  return (s || '').replace(/^\s*((re|fwd?|aw|sv):\s*)+/i, '').trim().toLowerCase();
}

// Median hours the counterparty takes to answer one of our sent messages.
function replyTempoHours(sortedAsc: MailEntry[]): number | null {
  const deltas: number[] = [];
  for (let i = 0; i < sortedAsc.length; i++) {
    const cur = sortedAsc[i];
    if (!cur || cur.direction !== 'sent') continue;
    const next = sortedAsc.slice(i + 1).find((e) => e.direction === 'received');
    if (!next) continue;
    const d = Date.parse(next.timestamp) - Date.parse(cur.timestamp);
    if (Number.isFinite(d) && d > 0) deltas.push(d / (60 * 60 * 1000));
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? null;
}

function fmtTempo(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return '<1h';
  if (hours < 48) return `~${Math.round(hours)}h`;
  return `~${Math.round(hours / 24)}d`;
}

// CRM correspondence feed for one counterparty (approved mockup 4):
// name header + AWAITING REPLY badge, 4 metrics, per-mailbox filter chips,
// vertical chronology with direction dots, partner-card link.
export default function CorrespondentView({
  address,
  onBack,
  onOpenMessage,
}: {
  address: string;
  onBack: () => void;
  onOpenMessage: (entry: MailEntry) => void;
}) {
  const [entries, setEntries] = useState<MailEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partner, setPartner] = useState<{ id: string; trade_name: string } | null>(null);
  const [mailboxFilter, setMailboxFilter] = useState<string>('all');
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries([]);
    setMailboxFilter('all');
    setShown(PAGE);

    (async () => {
      try {
        const mb = await getMailboxes();
        if (cancelled) return;
        if (!mb.success || !mb.result) {
          setError(mb.errors?.[0]?.message || 'Failed to load correspondence');
          return;
        }
        const who = emailAddr(address);
        const lists = await Promise.all(
          mb.result.mailboxes.map(async (m) => {
            try {
              const r = await getMailboxMessages(m.address);
              return r.success && r.result
                ? r.result.entries
                    .map((e) => ({ ...e, mailbox: m.address }))
                    .filter((e) => emailAddr(correspondent(e)) === who)
                : [];
            } catch {
              return [];
            }
          })
        );
        if (cancelled) return;
        const merged = lists.flat().sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
        setEntries(merged);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    (async () => {
      try {
        const r = await getPartners();
        if (cancelled || !r.success || !r.result) return;
        const who = emailAddr(address);
        const hit = r.result.partners.find((p) => p.email && emailAddr(p.email) === who);
        if (hit) setPartner({ id: hit.id, trade_name: hit.trade_name });
      } catch {
        /* partner link is best-effort */
      }
    })();

    return () => { cancelled = true; };
  }, [address]);

  const latest = entries[0];
  const bare = emailAddr(address);
  const name = latest ? displayName(correspondent(latest)) : displayName(address);
  const awaiting = !!latest && latest.direction === 'received';

  const metrics = useMemo(() => {
    const asc = [...entries].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    const threads = new Set(entries.map((e) => normSubject(e.subject))).size;
    return {
      messages: entries.length,
      threads,
      tempo: fmtTempo(replyTempoHours(asc)),
      lastContact: latest ? fmtRelative(latest.timestamp) : '—',
    };
  }, [entries, latest]);

  const byMailbox = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.mailbox, (m.get(e.mailbox) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const filtered = mailboxFilter === 'all' ? entries : entries.filter((e) => e.mailbox === mailboxFilter);
  const visible = filtered.slice(0, shown);
  const moreCount = filtered.length - visible.length;

  return (
    <div className="emailer-dark ed-screen rounded-[14px] p-5">
      <button onClick={onBack} className="ed-action mb-4 flex items-center gap-1.5 text-sm" style={{ color: 'var(--ed-text-2)' }}>
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      {loading ? (
        <div className="p-10 text-center"><Loader2 className="h-7 w-7 animate-spin mx-auto" style={{ color: 'var(--ed-meta)' }} /></div>
      ) : error ? (
        <div className="p-4 flex items-center gap-2 rounded-md" style={{ background: 'var(--ed-card)' }}>
          <AlertCircle className="h-5 w-5" style={{ color: 'var(--ed-out)' }} /> <span className="text-sm">{error}</span>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Header */}
          <div>
            <div className="flex items-start gap-3 flex-wrap">
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0" style={{ background: dotColor(bare), color: '#fff' }}>
                {(name[0] || '?').toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="ed-display ed-h2 leading-tight break-words">{name}</div>
                <div className="text-sm mt-0.5 break-all" style={{ color: 'var(--ed-text-2)' }}>{bare}</div>
              </div>
              {awaiting && (
                <span className="text-[11px] font-bold px-2 py-1 rounded self-center" style={{ background: 'var(--ed-gold)', color: 'var(--ed-gold-text)' }}>
                  AWAITING REPLY
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-4 flex-wrap text-sm">
              {partner ? (
                <Link href={`/partners/${partner.id}`} className="ed-action inline-flex items-center gap-1 font-semibold" style={{ color: 'var(--ed-gold)' }}>
                  <ExternalLink className="h-3.5 w-3.5" /> Partner: {partner.trade_name}
                </Link>
              ) : (
                <Link href={`/partners/new?email=${encodeURIComponent(bare)}`} className="ed-action inline-flex items-center gap-1 font-semibold" style={{ color: 'var(--ed-text-2)' }}>
                  <UserPlus className="h-3.5 w-3.5" /> Create partner
                </Link>
              )}
            </div>
          </div>

          {/* Metrics */}
          <div className="ed-metrics">
            {[
              { label: 'Messages', value: String(metrics.messages) },
              { label: 'Threads', value: String(metrics.threads) },
              { label: 'Their reply tempo', value: metrics.tempo },
              { label: 'Last contact', value: metrics.lastContact },
            ].map((m) => (
              <div key={m.label} className="ed-card p-3">
                <div className="ed-display text-xl">{m.value}</div>
                <div className="text-[11px] mt-1" style={{ color: 'var(--ed-meta)' }}>{m.label}</div>
              </div>
            ))}
          </div>

          {/* Mailbox filter chips */}
          {byMailbox.length > 1 && (
            <div className="ed-tabs" style={{ gap: '8px' }}>
              <button className="ed-chip" data-active={mailboxFilter === 'all'} onClick={() => { setMailboxFilter('all'); setShown(PAGE); }}>
                All {entries.length}
              </button>
              {byMailbox.map(([mbox, n]) => (
                <button key={mbox} className="ed-chip" data-active={mailboxFilter === mbox} onClick={() => { setMailboxFilter(mbox); setShown(PAGE); }}>
                  {mbox.split('@')[0]} {n}
                </button>
              ))}
            </div>
          )}

          {/* Chronology */}
          {visible.length === 0 ? (
            <div className="p-10 text-center text-sm" style={{ color: 'var(--ed-meta)' }}>No correspondence yet.</div>
          ) : (
            <div className="space-y-1.5">
              {visible.map((e) => {
                const system = originOf(e) === 'auto';
                const dot = system ? 'var(--ed-system-text)' : e.direction === 'received' ? 'var(--ed-in)' : 'var(--ed-out)';
                return (
                  <button
                    key={`${e.mailbox}:${e.key}`}
                    onClick={() => onOpenMessage(e)}
                    className="w-full text-left ed-card p-3 flex items-center gap-3 dx-hoverable"
                    style={system ? { opacity: 0.65 } : undefined}
                  >
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: dot }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ color: system ? 'var(--ed-system-text-2)' : 'var(--ed-text)' }}>
                        {e.subject || '(no subject)'}
                      </div>
                      <div className="text-xs truncate mt-0.5" style={{ color: 'var(--ed-meta)' }}>
                        {e.direction === 'received' ? '←' : '→'} {e.mailbox} · {fmtDate(e.timestamp)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {moreCount > 0 && (
            <button onClick={() => setShown((n) => n + PAGE)} className="ed-action text-sm font-semibold" style={{ color: 'var(--ed-gold)' }}>
              Show {moreCount} more →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
