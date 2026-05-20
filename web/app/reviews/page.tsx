'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback } from 'react';
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Sparkles,
  Edit3,
  Send,
  Filter,
  AlertTriangle,
  Inbox,
  ShoppingCart,
} from 'lucide-react';

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

// =============================================================================
// Types — matching backend D1 schema
// =============================================================================
type DraftStatus =
  | 'pending'
  | 'auto_sent'
  | 'approved_sent'
  | 'rejected'
  | 'failed';

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
  limit: number;
  offset: number;
}

interface Stats {
  ok: boolean;
  total: number;
  today: number;
  cached: boolean;
  stale?: boolean;
  error?: string;
}

interface TickEntry {
  ts: string;
  replied: number;
  drafted?: number;
  skipped: number;
  errors: number;
  firstError?: string | null;
  backlog: number;
  today: number;
  throttled: boolean;
  durationMs: number;
}

// =============================================================================
// Status visual mapping (apothecary palette)
// =============================================================================
const STATUS_COLORS: Record<
  DraftStatus,
  { bg: string; fg: string; border: string; label: string }
> = {
  pending: {
    bg: 'rgba(199,122,0,0.08)',
    fg: 'var(--status-warning)',
    border: 'rgba(199,122,0,0.3)',
    label: 'Pending',
  },
  auto_sent: {
    bg: 'rgba(46,125,79,0.08)',
    fg: 'var(--status-success)',
    border: 'rgba(46,125,79,0.3)',
    label: 'Auto-sent',
  },
  approved_sent: {
    bg: 'rgba(15,110,86,0.08)',
    fg: 'var(--status-success)',
    border: 'rgba(15,110,86,0.3)',
    label: 'Approved & sent',
  },
  rejected: {
    bg: 'var(--paper-sunk)',
    fg: 'var(--fg-3)',
    border: 'var(--border-hairline)',
    label: 'Rejected',
  },
  failed: {
    bg: 'rgba(229,32,44,0.08)',
    fg: 'var(--brand-rot)',
    border: 'rgba(229,32,44,0.3)',
    label: 'Failed',
  },
};

function ratingColor(r: number): string {
  if (r >= 5) return 'var(--status-success)';
  if (r >= 4) return 'var(--status-success)';
  if (r >= 3) return 'var(--status-warning)';
  return 'var(--brand-rot)';
}

