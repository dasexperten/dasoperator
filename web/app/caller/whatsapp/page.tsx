'use client';

export const runtime = 'edge';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Send } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api';

interface GatewayStatus {
  configured: boolean;
  gateway: 'online' | 'offline' | 'not_configured';
  session: { id: string; name?: string; phone?: string; status?: string } | null;
}
interface MessageRow {
  id: string; phone: string; message_text: string; status: 'pending' | 'sent' | 'failed';
  error_message?: string | null; created_at: number; sent_at?: number | null;
}

function when(value: number | null | undefined) {
  if (!value) return '—';
  return new Date(value * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function WhatsAppPage() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [s, h] = await Promise.all([
      apiGet<GatewayStatus>('/api/whatsapp/status'),
      apiGet<{ messages: MessageRow[] }>('/api/whatsapp/messages?limit=30'),
    ]);
    if (s.success && s.result) setStatus(s.result);
    if (h.success && h.result) setMessages(h.result.messages);
    if (!s.success) setError(s.errors[0]?.message || 'Could not read WhatsApp status.');
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function sendMessage() {
    setSending(true); setError(null); setNotice(null);
    const result = await apiPost<MessageRow>('/api/whatsapp/send', {
      phone, text: message, idempotency_key: crypto.randomUUID(),
    });
    setSending(false); setConfirming(false);
    if (!result.success || !result.result) {
      setError(result.errors[0]?.message || 'Message was not sent.');
      return;
    }
    setNotice(`Sent to +${result.result.phone}`);
    setMessage('');
    await refresh();
  }

  const connected = status?.gateway === 'online' && status.session?.status === 'ready';

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-extrabold uppercase text-stone-500">Caller · direct channel</p>
          <h1 className="mt-1 text-3xl font-extrabold text-foreground">WhatsApp</h1>
          <p className="mt-2 max-w-2xl text-base font-semibold text-muted-foreground">Send from ERP through the linked company session. Every attempt is recorded here.</p>
        </div>
        <button type="button" onClick={() => void refresh()} className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-border bg-card px-4 font-bold text-muted-foreground" disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </header>

      <section className="rounded-lg border border-border bg-card p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {connected ? <CheckCircle2 className="h-6 w-6 text-success" /> : <AlertCircle className="h-6 w-6 text-rot" />}
            <div><p className="font-extrabold text-foreground">{connected ? 'Connected' : 'Connection unavailable'}</p><p className="text-sm font-semibold text-stone-500">{status?.session?.name || 'main-whatsapp'} · {status?.session?.phone ? `+${status.session.phone}` : 'checking session'}</p></div>
          </div>
          <span className="rounded-full bg-muted px-3 py-1 text-sm font-extrabold text-muted-foreground">{status?.gateway || 'checking'}</span>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <section className="rounded-lg border border-border bg-card p-6 shadow-card">
          <h2 className="text-xl font-extrabold text-foreground">New message</h2>
          <label className="mt-5 block text-sm font-extrabold text-muted-foreground" htmlFor="wa-phone">International phone</label>
          <input id="wa-phone" value={phone} onChange={(e) => { setPhone(e.target.value); setConfirming(false); }} placeholder="+79309554025" className="mt-2 min-h-11 w-full rounded-sm border border-border bg-card px-3 font-semibold text-foreground outline-none focus:ring-2 focus:ring-gold" />
          <label className="mt-5 block text-sm font-extrabold text-muted-foreground" htmlFor="wa-message">Message</label>
          <textarea id="wa-message" value={message} onChange={(e) => { setMessage(e.target.value); setConfirming(false); }} rows={7} maxLength={4096} className="mt-2 w-full rounded-sm border border-border bg-card px-3 py-3 font-semibold text-foreground outline-none focus:ring-2 focus:ring-gold" placeholder="Write the message exactly as it should be delivered." />
          <div className="mt-2 text-right text-xs font-bold text-stone-500">{message.length}/4096</div>
          {error && <p className="mt-3 flex gap-2 text-sm font-bold text-rot"><AlertCircle className="h-5 w-5 shrink-0" />{error}</p>}
          {notice && <p className="mt-3 flex gap-2 text-sm font-bold text-success"><CheckCircle2 className="h-5 w-5 shrink-0" />{notice}</p>}
          {!confirming ? (
            <button type="button" disabled={!connected || !phone.trim() || !message.trim()} onClick={() => setConfirming(true)} className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-sm bg-rot px-5 font-extrabold text-paper disabled:cursor-not-allowed disabled:opacity-40"><Send className="h-5 w-5" /> Review recipient</button>
          ) : (
            <div className="mt-5 rounded-sm border border-gold bg-muted p-4">
              <p className="font-extrabold text-foreground">Send this message to +{phone.replace(/\D/g, '')}?</p>
              <div className="mt-3 flex gap-3"><button type="button" onClick={() => void sendMessage()} disabled={sending} className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-sm bg-rot px-4 font-extrabold text-paper">{sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />} Confirm send</button><button type="button" onClick={() => setConfirming(false)} className="min-h-11 rounded-sm border border-border bg-card px-4 font-extrabold text-muted-foreground">Cancel</button></div>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-6 shadow-card">
          <h2 className="text-xl font-extrabold text-foreground">Recent outgoing</h2>
          <div className="mt-4 divide-y divide-border">
            {messages.length === 0 && <p className="py-8 text-center font-semibold text-stone-500">No ERP messages yet.</p>}
            {messages.map((row) => <article key={row.id} className="py-4"><div className="flex items-center justify-between gap-3"><p className="font-extrabold text-foreground">+{row.phone}</p><span className={`text-sm font-extrabold ${row.status === 'sent' ? 'text-success' : row.status === 'failed' ? 'text-rot' : 'text-warning'}`}>{row.status}</span></div><p className="mt-2 whitespace-pre-wrap text-sm font-semibold text-muted-foreground">{row.message_text}</p><p className="mt-2 text-xs font-bold text-stone-500">{when(row.sent_at || row.created_at)}</p>{row.error_message && <p className="mt-1 text-xs font-bold text-rot">{row.error_message}</p>}</article>)}
          </div>
        </section>
      </div>
    </div>
  );
}
