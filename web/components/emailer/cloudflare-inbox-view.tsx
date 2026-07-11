'use client';

import { useEffect, useState } from 'react';
import { Inbox as InboxIcon, RefreshCw, Loader2, AlertCircle, ArrowLeft, ArrowUpRight, ArrowDownLeft, Reply, Send, X, CheckCircle2 } from 'lucide-react';
import {
  getMailboxes,
  getMailboxMessages,
  getMailboxMessage,
  getMailboxMessageSummary,
  sendReply,
  type MailboxSummary,
  type MailboxIndexEntry,
  type MailboxMessageRecord,
} from '@/lib/api';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function fmtAddressList(v?: string | string[]): string {
  if (!v) return '—';
  return Array.isArray(v) ? v.join(', ') : v;
}

// The correspondent = the CUSTOMER on a message: who we received it from, or
// who we sent it to — never our own mailbox address.
function correspondent(e: { direction: 'sent' | 'received'; from?: string; to?: string | string[] }): string {
  const raw = e.direction === 'received' ? e.from : Array.isArray(e.to) ? e.to[0] : e.to;
  return (raw || '').trim();
}
// Human name out of a "Name <email>" or bare "email" string.
function displayName(addr: string): string {
  if (!addr) return '—';
  const named = addr.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (named && named[1]?.trim()) return named[1].trim();
  const at = addr.indexOf('@');
  return at > 0 ? addr.slice(0, at) : addr;
}
// Stable warm colour per correspondent, kept in the brand's earthy range.
function dotColor(seed: string): string {
  const palette = ['#B23A2E', '#8A6D3B', '#4A6B57', '#5A5566', '#7A5230', '#3F5E6B'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length] as string;
}

