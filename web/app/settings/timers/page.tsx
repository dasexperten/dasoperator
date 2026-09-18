'use client';

export const runtime = 'edge';

// Settings → Timers: every erp-* timer worker, its last run and the last 50 runs.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Timer } from 'lucide-react';
import { apiGet } from '@/lib/api';

interface Run {
  id: number;
  worker: string;
  cron: string;
  started_at: string;
  finished_at: string | null;
  ok: number;
  dry_run: number;
  rows: number | null;
  note: string | null;
  error: string | null;
}
interface Day {
  worker: string;
  ok_24h: number;
  failed_24h: number;
}
interface Data {
  workers: Run[];
  last_24h: Day[];
  recent: Run[];
}

function yerevan(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Yerevan', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

function status(r: Run): { label: string; color: string } {
  if (!r.finished_at) return { label: 'идёт', color: 'var(--fg-2)' };
  if (!r.ok) return { label: 'ошибка', color: '#C71926' };
  return { label: r.dry_run ? 'сухой прогон' : 'готово', color: '#1D7A5A' };
}

const cell: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--line-1)', fontSize: '14px', color: 'var(--fg-1)', verticalAlign: 'top' };
const num: React.CSSProperties = { ...cell, whiteSpace: 'nowrap', width: '1%', textAlign: 'right' };
const head: React.CSSProperties = { ...cell, fontWeight: 600, color: 'var(--fg-2)', fontSize: '13px' };

function Table({ runs, day }: { runs: Run[]; day?: Map<string, Day> }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--paper)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...head, textAlign: 'left' }}>Таймер</th>
            <th style={{ ...head, textAlign: 'left' }}>Время, Ереван</th>
            <th style={{ ...head, textAlign: 'left' }}>Итог</th>
            <th style={{ ...head, textAlign: 'right' }}>Строк</th>
            {day && <th style={{ ...head, textAlign: 'right' }}>За сутки</th>}
            <th style={{ ...head, textAlign: 'left' }}>Что вышло</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const s = status(r);
            const d = day?.get(r.worker);
            return (
              <tr key={r.id}>
                <td style={{ ...cell, whiteSpace: 'nowrap', fontWeight: 600 }}>{r.worker}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap' }}>{yerevan(r.started_at)}</td>
                <td style={{ ...cell, whiteSpace: 'nowrap', color: s.color, fontWeight: 600 }}>{s.label}</td>
                <td style={num}>{r.rows ?? '—'}</td>
                {day && (
                  <td style={num}>
                    {d ? `${d.ok_24h} ок` : '—'}
                    {d && d.failed_24h > 0 ? <span style={{ color: '#C71926' }}>{` · ${d.failed_24h} ошиб.`}</span> : null}
                  </td>
                )}
                <td style={{ ...cell, color: r.error ? '#C71926' : 'var(--fg-2)', fontSize: '13px' }}>{r.error ?? r.note ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function TimersPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Data>('/api/cron-runs')
      .then((r) => {
        if (r.success && r.result) setData(r.result);
        else setError(r.errors?.[0]?.message ?? 'Не удалось загрузить');
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  const day = new Map((data?.last_24h ?? []).map((d) => [d.worker, d]));

  return (
    <div className="px-8 py-6 max-w-screen-2xl">
      <Link href="/settings" style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--fg-3)', textDecoration: 'none', marginBottom: '16px' }}>
        <ArrowLeft className="h-4 w-4" /> Settings
      </Link>
      <div className="flex items-center gap-3 mb-2">
        <Timer className="h-7 w-7" style={{ color: 'var(--fg-1)' }} />
        <h1 style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '28px', fontWeight: 700, color: 'var(--fg-1)', textTransform: 'uppercase', letterSpacing: 0 }}>
          Timers
        </h1>
      </div>
      <p style={{ fontSize: '14px', color: 'var(--fg-2)', marginBottom: '20px', maxWidth: '720px' }}>
        Автоматические задачи ERP без модели: курсы, остатки, продажи, банк, отзывы. Одна задача — один таймер.
        Ошибка любого таймера приходит в Telegram один раз.
      </p>

      {error && <div style={{ color: '#C71926', fontSize: '14px' }}>{error}</div>}
      {!data && !error && <div style={{ color: 'var(--fg-2)', fontSize: '14px' }}>Загрузка…</div>}

      {data && (
        <>
          <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--fg-1)', margin: '8px 0 12px' }}>Последний запуск каждого таймера</h2>
          {data.workers.length ? <Table runs={data.workers} day={day} /> : <div style={{ color: 'var(--fg-2)', fontSize: '14px' }}>Запусков пока нет.</div>}
          <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--fg-1)', margin: '28px 0 12px' }}>Последние 50 запусков</h2>
          {data.recent.length ? <Table runs={data.recent} /> : null}
        </>
      )}
    </div>
  );
}
