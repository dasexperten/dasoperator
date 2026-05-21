'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Loader2, RefreshCw, Send, Check, X, AlertTriangle, Edit3, Inbox, MessageSquare,
} from 'lucide-react';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

type DraftStatus = 'pending' | 'auto_sent' | 'approved_sent' | 'failed' | 'held' | 'rejected';

interface ReviewDraft {
  id: string;
  channel: 'wb' | 'ozon';
  external_id: string;
  rating: number;
  customer_name: string | null;
  product_name: string | null;
  product_sku: string | null;
  review_text: string | null;
  pros: string | null;
  cons: string | null;
  draft_text: string | null;
  status: DraftStatus;
  approved_by: string | null;
  posted_to_wb_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ProductOption { baseSku: string; name: string; count: number; }
interface DraftsResponse { ok: boolean; drafts: ReviewDraft[]; counts: Record<DraftStatus, number>; }
interface Stats { ok: boolean; total: number; today: number; cached: boolean; }
interface TickEntry { ts: string; replied: number; drafted?: number; errors: number; backlog: number; today: number; throttled: boolean; }

function ratingColor(r: number) {
  if (r >= 5) return '#0F6E56';
  if (r >= 4) return '#1D9E75';
  if (r >= 3) return '#BA7517';
  return '#A32D2D';
}
function stars(r: number) { return '★'.repeat(r) + '☆'.repeat(5 - r); }
function relativeDate(iso: string | null | undefined) {
  if (!iso) return '';
  const dt = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - dt.getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} д назад`;
  return dt.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

export default function ReviewsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tickLog, setTickLog] = useState<TickEntry[]>([]);
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [statusView, setStatusView] = useState<'pending' | 'sent' | 'all'>('pending');
  const [ratingFilter, setRatingFilter] = useState<number | 'all'>('all');
  const [skuFilter, setSkuFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyAllBusy, setReplyAllBusy] = useState(false);
  const [replyAllResult, setReplyAllResult] = useState<{ sent: number; failed: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      const statusArg = statusView === 'pending' ? 'pending'
        : statusView === 'sent' ? 'auto_sent,approved_sent'
        : 'pending,auto_sent,approved_sent,failed,held';
      params.set('status', statusArg);
      params.set('limit', '300');
      if (ratingFilter !== 'all') params.set('rating', String(ratingFilter));
      if (skuFilter !== 'all') params.set('sku', skuFilter);

      const [statsR, draftsR, tickR, prodR] = await Promise.all([
        fetch(`${API_BASE}/api/reviews/stats`).then((r) => r.json()),
        fetch(`${API_BASE}/api/reviews/drafts?${params}`).then((r) => r.json() as Promise<DraftsResponse>),
        fetch(`${API_BASE}/api/reviews/tick-log`).then((r) => r.json()),
        fetch(`${API_BASE}/api/reviews/products`).then((r) => r.json() as Promise<{ ok: boolean; products: ProductOption[] }>),
      ]);
      setStats(statsR);
      setDrafts(draftsR.drafts ?? []);
      setCounts(draftsR.counts ?? {});
      setTickLog(tickR.ticks ?? []);
      setProducts(prodR.products ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [statusView, ratingFilter, skuFilter]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    const t = setInterval(loadAll, 60_000);
    return () => clearInterval(t);
  }, [loadAll]);

  const pendingCount = counts.pending ?? 0;
  const sentCount = (counts.auto_sent ?? 0) + (counts.approved_sent ?? 0);
  const failedCount = counts.failed ?? 0;
  const lastTick = tickLog[0];
  const cronHealthy = lastTick && Date.now() - new Date(lastTick.ts).getTime() < 30 * 60_000;

  async function doReplyAll() {
    setReplyAllBusy(true);
    setReplyAllResult(null);
    setError(null);
    try {
      const body: any = { maxBatch: 200, pauseMs: 1200 };
      if (skuFilter !== 'all') body.sku = skuFilter;
      const r = await fetch(`${API_BASE}/api/reviews/reply-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (!r.ok) { setError(r.error ?? 'reply-all failed'); return; }
      setReplyAllResult({ sent: r.sent, failed: r.failed });
      await loadAll();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setReplyAllBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div style={{ padding: '24px', maxWidth: 1280, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--fg-1)', margin: 0 }}>Reviews</h1>
          <p style={{ fontSize: 14, color: 'var(--fg-3)', margin: '4px 0 0' }}>
            Wildberries — черновики ответов готовятся ботом, ты одобряешь и отправляешь
          </p>
        </div>
        <button
          onClick={loadAll}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', background: 'var(--paper)',
            border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
            fontSize: 14, fontWeight: 700, color: 'var(--fg-1)',
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      {/* REPLY ALL BAR — top sticky */}
      <div style={{
        background: 'var(--paper)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        padding: '18px 22px',
        marginBottom: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            {pendingCount > 0
              ? `${pendingCount} ${pendingCount === 1 ? 'ответ готов' : pendingCount < 5 ? 'ответа готовы' : 'ответов готовы'} к отправке`
              : 'Нет ответов на отправку'}
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--fg-3)' }}>
            {pendingCount > 0
              ? 'Просмотри ленту ниже, при необходимости отредактируй, потом отправь всё разом'
              : 'Cron заполнит очередь при следующем тике'}
          </p>
        </div>

        {replyAllResult && (
          <div style={{
            fontSize: 14, fontWeight: 700,
            color: replyAllResult.failed > 0 ? '#A32D2D' : '#1D9E75',
            padding: '8px 14px', borderRadius: 'var(--radius-sm)',
            background: replyAllResult.failed > 0 ? 'rgba(229,32,44,0.08)' : 'rgba(46,125,79,0.08)',
          }}>
            Отправлено: {replyAllResult.sent}
            {replyAllResult.failed > 0 && <> · ошибок: {replyAllResult.failed}</>}
          </div>
        )}

        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            disabled={pendingCount === 0 || replyAllBusy}
            style={{
              background: pendingCount > 0 ? '#1D9E75' : 'var(--paper-sunk)',
              color: pendingCount > 0 ? 'white' : 'var(--fg-3)',
              border: `1px solid ${pendingCount > 0 ? '#1D9E75' : 'var(--border-hairline)'}`,
              fontWeight: 700, fontSize: 16, padding: '16px 28px',
              display: 'flex', alignItems: 'center', gap: 10,
              flexShrink: 0,
              borderRadius: 'var(--radius-sm)',
              cursor: pendingCount > 0 ? 'pointer' : 'not-allowed',
              opacity: pendingCount > 0 ? 1 : 0.6,
            }}
          >
            <Send className="h-5 w-5" />
            Reply All{pendingCount > 0 && ` — отправить ${pendingCount}`}
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => setConfirming(false)}
              disabled={replyAllBusy}
              style={{
                background: 'var(--paper)', color: 'var(--fg-1)',
                border: '1px solid var(--border-hairline)',
                padding: '14px 20px', borderRadius: 'var(--radius-sm)',
                fontWeight: 700, fontSize: 14, cursor: 'pointer',
              }}
            >
              Отмена
            </button>
            <button
              onClick={doReplyAll}
              disabled={replyAllBusy}
              style={{
                background: '#A32D2D', color: 'white',
                border: '1px solid #A32D2D',
                padding: '14px 24px', borderRadius: 'var(--radius-sm)',
                fontWeight: 700, fontSize: 16,
                display: 'flex', alignItems: 'center', gap: 10,
                cursor: replyAllBusy ? 'wait' : 'pointer',
              }}
            >
              {replyAllBusy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
              Подтвердить — отправить {pendingCount}
            </button>
          </div>
        )}
      </div>