// Internal Cloudflare mail client — reads the R2 Inbox/<mailbox>/... archive
// written by api/src/lib/inbox-archive.ts. No connection to the Gmail/
// EMAILER bridge (that's the separate "History" tab). Read-only: this is an
// audit view of what the notify.dasexperten.com senders have actually sent
// (and, in future, received), not a place to compose or act on mail.
export default function CloudflareInboxView() {
  const [mailboxes, setMailboxes] = useState<MailboxSummary[]>([]);

  // Which group the inbox shows — switchable, one at a time.
  const [listView, setListView] = useState<'personal' | 'system'>('personal');

  // Flat message feed across the active group's mailboxes (the real inbox).
  type FeedEntry = MailboxIndexEntry & { mailbox: string; preview?: string };
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);

  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<MailboxIndexEntry | null>(null);
  const [record, setRecord] = useState<MailboxMessageRecord | null>(null);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  // Reply form state.
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyTo, setReplyTo] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [replyFrom, setReplyFrom] = useState('sales@my.dasexperten.com');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentOk, setSentOk] = useState(false);

  function openReply() {
    if (!record) return;
    const orig = Array.isArray(record.from) ? record.from[0] : record.from;
    setReplyTo(orig || '');
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

  async function loadMailboxes() {
    // Toggle counts are best-effort; the feed carries its own loading/error.
    try {
      const r = await getMailboxes();
      if (r.success && r.result) setMailboxes(r.result.mailboxes);
    } catch {
      /* ignore — counts only */
    }
  }

  // Build the flat inbox: pull each mailbox in the active group, merge their
  // messages, newest first. isGroup splits human mailboxes (Personal) from the
  // notify.* automated senders (System).
  const isGroup = (addr: string, group: 'personal' | 'system') =>
    group === 'system' ? addr.includes('@notify.') : !addr.includes('@notify.');

  async function loadFeed(group: 'personal' | 'system') {
    setLoadingFeed(true);
    setFeedError(null);
    try {
      const mb = await getMailboxes();
      if (!mb.success || !mb.result) {
        setFeedError(mb.errors?.[0]?.message || 'Failed to load mail');
        setFeed([]);
        return;
      }
      const addrs = mb.result.mailboxes.map((m) => m.address).filter((a) => isGroup(a, group));
      const lists = await Promise.all(
        addrs.map(async (a) => {
          try {
            const r = await getMailboxMessages(a);
            return r.success && r.result ? r.result.entries.map((e) => ({ ...e, mailbox: a })) : [];
          } catch {
            return [];
          }
        })
      );
      const merged = lists
        .flat()
        .sort((x, y) => (y.timestamp || '').localeCompare(x.timestamp || ''))
        .slice(0, 40);
      // Show the list immediately; 2-sentence AI summaries fill in progressively.
      setFeed(merged);
      setLoadingFeed(false);
      const withPreview = await Promise.all(
        merged.map(async (e) => {
          try {
            const r = await getMailboxMessageSummary(e.mailbox, e.key);
            return r.success && r.result ? { ...e, preview: r.result.summary } : e;
          } catch {
            return e;
          }
        })
      );
      setFeed(withPreview);
    } catch (e) {
      setFeedError(e instanceof Error ? e.message : 'Error');
      setFeed([]);
    } finally {
      setLoadingFeed(false);
    }
  }

  useEffect(() => { loadMailboxes(); }, []);
  useEffect(() => { loadFeed(listView); }, [listView]); // eslint-disable-line react-hooks/exhaustive-deps

  async function selectFeedEntry(entry: FeedEntry) {
    setSelectedAddress(entry.mailbox);
    setSelectedEntry(entry);
    setRecord(null);
    setLoadingRecord(true);
    setRecordError(null);
    try {
      const r = await getMailboxMessage(entry.mailbox, entry.key);
      if (r.success && r.result) setRecord(r.result.record);
      else setRecordError(r.errors?.[0]?.message || 'Failed to load message');
    } catch (e) {
      setRecordError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoadingRecord(false);
    }
  }

  // Message detail — takes over the pane when a message is selected.
  if (selectedAddress && selectedEntry) {
    return (
      <div>
        <button
          onClick={() => { setSelectedEntry(null); setSelectedAddress(null); setRecord(null); }}
          className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to inbox
        </button>

        {loadingRecord ? (
          <div className="p-8 text-center"><Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" /></div>
        ) : recordError ? (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-600" /> <span className="text-red-800">{recordError}</span>
          </div>
        ) : record ? (
          <div className="bg-card border border-border rounded-lg shadow-sm">
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  {record.direction === 'sent' ? (
                    <ArrowUpRight className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <ArrowDownLeft className="h-4 w-4 text-blue-600" />
                  )}
                  <h2 className="text-base font-bold text-foreground truncate">{record.subject || '(no subject)'}</h2>
                </div>
                {record.direction === 'received' && !replyOpen && (
                  <button
                    onClick={openReply}
                    className="shrink-0 flex items-center gap-1.5 text-sm font-medium rounded-md px-3 py-1.5"
                    style={{ background: 'var(--brand-rot, #E5202C)', color: '#fff' }}
                  >
                    <Reply className="h-4 w-4" /> Reply
                  </button>
                )}
              </div>
              <div className="text-xs text-muted-foreground space-y-0.5 mt-2">
                <div>From: {record.from || '—'}</div>
                <div>To: {fmtAddressList(record.to)}</div>
                {record.cc && <div>Cc: {fmtAddressList(record.cc)}</div>}
                {record.bcc && <div>Bcc: {fmtAddressList(record.bcc)}</div>}
                <div>{fmtDate(record.timestamp)}</div>
                {record.messageId && <div className="truncate">Message-Id: {record.messageId}</div>}
              </div>
            </div>

            {sentOk && (
              <div className="mx-4 mt-4 p-3 rounded-md flex items-center gap-2" style={{ background: 'var(--paper-sunk, #EAF3DE)' }}>
                <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--status-success, #2E7D4F)' }} />
                <span className="text-sm" style={{ color: 'var(--status-success, #2E7D4F)' }}>Reply sent via Resend.</span>
              </div>
            )}

            {replyOpen && (
              <div className="mx-4 mt-4 border border-border rounded-lg p-4 space-y-3" style={{ background: 'var(--paper-sunk, #F3F0E8)' }}>
                <div className="flex items-center justify-between">
                  <div className="dx-eyebrow-rot">Reply</div>
                  <button onClick={() => setReplyOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
                </div>
                <div className="space-y-2">
                  <label className="block text-xs text-muted-foreground">
                    From
                    <select value={replyFrom} onChange={(e) => setReplyFrom(e.target.value)} className="mt-1 w-full border border-border rounded-md px-3 py-2 text-sm bg-card">
                      <option value="sales@my.dasexperten.com">sales@my.dasexperten.com</option>
                      <option value="support@my.dasexperten.com">support@my.dasexperten.com</option>
                      <option value="eurasia@my.dasexperten.com">eurasia@my.dasexperten.com</option>
                      <option value="emea@my.dasexperten.com">emea@my.dasexperten.com</option>
                      <option value="asean@my.dasexperten.com">asean@my.dasexperten.com</option>
                    </select>
                  </label>
                  <label className="block text-xs text-muted-foreground">
                    To
                    <input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} className="mt-1 w-full border border-border rounded-md px-3 py-2 text-sm bg-card" />
                  </label>
                  <label className="block text-xs text-muted-foreground">
                    Subject
                    <input value={replySubject} onChange={(e) => setReplySubject(e.target.value)} className="mt-1 w-full border border-border rounded-md px-3 py-2 text-sm bg-card" />
                  </label>
                  <label className="block text-xs text-muted-foreground">
                    Message
                    <textarea value={replyBody} onChange={(e) => setReplyBody(e.target.value)} rows={6} className="mt-1 w-full border border-border rounded-md px-3 py-2 text-sm bg-card" placeholder="Type your reply…" />
                  </label>
                </div>
                {sendError && (
                  <div className="p-2 rounded-md flex items-center gap-2" style={{ background: 'var(--bg-danger, #FCEBEB)' }}>
                    <AlertCircle className="h-4 w-4" style={{ color: 'var(--brand-rot, #E5202C)' }} />
                    <span className="text-sm" style={{ color: 'var(--brand-rot, #E5202C)' }}>{sendError}</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    onClick={submitReply}
                    disabled={sending}
                    className="flex items-center gap-1.5 text-sm font-medium rounded-md px-4 py-2 disabled:opacity-60"
                    style={{ background: 'var(--brand-rot, #E5202C)', color: '#fff' }}
                  >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    {sending ? 'Sending…' : 'Send reply'}
                  </button>
                  <button onClick={() => setReplyOpen(false)} className="text-sm text-muted-foreground hover:text-foreground px-3 py-2">Cancel</button>
                </div>
                <p className="text-xs text-muted-foreground">Reply is sent through Resend from my.dasexperten.com. Inbound stays on Cloudflare.</p>
              </div>
            )}

            <div className="px-4 py-4">
              {record.html ? (
                // Sandboxed, scriptless iframe — some templates (e.g. lead-form
                // notifications) interpolate third-party input into the stored
                // HTML unescaped, so this must be treated as untrusted content,
                // never rendered via dangerouslySetInnerHTML in the admin UI.
                <iframe
                  srcDoc={record.html}
                  sandbox=""
                  title={record.subject || 'email body'}
                  className="w-full min-h-[300px] border border-border rounded-md bg-white"
                />
              ) : (
                <pre className="whitespace-pre-wrap text-sm text-foreground font-sans">{record.text || '(empty body)'}</pre>
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // Group counts for the toggle — sum of archived messages per group.
  const personalCount = mailboxes.filter((m) => !m.address.includes('@notify.')).reduce((s, m) => s + m.count, 0);
  const systemCount = mailboxes.filter((m) => m.address.includes('@notify.')).reduce((s, m) => s + m.count, 0);

  // One message row. The correspondent's FIRST letter lives inside the coloured
  // dot; the rest of their name continues immediately after it. The subject
  // rides alongside so the important info is visible without opening the mail.
  const renderFeedRow = (e: FeedEntry) => {
    const who = displayName(correspondent(e));
    const first = who[0] || '?';
    const rest = who.slice(1);
    const accent = dotColor(correspondent(e) || who);
    return (
      <button
        key={`${e.mailbox}:${e.key}`}
        onClick={() => selectFeedEntry(e)}
        className="relative w-full text-left px-4 py-3 block border-b border-border last:border-b-0 hover:bg-secondary/40 transition-colors"
      >
        {/* Date floats in the top-right corner — out of flow so the content
            below runs the full width of the row. */}
        <span className="absolute top-3 right-4 text-[10px] text-muted-foreground whitespace-nowrap">{fmtDate(e.timestamp)}</span>

        <div className="w-full min-w-0">
          <div className="flex items-baseline gap-1.5 min-w-0 pr-24">
            {/* Only the first letter is bold + coloured; the rest is normal. */}
            <span className="text-sm truncate shrink-0 max-w-[55%]">
              <span className="font-bold" style={{ color: accent }}>{first}</span>
              <span className="text-foreground">{rest}</span>
            </span>
            <span className="text-sm text-muted-foreground truncate">{e.subject || '(no subject)'}</span>
          </div>
          {/* Service-account mailbox, tiny italic, much smaller than the sender. */}
          <div className="text-[11px] italic text-muted-foreground truncate mt-0.5">{e.mailbox}</div>
          {/* 2-sentence AI summary of the message — full width. */}
          {e.preview && (
            <div
              className="text-xs text-muted-foreground mt-1"
              style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {e.preview}
            </div>
          )}
        </div>
      </button>
    );
  };

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-bold text-foreground">Inbox</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Cloudflare email archive — Personal (mail to sales@/support@/…) and System (notify.dasexperten.com), read-only
        </p>
      </div>

      <div className="space-y-4">
        {/* Toggle on the left, Refresh far right — same row */}
        <div className="flex items-center justify-between">
          <div className="inline-flex rounded-lg border border-border bg-secondary/40 p-0.5">
            {(['personal', 'system'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setListView(v)}
                className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${
                  listView === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {v === 'personal' ? 'Personal' : 'System'}
                <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
                  {v === 'personal' ? personalCount : systemCount}
                </span>
              </button>
            ))}
          </div>
          <button onClick={() => { loadMailboxes(); loadFeed(listView); }} className="text-sm border border-border rounded-md px-3 py-1.5 inline-flex items-center gap-2 hover:bg-muted">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>

        <div className="bg-card border border-border rounded-lg shadow-sm">
          {loadingFeed ? (
            <div className="p-8 text-center"><Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" /></div>
          ) : feedError ? (
            <div className="p-4 flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-600" /> <span className="text-red-800 text-sm">{feedError}</span>
            </div>
          ) : feed.length === 0 ? (
            <div className="p-8 text-center">
              <InboxIcon className="h-12 w-12 mx-auto text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                {listView === 'personal'
                  ? 'No personal mail yet — messages to sales@, support@, eurasia@, emea@ or asean@dasexperten.com will appear here.'
                  : 'No system mail yet — outbound notify.dasexperten.com messages will appear here.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {feed.map(renderFeedRow)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
