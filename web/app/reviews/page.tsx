'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';

// =============================================================================
// /reviews — marketplace reviews & questions, 4 live feeds from das_erp_dev D1.
// Bold / high-contrast UI. Same data wiring as before.
// =============================================================================

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

type Channel = 'ozon' | 'wb';
type Kind = 'reviews' | 'questions';

type Item = {
  id: string; kind: Kind; channel: Channel;
  rating?: number; author?: string | null; product?: string | null;
  text: string; answer?: string | null; status?: string | null; date?: string | null;
};

const TABS: { key: string; channel: Channel; kind: Kind; label: string }[] = [
  { key: 'ozon-reviews', channel: 'ozon', kind: 'reviews', label: 'Ozon reviews' },
  { key: 'ozon-questions', channel: 'ozon', kind: 'questions', label: 'Ozon questions' },
  { key: 'wb-reviews', channel: 'wb', kind: 'reviews', label: 'WB reviews' },
  { key: 'wb-questions', channel: 'wb', kind: 'questions', label: 'WB questions' },
];

const CHANNEL_COLOR: Record<Channel, string> = { ozon: '#005BFF', wb: '#CB11AB' };
const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  auto_sent: { bg: '#E7F6EC', fg: '#1B7A3D', label: 'Auto-replied' },
  approved_sent: { bg: '#E7F6EC', fg: '#1B7A3D', label: 'Replied' },
  answered: { bg: '#E7F6EC', fg: '#1B7A3D', label: 'Answered' },
  pending: { bg: '#FFF3D6', fg: '#9A6700', label: 'Pending' },
  failed: { bg: '#FBE3E4', fg: '#B42318', label: 'Failed' },
  rejected: { bg: '#FBE3E4', fg: '#B42318', label: 'Rejected' },
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
          rating: x.rating || 0, author: x.customer_name, product: x.product_name || x.product_sku,
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
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '28px 16px 72px' }}>
      <style>{`@keyframes dxspin{to{transform:rotate(360deg)}}`}</style>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          <span style={{ width: 44, height: 6, background: 'var(--brand-rot)', borderRadius: 3 }} />
          <span style={{ width: 22, height: 6, background: 'var(--brand-gold)', borderRadius: 3 }} />
        </div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 42, fontWeight: 900, lineHeight: 1.05, color: 'var(--fg-1)', margin: 0, letterSpacing: '-0.01em' }}>
          Reviews &amp; questions
        </h1>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 16, fontWeight: 600, color: 'var(--fg-2)', marginTop: 8 }}>
          Customer feedback across marketplaces
        </p>
      </div>

      {/* Tabs — bold filled pills */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 22, flexWrap: 'wrap' }}>
        {TABS.map(t => {
          const on = t.key === active;
          const col = CHANNEL_COLOR[t.channel];
          return (
            <button key={t.key} onClick={() => { setActive(t.key); setSearch(''); setRating(null); }} style={{
              fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 800,
              color: on ? '#fff' : 'var(--fg-1)',
              background: on ? col : 'var(--paper-raised)',
              border: on ? `2px solid ${col}` : '2px solid var(--stone-200)',
              borderRadius: 10, padding: '11px 18px', cursor: 'pointer', whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', gap: 8,
              boxShadow: on ? `0 4px 14px ${col}44` : 'none',
              transition: 'all .12s',
            }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: on ? '#fff' : col, display: 'inline-block' }} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 22 }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder={tab.kind === 'reviews' ? 'Search reviews, products…' : 'Search questions, products…'}
          style={{
            flex: '1 1 260px', minWidth: 220, height: 46, padding: '0 16px',
            fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 600, color: 'var(--fg-1)',
            background: 'var(--paper-raised)', border: '2px solid var(--stone-200)', borderRadius: 10, outline: 'none',
          }} />
        {tab.kind === 'reviews' && (
          <div style={{ display: 'flex', gap: 6 }}>
            {[null, 5, 4, 3, 2, 1].map(r => {
              const on = rating === r;
              return (
                <button key={String(r)} onClick={() => setRating(r)} style={{
                  fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 800,
                  color: on ? '#fff' : 'var(--fg-1)', background: on ? 'var(--brand-rot)' : 'var(--paper-raised)',
                  border: `2px solid ${on ? 'var(--brand-rot)' : 'var(--stone-200)'}`, borderRadius: 10,
                  padding: '9px 14px', cursor: 'pointer',
                }}>{r === null ? 'All' : `${r}★`}</button>
              );
            })}
          </div>
        )}
      </div>

      {loading ? <Spinner />
        : error ? <div style={{ textAlign: 'center', padding: '56px 16px', color: 'var(--brand-rot)', fontFamily: 'var(--font-body)', fontSize: 16, fontWeight: 700 }}>{error}</div>
        : visible.length === 0 ? <div style={{ textAlign: 'center', padding: '56px 16px', color: 'var(--fg-2)', fontFamily: 'var(--font-body)', fontSize: 16, fontWeight: 700 }}>Nothing here yet.</div>
        : (
          <>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-2)', marginBottom: 14 }}>
              {visible.length} {tab.kind}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {visible.map(it => <Card key={it.id} it={it} />)}
            </div>
          </>
        )}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 320, color: 'var(--fg-2)' }}>
      <div style={{ width: 34, height: 34, border: '4px solid var(--stone-200)', borderTopColor: 'var(--brand-rot)', borderRadius: '50%', animation: 'dxspin 0.9s linear infinite' }} />
      <p style={{ marginTop: 14, fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 700 }}>Loading…</p>
    </div>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(s => <span key={s} style={{ color: s <= n ? 'var(--brand-gold)' : 'var(--stone-200)', fontSize: 20, lineHeight: 1 }}>★</span>)}
    </span>
  );
}

