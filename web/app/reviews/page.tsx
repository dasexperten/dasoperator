'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';

// =============================================================================
// /reviews — marketplace reviews & questions, 4 live feeds from das_erp_dev D1.
// WB/Ozon reviews   -> /api/reviews/drafts?channel=
// WB/Ozon questions -> /api/mp/questions?channel=
// =============================================================================

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

type Channel = 'ozon' | 'wb';
type Kind = 'reviews' | 'questions';

type Item = {
  id: string;
  kind: Kind;
  channel: Channel;
  rating?: number;
  author?: string | null;
  product?: string | null;
  text: string;
  answer?: string | null;
  status?: string | null;
  date?: string | null;
};

const TABS: { key: string; channel: Channel; kind: Kind; label: string }[] = [
  { key: 'ozon-reviews', channel: 'ozon', kind: 'reviews', label: 'Ozon reviews' },
  { key: 'ozon-questions', channel: 'ozon', kind: 'questions', label: 'Ozon questions' },
  { key: 'wb-reviews', channel: 'wb', kind: 'reviews', label: 'WB reviews' },
  { key: 'wb-questions', channel: 'wb', kind: 'questions', label: 'WB questions' },
];

const CHANNEL_COLOR: Record<Channel, string> = { ozon: '#005BFF', wb: '#CB11AB' };
const STATUS_LABEL: Record<string, string> = {
  auto_sent: 'Auto-replied', approved_sent: 'Replied', pending: 'Pending',
  failed: 'Failed', rejected: 'Rejected', answered: 'Answered',
};

function authToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem('dx_auth_token'); } catch { return null; }
}
function fmtDate(s?: string | null): string {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}
async function api(path: string) {
  const token = authToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

export default function ReviewsPage() {
  const [active, setActive] = useState('wb-reviews');
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [rating, setRating] = useState<number | null>(null);

  const tab = TABS.find(t => t.key === active)!;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      let mapped: Item[] = [];
      if (tab.kind === 'reviews') {
        const p = new URLSearchParams({ channel: tab.channel, limit: '50' });
        if (search.trim()) p.set('search', search.trim());
        if (rating) p.set('rating', String(rating));
        const d = await api(`/api/reviews/drafts?${p.toString()}`);
        mapped = (d.drafts || []).map((x: any): Item => ({
          id: x.id, kind: 'reviews', channel: tab.channel,
          rating: x.rating || 0, author: x.customer_name,
          product: x.product_name || x.product_sku,
          text: x.review_text || [x.pros && `+ ${x.pros}`, x.cons && `− ${x.cons}`].filter(Boolean).join('\n'),
          answer: x.draft_text, status: x.status, date: x.created_at,
        }));
      } else {
        const d = await api(`/api/mp/questions?channel=${tab.channel}&limit=50`);
        mapped = (d.questions || []).map((x: any): Item => ({
          id: x.id, kind: 'questions', channel: tab.channel,
          author: x.customer_name, product: x.product_name || x.product_sku,
          text: x.question_text || '', answer: x.answer_text, status: x.status, date: x.created_at,
        }));
      }
      setItems(mapped);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally { setLoading(false); }
  }, [tab.kind, tab.channel, search, rating]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const visible = useMemo(() => {
    if (tab.kind === 'questions' && search.trim()) {
      const s = search.trim().toLowerCase();
      return items.filter(i => (i.text + ' ' + (i.product || '')).toLowerCase().includes(s));
    }
    return items;
  }, [items, search, tab.kind]);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px 64px' }}>
      <style>{`@keyframes dxspin{to{transform:rotate(360deg)}}`}</style>

      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 800, color: 'var(--fg-1)', margin: 0 }}>Reviews &amp; questions</h1>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--fg-3)', marginTop: 6 }}>Customer feedback across marketplaces</p>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 20, overflowX: 'auto', borderBottom: '1px solid var(--stone-100)' }}>
        {TABS.map(t => {
          const on = t.key === active;
          return (
            <button key={t.key} onClick={() => { setActive(t.key); setSearch(''); setRating(null); }} style={{
              fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: on ? 700 : 500,
              color: on ? 'var(--fg-1)' : 'var(--fg-3)', background: 'transparent', border: 'none',
              borderBottom: on ? `2px solid ${CHANNEL_COLOR[t.channel]}` : '2px solid transparent',
              padding: '10px 14px', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: CHANNEL_COLOR[t.channel], display: 'inline-block', opacity: on ? 1 : 0.5 }} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 18 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder={tab.kind === 'reviews' ? 'Search reviews, products…' : 'Search questions, products…'} style={{
          flex: '1 1 240px', minWidth: 200, height: 38, padding: '0 14px', fontFamily: 'var(--font-body)', fontSize: 14,
          color: 'var(--fg-1)', background: 'var(--paper-raised)', border: '1px solid var(--stone-200)', borderRadius: 6, outline: 'none',
        }} />
        {tab.kind === 'reviews' && (
          <div style={{ display: 'flex', gap: 4 }}>
            {[null, 5, 4, 3, 2, 1].map(r => {
              const on = rating === r;
              return (
                <button key={String(r)} onClick={() => setRating(r)} style={{
                  fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: on ? 700 : 500,
                  color: on ? 'var(--paper-raised)' : 'var(--fg-2)', background: on ? 'var(--brand-rot)' : 'var(--paper-raised)',
                  border: `1px solid ${on ? 'var(--brand-rot)' : 'var(--stone-200)'}`, borderRadius: 6, padding: '7px 12px', cursor: 'pointer',
                }}>{r === null ? 'All' : `${r}★`}</button>
              );
            })}
          </div>
        )}
      </div>

      {loading ? <Spinner />
        : error ? <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--brand-rot)', fontFamily: 'var(--font-body)', fontSize: 14 }}>{error}</div>
        : visible.length === 0 ? <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--fg-3)', fontFamily: 'var(--font-body)', fontSize: 14 }}>Nothing here yet.</div>
        : (
          <>
            <div style={{ fontFamily: 'var(--font-narrow)', fontSize: 13, color: 'var(--fg-3)', marginBottom: 12 }}>
              {visible.length} {tab.kind}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {visible.map(it => <Card key={it.id} it={it} />)}
            </div>
          </>
        )}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 320, color: 'var(--fg-3)' }}>
      <div style={{ width: 30, height: 30, border: '3px solid var(--stone-200)', borderTopColor: 'var(--brand-rot)', borderRadius: '50%', animation: 'dxspin 0.9s linear infinite' }} />
      <p style={{ marginTop: 12, fontFamily: 'var(--font-body)', fontSize: 14 }}>Loading…</p>
    </div>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1 }}>
      {[1, 2, 3, 4, 5].map(s => <span key={s} style={{ color: s <= n ? 'var(--brand-gold)' : 'var(--stone-200)', fontSize: 15 }}>★</span>)}
    </span>
  );
}

