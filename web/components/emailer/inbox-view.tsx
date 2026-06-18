'use client';

import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Reply, Paperclip, AlertCircle } from 'lucide-react';
import { getEmailHistory, apiPost, type EmailThread } from '@/lib/api';
import ReplyModal from './reply-modal';

// Live history thread shape (richer than the declared EmailThread)
interface InboxThread {
  thread_id: string;
  subject: string;
  last_message_from: string;
  last_message_snippet: string;
  last_message_date: string;
  message_count: number;
  has_attachments: boolean;
  participants: string[];
}

// Senders that never need a human reply — spam, newsletters, system, marketplace bots.
const SYSTEM_RE = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|noreply|newsletter|mailer-daemon|postmaster|bounce|notification|mailing|digest|automated|robot|uvedoml|news@|info@|seller\.ozon|@ozon\.ru|marketplace@|support@dasexperten|@sберbank|sberbank)/i;
// Our own outbound — if the LAST message is from us, the ball is not in our court.
const OWN_RE = /dasexperten\.(de|ru)|dasexperten@gmail\.com|kosarevam491/i;

function emailOf(s: string): string {
  const m = s?.match(/<([^>]+)>/);
  return (m ? m[1] : s || '').toLowerCase();
}
function nameOf(s: string): string {
  const m = s?.match(/^"?([^"<]+?)"?\s*</);
  return (m ? m[1] : (s || '').split('@')[0]).trim().replace(/^"|"$/g, '');
}
function needsReply(t: InboxThread): boolean {
  const from = emailOf(t.last_message_from);
  if (!from) return false;                          // no sender
  if (SYSTEM_RE.test(t.last_message_from)) return false; // spam / newsletter / system
  if (OWN_RE.test(from)) return false;              // last message is ours → already handled
  if ((t.participants?.length ?? 0) > 4) return false;  // mass mailing
  return true;
}
function fmtDate(d: string): string {
  try { return new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return d; }
}

export default function InboxView() {
  const [all, setAll] = useState<InboxThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<EmailThread | null>(null);
  const [aiDraft, setAiDraft] = useState<string>('');
  const [drafting, setDrafting] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const r = await getEmailHistory('newer_than:30d', 100);
      if (r.success && r.result) setAll((r.result.threads as unknown as InboxThread[]) || []);
      else setError('Failed to load inbox');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const inbox = all.filter(needsReply).sort((a, b) => new Date(b.last_message_date).getTime() - new Date(a.last_message_date).getTime());
  const filtered = all.length - inbox.length;

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading inbox…</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Needs reply</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Last 30 days · newest first · spam, newsletters, mass-mailings and no-reply senders filtered out{filtered > 0 ? ` (${filtered} hidden)` : ''}</p>
        </div>
        <button onClick={load} className="text-sm border border-border rounded-md px-3 py-1.5 inline-flex items-center gap-2 hover:bg-muted"><RefreshCw className="h-4 w-4" /> Refresh</button>
      </div>

      {error && <div className="flex items-center gap-2 text-sm text-red-600 mb-3"><AlertCircle className="h-4 w-4" /> {error}</div>}

      <div className="rounded-lg border border-border overflow-hidden">
        {inbox.length === 0 && <div className="px-4 py-10 text-center text-muted-foreground">Inbox zero — nothing waiting on a reply.</div>}
        {inbox.map((t) => (
          <div key={t.thread_id} className="flex items-start gap-4 px-4 py-3 border-b border-border last:border-b-0 hover:bg-muted/40">
            <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-muted-foreground shrink-0 mt-0.5">
              {(nameOf(t.last_message_from)[0] || '?').toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground truncate">{nameOf(t.last_message_from)}</span>
                <span className="text-xs text-muted-foreground truncate">{emailOf(t.last_message_from)}</span>
                {t.message_count > 1 && <span className="text-xs text-muted-foreground">· {t.message_count}</span>}
                {t.has_attachments && <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />}
              </div>
              <div className="text-sm text-foreground truncate">{t.subject || '(no subject)'}</div>
              <div className="text-xs text-muted-foreground truncate mt-0.5">{t.last_message_snippet}</div>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(t.last_message_date)}</span>
              <button
                disabled={drafting === t.thread_id}
                onClick={async () => {
                  setDrafting(t.thread_id);
                  const th = { thread_id: t.thread_id, subject: t.subject, snippet: t.last_message_snippet, from: t.last_message_from, to: '', date: t.last_message_date, has_attachments: t.has_attachments, labels: [] };
                  try {
                    const r = await apiPost<{ draft: string }>('/api/email-tasks/draft', { sender: t.last_message_from, subject: t.subject, body: t.last_message_snippet, source_email_id: t.thread_id });
                    setAiDraft(r.success && r.result ? r.result.draft : '');
                  } catch { setAiDraft(''); }
                  setReply(th); setDrafting(null);
                }}
                className="text-xs border border-border rounded-md px-2.5 py-1 inline-flex items-center gap-1 hover:bg-muted disabled:opacity-50">
                <Reply className="h-3 w-3" /> {drafting === t.thread_id ? 'Drafting…' : 'Reply (AI)'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {reply && <ReplyModal thread={reply} initialBody={aiDraft} onClose={() => { setReply(null); setAiDraft(''); }} onSent={() => { setReply(null); setAiDraft(''); load(); }} />}
    </div>
  );
}
