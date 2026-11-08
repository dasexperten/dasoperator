'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { apiGet } from '@/lib/api';
import styles from './ozon-boost-sales.module.css';

type Membership = {
  action_id: number;
  title: string;
  status: 'active' | 'future' | 'ended' | 'unknown';
  action_price: number | null;
  current_boost: number | null;
  official_boost?: number | null;
  min_boost: number | null;
  max_boost: number | null;
  is_quarantined: boolean | null;
  date_start: string | null;
  date_end: string | null;
};

type ProductRow = {
  product_id: number;
  offer_id: string;
  name: string;
  seller_price: number | null;
  min_price: number | null;
  boost: { value: number | null; value_kind?: 'api' | 'terms' | 'unknown'; status: 'active' | 'none' | 'unknown'; basis: string; memberships: Membership[] };
  issues: string[];
  today_units: number | null;
  yesterday_units: number | null;
  delta_units: number | null;
  delta_pct: number | null;
};

type PromotionReport = {
  snapshot_at: string | null;
  sales_as_of: string;
  timezone: string;
  cutoff: string;
  sales_scope?: string;
  sales_available: boolean;
  sales_error?: string;
  rows: ProductRow[];
  coverage?: { orders?: { basis?: string; [key: string]: unknown }; [key: string]: unknown };
};

const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const price = (value: number | null | undefined) => value == null ? 'не передана' : `${number(value)}\u00a0₽`;

function asOf(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'ещё не проверен';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Yerevan', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function Boost({ row, snapshot }: { row: ProductRow; snapshot: boolean }) {
  const boost = row.boost;
  const active = boost?.memberships?.filter(m => m.status === 'active') ?? [];
  const label = !snapshot || !boost || boost.status === 'unknown'
    ? 'Не подтверждён'
    : boost.value != null ? `${number(boost.value)}%`
      : boost.status === 'none' ? 'Нет активного' : 'Участие активно';
  return (
    <div className={styles.boost}>
      <strong>{label}</strong>
      {snapshot && boost?.value != null && boost.status !== 'unknown' && <span>{boost.value_kind === 'terms' ? 'по условиям акции' : boost.value_kind === 'api' ? 'данные Ozon API' : 'источник в расчёте'}</span>}
      {active.length > 0 && <span>{active.map(m => m.title).join(' · ')}</span>}
    </div>
  );
}

function Change({ row, available }: { row: ProductRow; available: boolean }) {
  if (!available || row.delta_units == null) return <span className={styles.unknown}>—</span>;
  const delta = row.delta_units;
  const direction = delta > 0 ? styles.positive : delta < 0 ? styles.negative : styles.neutral;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  return (
    <span className={`${styles.change} ${direction}`} aria-label={`${delta > 0 ? 'Рост' : delta < 0 ? 'Снижение' : 'Без изменения'}: ${number(Math.abs(delta))} шт`}>
      <strong>{sign}{number(Math.abs(delta))}<span className={styles.unit}> шт</span></strong>
      {row.delta_pct != null && delta !== 0 && <span>{sign}{number(Math.abs(row.delta_pct))}%</span>}
      {delta > 0 && row.yesterday_units === 0 && <span>вчера 0</span>}
    </span>
  );
}

