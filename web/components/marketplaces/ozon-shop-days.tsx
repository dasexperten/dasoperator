'use client';

// =============================================================================
// «Магазин по дням» — Owner 2026-11-24. The whole Ozon shop for the last five
// complete Moscow days: orders, revenue, average price, views, carts.
// Sits on the home page directly above the Ozon product table (Топ-10 Ozon).
// Days are columns, metrics are rows — the shape the Owner asked for.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiGet } from '@/lib/api';
import styles from './ozon-shop-days.module.css';

type ShopDay = { date: string; orders: number; revenue_rub: number; avg_price_rub: number | null; views: number; carts: number };
type ShopDays = { from: string; to: string; timezone: string; fetched_at: number; days: ShopDay[] };

const int = (v: number | null) => v == null ? '—' : Math.round(v).toLocaleString('ru-RU');
const thousands = (v: number) => (v / 1000).toLocaleString('ru-RU', { maximumFractionDigits: v >= 100_000 ? 0 : 1 });
const dayLabel = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

const ROWS: Array<{ key: string; label: string; short: string; value: (d: ShopDay) => string }> = [
  { key: 'orders', label: 'Заказы', short: 'Заказы', value: d => int(d.orders) },
  { key: 'revenue', label: 'Сумма заказов до скидок, тыс ₽', short: 'Сумма до скидок, тыс', value: d => thousands(d.revenue_rub) },
  { key: 'avg', label: 'Средняя цена до скидок, ₽', short: 'Цена до скидок', value: d => int(d.avg_price_rub) },
  { key: 'views', label: 'Показы, тыс', short: 'Показы, тыс', value: d => thousands(d.views) },
  { key: 'carts', label: 'Корзины', short: 'Корзины', value: d => int(d.carts) },
];

export default function OzonShopDays() {
  const [data, setData] = useState<ShopDays | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try {
      const res = await apiGet<ShopDays>(`/api/marketplaces/pulse/ozon-shop-days?days=5${refresh ? '&refresh=1' : ''}`);
      if (!res.success || !res.result) throw new Error('unavailable');
      setData(res.result);
    } catch { setError('Не удалось получить данные магазина Ozon.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const days = data?.days ?? [];
  return (
    <section className={styles.panel} aria-label="Магазин по дням" aria-busy={loading}>
      <header className={styles.header}>
        <h2>Магазин по дням</h2>
        <div className={styles.tools}>
          <span>Ozon · полные сутки МСК</span>
          <button type="button" className={styles.refresh} disabled={loading} onClick={() => void load(true)} aria-label="Обновить магазин по дням" title="Обновить">
            <RefreshCw size={16} aria-hidden="true" className={loading ? styles.spinning : ''} />
          </button>
        </div>
      </header>
      {error && <p className={styles.notice} role="alert">{error}</p>}
      {loading && !data ? <p className={styles.empty} role="status">Загружаем магазин…</p>
        : !days.length ? <p className={styles.empty}>Нет данных Ozon.</p>
          : <div className={styles.tableWrap}>
            <table className={`${styles.table} dx-keep-table`}>
              <thead><tr>
                <th scope="col" className={styles.metric}><span className={styles.srOnly}>Показатель</span></th>
                {days.map((d, i) => <th scope="col" key={d.date} className={i === days.length - 1 ? styles.latest : undefined}>{dayLabel(d.date)}</th>)}
              </tr></thead>
              <tbody>{ROWS.map(row => <tr key={row.key}>
                <th scope="row" className={styles.metric}>
                  <span className={styles.desktopLabel}>{row.label}</span><span className={styles.mobileLabel}>{row.short}</span>
                </th>
                {days.map((d, i) => <td key={d.date} className={i === days.length - 1 ? styles.latest : undefined}>{row.value(d)}</td>)}
              </tr>)}</tbody>
            </table>
          </div>}
    </section>
  );
}
