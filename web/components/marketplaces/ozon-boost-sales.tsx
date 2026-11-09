'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiGet } from '@/lib/api';
import styles from './ozon-boost-sales.module.css';

type Membership = {
  action_id: number; title: string; status: 'active' | 'future' | 'ended' | 'unknown';
  current_boost: number | null; official_boost?: number | null; is_quarantined: boolean | null;
};
type ProductRow = {
  product_id: number; offer_id: string; name: string; display_name?: string;
  boost: { value: number | null; value_kind?: 'api' | 'terms' | 'unknown'; status: 'active' | 'none' | 'unknown'; basis: string; memberships: Membership[] };
  issues: string[]; today_units: number | null; yesterday_units: number | null;
  delta_units: number | null; delta_pct: number | null;
  today_baskets?: number | null; yesterday_baskets?: number | null; delta_baskets_pct?: number | null;
};
type PromotionReport = {
  snapshot_at: string | null; sales_as_of: string; timezone: string; cutoff: string;
  sales_scope?: string; sales_available: boolean; sales_error?: string; rows: ProductRow[];
  baskets_available?: boolean; baskets_comparable?: boolean; baskets_basis?: string;
  baskets_period?: { today: string; yesterday: string; timezone: string } | string;
  baskets_as_of?: string; baskets_stale?: boolean; baskets_error?: string;
};

const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
function compactName(row: ProductRow) {
  return (row.display_name || row.offer_id || row.name)
    .replace(/\s*([24])\s*in\s*1\b/gi, '-$1')
    .replace(/TERMO\s*39\s*°?/gi, 'TERMO').toUpperCase();
}
function boostType(title: string) {
  if (/эластич/i.test(title)) return 'Эластичный бустинг';
  if (/супербустинг/i.test(title)) return 'Супербустинг';
  if (/максимальн.*бустинг/i.test(title)) return 'Максимальный бустинг';
  return 'Бустинг';
}
function Boost({ row, confirmed }: { row: ProductRow; confirmed: boolean }) {
  const boost = row.boost;
  if (!confirmed || !boost || boost.status === 'unknown') return <>Не подтверждён</>;
  if (boost.status === 'none') return <>Нет</>;
  if (boost.value == null) return <>Участие активно</>;
  const source = boost.memberships?.find(m => m.status === 'active' && !m.is_quarantined
    && (boost.value_kind === 'terms' ? m.official_boost === boost.value : m.current_boost === boost.value));
  return <><strong>{number(boost.value)}%</strong> {source ? boostType(source.title) : 'Бустинг'}</>;
}
function Change({ row, available }: { row: ProductRow; available: boolean }) {
  if (!available || row.delta_units == null) return <>—</>;
  const delta = row.delta_units;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const text = row.yesterday_units === 0 && delta !== 0
    ? `${sign}${number(Math.abs(delta))}`
    : row.delta_pct != null ? `${sign}${number(Math.abs(row.delta_pct))}%` : delta === 0 ? '0%' : '—';
  return <span className={delta > 0 ? styles.positive : delta < 0 ? styles.negative : styles.neutral}>{text}</span>;
}
function BasketChange({ row, available }: { row: ProductRow; available: boolean }) {
  if (!available || row.delta_baskets_pct == null) return <>—</>;
  const delta = row.delta_baskets_pct;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  const text = `${sign}${number(Math.abs(delta))}%`;
  return <span className={delta > 0 ? styles.positive : delta < 0 ? styles.negative : styles.neutral}>{text}</span>;
}

