'use client';

import { useEffect, useMemo, useState } from 'react';
import { Mail, Inbox as InboxIcon, RefreshCw, Loader2, AlertCircle, ArrowLeft, ArrowUpRight, ArrowDownLeft, Reply, Send, X, CheckCircle2, Search } from 'lucide-react';
import {
  getMailboxes,
  getMailboxMessages,
  getMailboxMessage,
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

// Locally-persisted read state. The archive has no `read` field server-side
// (it's a plain R2 index, shared by nothing but this browser tab), so "read"
// here is a per-browser convenience, not a synced/multi-user flag — good
// enough to kill the "which of these have I already looked at" problem
// without a schema migration. Keyed by mailbox address so unread counts stay
// scoped per mailbox.
const READ_KEY_PREFIX = 'dasoperator:emailer:read:';

function loadReadSet(address: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(READ_KEY_PREFIX + address);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function saveReadSet(address: string, set: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(READ_KEY_PREFIX + address, JSON.stringify(Array.from(set)));
  } catch {
    // localStorage full/unavailable — read-state is a convenience, never block on it.
  }
}

// Internal Cloudflare mail client — reads the R2 Inbox/<mailbox>/... archive
// written by api/src/lib/inbox-archive.ts. No connection to the Gmail/
// EMAILER bridge (that's the separate "History" tab). Read-only over the
// underlying mail itself: this is an audit view of what was actually sent
// and received, plus an inline Reply action via Resend.
export default function CloudflareInboxView() {
  const [mailboxes, setMailboxes] = useState<MailboxSummary[]>([]);
  const [loadingMailboxes, setLoadingMailboxes] = useState(true);
  const [mailboxError, setMailboxError] = useState<string | null>(null);

  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [entries, setEntries] = useState<MailboxIndexEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [readKeys, setReadKeys] = useState<Set<string>>(new Set());

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
    setLoadingMailboxes(true);
    setMailboxError(null);
    try {
      const r = await getMailboxes();
      if (r.success && r.result) setMailboxes(r.result.mailboxes);
      else setMailboxError(r.errors?.[0]?.message || 'Failed to load mailboxes');
    } catch (e) {
      setMailboxError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoadingMailboxes(false);
    }
  }

  useEffect(() => { loadMailboxes(); }, []);

  async function selectMailbox(address: string) {
    setSelectedAddress(address);
    setSelectedEntry(null);
    setRecord(null);
    setQuery('');
    setReadKeys(loadReadSet(address));
    setLoadingEntries(true);
    setEntriesError(null);
    try {
      const r = await getMailboxMessages(address);
      if (r.success && r.result) setEntries(r.result.entries);
      else setEntriesError(r.errors?.[0]?.message || 'Failed to load messages');
    } catch (e) {
      setEntriesError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoadingEntries(false);
    }
  }

  async function selectEntry(entry: MailboxIndexEntry) {
    if (!selectedAddress) return;
    setSelectedEntry(entry);
    setRecord(null);
    setReplyOpen(false);
    setSentOk(false);
    setLoadingRecord(true);
    setRecordError(null);

    // Mark read immediately on open — no need to wait for the fetch.
    setReadKeys((prev) => {
      if (prev.has(entry.key)) return prev;
      const next = new Set(prev).add(entry.key);
      saveReadSet(selectedAddress, next);
      return next;
    });

    try {
      const r = await getMailboxMessage(selectedAddress, entry.key);
      if (r.success && r.result) setRecord(r.result.record);
      else setRecordError(r.errors?.[0]?.message || 'Failed to load message');
    } catch (e) {
      setRecordError(e instanceof Error ? e.message : 'Error');
    } finally {
      setLoadingRecord(false);
    }
  }

  const filteredEntries = useMemo(() => {
    const sorted = [...entries]; // already newest-first from the API
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((e) => {
      const haystack = [e.subject, e.from, fmtAddressList(e.to)].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [entries, query]);

  const unreadInSelected = useMemo(
    () => entries.filter((e) => !readKeys.has(e.key)).length,
    [entries, readKeys],
  );

  // Mailbox list (default view). Split into Inbound (mail routed IN to
  // Das Operator, e.g. sales@dasexperten.com) and System outbound (the
  // notify.* addresses the ERP sends FROM). Split key: notify. = outbound.
  const inboundMailboxes = mailboxes.filter((m) => !m.address.includes('@notify.'));
  const outboundMailboxes = mailboxes.filter((m) => m.address.includes('@notify.'));

  // Local part before @, used for the display name and avatar initial.
  const localPart = (addr: string) => (addr.split('@')[0] || addr).trim();
  const avatarInitial = (addr: string) => (localPart(addr)[0] || '?').toUpperCase();
  // Deterministic warm avatar colour derived from the address, kept in the
  // brand's earthy range so it never clashes with rot/gold.
  const avatarColor = (addr: string) => {
    const palette = ['#B23A2E', '#8A6D3B', '#4A6B57', '#5A5566', '#7A5230', '#3F5E6B'];
    let h = 0;
    for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  };

  const renderMailboxRow = (m: MailboxSummary, inbound: boolean) => (
    <button
      key={m.address}
      onClick={() => selectMailbox(m.address)}
      className="w-full text-left px-4 py-3.5 flex items-center gap-3 border-b border-border last:border-b-0 hover:bg-secondary/40 transition-colors"
      style={inbound && m.count > 0 ? { background: 'linear-gradient(90deg, var(--bg-danger, #FCEBEB) 0%, transparent 42%)' } : undefined}
    >
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-white text-base"
        style={{ background: inbound ? 'var(--brand-rot, #E5202C)' : avatarColor(m.address), fontFamily: 'var(--font-display, inherit)', fontWeight: 900, boxShadow: 'var(--shadow-raised)' }}
      >
        {avatarInitial(m.address)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground truncate" style={{ fontFamily: 'var(--font-display, inherit)', fontWeight: 800 }}>{m.address}</span>
          <span
            className="shrink-0 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded"
            style={inbound
              ? { background: 'var(--bg-danger, #FCEBEB)', color: 'var(--brand-rot, #E5202C)' }
              : { background: 'var(--paper-sunk, #F3F0E8)', color: 'var(--fg-2, #6E6558)' }}
          >
            {inbound ? 'Inbound' : 'Sys'}
          </span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {localPart(m.address)} · {m.count} {m.count === 1 ? 'message' : 'messages'}
        </div>
      </div>

      <div className="text-right shrink-0 flex items-center gap-3">
        <div>
          <div
            className="text-sm font-bold tabular-nums"
            style={{ color: inbound ? 'var(--brand-rot, #E5202C)' : 'var(--fg-2, #6E6558)', fontFamily: 'var(--font-mono, inherit)' }}
          >
            {m.count}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{fmtDate(m.last_activity)}</div>
        </div>
        {inbound && m.count > 0 && (
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: 'var(--brand-rot, #E5202C)' }} />
        )}
      </div>
    </button>
  );

  if (!selectedAddress) {
    return (
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 style={{ fontFamily: 'var(--font-display, inherit)', fontWeight: 900, fontSize: 'var(--fs-h3, 24px)', color: 'var(--fg-1, inherit)' }}>Mailboxes</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Cloudflare email archive — inbound mail routed to Das Operator and outbound system mail
            </p>
          </div>
          <button
            onClick={loadMailboxes}
            className="text-sm rounded-md px-3.5 py-2 inline-flex items-center gap-2"
            style={{ background: 'var(--brand-schwarz, #282229)', color: '#fff', fontWeight: 700, boxShadow: 'var(--shadow-raised)' }}
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>

        {loadingMailboxes ? (
          <div className="p-8 text-center"><Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" /></div>
        ) : mailboxError ? (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-600" /> <span className="text-red-800">{mailboxError}</span>
          </div>
        ) : mailboxes.length === 0 ? (
          <div className="bg-card border border-border rounded-lg shadow-md p-8 text-center">
            <InboxIcon className="h-12 w-12 mx-auto text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">No archived mailboxes yet</p>
          </div>
        ) : (
          <div className="space-y-6">
            <div>
              <div className="dx-eyebrow-rot mb-2">Inbound</div>
              <div className="bg-card border border-border rounded-lg shadow-md">
                {inboundMailboxes.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    No inbound mail yet — messages sent to sales@, support@, eurasia@, emea@, asean@ or dr.badalyan@dasexperten.com will appear here.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {inboundMailboxes.map((m) => renderMailboxRow(m, true))}
                  </div>
                )}
              </div>
            </div>

            {outboundMailboxes.length > 0 && (
              <div>
                <div className="dx-eyebrow-rot mb-2">System (outbound)</div>
                <div className="bg-card border border-border rounded-lg shadow-md">
                  <div className="divide-y divide-border">
                    {outboundMailboxes.map((m) => renderMailboxRow(m, false))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Split-pane view: message list (left) + message detail (right), both
  // visible together once a mailbox is picked — no more full-page drill-down
  // between "list" and "detail". Switching messages just swaps the right
  // pane; the list and the mailbox switcher stay put.
  return (
    <div>
      <button
        onClick={() => { setSelectedAddress(null); setEntries([]); setSelectedEntry(null); setRecord(null); }}
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> All mailboxes
      </button>

      <div className="flex gap-4 items-start" style={{ minHeight: 480 }}>
        {/* Left pane: search + message list */}
        <div className="w-full max-w-sm shrink-0 bg-card border border-border rounded-lg shadow-md flex flex-col" style={{ maxHeight: 720 }}>
          <div className="p-3 border-b border-border space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-foreground truncate">{selectedAddress}</h2>
              <button onClick={() => selectMailbox(selectedAddress)} title="Refresh" className="shrink-0 text-muted-foreground hover:text-foreground p-1">
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>
            {unreadInSelected > 0 && (
              <div className="text-xs" style={{ color: 'var(--brand-rot, #E5202C)' }}>
                {unreadInSelected} unread
              </div>
            )}
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search subject, from, to…"
                className="w-full border border-border rounded-md pl-8 pr-2 py-1.5 text-sm bg-card"
              />
            </div>
          </div>

          <div className="overflow-y-auto flex-1">
            {loadingEntries ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></div>
            ) : entriesError ? (
              <div className="p-4 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-red-600 shrink-0" /> <span className="text-sm text-red-800">{entriesError}</span>
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="p-8 text-center">
                <Mail className="h-10 w-10 mx-auto text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">
                  {entries.length === 0 ? 'No mail archived for this mailbox yet' : 'No messages match your search'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filteredEntries.map((e) => {
                  const unread = !readKeys.has(e.key);
                  const active = selectedEntry?.key === e.key;
                  return (
                    <button
                      key={e.key}
                      onClick={() => selectEntry(e)}
                      className="w-full text-left p-3 hover:bg-secondary/50 transition-colors flex items-start gap-2"
                      style={active ? { background: 'var(--paper-sunk, #F3F0E8)' } : undefined}
                    >
                      {unread && (
                        <span className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0" style={{ background: 'var(--brand-rot, #E5202C)' }} />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          {e.direction === 'sent' ? (
                            <ArrowUpRight className="h-3 w-3 text-emerald-600 shrink-0" />
                          ) : (
                            <ArrowDownLeft className="h-3 w-3 text-blue-600 shrink-0" />
                          )}
                          <h3 className={`text-sm truncate ${unread ? 'font-bold text-foreground' : 'font-medium text-muted-foreground'}`}>
                            {e.subject || '(no subject)'}
                          </h3>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {e.direction === 'sent' ? `To: ${fmtAddressList(e.to)}` : `From: ${e.from || '—'}`}
                        </p>
                        <p className="text-xs text-muted-foreground/70 mt-0.5">{fmtDate(e.timestamp)}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right pane: message detail */}
        <div className="flex-1 min-w-0">
          {!selectedEntry ? (
            <div className="bg-card border border-border rounded-lg shadow-md p-12 text-center">
              <Mail className="h-12 w-12 mx-auto text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">Select a message to read it</p>
            </div>
          ) : loadingRecord ? (
            <div className="bg-card border border-border rounded-lg shadow-md p-12 text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
            </div>
          ) : recordError ? (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-600" /> <span className="text-red-800">{recordError}</span>
            </div>
          ) : record ? (
            <div className="bg-card border border-border rounded-lg shadow-md">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    {record.direction === 'sent' ? (
                      <ArrowUpRight className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <ArrowDownLeft className="h-4 w-4 text-blue-600" />
                    )}
                    <h2 className="truncate" style={{ fontFamily: 'var(--font-display, inherit)', fontWeight: 800, fontSize: 'var(--fs-h4, 20px)', color: 'var(--fg-1, inherit)' }}>{record.subject || '(no subject)'}</h2>
                  </div>
                  {record.direction === 'received' && !replyOpen && (
                    <button
                      onClick={openReply}
                      className="shrink-0 flex items-center gap-1.5 text-sm font-medium rounded-md px-3 py-1.5"
                      style={{ background: 'var(--brand-rot, #E5202C)', color: '#fff', fontWeight: 700, boxShadow: 'var(--shadow-raised)' }}
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
                      style={{ background: 'var(--brand-rot, #E5202C)', color: '#fff', fontWeight: 700, boxShadow: 'var(--shadow-raised)' }}
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
      </div>
    </div>
  );
}
