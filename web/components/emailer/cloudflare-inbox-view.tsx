'use client';

import { useEffect, useState } from 'react';
import { Mail, Inbox as InboxIcon, RefreshCw, Loader2, AlertCircle, ArrowLeft, ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import {
  getMailboxes,
  getMailboxMessages,
  getMailboxMessage,
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

// Internal Cloudflare mail client — reads the R2 Inbox/<mailbox>/... archive
// written by api/src/lib/inbox-archive.ts. No connection to the Gmail/
// EMAILER bridge (that's the separate "History" tab). Read-only: this is an
// audit view of what the notify.dasexperten.com senders have actually sent
// (and, in future, received), not a place to compose or act on mail.
export default function CloudflareInboxView() {
  const [mailboxes, setMailboxes] = useState<MailboxSummary[]>([]);
  const [loadingMailboxes, setLoadingMailboxes] = useState(true);
  const [mailboxError, setMailboxError] = useState<string | null>(null);

  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [entries, setEntries] = useState<MailboxIndexEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);

  const [selectedEntry, setSelectedEntry] = useState<MailboxIndexEntry | null>(null);
  const [record, setRecord] = useState<MailboxMessageRecord | null>(null);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

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
    setLoadingRecord(true);
    setRecordError(null);
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

  // Message detail — takes over the right pane when an entry is selected.
  if (selectedAddress && selectedEntry) {
    return (
      <div>
        <button
          onClick={() => { setSelectedEntry(null); setRecord(null); }}
          className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to {selectedAddress}
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
              <div className="flex items-center gap-2 mb-1">
                {record.direction === 'sent' ? (
                  <ArrowUpRight className="h-4 w-4 text-emerald-600" />
                ) : (
                  <ArrowDownLeft className="h-4 w-4 text-blue-600" />
                )}
                <h2 className="text-base font-semibold text-foreground">{record.subject || '(no subject)'}</h2>
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

  // Message list for a selected mailbox.
  if (selectedAddress) {
    return (
      <div>
        <button
          onClick={() => { setSelectedAddress(null); setEntries([]); }}
          className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> All mailboxes
        </button>

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">{selectedAddress}</h2>
          <button onClick={() => selectMailbox(selectedAddress)} className="text-sm border border-border rounded-md px-3 py-1.5 inline-flex items-center gap-2 hover:bg-muted">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>

        {loadingEntries ? (
          <div className="p-8 text-center"><Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" /></div>
        ) : entriesError ? (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-600" /> <span className="text-red-800">{entriesError}</span>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-lg shadow-sm">
            {entries.length === 0 ? (
              <div className="p-8 text-center">
                <Mail className="h-12 w-12 mx-auto text-muted-foreground" />
                <p className="mt-2 text-sm text-muted-foreground">No mail archived for this mailbox yet</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {entries.map((e) => (
                  <button
                    key={e.key}
                    onClick={() => selectEntry(e)}
                    className="w-full text-left p-4 hover:bg-secondary/50 transition-colors flex items-start justify-between gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        {e.direction === 'sent' ? (
                          <ArrowUpRight className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                        ) : (
                          <ArrowDownLeft className="h-3.5 w-3.5 text-blue-600 shrink-0" />
                        )}
                        <h3 className="text-sm font-medium text-foreground truncate">{e.subject || '(no subject)'}</h3>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {e.direction === 'sent' ? `To: ${fmtAddressList(e.to)}` : `From: ${e.from || '—'}`}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(e.timestamp)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Mailbox list (default view). Split into Inbound (mail routed IN to
  // Das Operator, e.g. sales@dasexperten.com) and System outbound (the
  // notify.* addresses the ERP sends FROM). Split key: notify. = outbound.
  const inboundMailboxes = mailboxes.filter((m) => !m.address.includes('@notify.'));
  const outboundMailboxes = mailboxes.filter((m) => m.address.includes('@notify.'));

  const renderMailboxRow = (m: MailboxSummary, inbound: boolean) => (
    <button
      key={m.address}
      onClick={() => selectMailbox(m.address)}
      className="w-full text-left p-4 hover:bg-secondary/50 transition-colors flex items-center justify-between gap-4"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
          style={{ background: inbound ? 'var(--bg-accent, #FCEBEB)' : 'var(--paper-sunk, #F3F0E8)' }}
        >
          {inbound ? (
            <ArrowDownLeft className="h-4 w-4" style={{ color: 'var(--brand-rot, #E5202C)' }} />
          ) : (
            <Mail className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{m.address}</div>
          <div className="text-xs text-muted-foreground">{m.count} {m.count === 1 ? 'message' : 'messages'}</div>
        </div>
      </div>
      <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(m.last_activity)}</span>
    </button>
  );

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Mailboxes</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Cloudflare email archive — inbound mail routed to Das Operator and outbound system mail, read-only
          </p>
        </div>
        <button onClick={loadMailboxes} className="text-sm border border-border rounded-md px-3 py-1.5 inline-flex items-center gap-2 hover:bg-muted">
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
        <div className="bg-card border border-border rounded-lg shadow-sm p-8 text-center">
          <InboxIcon className="h-12 w-12 mx-auto text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">No archived mailboxes yet</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <div className="dx-eyebrow-rot mb-2">Inbound</div>
            <div className="bg-card border border-border rounded-lg shadow-sm">
              {inboundMailboxes.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No inbound mail yet — messages sent to sales@, support@, eurasia@, emea@ or asean@dasexperten.com will appear here.
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
              <div className="bg-card border border-border rounded-lg shadow-sm">
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
