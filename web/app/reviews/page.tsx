'use client';

import React, { useState, useEffect, useCallback } from 'react';

// =============================================================================
// /reviews — Marketplace reviews & questions, 4 channels.
// WB reviews: live (dasoperator-api /api/reviews/drafts?channel=wb).
// Ozon reviews/questions + WB questions: backend not connected yet → empty state.
// =============================================================================

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

type Channel = 'ozon' | 'wb';
type Kind = 'reviews' | 'questions';

type Draft = {
  id: string;
  rating: number;
  customer_name: string | null;
  product_name: string | null;
  product_sku: string | null;
  review_text: string | null;
  pros: string | null;
  cons: string | null;
  draft_text: string | null;
  status: string;
  created_at: string;
};

type Tab = { key: string; channel: Channel; kind: Kind; label: string };

const TABS: Tab[] = [
  { key: 'ozon-reviews', channel: 'ozon', kind: 'reviews', label: 'Ozon reviews' },
  { key: 'ozon-questions', channel: 'ozon', kind: 'questions', label: 'Ozon questions' },
  { key: 'wb-reviews', channel: 'wb', kind: 'reviews', label: 'WB reviews' },
  { key: 'wb-questions', channel: 'wb', kind: 'questions', label: 'WB questions' },
];

const CHANNEL_COLOR: Record<Channel, string> = { ozon: '#005BFF', wb: '#CB11AB' };

const STATUS_LABEL: Record<string, string> = {
  auto_sent: 'Auto-replied',
  approved_sent: 'Replied',
  pending: 'Pending',
  failed: 'Failed',
  rejected: 'Rejected',
};

function authToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem('dx_auth_token'); } catch { return null; }
}

