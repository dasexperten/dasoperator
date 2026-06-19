'use client';

import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Reply, Paperclip, AlertCircle } from 'lucide-react';
import { getEmailHistory, apiPost, type EmailThread, type EmailHistoryResponse } from '@/lib/api';
import ReplyModal from './reply-modal';

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

// Senders that don't normally need a human reply — newsletters, system, marketplace bots.
const SYSTEM_RE = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|noreply|newsletter|mailer-daemon|postmaster|bounce|notification|mailing|digest|automated|robot|uvedoml|news@|info@|seller\.ozon|@ozon\.ru|marketplace@|support@dasexperten|@sберbank|sberbank)/i;
// Our own outbound — if the LAST message is from us, the ball is not in our court.
const OWN_RE = /dasexperten\.(de|ru)|dasexperten@gmail\.com|kosarevam491/i;

type Cat = 'urgent' | 'invoice' | 'reply' | 'fyi';
const URGENT_RE = /(срочно|urgent|overdue|просроч|asap|немедленно|deadline|сегодня до|important)/i;
const INVOICE_RE = /(счёт|счет|invoice|оплат|payment|накладн|акт сверки|бухгалт|account|инвойс|due|задолжен)/i;

const CAT: Record<Cat, { spine: string; chip: string; av: string; label: string }> = {
  urgent:  { spine: 'border-l-red-500',     chip: 'bg-red-50 text-red-700',         av: 'bg-red-50 text-red-700',         label: 'Urgent' },
  invoice: { spine: 'border-l-amber-400',   chip: 'bg-amber-50 text-amber-700',     av: 'bg-amber-50 text-amber-700',     label: 'Invoice' },
  reply:   { spine: 'border-l-emerald-500', chip: 'bg-emerald-50 text-emerald-700', av: 'bg-emerald-50 text-emerald-700', label: 'Reply needed' },
  fyi:     { spine: 'border-l-transparent', chip: 'bg-muted text-muted-foreground', av: 'bg-muted text-muted-foreground', label: 'FYI' },
};

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
  if (!from) return false;
  if (SYSTEM_RE.test(t.last_message_from)) return false;
  if (OWN_RE.test(from)) return false;
  if ((t.participants?.length ?? 0) > 4) return false;
  return true;
}
function category(t: InboxThread): Cat {
  if (!needsReply(t)) return 'fyi';
  const hay = `${t.subject} ${t.last_message_snippet} ${t.last_message_from}`;
  if (URGENT_RE.test(hay)) return 'urgent';
  if (INVOICE_RE.test(hay)) return 'invoice';
  return 'reply';
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
  const [filter, setFilter] = useState<'all' | 'reply'>('reply');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const PAGE = 100;
  const QUERY = 'in:inbox newer_than:90d';

  async function load(off = 0, append = false) {
    if (append) setLoadingMore(true); else { setLoading(true); setError(null); }
    try {
      const r = await getEmailHistory(QUERY, PAGE, off);
      const res = r.result as (EmailHistoryResponse & { has_more?: boolean }) | undefined;
      if (r.success && res) {
        const threads = (res.threads as unknown as InboxThread[]) || [];
        setAll((prev) => (append ? [...prev, ...threads] : threads));
        setHasMore(Boolean(res.has_more));
        setOffset(off + threads.length);
      } else if (!append) {
        setError('Failed to load inbox');
      }
    } catch (e) {
      if (!append) setError(e instanceof Error ? e.message : 'Error');
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }
  useEffect(() => { load(0, false); }, []);

  const sorted = [...all].sort((a, b) => new Date(b.last_message_date).getTime() - new Date(a.last_message_date).getTime());
  const replyCount = sorted.filter(needsReply).length;
  const list = filter === 'reply' ? sorted.filter(needsReply) : sorted;
  const attachCount = sorted.filter((t) => t.has_attachments).length;
  const invoiceCount = sorted.filter((t) => { const c = category(t); return c === 'invoice' || c === 'urgent'; }).length;

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading inbox…</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {sorted.length > 0 ? `${sorted.length} ${sorted.length === 1 ? 'email' : 'emails'} in your inbox` : 'Inbox zero'}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">Last 60 days · newest first · {replyCount} need your reply</p>
        </div>
        <button onClick={() => load(0, false)} className="text-sm border border-border rounded-md px-3 py-1.5 inline-flex items-center gap-2 hover:bg-muted"><RefreshCw className="h-4 w-4" /> Refresh</button>
      </div>

      {sorted.length > 0 && (
        <div className="grid grid-cols-3 gap-2.5 mb-4">
          <div className="rounded-lg bg-muted/50 px-3 py-2"><div className="text-xs text-muted-foreground">Needs your reply</div><div className="text-xl font-semibold text-foreground">{replyCount}</div></div>
          <div className="rounded-lg bg-muted/50 px-3 py-2"><div className="text-xs text-muted-foreground">Money &amp; invoices</div><div className="text-xl font-semibold text-foreground">{invoiceCount}</div></div>
          <div className="rounded-lg bg-muted/50 px-3 py-2"><div className="text-xs text-muted-foreground">With attachments</div><div className="text-xl font-semibold text-foreground">{attachCount}</div></div>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <button onClick={() => setFilter('all')} className={`text-sm px-3 py-1 rounded-full border ${filter === 'all' ? 'bg-emerald-600 text-white border-emerald-600' : 'border-border text-muted-foreground hover:bg-muted'}`}>All · {sorted.length}</button>
        <button onClick={() => setFilter('reply')} className={`text-sm px-3 py-1 rounded-full border ${filter === 'reply' ? 'bg-emerald-600 text-white border-emerald-600' : 'border-border text-muted-foreground hover:bg-muted'}`}>Needs reply · {replyCount}</button>
      </div>

      {error && <div className="flex items-center gap-2 text-sm text-red-600 mb-3"><AlertCircle className="h-4 w-4" /> {error}</div>}

      <div className="rounded-lg border border-border overflow-hidden">
        {list.length === 0 && <div className="px-4 py-10 text-center text-muted-foreground">Nothing here.</div>}
        {list.map((t) => {
          const cat = CAT[category(t)];
          return (
            <div key={t.thread_id} className={`flex items-start gap-4 px-4 py-3 border-b border-border last:border-b-0 border-l-4 ${cat.spine} hover:bg-muted/40`}>
              <div className={`w-9 h-9 rounded-full ${cat.av} flex items-center justify-center text-sm font-medium shrink-0 mt-0.5`}>
                {(nameOf(t.last_message_from)[0] || '?').toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground truncate">{nameOf(t.last_message_from)}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${cat.chip}`}>{cat.label}</span>
                  {t.message_count > 1 && <span className="text-xs text-muted-foreground">· {t.message_count}</span>}
                  {t.has_attachments && <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />}
                </div>
                <div className="text-sm text-foreground truncate">{t.subject || '(no subject)'}</div>
                <div className="text-xs text-muted-foreground truncate mt-0.5">{t.last_message_snippet}</div>
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(t.last_message_date)}</span>
                <div className="flex items-center gap-1.5">
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
                    className="text-xs rounded-md px-2.5 py-1 inline-flex items-center gap-1 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                    <Reply className="h-3 w-3" /> {drafting === t.thread_id ? 'Drafting…' : 'Reply (AI)'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {hasMore && (
        <div className="flex justify-center mt-3">
          <button onClick={() => load(offset, true)} disabled={loadingMore} className="text-sm border border-border rounded-md px-4 py-2 inline-flex items-center gap-2 hover:bg-muted disabled:opacity-50">
            {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />} {loadingMore ? 'Loading…' : 'Next 100'}
          </button>
        </div>
      )}

      {reply && <ReplyModal thread={reply} initialBody={aiDraft} onClose={() => { setReply(null); setAiDraft(''); }} onSent={() => { setReply(null); setAiDraft(''); load(0, false); }} />}
    </div>
  );
}