function Card({ it }: { it: Item }) {
  const [open, setOpen] = useState(false);
  const color = CHANNEL_COLOR[it.channel];
  const badge = it.channel === 'wb' ? 'WB' : 'OZON';
  const author = it.author || (it.channel === 'ozon' ? 'Ozon customer' : 'Customer');
  const initial = author.trim().charAt(0).toUpperCase();
  const text = it.text && it.text.trim() ? it.text : (it.kind === 'reviews' ? '— rating only, no text —' : '');
  return (
    <div style={{ background: 'var(--paper-raised)', border: '1px solid var(--stone-100)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 999, background: 'var(--paper-sunk)', color: 'var(--fg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 15, flex: '0 0 auto' }}>{initial}</div>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>{author}</p>
            <p style={{ fontFamily: 'var(--font-narrow)', fontSize: 12, color: 'var(--fg-3)', margin: '2px 0 0' }}>{fmtDate(it.date)}</p>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flex: '0 0 auto' }}>
          {it.kind === 'reviews' && <Stars n={it.rating || 0} />}
          <span style={{ fontFamily: 'var(--font-narrow)', fontSize: 11, fontWeight: 700, color: 'var(--paper-raised)', background: color, padding: '3px 8px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{badge}</span>
        </div>
      </div>

      {it.product && <p style={{ fontFamily: 'var(--font-narrow)', fontSize: 12, color: 'var(--fg-3)', margin: '12px 0 0' }}>{it.product}</p>}
      {text && <p style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--fg-1)', lineHeight: 1.6, margin: '6px 0 0', whiteSpace: 'pre-line' }}>{text}</p>}

      {it.answer && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--stone-100)', paddingTop: 10 }}>
          <button onClick={() => setOpen(o => !o)} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--fg-link)' }}>
            {it.status && <span style={{ fontFamily: 'var(--font-narrow)', fontSize: 11, fontWeight: 700, color: 'var(--fg-2)', background: 'var(--paper-sunk)', padding: '2px 8px', borderRadius: 999 }}>{STATUS_LABEL[it.status] || it.status}</span>}
            {open ? (it.kind === 'reviews' ? 'Hide reply' : 'Hide answer') : (it.kind === 'reviews' ? 'Show reply' : 'Show answer')}
          </button>
          {open && <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6, margin: '8px 0 0', padding: '10px 12px', background: 'var(--paper-sunk)', borderRadius: 6, whiteSpace: 'pre-line' }}>{it.answer}</p>}
        </div>
      )}
      {!it.answer && it.status && (
        <div style={{ marginTop: 10 }}>
          <span style={{ fontFamily: 'var(--font-narrow)', fontSize: 11, fontWeight: 700, color: 'var(--fg-2)', background: 'var(--paper-sunk)', padding: '2px 8px', borderRadius: 999 }}>{STATUS_LABEL[it.status] || it.status}</span>
        </div>
      )}
    </div>
  );
}