function Calculation({ row }: { row: ProductRow }) {
  const memberships = row.boost?.memberships ?? [];
  return (
    <details className={styles.calculation}>
      <summary>Расчёт бустинга</summary>
      <div className={styles.detailBody}>
        <p>{row.boost?.basis || 'Ozon ещё не передал подтверждение бустинга.'}</p>
        <p>Цена продавца: <strong>{price(row.seller_price)}</strong>. Минимальная цена в Ozon: <strong>{price(row.min_price)}</strong>.</p>
        {memberships.length > 0 && <ul>{memberships.map(m => (
          <li key={m.action_id}>
            <strong>{m.title}</strong>
            <span>{m.is_quarantined ? 'Карантин' : m.status === 'active' ? 'Действует' : m.status === 'future' ? 'Будущая акция' : m.status === 'ended' ? 'Завершена' : 'Статус не подтверждён'} · цена {price(m.action_price)}{m.official_boost != null ? ` · ${number(m.official_boost)}% по условиям` : m.current_boost != null ? ` · ${number(m.current_boost)}% по данным API` : ''}</span>
            {(m.date_start || m.date_end) && <span>{m.date_start ? `С ${asOf(m.date_start)}` : ''}{m.date_end ? ` до ${asOf(m.date_end)}` : ''} · Ереван</span>}
          </li>
        ))}</ul>}
        {row.issues?.length > 0 && <ul className={styles.issues}>{row.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>}
      </div>
    </details>
  );
}

/** Same factual rows on the homepage (top ten) and on the Ozon page (all SKUs). */
export default function OzonBoostSales({ top10 = false }: { top10?: boolean }) {
  const [report, setReport] = useState<PromotionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await apiGet<PromotionReport>('/api/cron-runs/promozon?refresh=1');
      if (!response.success || !response.result) throw new Error('report unavailable');
      setReport(response.result);
    } catch {
      setError('Не удалось обновить данные Ozon. Повторите обновление.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <OzonBoostSalesView top10={top10} report={report} loading={loading} error={error} onRefresh={() => void load()} />;
}

export function OzonBoostSalesView({ top10 = false, report, loading = false, error = '', onRefresh }: {
  top10?: boolean; report: PromotionReport | null; loading?: boolean; error?: string; onRefresh: () => void;
}) {
  const rows = useMemo(() => {
    // A top-ten ranking needs a confirmed order comparison, never an
    // alphabetical placeholder that could be mistaken for today's leaders.
    if (top10 && report && !report.sales_available) return [];
    const sorted = [...(report?.rows ?? [])].sort((a, b) =>
      (b.today_units ?? -1) - (a.today_units ?? -1)
      || (b.yesterday_units ?? -1) - (a.yesterday_units ?? -1)
      || a.offer_id.localeCompare(b.offer_id, 'ru', { numeric: true }));
    return top10 ? sorted.slice(0, 10) : sorted;
  }, [report, top10]);
  const available = Boolean(report?.sales_available) && !error;
  const title = top10 ? 'Топ-10 позиций Ozon' : 'Все позиции Ozon';

  return (
    <section className={styles.panel} aria-label={title} aria-busy={loading}>
      <header className={styles.header}>
        <div>
          <h2>{title}</h2>
          <p>Бустинг и заказанные единицы{report?.sales_scope ? ` · ${report.sales_scope}` : ''}</p>
        </div>
        <button type="button" className={styles.refresh} disabled={loading} onClick={onRefresh} aria-label="Обновить бустинг и заказы Ozon">
          <RefreshCw size={16} aria-hidden="true" className={loading ? styles.spinning : ''} />
          <span>{loading ? 'Обновляем' : 'Обновить'}</span>
        </button>
      </header>

      {report && <div className={styles.meta}>
        <span>Сегодня и вчера до <strong>{report.cutoff || '—'}</strong> · Ереван</span>
        <span>Бустинг проверен: {asOf(report.snapshot_at)}</span>
      </div>}
      {error && <p className={styles.notice} role="alert">{error}{report ? ' Ниже последний сохранённый срез.' : ''}</p>}
      {report && !report.sales_available && <p className={styles.notice}>Сравнение заказов пока не подтверждено. {report.sales_error || 'Данные за одинаковые часы ещё не получены.'}</p>}

      {loading && !report ? <div className={styles.skeleton} aria-label="Загрузка товаров Ozon">{Array.from({ length: top10 ? 5 : 8 }, (_, i) => <div key={i} />)}</div>
        : !rows.length ? <p className={styles.empty}>{error ? 'Таблица появится после успешного обновления.' : top10 && report && !report.sales_available ? 'Топ-10 появится, когда количество заказанных единиц будет подтверждено.' : 'В сохранённом срезе пока нет товаров Ozon.'}</p>
          : <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th scope="col">Товар</th><th scope="col">Бустинг сейчас</th><th scope="col">Сегодня</th><th scope="col">Вчера</th><th scope="col">Изменение</th></tr></thead>
              <tbody>{rows.map(row => <tr key={row.product_id}>
                <th scope="row" className={styles.product}>
                  <strong>{row.name || row.offer_id || `Товар ${row.product_id}`}</strong>
                  <span>{row.offer_id}</span>
                  <Calculation row={row} />
                </th>
                <td className={styles.boostCell} data-label="Бустинг"><Boost row={row} snapshot={Boolean(report?.snapshot_at) && !error} /></td>
                <td className={styles.count} data-label="Сегодня">{number(available ? row.today_units : null)}</td>
                <td className={styles.count} data-label="Вчера">{number(available ? row.yesterday_units : null)}</td>
                <td className={styles.delta} data-label="Изменение"><Change row={row} available={available} /></td>
              </tr>)}</tbody>
            </table>
          </div>}

      <footer className={styles.footer}>
        <span>{top10 ? 'По количеству заказанных единиц сегодня. ' : `${report?.rows.length ?? 0} позиций. `}Проценты разных акций не складываются.</span>
        {top10 && <Link href="/marketplaces?tab=ozon-promos">Все позиции <ArrowUpRight size={15} aria-hidden="true" /></Link>}
      </footer>
    </section>
  );
}