export default function OzonBoostSales({ top10 = false }: { top10?: boolean }) {
  const [report, setReport] = useState<PromotionReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [response, catalogue] = await Promise.all([
        apiGet<PromotionReport>('/api/cron-runs/promozon?refresh=1'),
        apiGet<{ products: Array<{ id: string; product_name: string }> }>('/api/products').catch(() => null),
      ]);
      if (!response.success || !response.result) throw new Error('report unavailable');
      const exactId = (value: string) => value.replace(/^prd_/i, '').toLowerCase();
      const names = new Map((catalogue?.success ? catalogue.result?.products ?? [] : [])
        .map(product => [exactId(product.id), product.product_name]));
      setReport({ ...response.result, rows: response.result.rows.map(row => ({ ...row,
        display_name: names.get(exactId(row.offer_id)) || undefined,
      })) });
    } catch { setError('Не удалось обновить данные Ozon.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <OzonBoostSalesView top10={top10} report={report} loading={loading} error={error} onRefresh={() => void load()} />;
}

export function OzonBoostSalesView({ top10 = false, report, loading = false, error = '', onRefresh }: {
  top10?: boolean; report: PromotionReport | null; loading?: boolean; error?: string; onRefresh: () => void;
}) {
  const rows = useMemo(() => {
    if (top10 && report && !report.sales_available) return [];
    const sorted = [...(report?.rows ?? [])].sort((a, b) =>
      (b.today_units ?? -1) - (a.today_units ?? -1) || (b.yesterday_units ?? -1) - (a.yesterday_units ?? -1)
      || a.offer_id.localeCompare(b.offer_id, 'ru', { numeric: true }));
    return top10 ? sorted.slice(0, 10) : sorted;
  }, [report, top10]);
  const available = Boolean(report?.sales_available) && !error;
  const basketsAvailable = Boolean(report?.baskets_available) && !error;
  const basketEvidence = ['Сегодня неполный московский день; вчера полный. Добавления в корзину, не уникальные покупатели.',
    report?.baskets_basis, typeof report?.baskets_period === 'string'
      ? report.baskets_period : report?.baskets_period ? `${report.baskets_period.today} / ${report.baskets_period.yesterday} · ${report.baskets_period.timezone}` : '',
    report?.baskets_as_of ? `Срез корзин: ${report.baskets_as_of}` : '', report?.baskets_error].filter(Boolean).join('\n')
    || 'Сопоставимый источник корзин не подтверждён';
  const title = top10 ? 'Топ-10 Ozon' : 'Все позиции Ozon';
  return (
    <section className={styles.panel} aria-label={title} aria-busy={loading}>
      <header className={styles.header}>
        <h2>{title}</h2>
        <div className={styles.tools}>
          {(report?.baskets_period || report?.baskets_available) && <span className={styles.basketPeriod} title={basketEvidence}>Корзины: сутки МСК{report?.baskets_stale ? ' · прошлый срез' : ''}</span>}
          {report?.cutoff && <span title={`Сегодня и вчера до одного времени. ${report.sales_as_of}. ${report.sales_scope ?? ''}`}>{report.cutoff} · Ереван</span>}
          <button type="button" className={styles.refresh} disabled={loading} onClick={onRefresh} aria-label="Обновить Ozon" title="Обновить">
            <RefreshCw size={16} aria-hidden="true" className={loading ? styles.spinning : ''} />
          </button>
        </div>
      </header>
      {error && <p className={styles.notice} role="alert">{error}</p>}
      {report && !report.sales_available && <p className={styles.notice}>Сравнение заказов не подтверждено.</p>}
      {loading && !report ? <p className={styles.empty} role="status">Загружаем Ozon…</p>
        : !rows.length ? <p className={styles.empty}>{top10 && report && !report.sales_available ? 'Топ-10 пока не подтверждён.' : 'Нет данных Ozon.'}</p>
          : <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Товары Ozon, таблица с горизонтальной прокруткой">
            <table className={`${styles.table} dx-keep-table`}>
              <thead><tr>
                <th scope="col">Товар</th><th scope="col" className={styles.boostHeader}>Бустинг</th>
                <th scope="col"><span className={styles.desktopLabel}>Заказы сегодня</span><span className={styles.mobileLabel}>Сег.</span></th>
                <th scope="col" className={styles.basket} title={basketEvidence}>Корзины сегодня</th>
                <th scope="col"><span className={styles.desktopLabel}>Заказы вчера</span><span className={styles.mobileLabel}>Вчр.</span></th>
                <th scope="col" className={styles.basket} title={basketEvidence}>Корзины вчера</th>
                <th scope="col"><span className={styles.desktopLabel}>Δ заказов</span><span className={styles.mobileLabel}>Δ</span></th>
                <th scope="col" className={styles.basket} title={basketEvidence}>Δ корзин</th>
              </tr></thead>
              <tbody>{rows.map(row => <tr key={row.product_id}>
                <th scope="row" className={styles.product} title={`${row.offer_id} · ${row.name}`}><span>{compactName(row)}</span></th>
                <td className={styles.boostCell} title={[row.boost?.basis, ...(row.boost?.memberships ?? []).map(m => m.title), ...(row.issues ?? [])].filter(Boolean).join('\n')}><Boost row={row} confirmed={Boolean(report?.snapshot_at) && !error} /></td>
                <td className={styles.count}>{number(available ? row.today_units : null)}</td>
                <td className={`${styles.count} ${styles.basket}`} title={basketEvidence}>{number(basketsAvailable ? row.today_baskets : null)}</td>
                <td className={styles.count}>{number(available ? row.yesterday_units : null)}</td>
                <td className={`${styles.count} ${styles.basket}`} title={basketEvidence}>{number(basketsAvailable ? row.yesterday_baskets : null)}</td>
                <td className={styles.delta}><Change row={row} available={available} /></td>
                <td className={`${styles.delta} ${styles.basket}`} title="Δ появится при сравнении за одинаковые часы"><BasketChange row={row} available={basketsAvailable && report?.baskets_comparable === true} /></td>
              </tr>)}</tbody>
            </table>
          </div>}
    </section>
  );
}
