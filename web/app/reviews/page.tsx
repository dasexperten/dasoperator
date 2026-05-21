'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  Check,
  X,
  AlertTriangle,
  Edit3,
  Inbox,
  ShoppingCart,
  MessageSquare,
} from 'lucide-react';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

type DraftStatus = 'auto_sent' | 'approved_sent' | 'held' | 'failed' | 'pending' | 'rejected';

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

interface DraftsResponse {
  ok: boolean;
  drafts: ReviewDraft[];
  counts: Record<DraftStatus, number>;
}

interface Stats { ok: boolean; total: number; today: number; cached: boolean; }
interface TickEntry { ts: string; replied: number; drafted?: number; errors: number; backlog: number; today: number; throttled: boolean; }

// =============================================================================
// Helpers
// =============================================================================
function ratingColor(r: number): string {
  if (r >= 5) return '#0F6E56';
  if (r >= 4) return '#1D9E75';
  if (r >= 3) return '#BA7517';
  return '#A32D2D';
}
function stars(r: number): string { return '★'.repeat(r) + '☆'.repeat(5 - r); }

function relativeDate(iso: string | null | undefined): string {
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

// =============================================================================
// Main page
// =============================================================================
export default function ReviewsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tickLog, setTickLog] = useState<TickEntry[]>([]);
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [ratingFilter, setRatingFilter] = useState<number | 'all'>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('status', 'auto_sent,approved_sent,held,failed');
      params.set('limit', '200');
      if (ratingFilter !== 'all') params.set('rating', String(ratingFilter));
      if (search.trim()) params.set('search', search.trim());

      const [statsR, draftsR, tickR] = await Promise.all([
        fetch(`${API_BASE}/api/reviews/stats`).then((r) => r.json()),
        fetch(`${API_BASE}/api/reviews/drafts?${params}`).then((r) => r.json() as Promise<DraftsResponse>),
        fetch(`${API_BASE}/api/reviews/tick-log`).then((r) => r.json()),
      ]);
      setStats(statsR);
      setDrafts(draftsR.drafts ?? []);
      setCounts(draftsR.counts ?? {});
      setTickLog(tickR.ticks ?? []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [ratingFilter, search]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Auto-refresh каждые 60 секунд
  useEffect(() => {
    const t = setInterval(loadAll, 60_000);
    return () => clearInterval(t);
  }, [loadAll]);

  const heldCount = counts.held ?? 0;
  const failedCount = counts.failed ?? 0;
  const lastTick = tickLog[0];
  const cronHealthy = lastTick && Date.now() - new Date(lastTick.ts).getTime() < 30 * 60_000;

  // Counts: ANSWERED today (auto_sent + approved_sent), edited count
  const totalAnswered = (counts.auto_sent ?? 0) + (counts.approved_sent ?? 0);
  const editedCount = counts.approved_sent ?? 0;

  return (
    <div style={{ padding: '24px', maxWidth: 1280, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--fg-1)', margin: 0, letterSpacing: 0 }}>
            Reviews
          </h1>
          <p style={{ fontSize: 14, color: 'var(--fg-3)', margin: '4px 0 0' }}>
            Wildberries — лента всех отзывов и наших ответов
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

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard label="Отвечено всего" value={totalAnswered} icon={<MessageSquare className="h-4 w-4" />} />
        <KpiCard label="Без ответа на WB" value={stats?.total ?? '—'} icon={<Inbox className="h-4 w-4" />} hint={stats?.cached ? 'кеш 60с' : 'live'} />
        <KpiCard label="Переписано вручную" value={editedCount} valueColor="#BA7517" icon={<Edit3 className="h-4 w-4" />} />
        <KpiCard
          label="Cron tick"
          value={lastTick ? relativeDate(lastTick.ts) : '—'}
          valueColor={cronHealthy ? '#1D9E75' : '#A32D2D'}
          hint={cronHealthy ? 'OK · каждые 20 мин' : 'проверить'}
        />
      </div>

      {/* Held / Failed banner if any */}
      {(heldCount > 0 || failedCount > 0) && (
        <div style={{
          padding: '12px 16px', background: 'rgba(199,122,0,0.08)',
          border: '1px solid rgba(199,122,0,0.3)', borderRadius: 'var(--radius-sm)',
          marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, fontWeight: 700,
        }}>
          <AlertTriangle className="h-5 w-5" style={{ color: '#BA7517', flexShrink: 0 }} />
          <span style={{ color: '#854F0B' }}>
            {heldCount > 0 && <>{heldCount} {heldCount === 1 ? 'ответ отложен' : 'ответа отложены'} safety-проверкой</>}
            {heldCount > 0 && failedCount > 0 && ' · '}
            {failedCount > 0 && <>{failedCount} {failedCount === 1 ? 'не доставлен' : 'не доставлено'}</>}
            {'  '}— проверь карточки ниже
          </span>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Поиск по тексту..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1, minWidth: 220, padding: '8px 14px',
            background: 'var(--paper)', border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700,
            color: 'var(--fg-1)',
          }}
        />
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
      </div>

      {/* Hint */}
      <div style={{
        fontSize: 13, color: 'var(--fg-3)', marginBottom: 16,
        padding: '8px 14px', background: 'var(--paper-sunk)',
        borderRadius: 'var(--radius-sm)',
      }}>
        💡 Клик по ответу — редактировать.{' '}
        <strong style={{ fontWeight: 700, color: 'var(--fg-1)' }}>Ctrl+Enter</strong> — перезаписать в Wildberries.
        Esc — отмена.
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '12px 16px', background: 'rgba(229,32,44,0.08)',
          border: '1px solid rgba(229,32,44,0.3)', borderRadius: 'var(--radius-sm)',
          color: 'var(--brand-rot)', fontSize: 14, fontWeight: 700, marginBottom: 16,
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
          <div style={{ fontSize: 16, fontWeight: 700 }}>Лента пуста</div>
          <div style={{ marginTop: 4, fontSize: 14 }}>Cron заполнит её при следующем тике.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {drafts.map((d) => (
            <ReviewCard key={d.id} draft={d} onChange={loadAll} />
          ))}
        </div>
      )}

      {/* Tick log footer */}
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

// =============================================================================
// KPI Card
// =============================================================================
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

// =============================================================================
// Review card — review on top, answer below (editable, Ctrl+Enter to publish)
// =============================================================================
function ReviewCard({ draft, onChange }: { draft: ReviewDraft; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(draft.draft_text ?? '');
  const [busy, setBusy] = useState<'save' | 'publish' | 'release' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [savedText, setSavedText] = useState(draft.draft_text ?? '');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync if parent reloads with newer text
  useEffect(() => {
    if (!editing) {
      setEditText(draft.draft_text ?? '');
      setSavedText(draft.draft_text ?? '');
    }
  }, [draft.draft_text, editing]);

  // Debounced autosave (800ms)
  useEffect(() => {
    if (!editing) return;
    if (editText === savedText) {
      setSaveStatus('idle');
      return;
    }
    setSaveStatus('saving');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/reviews/drafts/${draft.id}/save-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: editText }),
        }).then((r) => r.json());
        if (r.ok) {
          setSavedText(editText);
          setSaveStatus('saved');
        }
      } catch {}
    }, 800);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [editText, editing, savedText, draft.id]);

  function startEditing() {
    setEditing(true);
    setEditText(draft.draft_text ?? '');
    setSavedText(draft.draft_text ?? '');
    setLocalError(null);
    // Focus on next tick to ensure render
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function cancelEditing() {
    setEditText(savedText);
    setEditing(false);
    setLocalError(null);
  }

  async function publish() {
    setBusy('publish');
    setLocalError(null);
    try {
      const r = await fetch(`${API_BASE}/api/reviews/drafts/${draft.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: editText }),
      }).then((r) => r.json());
      if (!r.ok) { setLocalError(r.error ?? 'publish failed'); return; }
      setEditing(false);
      onChange();
    } catch (e: any) {
      setLocalError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function releaseHeld() {
    setBusy('release');
    setLocalError(null);
    try {
      const r = await fetch(`${API_BASE}/api/reviews/drafts/${draft.id}/release`, {
        method: 'POST',
      }).then((r) => r.json());
      if (!r.ok) { setLocalError(r.error ?? 'release failed'); return; }
      onChange();
    } catch (e: any) {
      setLocalError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      publish();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    }
  }

  const isHeld = draft.status === 'held';
  const isFailed = draft.status === 'failed';
  const isSent = draft.status === 'auto_sent' || draft.status === 'approved_sent';

  // Visual states for answer block
  let answerBg = '#E1F5EE';
  let answerBorder = 'rgba(15,110,86,0.3)';
  let answerLabelColor = '#0F6E56';
  let answerLabel = 'Ответ отправлен ботом';
  let answerIcon = <Check className="h-3.5 w-3.5" />;

  if (editing) {
    answerBg = '#FAEEDA';
    answerBorder = '#BA7517';
    answerLabelColor = '#854F0B';
    answerLabel = 'Редактирую — Ctrl+Enter сохранить, Esc отмена';
    answerIcon = <Edit3 className="h-3.5 w-3.5" />;
  } else if (isHeld) {
    answerBg = 'rgba(199,122,0,0.08)';
    answerBorder = 'rgba(199,122,0,0.3)';
    answerLabelColor = '#854F0B';
    answerLabel = `Отложено safety-проверкой${draft.rejection_reason ? ': ' + draft.rejection_reason : ''}`;
    answerIcon = <AlertTriangle className="h-3.5 w-3.5" />;
  } else if (isFailed) {
    answerBg = 'rgba(229,32,44,0.08)';
    answerBorder = 'rgba(229,32,44,0.3)';
    answerLabelColor = '#A32D2D';
    answerLabel = `Не отправлено: ${draft.rejection_reason ?? 'неизвестная ошибка'}`;
    answerIcon = <X className="h-3.5 w-3.5" />;
  } else if (draft.status === 'approved_sent') {
    answerLabel = `Переписано вручную${draft.posted_to_wb_at ? ' · ' + relativeDate(draft.posted_to_wb_at) : ''}`;
  }

  return (
    <div style={{
      background: 'var(--paper)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-md)',
      padding: '16px 20px',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        marginBottom: 10, flexWrap: 'wrap',
      }}>
        <span style={{
          padding: '2px 8px', background: 'var(--paper-sunk)',
          borderRadius: 'var(--radius-sm)', fontSize: 14,
          fontWeight: 700, color: 'var(--fg-2)', textTransform: 'uppercase',
        }}>
          {draft.channel}
        </span>
        <span style={{ color: ratingColor(draft.rating), fontSize: 16, fontWeight: 700 }}>
          {stars(draft.rating)}
        </span>
        {draft.customer_name && (
          <span style={{ fontSize: 14, color: 'var(--fg-2)', fontWeight: 700 }}>
            {draft.customer_name}
          </span>
        )}
        <span style={{ fontSize: 14, color: 'var(--fg-3)' }}>
          {draft.product_name ?? draft.product_sku ?? '—'}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 14, color: 'var(--fg-3)' }}>
          {relativeDate(draft.created_at)}
          {draft.posted_to_wb_at && draft.posted_to_wb_at !== draft.created_at && (
            <> · ответ {relativeDate(draft.posted_to_wb_at)}</>
          )}
        </span>
      </div>

      {/* Review text or rating-only marker */}
      {draft.review_text ? (
        <div style={{
          background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)',
          padding: '12px 14px', fontSize: 14, lineHeight: 1.55,
          marginBottom: 10, whiteSpace: 'pre-wrap',
        }}>
          {draft.review_text}
        </div>
      ) : (
        <div style={{
          background: 'var(--paper-sunk)', borderRadius: 'var(--radius-sm)',
          padding: '8px 14px', fontSize: 14, fontStyle: 'italic',
          marginBottom: 10, color: 'var(--fg-3)',
        }}>
          Покупатель не оставил текст — только {draft.rating} {draft.rating === 1 ? 'звезда' : 'звёзд'}
        </div>
      )}

      {/* Pros / Cons */}
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

      {/* Local error */}
      {localError && (
        <div style={{
          padding: '8px 12px', background: 'rgba(229,32,44,0.08)',
          color: '#A32D2D', border: '1px solid rgba(229,32,44,0.3)',
          borderRadius: 'var(--radius-sm)', fontSize: 14, marginBottom: 8, fontWeight: 700,
        }}>
          {localError}
        </div>
      )}

      {/* Answer block — click to edit (if not held/failed actions needed first) */}
      <div
        onClick={() => { if (!editing && !busy && isSent) startEditing(); }}
        style={{
          background: answerBg,
          border: `1px solid ${answerBorder}`,
          borderRadius: 'var(--radius-sm)',
          padding: '12px 14px',
          cursor: editing || busy ? 'default' : (isSent ? 'text' : 'default'),
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 6,
        }}>
          <div style={{
            fontSize: 14, color: answerLabelColor, fontWeight: 700,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {answerIcon}
            {answerLabel}
          </div>
          {editing && saveStatus === 'saving' && (
            <span style={{ fontSize: 14, color: 'var(--fg-3)' }}>сохраняю...</span>
          )}
          {editing && saveStatus === 'saved' && editText !== savedText && (
            <span style={{ fontSize: 14, color: 'var(--fg-3)' }}>несохранено</span>
          )}
          {editing && saveStatus === 'saved' && editText === savedText && (
            <span style={{ fontSize: 14, color: '#0F6E56' }}>сохранено</span>
          )}
        </div>

        {editing ? (
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
        ) : (
          <div style={{
            fontSize: 14, lineHeight: 1.55, color: 'var(--fg-1)',
            whiteSpace: 'pre-wrap',
          }}>
            {draft.draft_text}
          </div>
        )}
      </div>

      {/* Editing action row */}
      {editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={cancelEditing}
            style={{
              padding: '8px 14px', background: 'var(--paper)',
              border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
              fontSize: 14, fontWeight: 700, color: 'var(--fg-1)', cursor: 'pointer',
            }}
          >
            Отмена (Esc)
          </button>
          <button
            onClick={publish}
            disabled={busy === 'publish'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', background: '#1D9E75',
              border: '1px solid #1D9E75', color: 'white',
              borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700,
              cursor: busy === 'publish' ? 'wait' : 'pointer',
            }}
          >
            {busy === 'publish' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Перезаписать в WB (Ctrl+Enter)
          </button>
        </div>
      )}

      {/* HELD — release button */}
      {isHeld && !editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={startEditing}
            style={{
              padding: '8px 14px', background: 'var(--paper)',
              border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
              fontSize: 14, fontWeight: 700, color: 'var(--fg-1)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <Edit3 className="h-4 w-4" />
            Редактировать
          </button>
          <button
            onClick={releaseHeld}
            disabled={busy === 'release'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', background: '#1D9E75',
              border: '1px solid #1D9E75', color: 'white',
              borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700,
              cursor: busy === 'release' ? 'wait' : 'pointer',
            }}
          >
            {busy === 'release' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Одобрить и опубликовать
          </button>
        </div>
      )}

      {/* FAILED — retry */}
      {isFailed && !editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={startEditing}
            style={{
              padding: '8px 14px', background: 'var(--paper)',
              border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)',
              fontSize: 14, fontWeight: 700, color: 'var(--fg-1)', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <Edit3 className="h-4 w-4" />
            Редактировать и опубликовать
          </button>
        </div>
      )}
    </div>
  );
}