function Card({ it }: { it: Item }) {
  const [open, setOpen] = useState(true);
  const color = CHANNEL_COLOR[it.channel];
  const badge = it.channel === 'wb' ? 'WB' : 'OZON';
  const author = it.author || (it.channel === 'ozon' ? 'Ozon customer' : 'Customer');
  const initial = author.trim().charAt(0).toUpperCase();
  const text = it.text && it.text.trim() ? it.text : (it.kind === 'reviews' ? '— rating only, no text —' : '');
  const st = it.status ? STATUS_STYLE[it.status] : null;
  return (
    <div style={{ background: 'var(--paper-raised)', border: '2px solid var(--stone-200)', borderRadius: 14, padding: 20, boxShadow: '0 2px 10px rgba(26,21,25,.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
          <div style={{ width: 46, height: 46, borderRadius: 12, background: color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: 19, flex: '0 0 auto' }}>{initial}</div>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 16, fontWeight: 800, color: 'var(--fg-1)', margin: 0 }}>{author}</p>
            <p style={{ fontFamily: 'var(--font-narrow)', fontSize: 13, fontWeight: 600, color: 'var(--fg-2)', margin: '3px 0 0' }}>{fmtDate(it.date)}</p>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flex: '0 0 auto' }}>
          {it.kind === 'reviews' && <Stars n={it.rating || 0} />}
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 900, color: '#fff', background: color, padding: '4px 11px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{badge}</span>
        </div>
      </div>

      {it.product && <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 700, color: 'var(--fg-2)', margin: '14px 0 0' }}>{it.product}</p>}
      {text && <p style={{ fontFamily: 'var(--font-body)', fontSize: 19, fontWeight: 700, fontStyle: 'italic', color: 'var(--fg-1)', lineHeight: 1.55, margin: '8px 0 0', whiteSpace: 'pre-line' }}>{text}</p>}

      {(it.answer || st) && (
        <div style={{ marginTop: 14, borderTop: '2px solid var(--stone-100)', paddingTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {st && <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 900, color: st.fg, background: st.bg, padding: '4px 11px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{st.label}</span>}
          {it.answer && (
            <button onClick={() => setOpen(o => !o)} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 800, color: 'var(--fg-link)' }}>
              {open ? (it.kind === 'reviews' ? 'Hide reply' : 'Hide answer') : (it.kind === 'reviews' ? 'Show reply' : 'Show answer')}
            </button>
          )}
        </div>
      )}
      {it.answer && open && (
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 500, color: 'var(--fg-1)', lineHeight: 1.6, margin: '10px 0 0', padding: '14px 16px', background: 'var(--paper-sunk)', borderRadius: 10, borderLeft: `4px solid ${color}`, whiteSpace: 'pre-line' }}>{it.answer}</p>
      )}
    </div>
  );
}