function fmtDate(s: string | null): string {
  if (!s) return '';
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function ReviewsPage() {
  const [active, setActive] = useState<string>('wb-reviews');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  const tab = TABS.find(t => t.key === active)!;
  const isLiveWbReviews = tab.channel === 'wb' && tab.kind === 'reviews';

  const load = useCallback(async () => {
    if (!isLiveWbReviews) { setDrafts([]); setError(null); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ channel: 'wb', limit: '50' });
      if (search.trim()) params.set('search', search.trim());
      if (rating) params.set('rating', String(rating));
      const token = authToken();
      const res = await fetch(`${API_BASE}/api/reviews/drafts?${params.toString()}`, {
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setDrafts((data.drafts || []) as Draft[]);
      const counts = data.counts || {};
      setTotal(Object.values(counts).reduce((a: number, b: any) => a + (Number(b) || 0), 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [isLiveWbReviews, search, rating]);

  useEffect(() => {
    const t = setTimeout(load, search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 16px 64px' }}>
      <style>{`@keyframes dxspin{to{transform:rotate(360deg)}}`}</style>

      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 800, color: 'var(--fg-1)', margin: 0 }}>
          Reviews &amp; questions
        </h1>
        <p style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--fg-3)', marginTop: 6 }}>
          Customer feedback across marketplaces
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, overflowX: 'auto', borderBottom: '1px solid var(--stone-100)', paddingBottom: 0 }}>
        {TABS.map(t => {
          const on = t.key === active;
          return (
            <button key={t.key} onClick={() => setActive(t.key)} style={{
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

      {/* Toolbar (live tab only) */}
      {isLiveWbReviews && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 18 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search reviews, products…" style={{
            flex: '1 1 240px', minWidth: 200, height: 38, padding: '0 14px', fontFamily: 'var(--font-body)', fontSize: 14,
            color: 'var(--fg-1)', background: 'var(--paper-raised)', border: '1px solid var(--stone-200)', borderRadius: 6, outline: 'none',
          }} />
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
        </div>
      )}

      {/* Content */}
      {!isLiveWbReviews ? (
        <EmptyState channel={tab.channel} kind={tab.kind} />
      ) : loading ? (
        <Spinner />
      ) : error ? (
        <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--brand-rot)', fontFamily: 'var(--font-body)', fontSize: 14 }}>{error}</div>
      ) : drafts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--fg-3)', fontFamily: 'var(--font-body)', fontSize: 14 }}>No reviews match your filters.</div>
      ) : (
        <>
          <div style={{ fontFamily: 'var(--font-narrow)', fontSize: 13, color: 'var(--fg-3)', marginBottom: 12 }}>
            Showing {drafts.length}{total ? ` of ${total}` : ''} reviews
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {drafts.map(d => <ReviewCard key={d.id} d={d} />)}
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

function EmptyState({ channel, kind }: { channel: Channel; kind: Kind }) {
  const name = `${channel === 'wb' ? 'Wildberries' : 'Ozon'} ${kind}`;
  return (
    <div style={{ textAlign: 'center', padding: '64px 24px', background: 'var(--paper-sunk)', border: '1px dashed var(--stone-200)', borderRadius: 10 }}>
      <div style={{ width: 44, height: 44, borderRadius: 999, margin: '0 auto 14px', background: 'var(--paper-raised)', border: `2px solid ${CHANNEL_COLOR[channel]}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: CHANNEL_COLOR[channel], fontFamily: 'var(--font-display)', fontWeight: 800 }}>
        {channel === 'wb' ? 'W' : 'O'}
      </div>
      <p style={{ fontFamily: 'var(--font-body)', fontSize: 15, fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>{name} — not connected yet</p>
      <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--fg-3)', marginTop: 6, maxWidth: 420, marginLeft: 'auto', marginRight: 'auto' }}>
        This feed will appear here once the {name} integration is wired into the API.
      </p>
    </div>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1 }}>
      {[1, 2, 3, 4, 5].map(s => (
        <span key={s} style={{ color: s <= n ? 'var(--brand-gold)' : 'var(--stone-200)', fontSize: 15 }}>★</span>
      ))}
    </span>
  );
}

function ReviewCard({ d }: { d: Draft }) {
  const [open, setOpen] = useState(false);
  const body = d.review_text || [d.pros && `+ ${d.pros}`, d.cons && `− ${d.cons}`].filter(Boolean).join('\n') || '—';
  const initial = (d.customer_name || '?').trim().charAt(0).toUpperCase();
  return (
    <div style={{ background: 'var(--paper-raised)', border: '1px solid var(--stone-100)', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
          <div style={{ width: 36, height: 36, borderRadius: 999, background: 'var(--paper-sunk)', color: 'var(--fg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 15, flex: '0 0 auto' }}>{initial}</div>
          <div style={{ minWidth: 0 }}>
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 14, fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>{d.customer_name || 'Anonymous'}</p>
            <p style={{ fontFamily: 'var(--font-narrow)', fontSize: 12, color: 'var(--fg-3)', margin: '2px 0 0' }}>{fmtDate(d.created_at)}</p>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flex: '0 0 auto' }}>
          <Stars n={d.rating || 0} />
          <span style={{ fontFamily: 'var(--font-narrow)', fontSize: 11, fontWeight: 700, color: 'var(--paper-raised)', background: '#CB11AB', padding: '3px 8px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.04em' }}>WB</span>
        </div>
      </div>

      {d.product_name && (
        <p style={{ fontFamily: 'var(--font-narrow)', fontSize: 12, color: 'var(--fg-3)', margin: '12px 0 0' }}>{d.product_name}</p>
      )}
      <p style={{ fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--fg-1)', lineHeight: 1.6, margin: '6px 0 0', whiteSpace: 'pre-line' }}>{body}</p>

      {d.draft_text && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--stone-100)', paddingTop: 10 }}>
          <button onClick={() => setOpen(o => !o)} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600, color: 'var(--fg-link)' }}>
            <span style={{ fontFamily: 'var(--font-narrow)', fontSize: 11, fontWeight: 700, color: 'var(--fg-2)', background: 'var(--paper-sunk)', padding: '2px 8px', borderRadius: 999 }}>
              {STATUS_LABEL[d.status] || d.status}
            </span>
            {open ? 'Hide reply' : 'Show reply'}
          </button>
          {open && (
            <p style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--fg-2)', lineHeight: 1.6, margin: '8px 0 0', padding: '10px 12px', background: 'var(--paper-sunk)', borderRadius: 6, whiteSpace: 'pre-line' }}>{d.draft_text}</p>
          )}
        </div>
      )}
    </div>
  );
}