function relativeDate(iso: string): string {
  const dt = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - dt.getTime();
  const diffH = Math.floor(diffMs / 3600_000);
  if (diffH < 1) {
    const m = Math.floor(diffMs / 60_000);
    return `${m} мин назад`;
  }
  if (diffH < 24) return `${diffH} ч назад`;
  const d = Math.floor(diffH / 24);
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
  const [statusFilter, setStatusFilter] =
    useState<DraftStatus | 'all'>('pending');
  const [ratingFilter, setRatingFilter] = useState<number | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statusArg =
        statusFilter === 'all'
          ? 'pending,auto_sent,approved_sent,rejected,failed'
          : statusFilter;
      const [statsR, draftsR, tickR] = await Promise.all([
        fetch(`${API_BASE}/api/reviews/stats`).then((r) => r.json()),
        fetch(
          `${API_BASE}/api/reviews/drafts?status=${statusArg}&limit=200`
        ).then((r) => r.json() as Promise<DraftsResponse>),
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
  }, [statusFilter]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Auto-refresh every 60s for stats + drafts (no WB cost — kv-cached)
  useEffect(() => {
    const t = setInterval(loadAll, 60_000);
    return () => clearInterval(t);
  }, [loadAll]);

  // Filtered list (client-side rating filter)
  const visibleDrafts =
    ratingFilter === 'all'
      ? drafts
      : drafts.filter((d) => d.rating === ratingFilter);

  const lastTick = tickLog[0];
  const cronHealthy =
    lastTick &&
    Date.now() - new Date(lastTick.ts).getTime() < 25 * 60_000; // within 25 min

  return (
    <div style={{ padding: '24px', maxWidth: 1280, margin: '0 auto' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 24,
          gap: 16,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: 'var(--fg-1)',
              margin: 0,
              letterSpacing: 0,
            }}
          >
            Reviews
          </h1>
          <p
            style={{
              fontSize: 14,
              color: 'var(--fg-3)',
              margin: '4px 0 0',
            }}
          >
            Wildberries отзывы — автоответ 5★, ручное одобрение 1-4★
          </p>
        </div>
        <button
          onClick={loadAll}
          disabled={loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 16px',
            background: 'var(--paper)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--fg-1)',
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Refresh
        </button>
      </div>

      {/* KPI row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 12,
          marginBottom: 24,
        }}
      >
        <KpiCard
          label="Без ответа на WB"
          value={stats?.total ?? '—'}
          hint={stats?.cached ? 'кеш 60с' : 'live'}
          icon={<Inbox className="h-4 w-4" />}
        />
        <KpiCard
          label="Пришло сегодня"
          value={stats?.today ?? '—'}
          icon={<ShoppingCart className="h-4 w-4" />}
        />
        <KpiCard
          label="Ждут одобрения"
          value={counts.pending ?? 0}
          hint="1-4★ нужно ваше решение"
          valueColor="var(--status-warning)"
          icon={<AlertTriangle className="h-4 w-4" />}
        />
        <KpiCard
          label="Cron tick"
          value={
            lastTick ? relativeDate(lastTick.ts) : '—'
          }
          hint={
            cronHealthy
              ? 'каждые 20 мин — ОК'
              : 'давно не было — проверить'
          }
          valueColor={
            cronHealthy ? 'var(--status-success)' : 'var(--brand-rot)'
          }
        />
      </div>

      {/* Filter row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <Filter
          className="h-4 w-4"
          style={{ color: 'var(--fg-3)', marginRight: 4 }}
        />
        <StatusChip
          label="Pending"
          count={counts.pending ?? 0}
          active={statusFilter === 'pending'}
          onClick={() => setStatusFilter('pending')}
          accent="var(--status-warning)"
        />
        <StatusChip
          label="Auto-sent"
          count={counts.auto_sent ?? 0}
          active={statusFilter === 'auto_sent'}
          onClick={() => setStatusFilter('auto_sent')}
          accent="var(--status-success)"
        />
        <StatusChip
          label="Approved"
          count={counts.approved_sent ?? 0}
          active={statusFilter === 'approved_sent'}
          onClick={() => setStatusFilter('approved_sent')}
          accent="var(--status-success)"
        />
        <StatusChip
          label="Rejected"
          count={counts.rejected ?? 0}
          active={statusFilter === 'rejected'}
          onClick={() => setStatusFilter('rejected')}
          accent="var(--fg-3)"
        />
        <StatusChip
          label="Failed"
          count={counts.failed ?? 0}
          active={statusFilter === 'failed'}
          onClick={() => setStatusFilter('failed')}
          accent="var(--brand-rot)"
        />
        <StatusChip
          label="All"
          count={Object.values(counts).reduce(
            (a: number, b) => a + (b as number),
            0
          )}
          active={statusFilter === 'all'}
          onClick={() => setStatusFilter('all')}
        />

        <div style={{ flex: 1 }} />

        <select
          value={String(ratingFilter)}
          onChange={(e) =>
            setRatingFilter(
              e.target.value === 'all' ? 'all' : parseInt(e.target.value, 10)
            )
          }
          style={{
            padding: '6px 12px',
            background: 'var(--paper)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--fg-1)',
          }}
        >
          <option value="all">Все оценки</option>
          <option value="5">★★★★★ только 5</option>
          <option value="4">★★★★ только 4</option>
          <option value="3">★★★ только 3</option>
          <option value="2">★★ только 2</option>
          <option value="1">★ только 1</option>
        </select>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            padding: '12px 16px',
            background: 'rgba(229,32,44,0.08)',
            border: '1px solid rgba(229,32,44,0.3)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--brand-rot)',
            fontSize: 14,
            fontWeight: 700,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {/* Drafts list */}
      {loading && drafts.length === 0 ? (
        <div
          style={{
            padding: 48,
            textAlign: 'center',
            color: 'var(--fg-3)',
            fontSize: 14,
          }}
        >
          <Loader2 className="h-6 w-6 animate-spin inline-block" />
          <div style={{ marginTop: 12 }}>Загрузка...</div>
        </div>
      ) : visibleDrafts.length === 0 ? (
        <div
          style={{
            padding: 48,
            textAlign: 'center',
            color: 'var(--fg-3)',
            fontSize: 14,
            background: 'var(--paper-sunk)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          {statusFilter === 'pending' ? (
            <>
              <CheckCircle2
                className="h-8 w-8 inline-block"
                style={{ color: 'var(--status-success)' }}
              />
              <div style={{ marginTop: 12, fontSize: 16, fontWeight: 700 }}>
                Нет отзывов на одобрение
              </div>
              <div style={{ marginTop: 4 }}>
                Cron запустится в ближайшие 20 минут и наполнит очередь.
              </div>
            </>
          ) : (
            'Нет данных под этот фильтр'
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {visibleDrafts.map((d) => (
            <DraftCard key={d.id} draft={d} onChange={loadAll} />
          ))}
        </div>
      )}

      {/* Tick log footer */}
      <details
        style={{
          marginTop: 32,
          padding: 16,
          background: 'var(--paper-sunk)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 14,
        }}
      >
        <summary
          style={{
            cursor: 'pointer',
            fontWeight: 700,
            color: 'var(--fg-2)',
            userSelect: 'none',
          }}
        >
          Последние тики cron ({tickLog.length})
        </summary>
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontFamily: 'var(--font-mono, ui-monospace)',
            fontSize: 14,
          }}
        >
          {tickLog.slice(0, 12).map((t, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 12,
                color:
                  t.errors > 0 ? 'var(--brand-rot)' : 'var(--fg-2)',
              }}
            >
              <span style={{ color: 'var(--fg-3)', minWidth: 140 }}>
                {t.ts.slice(11, 19)} {t.ts.slice(0, 10)}
              </span>
              <span style={{ fontWeight: 700 }}>
                ↑{t.replied} ↓{t.drafted ?? 0}
              </span>
              <span style={{ color: 'var(--fg-3)' }}>backlog {t.backlog}</span>
              {t.throttled && (
                <span style={{ color: 'var(--status-warning)' }}>
                  throttled
                </span>
              )}
              {t.errors > 0 && (
                <span style={{ fontWeight: 700 }}>{t.errors} err</span>
              )}
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
function KpiCard({
  label,
  value,
  hint,
  valueColor,
  icon,
}: {
  label: string;
  value: number | string;
  hint?: string;
  valueColor?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--paper)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
        padding: '16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 14,
          color: 'var(--fg-3)',
          marginBottom: 8,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: 0,
        }}
      >
        {icon}
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: valueColor ?? 'var(--fg-1)',
          letterSpacing: 0,
        }}
      >
        {value}
      </div>
      {hint && (
        <div
          style={{
            fontSize: 14,
            color: 'var(--fg-3)',
            marginTop: 4,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Status chip (filter button)
// =============================================================================
function StatusChip({
  label,
  count,
  active,
  onClick,
  accent,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  accent?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        background: active ? 'var(--brand-schwarz)' : 'var(--paper)',
        color: active ? 'var(--paper)' : 'var(--fg-1)',
        border: active
          ? '1px solid var(--brand-schwarz)'
          : '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 14,
        fontWeight: 700,
        cursor: 'pointer',
      }}
    >
      {accent && (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: accent,
          }}
        />
      )}
      {label}
      <span
        style={{
          color: active ? 'var(--stone-300)' : 'var(--fg-3)',
          fontWeight: 700,
        }}
      >
        {count}
      </span>
    </button>
  );
}

// =============================================================================
// Draft card (one review row)
// =============================================================================
function DraftCard({
  draft,
  onChange,
}: {
  draft: ReviewDraft;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(draft.draft_text ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localDraftText, setLocalDraftText] = useState(draft.draft_text);

  const stColors = STATUS_COLORS[draft.status];

  async function call(
    action: 'approve' | 'reject' | 'regenerate' | 'edit',
    body?: any
  ) {
    setBusy(action);
    setLocalError(null);
    try {
      const r = await fetch(
        `${API_BASE}/api/reviews/drafts/${draft.id}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }
      ).then((r) => r.json());
      if (!r.ok) {
        setLocalError(r.error ?? 'unknown error');
        return;
      }
      if (action === 'regenerate' && r.draft_text) {
        setLocalDraftText(r.draft_text);
        setEditText(r.draft_text);
      } else if (action === 'edit') {
        setLocalDraftText(body?.text ?? '');
        setEditing(false);
      } else {
        // approve / reject — reload parent list
        onChange();
      }
    } catch (e: any) {
      setLocalError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const isPending = draft.status === 'pending';
  const stars = '★'.repeat(draft.rating) + '☆'.repeat(5 - draft.rating);

  return (
    <div
      style={{
        background: 'var(--paper)',
        border:
          isPending && draft.rating <= 3
            ? '1px solid rgba(229,32,44,0.4)'
            : '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-md)',
        padding: '16px 20px',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            padding: '2px 8px',
            background: 'var(--paper-sunk)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--fg-2)',
            textTransform: 'uppercase',
          }}
        >
          {draft.channel}
        </span>
        <span
          style={{
            color: ratingColor(draft.rating),
            fontSize: 16,
            fontWeight: 700,
            letterSpacing: 0,
          }}
        >
          {stars}
        </span>
        <span
          style={{
            padding: '2px 10px',
            background: stColors.bg,
            color: stColors.fg,
            border: `1px solid ${stColors.border}`,
            borderRadius: 'var(--radius-sm)',
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          {stColors.label}
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
        </span>
      </div>

      {/* Review text */}
      {draft.review_text && (
        <div
          style={{
            padding: '12px 14px',
            background: 'var(--paper-sunk)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--fg-1)',
            marginBottom: 12,
            whiteSpace: 'pre-wrap',
          }}
        >
          {draft.review_text}
        </div>
      )}

      {(draft.pros || draft.cons) && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
          {draft.pros && (
            <div style={{ flex: 1, fontSize: 14 }}>
              <div
                style={{
                  color: 'var(--status-success)',
                  fontWeight: 700,
                  marginBottom: 4,
                }}
              >
                Достоинства
              </div>
              <div style={{ color: 'var(--fg-2)' }}>{draft.pros}</div>
            </div>
          )}
          {draft.cons && (
            <div style={{ flex: 1, fontSize: 14 }}>
              <div
                style={{
                  color: 'var(--brand-rot)',
                  fontWeight: 700,
                  marginBottom: 4,
                }}
              >
                Недостатки
              </div>
              <div style={{ color: 'var(--fg-2)' }}>{draft.cons}</div>
            </div>
          )}
        </div>
      )}

      {/* Draft text */}
      {localDraftText && (
        <>
          <div
            style={{
              fontSize: 14,
              color: 'var(--fg-3)',
              fontWeight: 700,
              textTransform: 'uppercase',
              marginBottom: 6,
              letterSpacing: 0,
            }}
          >
            {draft.status === 'auto_sent' || draft.status === 'approved_sent'
              ? 'Отправлено в WB'
              : 'Черновик ответа · Claude'}
          </div>
          {editing ? (
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={6}
              style={{
                width: '100%',
                padding: '12px 14px',
                background: 'var(--paper-deep)',
                border: '1px solid var(--brand-gold)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 14,
                lineHeight: 1.55,
                color: 'var(--fg-1)',
                fontFamily: 'inherit',
                resize: 'vertical',
                marginBottom: 12,
              }}
            />
          ) : (
            <div
              style={{
                padding: '12px 14px',
                background:
                  draft.status === 'auto_sent' ||
                  draft.status === 'approved_sent'
                    ? 'rgba(46,125,79,0.05)'
                    : 'rgba(199,122,0,0.05)',
                border:
                  draft.status === 'auto_sent' ||
                  draft.status === 'approved_sent'
                    ? '1px solid rgba(46,125,79,0.2)'
                    : '1px solid rgba(199,122,0,0.2)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 14,
                lineHeight: 1.55,
                color: 'var(--fg-1)',
                marginBottom: 12,
                whiteSpace: 'pre-wrap',
              }}
            >
              {localDraftText}
            </div>
          )}
        </>
      )}

      {/* Local error */}
      {localError && (
        <div
          style={{
            padding: '8px 12px',
            background: 'rgba(229,32,44,0.08)',
            color: 'var(--brand-rot)',
            border: '1px solid rgba(229,32,44,0.3)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 14,
            marginBottom: 8,
            fontWeight: 700,
          }}
        >
          {localError}
        </div>
      )}

      {/* Action buttons (only when pending) */}
      {isPending && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {editing ? (
            <>
              <ActionBtn
                onClick={() => call('edit', { text: editText })}
                icon={<CheckCircle2 className="h-4 w-4" />}
                label="Сохранить"
                busy={busy === 'edit'}
                primary
              />
              <ActionBtn
                onClick={() => {
                  setEditing(false);
                  setEditText(localDraftText ?? '');
                }}
                icon={<XCircle className="h-4 w-4" />}
                label="Отмена"
              />
            </>
          ) : (
            <>
              <ActionBtn
                onClick={() => call('approve', { approvedBy: 'aram' })}
                icon={<Send className="h-4 w-4" />}
                label="Одобрить и отправить"
                busy={busy === 'approve'}
                primary
              />
              <ActionBtn
                onClick={() => call('regenerate')}
                icon={<Sparkles className="h-4 w-4" />}
                label="Перегенерировать"
                busy={busy === 'regenerate'}
              />
              <ActionBtn
                onClick={() => {
                  setEditText(localDraftText ?? '');
                  setEditing(true);
                }}
                icon={<Edit3 className="h-4 w-4" />}
                label="Редактировать"
              />
              <div style={{ flex: 1 }} />
              <ActionBtn
                onClick={() =>
                  call('reject', {
                    reason: 'manual skip',
                    rejectedBy: 'aram',
                  })
                }
                icon={<XCircle className="h-4 w-4" />}
                label="Пропустить"
                danger
                busy={busy === 'reject'}
              />
            </>
          )}
        </div>
      )}

      {/* Meta footer for sent items */}
      {(draft.status === 'auto_sent' || draft.status === 'approved_sent') &&
        draft.posted_to_wb_at && (
          <div
            style={{
              fontSize: 14,
              color: 'var(--fg-3)',
              fontStyle: 'italic',
              borderTop: '1px solid var(--border-hairline)',
              paddingTop: 8,
              marginTop: 4,
            }}
          >
            Отправлено {relativeDate(draft.posted_to_wb_at)}
            {draft.approved_by && ` · ${draft.approved_by}`}
          </div>
        )}
    </div>
  );
}

// =============================================================================
// Action button
// =============================================================================
function ActionBtn({
  onClick,
  icon,
  label,
  primary = false,
  danger = false,
  busy = false,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 14px',
        background: primary
          ? 'var(--status-success)'
          : danger
            ? 'var(--paper)'
            : 'var(--paper)',
        color: primary
          ? 'var(--paper)'
          : danger
            ? 'var(--brand-rot)'
            : 'var(--fg-1)',
        border: primary
          ? '1px solid var(--status-success)'
          : danger
            ? '1px solid rgba(229,32,44,0.3)'
            : '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 14,
        fontWeight: 700,
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {label}
    </button>
  );
}