      {/* KPI */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <KpiCard label="Без ответа на WB" value={stats?.total ?? '—'} icon={<Inbox className="h-4 w-4" />} hint={stats?.cached ? 'кеш 60с' : 'live'} />
        <KpiCard label="Готовы к отправке" value={pendingCount} valueColor="#1D9E75" />
        <KpiCard label="Отправлено всего" value={sentCount} icon={<Check className="h-4 w-4" />} />
        <KpiCard
          label="Cron tick"
          value={lastTick ? relativeDate(lastTick.ts) : '—'}
          valueColor={cronHealthy ? '#1D9E75' : '#A32D2D'}
          hint={cronHealthy ? 'OK · каждые 20 мин' : 'проверить'}
        />
      </div>

      {/* Failed banner */}
      {failedCount > 0 && (
        <div style={{
          padding: '12px 16px', background: 'rgba(229,32,44,0.08)',
          border: '1px solid rgba(229,32,44,0.3)', borderRadius: 'var(--radius-sm)',
          marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12,
          fontSize: 14, fontWeight: 700, color: '#A32D2D',
        }}>
          <AlertTriangle className="h-5 w-5" />
          {failedCount} {failedCount === 1 ? 'ответ не отправлен' : 'ответов не отправлено'} — посмотри во вкладке Все
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {(['pending', 'sent', 'all'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusView(s)}
            style={{
              padding: '8px 16px',
              background: statusView === s ? 'var(--fg-1)' : 'var(--paper)',
              color: statusView === s ? 'var(--paper)' : 'var(--fg-1)',
              border: `1px solid ${statusView === s ? 'var(--fg-1)' : 'var(--border-hairline)'}`,
              borderRadius: 'var(--radius-sm)',
              fontSize: 14, fontWeight: 700, cursor: 'pointer',
            }}
          >
            {s === 'pending' ? `Готовы (${pendingCount})` : s === 'sent' ? `Отправлено (${sentCount})` : 'Все'}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <select
          value={String(ratingFilter)}
          onChange={(e) => setRatingFilter(e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10))}
          style={{
            padding: '8px 14px', background: 'var(--paper)',
            border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
            fontSize: 14, fontWeight: 700, color: 'var(--fg-1)',
          }}
        >
          <option value="all">Все оценки</option>
          <option value="5">★★★★★</option>
          <option value="4">★★★★</option>
          <option value="3">★★★</option>
          <option value="2">★★</option>
          <option value="1">★</option>
        </select>
        <select
          value={skuFilter}
          onChange={(e) => setSkuFilter(e.target.value)}
          style={{
            padding: '8px 14px', background: 'var(--paper)',
            border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
            fontSize: 14, fontWeight: 700, color: 'var(--fg-1)',
            minWidth: 180,
          }}
        >
          <option value="all">Все товары</option>
          {products.map((p) => (
            <option key={p.baseSku} value={p.baseSku.toLowerCase()}>
              {p.name} ({p.count})
            </option>
          ))}
        </select>
      </div>

      {/* Hint */}
      <div style={{
        fontSize: 13, color: 'var(--fg-3)', marginBottom: 16,
        padding: '8px 14px', background: 'var(--paper-sunk)',
        borderRadius: 'var(--radius-sm)',
      }}>
        Клик по ответу — редактировать.{' '}
        <strong style={{ fontWeight: 700, color: 'var(--fg-1)' }}>Ctrl+Enter</strong> — сохранить.
        Esc — отмена. Все готовые ответы отправятся одной волной по кнопке Reply All.
      </div>

      {error && (
        <div style={{
          padding: '12px 16px', background: 'rgba(229,32,44,0.08)',
          border: '1px solid rgba(229,32,44,0.3)', borderRadius: 'var(--radius-sm)',
          color: '#A32D2D', fontSize: 14, fontWeight: 700, marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {/* Feed */}
      {loading && drafts.length === 0 ? (
        <div style={{ padding: 48, textAlign: 'center', color: 'var(--fg-3)' }}>
          <Loader2 className="h-6 w-6 animate-spin inline-block" />
        </div>
      ) : drafts.length === 0 ? (
        <div style={{
          padding: 48, textAlign: 'center', color: 'var(--fg-3)',
          background: 'var(--paper-sunk)', borderRadius: 'var(--radius-md)',
        }}>
          <MessageSquare className="h-8 w-8 inline-block" style={{ marginBottom: 12 }} />
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            {statusView === 'pending' ? 'Нет готовых ответов' : 'Лента пуста'}
          </div>
          <div style={{ marginTop: 4, fontSize: 14 }}>
            {statusView === 'pending' ? 'Cron подготовит черновики при следующем тике' : 'Запусти cron для наполнения'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {drafts.map((d) => <ReviewCard key={d.id} draft={d} onChange={loadAll} />)}
        </div>
      )}

      {/* Tick log */}
      <details style={{
        marginTop: 32, padding: 16, background: 'var(--paper-sunk)',
        borderRadius: 'var(--radius-sm)', fontSize: 14,
      }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, color: 'var(--fg-2)' }}>
          Последние тики cron ({tickLog.length})
        </summary>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-mono, ui-monospace)' }}>
          {tickLog.slice(0, 12).map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, color: t.errors > 0 ? '#A32D2D' : 'var(--fg-2)' }}>
              <span style={{ color: 'var(--fg-3)', minWidth: 140 }}>{t.ts.slice(11, 19)} {t.ts.slice(0, 10)}</span>
              <span style={{ fontWeight: 700 }}>↑{t.replied} ↓{t.drafted ?? 0}</span>
              <span style={{ color: 'var(--fg-3)' }}>backlog {t.backlog}</span>
              {t.throttled && <span style={{ color: '#BA7517' }}>throttled</span>}
              {t.errors > 0 && <span style={{ fontWeight: 700 }}>{t.errors} err</span>}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function KpiCard({ label, value, hint, valueColor, icon }: {
  label: string; value: number | string; hint?: string; valueColor?: string; icon?: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--paper)', border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-sm)', padding: '16px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 14, color: 'var(--fg-3)', marginBottom: 8,
        fontWeight: 700, textTransform: 'uppercase',
      }}>
        {icon}{label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: valueColor ?? 'var(--fg-1)' }}>{value}</div>
      {hint && <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// Card: header → review text → ANSWER (no label "Ответ отправлен ботом" — color says it)
function ReviewCard({ draft, onChange }: { draft: ReviewDraft; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(draft.draft_text ?? '');
  const [savedText, setSavedText] = useState(draft.draft_text ?? '');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editing) {
      setEditText(draft.draft_text ?? '');
      setSavedText(draft.draft_text ?? '');
    }
  }, [draft.draft_text, editing]);

  useEffect(() => {
    if (!editing) return;
    if (editText === savedText) { setSaveStatus('idle'); return; }
    setSaveStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/reviews/drafts/${draft.id}/save-text`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: editText }),
        }).then((r) => r.json());
        if (r.ok) { setSavedText(editText); setSaveStatus('saved'); }
      } catch {}
    }, 800);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [editText, editing, savedText, draft.id]);

  function startEditing() {
    if (busy) return;
    setEditing(true);
    setLocalError(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }
  function cancelEditing() { setEditText(savedText); setEditing(false); setLocalError(null); }
  async function saveAndClose() {
    if (editText === savedText) { setEditing(false); return; }
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/reviews/drafts/${draft.id}/save-text`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: editText }),
      });
      setSavedText(editText);
      setEditing(false);
      onChange();
    } catch (e: any) { setLocalError(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }
  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveAndClose(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEditing(); }
  }

  const isPending = draft.status === 'pending';
  const isSent = draft.status === 'auto_sent' || draft.status === 'approved_sent';
  const isFailed = draft.status === 'failed';

  // Color of answer block by state
  let answerBg = '#E1F5EE';     // sent — green
  let answerBorder = 'rgba(15,110,86,0.3)';
  if (editing) { answerBg = '#FAEEDA'; answerBorder = '#BA7517'; }
  else if (isPending) { answerBg = '#E6F1FB'; answerBorder = 'rgba(24,95,165,0.3)'; }
  else if (isFailed) { answerBg = 'rgba(229,32,44,0.08)'; answerBorder = 'rgba(229,32,44,0.3)'; }

  return (
    <div style={{
      background: 'var(--paper)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-md)',
      padding: '16px 20px',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{
          padding: '2px 8px', background: 'var(--paper-sunk)',
          borderRadius: 'var(--radius-sm)', fontSize: 14,
          fontWeight: 700, color: 'var(--fg-2)', textTransform: 'uppercase',
        }}>{draft.channel}</span>
        <span style={{ color: ratingColor(draft.rating), fontSize: 16, fontWeight: 700 }}>{stars(draft.rating)}</span>
        {draft.customer_name && (
          <span style={{ fontSize: 14, color: 'var(--fg-2)', fontWeight: 700 }}>{draft.customer_name}</span>
        )}
        <span style={{ fontSize: 14, color: 'var(--fg-3)' }}>{draft.product_name ?? draft.product_sku ?? '—'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 14, color: 'var(--fg-3)' }}>
          {relativeDate(draft.created_at)}
          {draft.posted_to_wb_at && <> · отправлено {relativeDate(draft.posted_to_wb_at)}</>}
        </span>
      </div>

      {/* Review text or rating-only */}
      {draft.review_text ? (
        <div style={{
          background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)',
          padding: '12px 14px', fontSize: 14, lineHeight: 1.55,
          marginBottom: 10, whiteSpace: 'pre-wrap',
        }}>{draft.review_text}</div>
      ) : (
        <div style={{
          background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)',
          padding: '8px 14px', fontSize: 14, fontStyle: 'italic',
          marginBottom: 10, color: 'var(--fg-3)',
        }}>
          Покупатель не оставил текст — только {draft.rating} {draft.rating === 1 ? 'звезда' : 'звёзд'}
        </div>
      )}

