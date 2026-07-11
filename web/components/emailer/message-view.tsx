'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, AlertCircle, Reply, Send, X, CheckCircle2, Paperclip, History } from 'lucide-react';
import {
  getMailboxMessage,
  getMailboxMessageSummaryV2,
  getMailboxMessages,
  sendReply,
  markMailRead,
  type MailboxMessageRecord,
} from '@/lib/api';
import { type MailEntry, fmtDate, fmtAddressList, correspondent, displayName } from './shared';

const APEX_SENDERS = [
  'sales@dasexperten.com',
  'support@dasexperten.com',
  'emea@dasexperten.com',
  'eurasia@dasexperten.com',
  'asean@dasexperten.com',
  'dr.badalyan@dasexperten.com',
];

export default function MessageView({
  entry,
  onBack,
  onOpenCorrespondent,
}: {
  entry: MailEntry;
  onBack: () => void;
  onOpenCorrespondent?: (address: string) => void;
}) {
  const [record, setRecord] = useState<MailboxMessageRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [thread, setThread] = useState<MailEntry[]>([]);

  const [replyOpen, setReplyOpen] = useState(false);
  const [replyTo, setReplyTo] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [replyFrom, setReplyFrom] = useState('sales@dasexperten.com');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentOk, setSentOk] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRecord(null);
    setError(null);
    setSummary(null);
    setSummaryLoading(true);
    setThread([]);

    (async () => {
      try {
        const r = await getMailboxMessage(entry.mailbox, entry.key);
        if (cancelled) return;
        if (r.success && r.result) setRecord(r.result.record);
        else setError(r.errors?.[0]?.message || 'Failed to load message');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    (async () => {
      try {
        const r = await getMailboxMessageSummaryV2(entry.mailbox, entry.key);
        if (!cancelled && r.success && r.result) setSummary(r.result.summary);
      } catch { /* skeleton stays, non-fatal */ }
      finally { if (!cancelled) setSummaryLoading(false); }
    })();

    (async () => {
      try {
        const r = await getMailboxMessages(entry.mailbox);
        if (cancelled || !r.success || !r.result) return;
        const who = correspondent(entry).toLowerCase();
        const related = r.result.entries
          .map((e) => ({ ...e, mailbox: entry.mailbox }))
          .filter((e) => correspondent(e).toLowerCase() === who)
          .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
          .slice(-8);
        setThread(related);
      } catch { /* mini-timeline is best-effort */ }
    })();

    if (entry.direction === 'received') {
      markMailRead([entry.key], entry.mailbox).catch(() => { /* best-effort */ });
    }

    return () => { cancelled = true; };
  }, [entry.mailbox, entry.key]); // eslint-disable-line react-hooks/exhaustive-deps

  function openReply() {
    if (!record) return;
    const orig = Array.isArray(record.from) ? record.from[0] : record.from;
    setReplyTo(orig || '');
    const arrivedAt = (record.address || '').toLowerCase();
    if (APEX_SENDERS.includes(arrivedAt)) setReplyFrom(arrivedAt);
    const subj = record.subject || '';
    setReplySubject(subj.toLowerCase().startsWith('re:') ? subj : `Re: ${subj}`);
    setReplyBody('');
    setSendError(null);
    setSentOk(false);
    setReplyOpen(true);
  }

  async function submitReply() {
    if (!replyTo || !replySubject || !replyBody) {
      setSendError('Fill in recipient, subject and message.');
      return;
    }
    setSending(true);
    setSendError(null);
    try {
      const r = await sendReply({
        to: replyTo,
        subject: replySubject,
        text: replyBody,
        from: replyFrom,
        in_reply_to: record?.messageId,
      });
      if (r.success) {
        setSentOk(true);
        setReplyOpen(false);
      } else {
        setSendError(r.error || 'Send failed');
      }
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  const counterparty = record ? correspondent(record) : correspondent(entry);
  const who = displayName(counterparty);

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
      ) : record ? (
        <div className="space-y-5">
          <div>
            <div className="text-xs" style={{ color: 'var(--ed-meta)' }}>{entry.mailbox}</div>
            <div className="ed-display ed-h2 leading-tight mt-1 break-words">{who}</div>
            <div className="flex items-center gap-2 text-sm mt-1 flex-wrap">
              <span style={{ color: record.direction === 'received' ? 'var(--ed-in)' : 'var(--ed-out)' }}>
                {record.direction === 'received' ? 'Received' : 'Sent'}
              </span>
              <span style={{ color: 'var(--ed-meta)' }}>· {fmtDate(record.timestamp)}</span>
              {onOpenCorrespondent && counterparty && (
                <button
                  onClick={() => onOpenCorrespondent(counterparty)}
                  className="ed-action inline-flex items-center gap-1 text-xs font-semibold"
                  style={{ color: 'var(--ed-gold)' }}
                >
                  <History className="h-3.5 w-3.5" /> History
                </button>
              )}
            </div>
            <div className="text-sm mt-2" style={{ color: 'var(--ed-text-2)' }}>{record.subject || '(no subject)'}</div>
            {thread.length > 1 && (
              <div className="text-xs mt-0.5" style={{ color: 'var(--ed-meta)' }}>{thread.length} messages in this thread</div>
            )}
          </div>

          {/* WHAT THEY WANT — AI digest */}
          <div className="ed-card p-4" style={{ borderLeft: '3px solid var(--ed-gold)' }}>
            <div className="text-xs font-bold mb-2" style={{ color: 'var(--ed-gold)' }}>WHAT THEY WANT</div>
            {summaryLoading ? (
              <div className="space-y-1.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-3 rounded animate-pulse" style={{ background: 'var(--ed-border-strong)', width: `${90 - i * 15}%` }} />
                ))}
              </div>
            ) : (
              <div className="text-sm whitespace-pre-line" style={{ color: 'var(--ed-text)' }}>{summary || 'No summary available.'}</div>
            )}
          </div>

          {/* Attachment chips — the archive stores html/text only today, no
              binary attachments yet, so this shows a placeholder chip iff the
              record signals one exists via a truthy `attachments` field. */}
          {Array.isArray((record as unknown as { attachments?: unknown[] }).attachments) &&
            (record as unknown as { attachments: unknown[] }).attachments.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              {(record as unknown as { attachments: { name?: string }[] }).attachments.map((a, i) => (
                <span key={i} className="ed-card px-2.5 py-1 text-xs inline-flex items-center gap-1.5">
                  <Paperclip className="h-3 w-3" /> {a.name || 'attachment'}
                </span>
              ))}
            </div>
          )}

          {sentOk && (
            <div className="ed-card p-3 flex items-center gap-2" style={{ borderLeft: '3px solid var(--ed-in)' }}>
              <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--ed-in)' }} />
              <span className="text-sm">Reply sent via Resend.</span>
            </div>
          )}

          {replyOpen ? (
            <div className="ed-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold" style={{ color: 'var(--ed-gold)' }}>REPLY</div>
                <button onClick={() => setReplyOpen(false)} aria-label="Close reply" className="ed-icon-btn p-1.5" style={{ color: 'var(--ed-text-2)' }}><X className="h-4 w-4" /></button>
              </div>
              <label className="block text-xs" style={{ color: 'var(--ed-text-2)' }}>
                From
                <select value={replyFrom} onChange={(e) => setReplyFrom(e.target.value)} className="mt-1 w-full rounded-md px-3 py-2 text-sm" style={{ background: 'var(--ed-body)', color: 'var(--ed-text)', border: '1px solid var(--ed-border)' }}>
                  {APEX_SENDERS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label className="block text-xs" style={{ color: 'var(--ed-text-2)' }}>
                To
                <input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} className="mt-1 w-full rounded-md px-3 py-2 text-sm" style={{ background: 'var(--ed-body)', color: 'var(--ed-text)', border: '1px solid var(--ed-border)' }} />
              </label>
              <label className="block text-xs" style={{ color: 'var(--ed-text-2)' }}>
                Subject
                <input value={replySubject} onChange={(e) => setReplySubject(e.target.value)} className="mt-1 w-full rounded-md px-3 py-2 text-sm" style={{ background: 'var(--ed-body)', color: 'var(--ed-text)', border: '1px solid var(--ed-border)' }} />
              </label>
              <label className="block text-xs" style={{ color: 'var(--ed-text-2)' }}>
                Message
                <textarea value={replyBody} onChange={(e) => setReplyBody(e.target.value)} rows={6} className="mt-1 w-full rounded-md px-3 py-2 text-sm" style={{ background: 'var(--ed-body)', color: 'var(--ed-text)', border: '1px solid var(--ed-border)' }} placeholder="Type your reply…" />
              </label>
              {sendError && (
                <div className="p-2 rounded-md flex items-center gap-2" style={{ background: 'var(--ed-body)' }}>
                  <AlertCircle className="h-4 w-4" style={{ color: 'var(--ed-out)' }} />
                  <span className="text-sm" style={{ color: 'var(--ed-out)' }}>{sendError}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button onClick={submitReply} disabled={sending} className="ed-btn-primary flex items-center gap-1.5 text-sm px-4 py-2 disabled:opacity-60">
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {sending ? 'Sending…' : 'Send reply'}
                </button>
                <button onClick={() => setReplyOpen(false)} className="ed-action text-sm px-3 py-2" style={{ color: 'var(--ed-text-2)' }}>Cancel</button>
              </div>
            </div>
          ) : record.direction === 'received' ? (
            <button onClick={openReply} className="ed-btn-primary flex items-center gap-1.5 text-sm px-4 py-2">
              <Reply className="h-4 w-4" /> Reply
            </button>
          ) : null}

          {/* Body */}
          <div className="rounded-md p-4" style={{ background: 'var(--ed-body)' }}>
            {record.html ? (
              <iframe
                srcDoc={record.html}
                sandbox=""
                title={record.subject || 'email body'}
                className="w-full min-h-[320px] h-[55vh] rounded-md bg-white"
              />
            ) : (
              <pre className="whitespace-pre-wrap text-sm font-sans" style={{ color: 'var(--ed-text)' }}>{record.text || '(empty body)'}</pre>
            )}
          </div>

          {/* Mini thread timeline — one line per message */}
          {thread.length > 1 && (
            <div>
              <div className="text-xs font-bold mb-2" style={{ color: 'var(--ed-text-2)' }}>THREAD</div>
              <div className="space-y-1">
                {thread.map((t) => (
                  <div key={t.key} className="text-xs flex items-center gap-2" style={{ color: t.key === entry.key ? 'var(--ed-text)' : 'var(--ed-meta)' }}>
                    <span style={{ color: t.direction === 'received' ? 'var(--ed-in)' : 'var(--ed-out)' }}>{t.direction === 'received' ? '←' : '→'}</span>
                    <span className="truncate flex-1">{t.subject || '(no subject)'}</span>
                    <span className="shrink-0">{fmtDate(t.timestamp)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-xs" style={{ color: 'var(--ed-meta)' }}>
            To: {fmtAddressList(record.to)}{record.cc ? ` · Cc: ${fmtAddressList(record.cc)}` : ''}
          </div>
        </div>
      ) : null}
    </div>
  );
}
