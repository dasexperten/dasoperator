'use client';

import React, { useEffect, useState } from 'react';
import './marketplace-chats.css';

type Thread = {
  id: string; external_chat_id: string; buyer_name: string; product_name: string;
  sku: string; status: string; latest_text?: string; last_buyer_at: string;
  reply_status?: string;
};
type Message = { id: string; sender: string; msg_type: string; text: string; created_at: string };
type Reply = { id: string; text: string; status: string; created_at: string; sent_at?: string };
type Sync = { status?: string; started_at?: number; finished_at?: number; rows_synced: number };
type List = { threads: Thread[]; total: number; sync: Sync | null; last_success: Sync | null };
type Detail = { thread: Thread; messages: Message[]; replies: Reply[]; next_offset: number | null };

const labels: Record<string, string> = {
  ready: 'Prepared · not sent', sending: 'Sending', sent: 'Sent', failed: 'Delivery failed',
  expired: 'Reply window expired', skipped: 'Skipped', escalated: 'Needs attention',
};

function date(value?: string | number | null) {
  if (!value) return 'Not recorded';
  if (typeof value === 'number') return new Date(value * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Yerevan', dateStyle: 'medium', timeStyle: 'short' });
  const normalized = value.replace(' ', 'T');
  const parsed = new Date(/(Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('en-GB', { timeZone: 'Asia/Yerevan', dateStyle: 'medium', timeStyle: 'short' });
}

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = window.localStorage.getItem('dx_auth_token');
  const response = await fetch(`https://dasoperator-api.dasexperten.workers.dev/api/marketplace-chats${path}`, {
    signal, headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Unable to load customer chats.');
  return body;
}

export default function MarketplaceChats({ channel }: { channel: 'wb' | 'ozon' }) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<List | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ channel, offset: String(offset), search });
      read<List>(`?${params}`, controller.signal).then(setList).catch(e => {
        if (!controller.signal.aborted) setError(e.message);
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, search ? 300 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [channel, search, offset, refresh]);

  useEffect(() => {
    setDetail(null); setDetailError(''); setLoadingMore(false);
    if (!selected) return;
    const controller = new AbortController();
    read<Detail>(`/${encodeURIComponent(selected)}`, controller.signal).then(setDetail).catch(e => {
      if (!controller.signal.aborted) setDetailError(e.message);
    });
    return () => controller.abort();
  }, [selected, refresh]);

  async function moreMessages() {
    if (!detail || detail.next_offset === null) return;
    const threadId = detail.thread.id;
    setLoadingMore(true); setDetailError('');
    try {
      const next = await read<Detail>(`/${encodeURIComponent(threadId)}?offset=${detail.next_offset}`);
      setDetail(current => current?.thread.id === threadId ? { ...next, messages: [...current.messages, ...next.messages] } : current);
    } catch (e) { setDetailError(e instanceof Error ? e.message : 'Unable to load more messages.'); }
    finally { setLoadingMore(false); }
  }

  return <section className="dx-marketplace-chats" aria-label={`${channel === 'wb' ? 'WB' : 'Ozon'} customer chats`}>
    <div className="mc-toolbar">
      <input aria-label="Search customer chats" placeholder="Search customers, messages, products…" value={search}
        onChange={e => { setSearch(e.target.value); setOffset(0); setSelected(null); }} />
      <button onClick={() => setRefresh(n => n + 1)}>Refresh</button>
    </div>
    {list && <div className="mc-sync" role="status">
      <p>Last successful sync: <strong>{date(list.last_success?.finished_at)}</strong> · Yerevan time</p>
      {!list.last_success && <p>Chat coverage is not yet confirmed.</p>}
      {list.sync?.status === 'running' && <p>Latest sync is in progress. Showing previously received conversations.</p>}
      {list.sync && !['ok', 'running'].includes(list.sync.status || '') && <p>Latest sync did not complete. The conversations below may be incomplete.</p>}
      {channel === 'ozon' && list.total === 0 && !search && <p>No Ozon conversations have been received. This does not confirm that the marketplace inbox is empty.</p>}
    </div>}
    {error && <p className="mc-error" role="alert">{error}</p>}
    <div className={`mc-layout ${selected ? 'mc-selected' : ''}`}>
      <div className="mc-list" aria-busy={loading}>
        <p className="mc-count">{loading ? 'Loading conversations…' : error ? 'Conversations unavailable' : `${list?.total ?? 0} conversations`}</p>
        {!loading && !error && list?.threads.length === 0 && <p>{search ? 'No conversations match your search.' : 'No conversations received yet.'}</p>}
        {!loading && !error && list?.threads.map(thread => <button className={`mc-thread ${selected === thread.id ? 'mc-active' : ''}`}
          key={thread.id} onClick={() => setSelected(thread.id)} aria-pressed={selected === thread.id}>
          <strong>{thread.buyer_name || `${channel === 'wb' ? 'WB' : 'Ozon'} customer`}</strong>
          <span className="mc-date">{date(thread.last_buyer_at)}</span>
          {thread.product_name && <span>{thread.product_name}</span>}
          <span className="mc-preview">{thread.latest_text || 'No message text received'}</span>
          <span className="mc-badge">{thread.reply_status ? labels[thread.reply_status] || thread.reply_status : thread.status === 'closed' ? 'Closed' : 'Open conversation'}</span>
        </button>)}
        <div className="mc-pagination">
          <button disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</button>
          <span>Page {Math.floor(offset / 30) + 1}</span>
          <button disabled={loading || offset + 30 >= (list?.total || 0)} onClick={() => setOffset(offset + 30)}>Next</button>
        </div>
      </div>
      <div className="mc-detail" aria-live="polite">
        {!selected ? <div className="mc-empty"><h2>Select a conversation</h2><p>Read customer messages and Tamara’s replies here.</p></div> : <>
          <button className="mc-back" onClick={() => setSelected(null)}>Back to conversations</button>
          {detailError && <p className="mc-error" role="alert">{detailError}</p>}
          {!detail && !detailError && <p>Loading conversation…</p>}
          {detail && <>
            <h2>{detail.thread.buyer_name || 'Customer'}</h2>
            <p>{detail.thread.product_name || detail.thread.sku}</p>
            <p className="mc-date">Conversation {detail.thread.external_chat_id}</p>
            <h3>Message history</h3>
            {detail.messages.length === 0 && <p>No message history has been received.</p>}
            {detail.messages.map(message => <article className={`mc-message ${message.sender === 'seller' ? 'mc-seller' : ''}`} key={message.id}>
              <div className="mc-message-head"><strong>{message.sender === 'buyer' ? 'Customer' : message.sender === 'seller' ? 'Seller' : 'System'}</strong><time>{date(message.created_at)}</time></div>
              <p>{message.text || (message.msg_type === 'text' ? 'No message text' : 'Attachment · preview unavailable')}</p>
            </article>)}
            {detail.next_offset !== null && <button disabled={loadingMore} onClick={moreMessages}>{loadingMore ? 'Loading…' : 'Load more messages'}</button>}
            <h3>Tamara’s replies</h3>
            {detail.replies.length === 0 && <p>No Tamara replies recorded for this conversation.</p>}
            {detail.replies.map(reply => <article className="mc-message mc-seller" key={reply.id}>
              <div className="mc-message-head"><strong>{labels[reply.status] || reply.status}</strong><time>{date(reply.sent_at || reply.created_at)}</time></div>
              <p>{reply.text}</p>
            </article>)}
          </>}
        </>}
      </div>
    </div>
  </section>;
}