      {(draft.pros || draft.cons) && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
          {draft.pros && (
            <div style={{ flex: 1, fontSize: 14 }}>
              <div style={{ color: '#0F6E56', fontWeight: 700, marginBottom: 4 }}>Достоинства</div>
              <div style={{ color: 'var(--fg-2)' }}>{draft.pros}</div>
            </div>
          )}
          {draft.cons && (
            <div style={{ flex: 1, fontSize: 14 }}>
              <div style={{ color: '#A32D2D', fontWeight: 700, marginBottom: 4 }}>Недостатки</div>
              <div style={{ color: 'var(--fg-2)' }}>{draft.cons}</div>
            </div>
          )}
        </div>
      )}

      {localError && (
        <div style={{
          padding: '8px 12px', background: 'rgba(229,32,44,0.08)',
          color: '#A32D2D', border: '1px solid rgba(229,32,44,0.3)',
          borderRadius: 'var(--radius-sm)', fontSize: 14, marginBottom: 8, fontWeight: 700,
        }}>{localError}</div>
      )}

      {/* Failed reason */}
      {isFailed && draft.rejection_reason && (
        <div style={{
          padding: '6px 12px', background: 'rgba(229,32,44,0.08)',
          color: '#A32D2D', border: '1px solid rgba(229,32,44,0.3)',
          borderRadius: 'var(--radius-sm)', fontSize: 13, marginBottom: 8, fontWeight: 700,
        }}>
          {draft.rejection_reason}
        </div>
      )}

      {/* Answer block — NO label header, color alone shows state */}
      <div
        onClick={() => { if (!editing && (isPending || isSent || isFailed)) startEditing(); }}
        style={{
          background: answerBg,
          border: `1px solid ${answerBorder}`,
          borderRadius: 'var(--radius-sm)',
          padding: '12px 14px',
          cursor: editing ? 'default' : 'text',
        }}
      >
        {editing ? (
          <>
            <textarea
              ref={textareaRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKey}
              rows={Math.max(3, Math.ceil(editText.length / 90))}
              style={{
                width: '100%', border: 'none', background: 'transparent',
                resize: 'vertical', padding: 0, fontFamily: 'inherit',
                fontSize: 14, lineHeight: 1.55, outline: 'none',
                color: 'var(--fg-1)', minHeight: 80,
              }}
            />
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(199,122,0,0.2)',
              fontSize: 13, color: '#854F0B',
            }}>
              <span>Ctrl+Enter — сохранить, Esc — отмена</span>
              <span>
                {saveStatus === 'saving' && 'сохраняю...'}
                {saveStatus === 'saved' && editText === savedText && 'сохранено'}
                {editText !== savedText && saveStatus !== 'saving' && 'несохранено'}
              </span>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--fg-1)', whiteSpace: 'pre-wrap' }}>
            {draft.draft_text || <span style={{ color: 'var(--fg-3)', fontStyle: 'italic' }}>(пусто)</span>}
          </div>
        )}
      </div>
    </div>
  );
}
