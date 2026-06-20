'use client';

import { useEffect, useState } from 'react';
import { Mail, Calendar, ShoppingCart, Clock } from 'lucide-react';

// =============================================================================
// Daily Digest Widget — reads from KV cache (warmed by cron at 06:00 MSK)
// =============================================================================

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || 'https://dasoperator-api.dasexperten.workers.dev';

type DigestData = {
  timestamp: string;
  text: string;
  gmail: { messages: Array<{ from: string; subject: string; isUnread: boolean }>; unreadCount: number };
  calendar: { events: Array<{ summary: string; start: string }>; todayCount: number };
  marketplace: { combined: number };
};

export default function DailyDigest() {
  const [digest, setDigest] = useState<DigestData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/daily-digest`)
      .then((r) => r.json())
      .then((json) => {
        if (json.success && json.result) setDigest(json.result);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <section>
        <div className="dx-eyebrow-rot mb-2" style={{ fontSize: 'var(--fs-body-sm)' }}>
          Daily Digest
        </div>
        <div style={{ color: 'var(--fg-3)', fontSize: '14px' }}>Loading…</div>
      </section>
    );
  }

  if (!digest) {
    return null; // No digest available yet
  }

  const lastUpdate = new Date(digest.timestamp).toLocaleString('ru-RU', {
    timeZone: 'Asia/Yerevan',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="dx-eyebrow-rot" style={{ fontSize: 'var(--fs-body-sm)' }}>
          Daily Digest
        </div>
        <div className="flex items-center gap-1" style={{ color: 'var(--fg-3)', fontSize: '12px' }}>
          <Clock size={12} />
          {lastUpdate}
        </div>
      </div>

      <div
        className="grid grid-cols-3 gap-4"
        style={{
          backgroundColor: 'var(--paper)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-md)',
          padding: '16px',
        }}
      >
        {/* Gmail */}
        <div className="flex items-start gap-3">
          <Mail size={18} style={{ color: 'var(--brand-rot)', marginTop: '2px' }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--fg-1)' }}>Почта</div>
            <div style={{ fontSize: '13px', color: 'var(--fg-2)', marginTop: '4px' }}>
              {digest.gmail.unreadCount > 0
                ? `${digest.gmail.unreadCount} непрочитанных`
                : 'Нет новых писем'}
            </div>
          </div>
        </div>

        {/* Calendar */}
        <div className="flex items-start gap-3">
          <Calendar size={18} style={{ color: 'var(--line-innoweiss)', marginTop: '2px' }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--fg-1)' }}>Календарь</div>
            <div style={{ fontSize: '13px', color: 'var(--fg-2)', marginTop: '4px' }}>
              {digest.calendar.todayCount > 0
                ? `${digest.calendar.todayCount} событий сегодня`
                : 'Нет событий'}
            </div>
          </div>
        </div>

        {/* Marketplace */}
        <div className="flex items-start gap-3">
          <ShoppingCart size={18} style={{ color: 'var(--status-success)', marginTop: '2px' }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--fg-1)' }}>Продажи</div>
            <div style={{ fontSize: '13px', color: 'var(--fg-2)', marginTop: '4px' }}>
              {digest.marketplace.combined > 0
                ? `${Math.round(digest.marketplace.combined).toLocaleString('ru-RU')} ₽`
                : 'Данные обновляются…'}
            </div>
          </div>
        </div>
      </div>

      {/* Expanded digest text */}
      <details className="mt-3">
        <summary
          style={{
            cursor: 'pointer',
            fontSize: '13px',
            color: 'var(--fg-3)',
            userSelect: 'none',
          }}
        >
          Полная сводка
        </summary>
        <pre
          style={{
            marginTop: '8px',
            padding: '12px',
            backgroundColor: 'var(--paper-sunk)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '13px',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            fontFamily: 'var(--font-body)',
            color: 'var(--fg-2)',
          }}
        >
          {digest.text}
        </pre>
      </details>
    </section>
  );
}
