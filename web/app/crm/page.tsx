'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback } from 'react';
import {
  Loader2, RefreshCw, Headphones, AlertCircle, Search, Save,
  ChevronLeft, ChevronRight, ShoppingBag, Users
} from 'lucide-react';

interface CrmStats {
  source: string;
  customers_total: number;
  orders_total: number;
  orders_this_month: number;
  revenue_this_month_rub: number;
  loyalty_members_total: number;
  synced_at: number;
}

interface MetrikaStats {
  source: string;
  counter_id: number;
  today: {
    visits: number;
    users: number;
    bounce_rate_pct: number;
    avg_duration_sec: number;
  };
  timeline: Array<{ date: string; visits: number; users: number }>;
  synced_at: number;
}

interface CrmTimeline {
  source: string;
  window_days: number;
  timeline: Array<{ date: string; registrations: number; orders: number }>;
  synced_at: number;
}

interface CrmOrder {
  id: number;
  number: string;
  customer_name: string;
  total: number;
  status: string;
  created_at: string;
  bonus_credited: number;
  bonus_charged: number;
  loyalty_balance: number | null;
  loyalty_level: string | null;
  loyalty_privilege_pct: number | null;
  // present only for the .com (website/Stripe) source
  currency?: string;
  email?: string | null;
  ship_country?: string | null;
  items?: Array<{ sku: string | null; name?: string | null; qty: number }>;
  // .ru: витрина отдаёт позиции только количеством — артикулов и названий в
  // ленте пока нет, поэтому здесь число штук. Как только orders.php начнёт
  // класть в позицию sku и name, они приедут в items и подсказка оживёт сама.
  items_count?: number;
  order_source?: string;
  fulfillment_status?: string | null;
  tracking_url?: string | null;
  // слой 3 (зеркало .ru в D1, 29.08.2026): оплата Т-Кассы и доставка Ozon
  storefront_status?: string | null;
  paid?: boolean;
  paid_at?: string | null;
  delivery_provider?: string | null;
  delivery_status?: string | null;
  delivery_order_id?: string | null;
  tracking_number?: string | null;
  // слой 4 (05.09.2026): подстатус Ozon и разбивка заказа на посылки
  delivery_substatus?: string | null;
  delivery_updated_at?: string | null;
  mirror_source?: string | null;
  delivery_parts_total?: number;
  delivery_parts_at_point?: number;
  delivery_parts_received?: number;
  // Проверка наличия двумя местами: Зина — наши склады/поставки, Даша — Ozon.
  stock_facts?: Array<{
    sku: string;
    our_stock: number;
    assembleable: number;
    our_stock_at: number | null;
    in_transit: number;
    in_transit_at: number | null;
    ozon_available: number | null;
    ozon_stock_at: number | null;
    supply_qty: number;
    supply_stage: string | null;
    supply_eta: number | null;
    supply_updated_at: number | null;
    // Живой снимок Seller API: только он даёт право назвать поставку «в пути».
    ozon_supply_qty: number | null;
    ozon_supply_states: string[] | null;
    ozon_in_transit: number | null;
  }>;
}

interface CrmCustomer {
  id: number | string;
  name: string;
  // .ru: город пункта выдачи из связки ключей; в ленте витрины города нет.
  city?: string | null;
  email: string | null;
  phone: string | null;
  orders_count: number;
  total_spent: number;
  average_order: number;
  created_at: string;
  // .ru: даты регистрации лента не отдаёт — здесь дата последнего заказа.
  last_order_at?: string;
  loyalty_balance: number | null;
  loyalty_level: string | null;
  loyalty_privilege_pct: number | null;
  // Откуда уровень: 'account' — счёт лояльности в D1, 'spent' — посчитан по
  // сумме покупок, счёта у этого покупателя нет.
  loyalty_level_basis?: 'account' | 'spent';
  // Баллов потрачено покупателем в заказах (не остаток счёта).
  loyalty_used?: number;
  // .ru: строка обезличена — имени, телефона и почты нет, есть ключ для показа по кнопке
  depersonalized?: boolean;
  key?: string | null;
  // present only for the .com (website/Stripe) source
  currency?: string;
  country?: string | null;
  customer_source?: string;
}

// /api/crm/website/carts — abandoned-checkout funnel (.com only)
interface CrmCart {
  id: string;
  number: string;
  status: 'initiated' | 'converted' | 'abandoned' | 'recovered';
  customer_name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  city: string | null;
  currency: string;
  total: number;
  items: Array<{ sku: string; name?: string; qty: number }>;
  initiated_at: string;
  converted_at: string | null;
  abandoned_at: string | null;
}

// /api/crm/website/stats — KPI strip for the .com storefront source
interface ComStats {
  source: string;
  currency: string;
  orders_total: number;
  revenue_total_cents: number;
  aov_cents: number;
  orders_this_month: number;
  revenue_this_month_cents: number;
  sales_30d_cents?: number;
  orders_30d?: number;
  sales_prev30_cents?: number;
  customers_total: number;
  buyers_count: number;
  repeat_buyers: number;
  customers_by_source: { website: number; wix: number; retailcrm: number };
  top_skus: Array<{ sku: string; name: string; units: number }>;
  monthly?: Array<{ month: string; orders: number; revenue_cents: number }>;
  synced_at: number;
}

type CrmSource = 'ru' | 'com' | 'pricing';

// Zonal pricing matrix (from GET /api/pricing/matrix)
interface PricingMatrixColumn {
  country: string;
  currency: string;
  zone: string;
  decimals: number;
  rate: number | null;
  stripe_hidden: boolean;
  prices: Record<string, number>;
  manual?: Record<string, boolean>;
}
interface PricingMatrix {
  base_currency: string;
  updated_at: string | null;
  rates_stale: boolean;
  columns: PricingMatrixColumn[];
  rows: Array<{ sku: string; base_eur: string }>;
  zones: string[];
}

interface PageMeta {
  page: number;
  limit: number;
  total_count: number;
  total_pages: number;
}

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

type TabId = 'orders' | 'customers' | 'carts';

// Столбики визитов на «Daily activity». Значение — токен книги
// --line-innoweiss (он же --status-info), взятый цифрой: var() в атрибуте
// fill у SVG не раскрывается, а подбирать свой синий на глаз нельзя.
const VISITS_FILL = '#0D199E';

// Порядок покупателей по умолчанию. Обе витрины понимают ключ last_order:
// у .ru это дата последнего заказа из ленты, у .com — графа last_order_at.
function defaultCustSort(src: CrmSource): { key: string; dir: 'asc' | 'desc' } {
  return src === 'com' ? { key: 'spent', dir: 'desc' } : { key: 'last_order', dir: 'desc' };
}

export default function CrmPage() {
  const [stats, setStats] = useState<CrmStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [metrika, setMetrika] = useState<MetrikaStats | null>(null);
  const [metrikaLoading, setMetrikaLoading] = useState(true);

  const [timeline, setTimeline] = useState<CrmTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(true);

  const [tab, setTab] = useState<TabId>('orders');

  // Which storefront feeds the Orders/Customers tabs:
  // 'ru'  — dasexperten.ru, обезличенная выдача самой витрины (/api/crm/*, RUB).
  //          Персональные поля остаются в России; в списке вместо имени номер заказа.
  // 'com' — dasexperten.com via Stripe   (/api/crm/website/*, USD)
  const [crmSource, setCrmSource] = useState<CrmSource>('ru');
  const [matrix, setMatrix] = useState<PricingMatrix | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [comStats, setComStats] = useState<ComStats | null>(null);
  const [comStatsLoading, setComStatsLoading] = useState(false);
  const [comStatsError, setComStatsError] = useState<string | null>(null);

  // Orders state
  const [orders, setOrders] = useState<CrmOrder[]>([]);
  // Персональные данные показываются по кнопке в строке, по одному заказу.
  // Список приходит обезличенным — в колонке номер заказа вместо имени.
  // Каждый показ пишется в журнал на стороне России (pd_access_log).
  const [pdShown, setPdShown] = useState<Record<string, { name?: string; phone?: string; email?: string; city?: string } | 'loading' | 'error'>>({});
  const revealCustomer = async (number: string) => {
    if (pdShown[number]) return;
    setPdShown((m) => ({ ...m, [number]: 'loading' }));
    try {
      const res = await fetch(`${API_BASE}/api/crm/customer/${encodeURIComponent(number)}?who=erp-ui`);
      const j = await res.json();
      if (!j?.success) throw new Error('нет данных');
      setPdShown((m) => ({ ...m, [number]: {
        name: j.result?.customer?.name, phone: j.result?.customer?.phone,
        email: j.result?.customer?.email, city: j.result?.delivery?.city } }));
    } catch {
      setPdShown((m) => ({ ...m, [number]: 'error' }));
    }
  };
  const [ordersMeta, setOrdersMeta] = useState<PageMeta | null>(null);
  // Заказы могут прийти из сохранённой копии, когда витрина .ru не ответила.
  const [ordersStaleAt, setOrdersStaleAt] = useState<number | null>(null);
  // слой 3: отметка последнего удачного синка зеркала и текст его последней ошибки
  const [ordersAsOf, setOrdersAsOf] = useState<number | null>(null);
  const [ordersSyncError, setOrdersSyncError] = useState<string | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [ordersPage, setOrdersPage] = useState(1);
  const [ordersLimit, setOrdersLimit] = useState(50);
  const [ordersSearchInput, setOrdersSearchInput] = useState('');
  const [ordersActiveSearch, setOrdersActiveSearch] = useState('');

  // Customers state
  const [customers, setCustomers] = useState<CrmCustomer[]>([]);
  const [customersMeta, setCustomersMeta] = useState<PageMeta | null>(null);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customersError, setCustomersError] = useState<string | null>(null);
  const [customersPage, setCustomersPage] = useState(1);
  const [customersLimit, setCustomersLimit] = useState(50);
  const [customersSearchInput, setCustomersSearchInput] = useState('');
  const [customersActiveSearch, setCustomersActiveSearch] = useState('');

  // Carts state (.com only — abandoned-checkout funnel)
  const [carts, setCarts] = useState<CrmCart[]>([]);
  const [cartsMeta, setCartsMeta] = useState<PageMeta | null>(null);
  const [cartsLoading, setCartsLoading] = useState(false);
  const [cartsError, setCartsError] = useState<string | null>(null);
  const [cartsPage, setCartsPage] = useState(1);
  const [cartsLimit, setCartsLimit] = useState(50);
  const [cartsSearchInput, setCartsSearchInput] = useState('');
  const [cartsActiveSearch, setCartsActiveSearch] = useState('');

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await fetch(`${API_BASE}/api/crm/stats`);
      const data = await res.json();
      if (data.success && data.result) setStats(data.result);
      else setStatsError(data.errors?.[0]?.message || 'Failed to load');
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadMetrika = useCallback(async () => {
    setMetrikaLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/metrika/stats`);
      const data = await res.json();
      if (data.success && data.result) setMetrika(data.result);
      // Errors are silent — Metrika is supplementary, not blocking
    } catch (e) {
      // Same: silent. Tile will just not appear.
    } finally {
      setMetrikaLoading(false);
    }
  }, []);

  const loadTimeline = useCallback(async () => {
    setTimelineLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/crm/timeline`);
      const data = await res.json();
      if (data.success && data.result) setTimeline(data.result);
    } catch (e) {
      // Silent — chart simply doesn't render
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const loadComStats = useCallback(async () => {
    setComStatsLoading(true);
    setComStatsError(null);
    try {
      const res = await fetch(`${API_BASE}/api/crm/website/stats`);
      const data = await res.json();
      if (data.success && data.result) setComStats(data.result);
      else setComStatsError(data.errors?.[0]?.message || 'Failed to load');
    } catch (e) {
      setComStatsError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setComStatsLoading(false);
    }
  }, []);

  const loadMatrix = useCallback(async () => {
    setMatrixLoading(true);
    setMatrixError(null);
    try {
      const res = await fetch(`${API_BASE}/api/pricing/matrix`, { cache: 'no-store' });
      const data = await res.json();
      if (data.success && data.result) setMatrix(data.result);
      else setMatrixError(data.errors?.[0]?.message || 'Failed to load');
    } catch (e) {
      setMatrixError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setMatrixLoading(false);
    }
  }, []);

  const [ordersSort, setOrdersSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: '', dir: 'desc' });
  const sortOrders = (k: string) => {
    setOrdersSort((prev) => (prev.key === k ? { key: k, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' }));
    setOrdersPage(1);
  };

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const params = new URLSearchParams({
        page: String(ordersPage),
        limit: String(ordersLimit),
      });
      if (ordersActiveSearch) params.set('search', ordersActiveSearch);
      if (ordersSort.key) { params.set('sort', ordersSort.key); params.set('dir', ordersSort.dir); }
      const path = crmSource === 'com' ? '/api/crm/website/orders' : '/api/crm/orders';
      const res = await fetch(`${API_BASE}${path}?${params}`);
      const data = await res.json();
      if (data.success && data.result) {
        const rows = (data.result.orders ?? []).map((o: any) =>
          crmSource === 'com'
            ? {
                ...o,
                created_at: String(o.created_at).slice(0, 10),
                bonus_credited: 0,
                bonus_charged: 0,
                loyalty_balance: null,
                loyalty_level: null,
                loyalty_privilege_pct: null,
                order_source: o.source,
              }
            : o
        );
        setOrders(rows);
        setOrdersMeta(data.result.pagination);
        setOrdersStaleAt(data.result.stale ? (data.result.data_as_of ?? null) : null);
        setOrdersAsOf(data.result.data_as_of ?? null);
        setOrdersSyncError(data.result.sync_error ?? null);
      } else {
        setOrdersError(data.errors?.[0]?.message || 'Failed to load orders');
      }
    } catch (e) {
      setOrdersError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setOrdersLoading(false);
    }
  }, [ordersPage, ordersLimit, ordersActiveSearch, ordersSort, crmSource]);

  // Владелец 02.09.2026: на русском экране покупатели идут по дате последней
  // покупки, свежие сверху. У .com графы «Last order» нет — там прежний порядок
  // по сумме.
  const [custSort, setCustSort] = useState<{ key: string; dir: 'asc' | 'desc' }>(defaultCustSort('ru'));
  const sortCustomers = (k: string) => {
    setCustSort((prev) => (prev.key === k ? { key: k, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' }));
    setCustomersPage(1);
  };

  const loadCustomers = useCallback(async () => {
    setCustomersLoading(true);
    setCustomersError(null);
    try {
      const params = new URLSearchParams({
        page: String(customersPage),
        limit: String(customersLimit),
      });
      if (customersActiveSearch) params.set('search', customersActiveSearch);
      params.set('sort', custSort.key);
      params.set('dir', custSort.dir);
      const path = crmSource === 'com' ? '/api/crm/website/customers' : '/api/crm/customers';
      const res = await fetch(`${API_BASE}${path}?${params}`);
      const data = await res.json();
      if (data.success && data.result) {
        const rows = (data.result.customers ?? []).map((cu: any) =>
          crmSource === 'com'
            ? {
                ...cu,
                created_at: String(cu.created_at).slice(0, 10),
                loyalty_balance: null,
                loyalty_level: null,
                loyalty_privilege_pct: null,
                customer_source: cu.source,
              }
            : cu
        );
        setCustomers(rows);
        setCustomersMeta(data.result.pagination);
      } else {
        setCustomersError(data.errors?.[0]?.message || 'Failed to load customers');
      }
    } catch (e) {
      setCustomersError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setCustomersLoading(false);
    }
  }, [customersPage, customersLimit, customersActiveSearch, custSort, crmSource]);

  // --------------------------------------------------------------------------
  // Detail drawer (Owner 2026-08-15: order and customer rows were dead ends —
  // the API already served /orders/:number and /customers/:id, the table just
  // never called them). Заказы .ru получили свой адрес 06.09.2026 — до того
  // щелчок по русской строке открывал ящик, который шёл по адресу .com и не
  // находил ничего. Карточки покупателей .ru своего адреса всё ещё не имеют.
  // --------------------------------------------------------------------------
  const [detail, setDetail] = useState<{ kind: 'order' | 'customer'; id: string; src?: CrmSource } | null>(null);
  const [detailData, setDetailData] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (!detail) { setDetailData(null); setDetailError(null); return; }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setDetailData(null);
    const path = detail.kind === 'order'
      ? (detail.src === 'ru'
          ? `/api/crm/order/${encodeURIComponent(detail.id)}`
          : `/api/crm/website/orders/${encodeURIComponent(detail.id)}`)
      : `/api/crm/website/customers/${encodeURIComponent(detail.id)}`;
    fetch(`${API_BASE}${path}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.success && d.result) setDetailData(d.result);
        else setDetailError(d.errors?.[0]?.message || 'Not found');
      })
      .catch((e) => { if (!cancelled) setDetailError(e instanceof Error ? e.message : 'Network error'); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [detail]);

  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDetail(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail]);

  const [cartsSort, setCartsSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' });
  const sortCarts = (k: string) => {
    setCartsSort((prev) => (prev.key === k ? { key: k, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' }));
    setCartsPage(1);
  };

  const loadCarts = useCallback(async () => {
    setCartsLoading(true);
    setCartsError(null);
    try {
      const params = new URLSearchParams({
        page: String(cartsPage),
        limit: String(cartsLimit),
      });
      if (cartsActiveSearch) params.set('search', cartsActiveSearch);
      if (cartsSort.key) { params.set('sort', cartsSort.key); params.set('dir', cartsSort.dir); }
      const res = await fetch(`${API_BASE}/api/crm/website/carts?${params}`);
      const data = await res.json();
      if (data.success && data.result) {
        const rows = (data.result.carts ?? []).map((r: any) => ({
          ...r,
          initiated_at: r.initiated_at ? String(r.initiated_at).slice(0, 10) : '—',
        }));
        setCarts(rows);
        setCartsMeta(data.result.pagination);
      } else {
        setCartsError(data.errors?.[0]?.message || 'Failed to load carts');
      }
    } catch (e) {
      setCartsError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setCartsLoading(false);
    }
  }, [cartsPage, cartsLimit, cartsActiveSearch, cartsSort]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadMetrika(); }, [loadMetrika]);
  useEffect(() => { loadTimeline(); }, [loadTimeline]);
  useEffect(() => { if (tab === 'orders') loadOrders(); }, [tab, loadOrders]);
  useEffect(() => { if (tab === 'customers') loadCustomers(); }, [tab, loadCustomers]);
  useEffect(() => { if (tab === 'carts' && crmSource === 'com') loadCarts(); }, [tab, crmSource, loadCarts]);
  useEffect(() => { if (crmSource === 'com') loadComStats(); }, [crmSource, loadComStats]);
  useEffect(() => { if (crmSource === 'pricing' && !matrix) loadMatrix(); }, [crmSource, matrix, loadMatrix]);

  function switchSource(next: CrmSource) {
    if (next === crmSource) return;
    setCrmSource(next);
    setOrdersPage(1);
    setCustomersPage(1);
    setCartsPage(1);
    setOrdersSort({ key: '', dir: 'desc' });
    setCustSort(defaultCustSort(next));
    setCartsSort({ key: 'date', dir: 'desc' });
    // Carts only exist for the .com source — fall back to Orders when leaving it.
    if (next !== 'com' && tab === 'carts') setTab('orders');
  }

  function handleOrdersSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setOrdersPage(1);
    setOrdersActiveSearch(ordersSearchInput.trim());
  }
  function handleCustomersSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCustomersPage(1);
    setCustomersActiveSearch(customersSearchInput.trim());
  }
  function handleCartsSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCartsPage(1);
    setCartsActiveSearch(cartsSearchInput.trim());
  }

  function refreshAll() {
    loadStats();
    loadMetrika();
    loadTimeline();
    if (crmSource === 'com') loadComStats();
    if (crmSource === 'pricing') loadMatrix(); // Geo Price Matrix view — reload it too
    if (tab === 'orders') loadOrders();
    else if (tab === 'customers') loadCustomers();
    else if (tab === 'carts') loadCarts();
  }

  const isLoading = statsLoading || metrikaLoading || timelineLoading || ordersLoading || customersLoading;

  return (
    <div className="space-y-4 max-w-full crm-mock">
      {/* Owner order 2026-07-21: mockup typography — Plus Jakarta Sans body, Fraunces numerals.
          Brighter pass (same day): denser layout, solid CTAs, larger key numbers, raised cards. */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,600;9..144,700;9..144,800&display=swap');
        .crm-mock{font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;}
        .crm-mock h1{font-family:'Fraunces',serif;font-weight:700;}
        .crm-mock tbody tr:hover{background:#F3F0E8;}
      `}</style>
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Headphones className="h-7 w-7" style={{ color: 'var(--brand-rot)' }} />
            <h1 style={{
              fontFamily: "'Fraunces', serif",
              fontSize: 36,
              fontWeight: 700,
              lineHeight: 1.05,
              color: 'var(--fg-1)',
              margin: 0,
              letterSpacing: '-0.01em',
            }}>
              CRM
            </h1>
          </div>
          <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-3)', marginTop: 4 }}>
            {crmSource === 'pricing'
              ? 'Geo Price Matrix — зональные цены по валютам (EUR base × FX × округление)'
              : crmSource === 'com'
              ? 'dasexperten.com — Stripe orders & customer database'
              : 'Retail CRM — customers, orders, revenue'}
          </p>
        </div>
        {/* On the Geo Price Matrix view the matrix owns a single "Save Prices"
            button; the global Refresh would be a confusing second button there. */}
        {crmSource !== 'pricing' && (
          <button
            onClick={refreshAll}
            disabled={isLoading}
            className="flex items-center gap-2 px-4 py-2"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 14,
              fontWeight: 800,
              color: 'var(--fg-on-brand)',
              backgroundColor: 'var(--brand-schwarz)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              boxShadow: 'var(--shadow-raised)',
              cursor: isLoading ? 'wait' : 'pointer',
            }}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        )}
      </div>

      {/* Storefront source switcher: .ru (Yandex KIT) ↔ .com (Stripe) */}
      <div className="flex items-center gap-2">
        <SourcePill
          active={crmSource === 'ru'}
          onClick={() => switchSource('ru')}
          label="dasexperten.ru"
          sublabel="Т-Касса · ₽ · база РФ"
        />
        <SourcePill
          active={crmSource === 'com'}
          onClick={() => switchSource('com')}
          label="dasexperten.com"
          sublabel="Stripe · $"
        />
        <SourcePill
          active={crmSource === 'pricing'}
          onClick={() => switchSource('pricing')}
          label="Geo Price Matrix"
          sublabel="Zonal · 13 currencies"
        />
      </div>

      {crmSource === 'pricing' && (
        <PricingMatrixSection
          matrix={matrix}
          loading={matrixLoading}
          error={matrixError}
          onRetry={loadMatrix}
        />
      )}

      {crmSource === 'ru' && statsError && (
        <ErrorBox title="Retail CRM stats unavailable" message={statsError} />
      )}
      {crmSource === 'com' && comStatsError && (
        <ErrorBox title="Website CRM stats unavailable" message={comStatsError} />
      )}

      {/* KPI tiles — .com source (USD, cents from /api/crm/website/stats) */}
      {crmSource === 'com' && comStats && <ComMetricBand stats={comStats} />}
      {crmSource === 'com' && comStatsLoading && !comStats && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      )}

      {/* KPI tiles */}
      {crmSource === 'ru' && stats && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 12,
        }}>
          <KpiTile label="Customers" value={stats.customers_total.toLocaleString('ru-RU')} />
          <KpiTile label="Loyalty members" value={stats.loyalty_members_total.toLocaleString('ru-RU')} />
          <KpiTile label="Orders (total)" value={stats.orders_total.toLocaleString('ru-RU')} />
          <KpiTile label="Orders this month" value={stats.orders_this_month.toLocaleString('ru-RU')} />
          <KpiTile label="Revenue this month" value={`${stats.revenue_this_month_rub.toLocaleString('ru-RU')} ₽`} accent />
          <KpiTile
            label="Visits today"
            value={metrika ? metrika.today.visits.toLocaleString('ru-RU') : (metrikaLoading ? '…' : '—')}
          />
        </div>
      )}

      {/* Daily activity — visits behind, orders in front, one shared scale */}
      {crmSource === 'ru' && (
        <DailyActivityChart
          crmTimeline={timeline?.timeline ?? null}
          metrikaTimeline={metrika?.timeline ?? null}
          loading={timelineLoading || metrikaLoading}
        />
      )}

      {/* Tabs — filled chips (brighter: fill, not underline) */}
      {crmSource !== 'pricing' && (
      <div className="flex items-center gap-2 flex-wrap">
        <TabButton
          active={tab === 'orders'}
          onClick={() => setTab('orders')}
          icon={<ShoppingBag className="h-4 w-4" />}
          label="Orders"
          count={(crmSource === 'com' ? comStats?.orders_total : stats?.orders_total) ?? null}
        />
        <TabButton
          active={tab === 'customers'}
          onClick={() => setTab('customers')}
          icon={<Users className="h-4 w-4" />}
          label="Customers"
          count={(crmSource === 'com' ? comStats?.customers_total : stats?.customers_total) ?? null}
        />
        {crmSource === 'com' && (
          <TabButton
            active={tab === 'carts'}
            onClick={() => setTab('carts')}
            icon={<ShoppingBag className="h-4 w-4" />}
            label="Carts"
            count={null}
          />
        )}
      </div>
      )}

      {/* Tab content */}
      {crmSource !== 'pricing' && tab === 'orders' && (
        <DataTablePanel
          title="Orders"
          meta={ordersMeta}
          loading={ordersLoading}
          error={ordersError}
          searchPlaceholder="Search customer or order #"
          searchInput={ordersSearchInput}
          setSearchInput={setOrdersSearchInput}
          activeSearch={ordersActiveSearch}
          onSearchSubmit={handleOrdersSearchSubmit}
          onClearSearch={() => { setOrdersSearchInput(''); setOrdersActiveSearch(''); setOrdersPage(1); }}
          limit={ordersLimit}
          setLimit={(n) => { setOrdersLimit(n); setOrdersPage(1); }}
          page={ordersPage}
          setPage={setOrdersPage}
        >
          {ordersStaleAt !== null && (
            <div
              style={{
                margin: '0 0 12px',
                padding: '10px 14px',
                borderRadius: 8,
                background: '#FEF3C7',
                color: '#7A4706',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              Зеркало заказов не обновлялось больше 3 часов — данные на{' '}
              {new Date(ordersStaleAt * 1000).toLocaleString('ru-RU')}
            </div>
          )}
          {ordersSyncError && (
            <div
              style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: 8,
                       background: '#FDE2E2', color: '#7A1F1F', fontWeight: 600, fontSize: 14 }}
            >
              Синк зеркала не прошёл: {ordersSyncError}
            </div>
          )}
          {ordersAsOf !== null && crmSource === 'ru' && (
            <div style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--fg-2)' }}>
              Данные на {new Date(ordersAsOf * 1000).toLocaleString('ru-RU')} · зеркало витрины в ERP, обновляется каждые 15 минут
            </div>
          )}
          <OrdersTable orders={orders} hasSearch={!!ordersActiveSearch} search={ordersActiveSearch} sort={ordersSort} onSort={sortOrders} variant={crmSource} onOpen={(n) => setDetail({ kind: 'order', id: n, src: crmSource })} pdShown={pdShown} revealCustomer={revealCustomer} />
        </DataTablePanel>
      )}

      {crmSource !== 'pricing' && tab === 'customers' && (
        <DataTablePanel
          title="Customers"
          meta={customersMeta}
          loading={customersLoading}
          error={customersError}
          searchPlaceholder="Search by name or phone"
          searchInput={customersSearchInput}
          setSearchInput={setCustomersSearchInput}
          activeSearch={customersActiveSearch}
          onSearchSubmit={handleCustomersSearchSubmit}
          onClearSearch={() => { setCustomersSearchInput(''); setCustomersActiveSearch(''); setCustomersPage(1); }}
          limit={customersLimit}
          setLimit={(n) => { setCustomersLimit(n); setCustomersPage(1); }}
          page={customersPage}
          setPage={setCustomersPage}
        >
          <CustomersTable customers={customers} hasSearch={!!customersActiveSearch} search={customersActiveSearch} sort={custSort} onSort={sortCustomers} variant={crmSource} onOpen={(id) => setDetail({ kind: 'customer', id, src: crmSource })} />
        </DataTablePanel>
      )}

      {crmSource === 'com' && tab === 'carts' && (
        <DataTablePanel
          title="Carts"
          meta={cartsMeta}
          loading={cartsLoading}
          error={cartsError}
          searchPlaceholder="Search email, order # or country"
          searchInput={cartsSearchInput}
          setSearchInput={setCartsSearchInput}
          activeSearch={cartsActiveSearch}
          onSearchSubmit={handleCartsSearchSubmit}
          onClearSearch={() => { setCartsSearchInput(''); setCartsActiveSearch(''); setCartsPage(1); }}
          limit={cartsLimit}
          setLimit={(n) => { setCartsLimit(n); setCartsPage(1); }}
          page={cartsPage}
          setPage={setCartsPage}
        >
          <CartsTable carts={carts} hasSearch={!!cartsActiveSearch} search={cartsActiveSearch} sort={cartsSort} onSort={sortCarts} />
        </DataTablePanel>
      )}

      {crmSource === 'ru' && stats && (
        <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>
          Source: {stats.source} · synced {new Date(stats.synced_at * 1000).toLocaleString('ru-RU')}
        </div>
      )}
      {detail && (
        <CrmDetailDrawer
          kind={detail.kind}
          data={detailData}
          loading={detailLoading}
          error={detailError}
          onClose={() => setDetail(null)}
          onOpenOrder={(n) => setDetail({ kind: 'order', id: n, src: detail.src ?? crmSource })}
          onOpenCustomer={(id) => setDetail({ kind: 'customer', id, src: detail.src ?? crmSource })}
        />
      )}

      {crmSource === 'com' && comStats && (
        <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>
          Source: {comStats.source} · customers: website {comStats.customers_by_source.website} /
          wix {comStats.customers_by_source.wix} / retailcrm {comStats.customers_by_source.retailcrm} ·
          synced {new Date(comStats.synced_at * 1000).toLocaleString('ru-RU')}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Components
// ============================================================================

// ----------------------------------------------------------------------------
// Detail drawer — the order / customer card behind a table row.
// Reads /api/crm/website/orders/:number and /api/crm/website/customers/:id.
// Owner 2026-08-15: a row you cannot open is a row you cannot work.
// ----------------------------------------------------------------------------
function DrawerRow({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  if (value === null || value === undefined || value === '' ) return null;
  return (
    <div style={{ display: 'flex', gap: 16, padding: '7px 0', borderBottom: '1px solid var(--border-hairline)' }}>
      <div style={{ width: 150, flexShrink: 0, fontSize: 13, color: 'var(--fg-3)' }}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--fg-1)', wordBreak: 'break-word', fontFamily: mono ? 'ui-monospace, SFMono-Regular, monospace' : undefined }}>{value}</div>
    </div>
  );
}

function drawerMoney(cents: number | null | undefined, currency: string | null | undefined) {
  if (cents === null || cents === undefined) return null;
  return `${(Number(cents) / 100).toFixed(2)} ${(currency ?? 'USD').toUpperCase()}`;
}

function drawerDate(epoch: number | null | undefined) {
  if (!epoch) return null;
  return new Date(Number(epoch) * 1000).toLocaleString('ru-RU');
}

function CrmDetailDrawer({
  kind, data, loading, error, onClose, onOpenOrder, onOpenCustomer,
}: {
  kind: 'order' | 'customer';
  data: any;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onOpenOrder: (orderNumber: string) => void;
  onOpenCustomer: (customerId: string) => void;
}) {
  const title = kind === 'order'
    ? (data?.order_number ? `Order ${data.order_number}` : 'Order')
    : (data ? [data.first_name, data.last_name].filter(Boolean).join(' ') || data.email || 'Customer' : 'Customer');

  const ship = data ? [data.ship_address1, data.ship_address2, data.ship_city, data.ship_state, data.ship_zip, data.ship_country].filter(Boolean).join(', ') : '';
  const addr = data ? [data.address1, data.address2, data.city, data.state_code, data.zip, data.country_code].filter(Boolean).join(', ') : '';

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(26,21,25,.32)', zIndex: 60, display: 'flex', justifyContent: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(560px, 100%)', height: '100%', overflowY: 'auto', backgroundColor: 'var(--paper, #FFFFFF)', boxShadow: '-6px 0 24px rgba(26,21,25,.16)', padding: '24px 28px 40px' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0', textTransform: 'uppercase', color: 'var(--fg-3)' }}>
              {kind === 'order' ? 'Order card' : 'Customer card'}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--fg-1)', fontFamily: kind === 'order' ? 'ui-monospace, SFMono-Regular, monospace' : undefined }}>{title}</div>
          </div>
          <button
            onClick={onClose}
            style={{ border: '1px solid var(--border-hairline)', backgroundColor: 'transparent', borderRadius: 8, padding: '6px 12px', fontSize: 13, color: 'var(--fg-3)', cursor: 'pointer' }}
          >
            Close
          </button>
        </div>

        {loading && <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>Loading…</div>}
        {error && <div style={{ fontSize: 14, color: '#B3261E' }}>{error}</div>}

        {!loading && !error && data && kind === 'order' && (
          <>
            <DrawerRow label="Status" value={`${data.financial_status ?? '—'} · ${data.fulfillment_status ?? '—'}`} />
            <DrawerRow label="Placed" value={drawerDate(data.placed_at) ?? drawerDate(data.created_at)} />
            <DrawerRow label="Customer" value={data.customer_name} />
            <DrawerRow label="Email" value={data.email} />
            <DrawerRow label="Phone" value={data.phone} />
            <DrawerRow label="Ship to" value={ship || null} />
            <DrawerRow label="Shipping method" value={data.shipping_method} />
            <DrawerRow
              label="Tracking"
              value={data.tracking_number ? (
                data.tracking_url
                  ? <a href={data.tracking_url} target="_blank" rel="noreferrer" style={{ color: 'var(--fg-1)', textDecoration: 'underline' }}>{data.tracking_number}</a>
                  : data.tracking_number
              ) : null}
              mono
            />
            <DrawerRow label="Subtotal" value={drawerMoney(data.subtotal_cents, data.currency)} />
            <DrawerRow label="Shipping" value={drawerMoney(data.shipping_cents, data.currency)} />
            <DrawerRow label="Discount" value={data.discount_cents ? drawerMoney(data.discount_cents, data.currency) : null} />
            <DrawerRow label="Tax" value={data.tax_cents ? drawerMoney(data.tax_cents, data.currency) : null} />
            <DrawerRow label="Total" value={drawerMoney(data.total_cents, data.currency)} />
            <DrawerRow label="Payment" value={data.payment_method} />
            <DrawerRow label="Stripe PI" value={data.stripe_payment_intent} mono />
            <DrawerRow label="Source" value={data.source} />
            <DrawerRow label="Language" value={data.lang} />

            <div style={{ marginTop: 22, marginBottom: 8, fontSize: 13, letterSpacing: '0', textTransform: 'uppercase', color: 'var(--fg-3)' }}>Items</div>
            {(data.items ?? []).length === 0 && <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>—</div>}
            {(data.items ?? []).map((it: any, i: number) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '7px 0', borderBottom: '1px solid var(--border-hairline)' }}>
                <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13, color: 'var(--fg-1)' }}>{it.sku}</span>
                <span style={{ fontSize: 14, color: 'var(--fg-3)' }}>{it.name ? `${it.name} · ` : ''}×{it.qty}</span>
              </div>
            ))}

            {data.customer_id && (
              <button
                onClick={() => onOpenCustomer(String(data.customer_id))}
                style={{ marginTop: 22, border: '1px solid var(--border-hairline)', backgroundColor: 'transparent', borderRadius: 8, padding: '8px 14px', fontSize: 13, color: 'var(--fg-1)', cursor: 'pointer' }}
              >
                Open customer card
              </button>
            )}
          </>
        )}

        {!loading && !error && data && kind === 'customer' && (
          <>
            <DrawerRow label="Email" value={data.email} />
            <DrawerRow label="Phone" value={data.phone} />
            <DrawerRow label="Company" value={data.company} />
            <DrawerRow label="Address" value={addr || null} />
            <DrawerRow label="Language" value={data.lang} />
            <DrawerRow label="Source" value={data.source} />
            <DrawerRow label="Orders" value={data.orders_count} />
            <DrawerRow label="Total spent" value={drawerMoney(data.total_spent_cents, data.currency)} />
            <DrawerRow label="First order" value={drawerDate(data.first_order_at)} />
            <DrawerRow label="Last order" value={drawerDate(data.last_order_at)} />
            <DrawerRow label="Registered" value={drawerDate(data.created_at)} />
            <DrawerRow label="Marketing consent" value={data.marketing_consent ? 'yes' : 'no'} />
            <DrawerRow label="Tags" value={(data.tags ?? []).length ? (data.tags ?? []).join(', ') : null} />

            <div style={{ marginTop: 22, marginBottom: 8, fontSize: 13, letterSpacing: '0', textTransform: 'uppercase', color: 'var(--fg-3)' }}>Orders</div>
            {(data.orders ?? []).length === 0 && <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>—</div>}
            {(data.orders ?? []).map((o: any) => (
              <div
                key={o.order_number}
                onClick={() => onOpenOrder(String(o.order_number))}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '9px 0', borderBottom: '1px solid var(--border-hairline)', cursor: 'pointer' }}
              >
                <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 13, color: 'var(--fg-1)' }}>{o.order_number}</span>
                <span style={{ fontSize: 13, color: 'var(--fg-3)' }}>
                  {drawerMoney(o.total_cents, o.currency)} · {o.fulfillment_status ?? '—'} · {drawerDate(o.placed_at) ?? '—'}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function DailyActivityChart({
  crmTimeline,
  metrikaTimeline,
  loading,
}: {
  crmTimeline: Array<{ date: string; registrations: number; orders: number }> | null;
  metrikaTimeline: Array<{ date: string; visits: number; users: number }> | null;
  loading: boolean;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Owner 2026-09-02: окно — 14 дней, не 30. На тридцати столбик тоньше волоса.
  const WINDOW_DAYS = 14;

  // Merge by date — CRM timeline drives the day list, Metrika visits looked up
  // per-day. If a Metrika day is missing, treat as 0. Keep the last 14 days.
  const merged = (crmTimeline ?? [])
    .map((d) => {
      const m = metrikaTimeline?.find((x) => x.date === d.date);
      return {
        date: d.date,
        visits: m?.visits ?? 0,
        orders: d.orders,
      };
    })
    .slice(-WINDOW_DAYS);

  if (!loading && merged.length === 0) {
    return null;
  }

  // Owner 2026-09-02: одна шкала на оба ряда — длина столбика абсолютная,
  // визиты и заказы сравнимы между собой, а не каждый со своим максимумом.
  const maxValue = Math.max(1, ...merged.map((d) => Math.max(d.visits, d.orders)));

  // SVG geometry
  const W = 600;
  const H = 140;
  const padTop = 16;
  const padBottom = 24;
  const chartH = H - padTop - padBottom;
  const days = merged.length || WINDOW_DAYS;
  const slot = W / days;
  const wideBarW = slot * 0.62;
  const narrowBarW = slot * 0.3;

  // Одна шкала для обоих рядов. Ненулевой день не исчезает: минимум 2 единицы
  // высоты — иначе один заказ на фоне тысячи визитов не виден вовсе.
  function bar(value: number, idx: number, w: number) {
    const raw = (value / maxValue) * chartH;
    const h = value > 0 ? Math.max(raw, 2) : 0;
    const x = idx * slot + (slot - w) / 2;
    const y = padTop + (chartH - h);
    return { x, y, w, h };
  }

  // Mouse handler — figure out which day the cursor is over
  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    // Map screen X to viewBox X
    const xRatio = (e.clientX - rect.left) / rect.width;
    const vbX = xRatio * W;
    const idx = Math.floor(vbX / slot);
    if (idx >= 0 && idx < merged.length) {
      setHoverIdx(idx);
    } else {
      setHoverIdx(null);
    }
  }

  function handleMouseLeave() {
    setHoverIdx(null);
  }

  const totalVisits = merged.reduce((s, d) => s + d.visits, 0);
  const totalOrders = merged.reduce((s, d) => s + d.orders, 0);

  const hoverDay = hoverIdx !== null ? merged[hoverIdx] : null;

  return (
    <div style={{
      backgroundColor: 'var(--paper-raised)',
      boxShadow: 'var(--shadow-raised)',
      borderRadius: 'var(--radius-md)',
      padding: '16px 20px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{
            fontFamily: 'var(--font-display)',
            fontSize: 16,
            fontWeight: 800,
            color: 'var(--fg-1)',
          }}>
            Daily activity
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-3)' }}>Last 14 days · one scale · hover to inspect</div>
        </div>
        {!loading && merged.length > 0 && (
          <div style={{ display: 'flex', gap: 18, fontSize: 14, alignItems: 'baseline' }}>
            <span style={{ color: 'var(--fg-3)', fontWeight: 600 }}>
              <span style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 900,
                fontSize: 20,
                color: 'var(--fg-1)',
                marginRight: 4,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}>
                {totalVisits.toLocaleString('ru-RU')}
              </span>
              visits
            </span>
            <span style={{ color: 'var(--fg-3)', fontWeight: 600 }}>
              <span style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 900,
                fontSize: 20,
                color: 'var(--brand-rot)',
                marginRight: 4,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}>
                {totalOrders.toLocaleString('ru-RU')}
              </span>
              orders
            </span>
          </div>
        )}
      </div>

      {loading && merged.length === 0 ? (
        <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      ) : (
        <>
          <div style={{ position: 'relative' }}>
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              style={{ width: '100%', height: H, display: 'block', cursor: 'crosshair' }}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            >
              {/* Hover guide: vertical highlight band on slot */}
              {hoverIdx !== null && (
                <rect
                  x={hoverIdx * slot}
                  y={padTop - 4}
                  width={slot}
                  height={chartH + 8}
                  fill="var(--fg-1)"
                  fillOpacity="0.05"
                />
              )}

              {/* Visits — синий книги (--line-innoweiss / --status-info), широкий,
                  сзади. Владелец 02.09.2026: бледно-серый столбик на белой
                  карточке не читался. Цвет взят из книги, не подобран на глаз. */}
              {merged.map((d, i) => {
                const r = bar(d.visits, i, wideBarW);
                if (r.h <= 0) return null;
                const isHover = hoverIdx === i;
                return (
                  <rect key={`v${i}`} x={r.x} y={r.y} width={r.w} height={r.h} rx="2"
                        fill={VISITS_FILL} fillOpacity={isHover ? 1 : 0.85} />
                );
              })}
              {/* Orders — teal, narrow, front. Та же шкала, что у визитов. */}
              {merged.map((d, i) => {
                const r = bar(d.orders, i, narrowBarW);
                if (r.h <= 0) return null;
                return (
                  <rect key={`o${i}`} x={r.x} y={r.y} width={r.w} height={r.h} rx="1.5"
                        fill="#1D9E75" />
                );
              })}
            </svg>
          </div>

          {/* Date axis: first / mid / last */}
          {merged.length > 0 && (
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 14, color: 'var(--fg-3)', marginTop: 4,
            }}>
              <span>{merged[0].date}</span>
              <span>{merged[Math.floor(merged.length / 2)].date}</span>
              <span>{merged[merged.length - 1].date}</span>
            </div>
          )}

          {/* Per-day inspector — shown below the chart, doesn't cover bars */}
          <div style={{
            marginTop: 16,
            padding: '12px 16px',
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
            fontSize: 14,
            minHeight: 44,
          }}>
            {hoverDay ? (
              <>
                <div style={{ fontWeight: 700, color: 'var(--fg-1)', minWidth: 110 }}>
                  {hoverDay.date}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
                  <span style={{ width: 12, height: 10, backgroundColor: VISITS_FILL, opacity: 0.85, borderRadius: 2, display: 'inline-block' }} />
                  Visits <span style={{ fontWeight: 700, color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{hoverDay.visits.toLocaleString('ru-RU')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
                  <span style={{ width: 8, height: 10, backgroundColor: '#1D9E75', borderRadius: 2, display: 'inline-block' }} />
                  Orders <span style={{ fontWeight: 700, color: 'var(--fg-1)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{hoverDay.orders.toLocaleString('ru-RU')}</span>
                </div>
              </>
            ) : (
              <span style={{ color: 'var(--fg-3)' }}>Hover any day on the chart to see exact numbers</span>
            )}
          </div>

          {/* Legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12, fontSize: 14 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
              <span style={{ width: 14, height: 10, backgroundColor: VISITS_FILL, opacity: 0.85, borderRadius: 2, display: 'inline-block' }} />
              Visits (Yandex Metrika)
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
              <span style={{ width: 8, height: 10, backgroundColor: '#1D9E75', borderRadius: 2, display: 'inline-block' }} />
              Orders
            </span>
            <span style={{ color: 'var(--fg-3)' }}>
              Both series share one scale — bar lengths are directly comparable.
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function ComMetricBand({ stats }: { stats: ComStats }) {
  const sales30 = (stats.sales_30d_cents ?? 0) / 100;
  const prev30 = (stats.sales_prev30_cents ?? 0) / 100;
  const deltaPct = prev30 > 0 ? Math.round(((sales30 - prev30) / prev30) * 100) : null;
  const monthly = stats.monthly ?? [];
  const curKey = new Date().toISOString().slice(0, 7);
  const closed = monthly.filter((m) => m.month < curKey);
  const lastM = closed[closed.length - 1];
  const prevM = closed[closed.length - 2];
  const lastRev = lastM ? lastM.revenue_cents / 100 : 0;
  const lastDelta = lastM && prevM && prevM.revenue_cents > 0
    ? Math.round(((lastM.revenue_cents - prevM.revenue_cents) / prevM.revenue_cents) * 100)
    : null;
  const monthName = lastM
    ? new Date(`${lastM.month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
    : '—';
  const buyers = stats.buyers_count ?? 0;
  const repeatPct = buyers > 0 ? ((stats.repeat_buyers / buyers) * 100).toFixed(1) : '0.0';
  const spark = monthly.slice(-12).map((m) => m.revenue_cents);
  const maxV = Math.max(...spark, 1);
  const pts = spark
    .map((v, i) => `${spark.length > 1 ? (i / (spark.length - 1)) * 240 : 0},${42 - (v / maxV) * 34}`)
    .join(' ');
  const fmt = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
      gap: 12,
    }}>
      <div style={{
        gridColumn: 'span 2',
        minWidth: 0,
        padding: '14px 16px',
        background: 'linear-gradient(135deg, var(--brand-schwarz-ink), #2B2228)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-raised)',
        color: 'var(--paper)',
      }}>
        <div style={{
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: '0',
          textTransform: 'uppercase',
          color: 'var(--brand-gold)',
        }}>
          Sales · last 30 days
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{
            fontFamily: "'Fraunces', serif",
            fontSize: 40,
            fontWeight: 700,
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--paper-raised)',
          }}>
            {fmt(sales30)}
          </span>
          {deltaPct !== null && (
            <span style={{
              fontSize: 14,
              fontWeight: 800,
              color: deltaPct < 0 ? '#FF6B6B' : '#2FB894',
            }}>
              {deltaPct < 0 ? '▼' : '▲'} {Math.abs(deltaPct)}%
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--stone-300)', marginTop: 4 }}>
          {deltaPct !== null ? `vs ${fmt(prev30)} prior 30 days` : 'no prior-period data'}
        </div>
        {spark.length > 1 && (
          <svg viewBox="0 0 240 44" preserveAspectRatio="none" style={{ width: '100%', height: 36, marginTop: 10, display: 'block' }} aria-hidden="true">
            <polyline points={pts} fill="none" stroke="#2FB894" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <KpiTile label="Customers" value={stats.customers_total.toLocaleString('en-US')} />
      <KpiTile label="Orders · 30 days" value={(stats.orders_30d ?? 0).toLocaleString('en-US')} />
      <KpiTile
        label={`Last month · ${monthName}`}
        value={fmt(lastRev)}
        sub={lastDelta === null ? undefined : `${lastDelta < 0 ? '▼' : '▲'} ${Math.abs(lastDelta)}% vs prior`}
        accent
      />
      <KpiTile label="Repeat purchase rate" value={`${repeatPct}%`} sub={`${stats.repeat_buyers} of ${buyers} buyers`} accent />
    </div>
  );
}

function KpiTile({ label, value, sub, accent = false }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{
      backgroundColor: accent ? 'var(--brand-schwarz-ink)' : 'var(--paper-raised)',
      boxShadow: 'var(--shadow-raised)',
      borderRadius: 'var(--radius-md)',
      padding: '14px 16px',
      minWidth: 0,
    }}>
      <div style={{
        fontSize: 14,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0',
        color: accent ? 'var(--stone-300)' : 'var(--fg-3)',
        marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: "'Fraunces', serif",
        fontWeight: 700,
        fontSize: 34,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
        color: accent ? 'var(--brand-gold)' : 'var(--brand-rot)',
        wordBreak: 'break-word',
      }}>
        {value}
      </div>
      {sub && (
        <div style={{
          fontSize: 14,
          fontWeight: 600,
          color: accent ? 'var(--stone-300)' : 'var(--fg-3)',
          marginTop: 6,
        }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active, onClick, icon, label, count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number | null;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2.5"
      style={{
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        fontSize: 14,
        fontWeight: 800,
        color: active ? 'var(--fg-on-brand)' : 'var(--fg-2)',
        backgroundColor: active ? 'var(--brand-rot)' : 'var(--paper-sunk)',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        boxShadow: active ? 'var(--shadow-raised)' : 'none',
        cursor: 'pointer',
      }}
    >
      {icon}
      {label}
      {count !== null && (
        <span style={{
          fontFamily: "'Fraunces', serif",
          fontSize: 15,
          fontWeight: 700,
          color: active ? 'var(--brand-rot)' : 'var(--fg-1)',
          padding: '2px 8px',
          backgroundColor: 'var(--paper-raised)',
          borderRadius: 'var(--radius-pill)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {count.toLocaleString('ru-RU')}
        </span>
      )}
    </button>
  );
}

function SourcePill({
  active, onClick, label, sublabel,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sublabel: string;
}) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2.5"
      style={{
        textAlign: 'left',
        backgroundColor: active ? 'var(--brand-rot)' : 'var(--paper-sunk)',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        boxShadow: active ? 'var(--shadow-raised)' : 'none',
        cursor: 'pointer',
      }}
    >
      <div style={{
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        fontSize: 14,
        fontWeight: 800,
        color: active ? 'var(--fg-on-brand)' : 'var(--fg-1)',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 14,
        fontWeight: 600,
        // Full paper, not 85% of it — a translucent sublabel on the rot tab
        // reads 3.5:1. The hierarchy is carried by size and weight already.
        color: active ? 'var(--fg-on-brand)' : 'var(--fg-3)',
      }}>
        {sublabel}
      </div>
    </button>
  );
}

// Real flag rendered as a small circular image (emoji flags don't render on
// Windows — they degrade to the 2-letter country code). SVGs are bundled in
// /public/flags so there's no runtime dependency on an external CDN.
function FlagDot({ country }: { country: string }) {
  const cc = country.toLowerCase();
  return (
    <img
      src={`/flags/${cc}.svg`}
      alt={country}
      width={18}
      height={18}
      style={{
        width: 18, height: 18, borderRadius: '50%', objectFit: 'cover',
        display: 'inline-block', verticalAlign: 'middle',
        boxShadow: '0 0 0 1px var(--border-hairline)',
      }}
    />
  );
}

// Cell value: number only (the currency lives in the column header). Respects
// the currency's decimals — VND/RUB → grouped integers, KWD → 3 decimals.
function fmtNum(amount: number | undefined, decimals: number): string {
  if (typeof amount !== 'number') return '—';
  return new Intl.NumberFormat('en', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(amount);
}

// Editable price cell — click to type a manual price; blank reverts to the
// computed value. Edits are staged (amber) until "Save Prices" commits them.
function PriceCell({ col, sku, staged, onStage }: {
  col: PricingMatrixColumn; sku: string;
  staged: string | undefined; // pending edit not yet saved (undefined = none, '' = revert to computed)
  onStage: (currency: string, sku: string, norm: string, committed: string, isManual: boolean) => void;
}) {
  const value = col.prices[sku];
  const isManual = !!(col.manual && col.manual[sku]);
  const [editing, setEditing] = useState(false);
  if (typeof value !== 'number') {
    return <td style={{ textAlign: 'right', padding: '9px 12px', color: 'var(--fg-3)', borderBottom: '1px solid var(--border-hairline)' }}>—</td>;
  }
  const isDirty = staged !== undefined;
  function commit(raw: string) {
    setEditing(false);
    onStage(col.currency, sku, raw.trim().replace(',', '.'), String(value), isManual);
  }
  // Colour: dirty (amber) > manual (red) > computed.
  const color = isDirty ? 'var(--brand-amber, #b45309)' : isManual ? 'var(--brand-rot)' : 'var(--fg-1)';
  const bg = isDirty ? 'rgba(180,83,9,0.10)' : isManual ? 'rgba(199,33,39,0.06)' : undefined;
  const shown = isDirty ? (staged === '' ? 'auto' : staged) : fmtNum(value, col.decimals);
  return (
    <td
      onClick={() => { if (!editing) setEditing(true); }}
      title={isDirty ? 'Unsaved — click Save Prices to apply' : isManual ? 'Manual price — click to edit, clear to revert to computed' : 'Computed — click to set a manual price'}
      style={{
        textAlign: 'right', padding: '9px 12px', cursor: 'text',
        color, fontWeight: isDirty || isManual ? 700 : 400, backgroundColor: bg,
        borderBottom: '1px solid var(--border-hairline)',
      }}
    >
      {editing ? (
        <input
          autoFocus
          defaultValue={isDirty ? staged : String(value)}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); }}
          style={{ width: 78, textAlign: 'right', font: 'inherit', color: 'var(--fg-1)', border: '1px solid var(--brand-rot)', borderRadius: 4, padding: '2px 4px', background: 'var(--paper)' }}
        />
      ) : (
        <span>{shown}{isDirty ? ' ✎' : isManual ? ' •' : ''}</span>
      )}
    </td>
  );
}

function PricingMatrixSection({
  matrix, loading, error, onRetry,
}: {
  matrix: PricingMatrix | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  // Edits are staged locally (per currency|sku) and committed together by the
  // single "Save Prices" button — nothing is written until then.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const stageEdit = useCallback((currency: string, sku: string, norm: string, committed: string, isManual: boolean) => {
    const key = currency + '|' + sku;
    setDrafts((prev) => {
      const next = { ...prev };
      // No real change (typed back the current value, or cleared a computed cell)
      // → drop any stale draft so the cell isn't falsely marked dirty.
      if (norm === committed || (norm === '' && !isManual)) delete next[key];
      else next[key] = norm;
      return next;
    });
  }, []);

  const savePrices = useCallback(async () => {
    const entries = Object.entries(drafts);
    if (!entries.length || saving) return;
    setSaving(true);
    try {
      for (const [key, val] of entries) {
        const [currency, sku] = key.split('|');
        const res = await fetch(`${API_BASE}/api/pricing/override`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currency, sku, amount: val === '' ? null : val }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(`${sku} ${currency}: ${data.errors?.[0]?.message || 'save failed'}`);
      }
      setDrafts({});
      onRetry(); // reload the matrix to reflect the saved prices
    } catch (e) {
      alert('Could not save prices: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }, [drafts, saving, onRetry]);

  const dirtyCount = Object.keys(drafts).length;

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorBox title="Pricing matrix unavailable" message={error} />
        <button onClick={onRetry} className="px-4 py-2" style={{
          fontSize: 13, fontWeight: 700, color: 'var(--fg-1)',
          backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-sm)', cursor: 'pointer',
        }}>Retry</button>
      </div>
    );
  }
  if (loading && !matrix) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
      </div>
    );
  }
  if (!matrix) return null;

  const updated = matrix.updated_at ? new Date(matrix.updated_at).toLocaleString('ru-RU') : '—';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div style={{ fontSize: 13, color: 'var(--fg-3)' }}>
          Base <strong style={{ color: 'var(--fg-1)' }}>{matrix.base_currency}</strong> ·{' '}
          {matrix.columns.length} currencies · {matrix.rows.length} SKU · FX updated {updated}
          {matrix.rates_stale && (
            <span style={{ marginLeft: 8, color: 'var(--brand-rot)', fontWeight: 700 }}>
              ⚠ rates not yet loaded (run FX cron)
            </span>
          )}
        </div>
        <button onClick={savePrices} disabled={saving || dirtyCount === 0} className="flex items-center gap-2 px-4 py-2" style={{
          fontFamily: 'var(--font-display)',
          fontSize: 14, fontWeight: 800,
          color: dirtyCount ? 'var(--fg-on-brand)' : 'var(--fg-3)',
          backgroundColor: dirtyCount ? 'var(--brand-rot)' : 'var(--paper-sunk)',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          boxShadow: dirtyCount ? 'var(--shadow-raised)' : 'none',
          cursor: (saving || !dirtyCount) ? 'default' : 'pointer',
          opacity: saving ? 0.7 : 1,
        }}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save Prices{dirtyCount ? ` (${dirtyCount})` : ''}
        </button>
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-sm)' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13, whiteSpace: 'nowrap' }}>
          <thead>
            <tr style={{ backgroundColor: 'var(--paper-sunk)' }}>
              <th style={{ textAlign: 'left', padding: '10px 12px', position: 'sticky', left: 0, backgroundColor: 'var(--paper-sunk)', borderBottom: '1px solid var(--border-hairline)' }}>SKU</th>
              <th style={{ textAlign: 'right', padding: '10px 12px', borderBottom: '1px solid var(--border-hairline)', color: 'var(--fg-3)' }}>Base €</th>
              {matrix.columns.map((col) => (
                <th key={col.currency} style={{ textAlign: 'right', padding: '10px 12px', borderBottom: '1px solid var(--border-hairline)' }}>
                  <div style={{ fontWeight: 700, color: 'var(--fg-1)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                    <FlagDot country={col.country} /> {col.currency}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-3)', fontWeight: 400 }}>
                    {col.zone}{col.stripe_hidden ? ' · no Stripe' : ''}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row, ri) => (
              <tr key={row.sku} style={{ backgroundColor: ri % 2 ? 'var(--paper)' : 'transparent' }}>
                <td style={{ textAlign: 'left', padding: '9px 12px', fontWeight: 700, color: 'var(--fg-1)', position: 'sticky', left: 0, backgroundColor: ri % 2 ? 'var(--paper)' : 'var(--paper)', borderBottom: '1px solid var(--border-hairline)' }}>{row.sku}</td>
                <td style={{ textAlign: 'right', padding: '9px 12px', color: 'var(--fg-3)', borderBottom: '1px solid var(--border-hairline)' }}>{row.base_eur}</td>
                {matrix.columns.map((col) => (
                  <PriceCell key={col.currency} col={col} sku={row.sku} staged={drafts[col.currency + '|' + row.sku]} onStage={stageEdit} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 12, color: 'var(--fg-3)' }}>
        Computed cells = EUR base × daily FX × psychological rounding. <b>Click any cell to edit</b> a
        manual price; edits stay <span style={{ color: 'var(--brand-amber, #b45309)', fontWeight: 700 }}>amber ✎</span> (unsaved)
        until you press <b>Save Prices</b>. Clear a cell to revert it to computed. Saved manual prices
        (<span style={{ color: 'var(--brand-rot)', fontWeight: 700 }}>red •</span>) flow straight to the
        storefront and checkout via the same resolver, and are never auto-changed. Checkout always
        reprices server-side by the shipping country.
      </p>
    </div>
  );
}

function ErrorBox({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex items-start gap-3 p-4" style={{
      backgroundColor: 'var(--paper-sunk)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--brand-rot)' }} />
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-1)' }}>{title}</div>
        <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 4 }}>{message}</div>
      </div>
    </div>
  );
}

interface DataTablePanelProps {
  title: string;
  meta: PageMeta | null;
  loading: boolean;
  error: string | null;
  searchPlaceholder: string;
  searchInput: string;
  setSearchInput: (s: string) => void;
  activeSearch: string;
  onSearchSubmit: (e: React.FormEvent) => void;
  onClearSearch: () => void;
  limit: number;
  setLimit: (n: number) => void;
  page: number;
  setPage: (p: number | ((p: number) => number)) => void;
  children: React.ReactNode;
}

function DataTablePanel({
  title, meta, loading, error,
  searchPlaceholder, searchInput, setSearchInput, activeSearch,
  onSearchSubmit, onClearSearch,
  limit, setLimit, page, setPage,
  children,
}: DataTablePanelProps) {
  const totalCount = meta?.total_count ?? 0;
  const totalPages = meta?.total_pages ?? 1;
  const startRow = totalCount === 0 ? 0 : (page - 1) * limit + 1;
  const endRow = meta ? Math.min(page * limit, totalCount) : 0;

  return (
    <div style={{
      backgroundColor: 'var(--paper-raised)',
      boxShadow: 'var(--shadow-raised)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div className="px-5 py-3.5 flex items-center justify-between gap-4 flex-wrap"
           style={{ borderBottom: '1px solid var(--border-hairline)' }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 16,
          fontWeight: 800,
          color: 'var(--fg-1)',
        }}>
          {title}
          {totalCount > 0 && (
            <span style={{
              fontFamily: 'var(--font-body)',
              fontWeight: 700,
              color: 'var(--fg-3)',
              marginLeft: 8,
              fontSize: 14,
            }}>
              {startRow.toLocaleString('ru-RU')}–{endRow.toLocaleString('ru-RU')} of {totalCount.toLocaleString('ru-RU')}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <form onSubmit={onSearchSubmit} className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2"
                    style={{ color: 'var(--fg-muted)' }} />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-10 pr-3 py-2"
              style={{
                fontSize: 14,
                width: 280,
                backgroundColor: 'var(--paper-sunk)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--fg-1)',
              }}
            />
          </form>
          {activeSearch && (
            <button onClick={onClearSearch} style={{
              fontSize: 14, color: 'var(--brand-rot)', fontWeight: 700, cursor: 'pointer',
            }}>
              Clear
            </button>
          )}
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            style={{
              fontSize: 14, fontWeight: 700,
              padding: '8px 12px',
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--fg-1)', cursor: 'pointer',
            }}
          >
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
      </div>

      {error && (
        <div className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--brand-rot)' }}>
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      )}

      {!loading && !error && (
        <div className="overflow-x-auto">{children}</div>
      )}

      {meta && totalPages > 1 && (
        <div className="px-6 py-4 flex items-center justify-between"
             style={{ borderTop: '1px solid var(--border-hairline)' }}>
          <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>
            Page <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{page}</span> of{' '}
            <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{totalPages}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p: number) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="flex items-center gap-1 px-3 py-2"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 14, fontWeight: 800,
                color: page === 1 ? 'var(--fg-3)' : 'var(--fg-on-brand)',
                backgroundColor: page === 1 ? 'var(--paper-sunk)' : 'var(--brand-schwarz)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                boxShadow: page === 1 ? 'none' : 'var(--shadow-raised)',
                cursor: page === 1 ? 'not-allowed' : 'pointer',
                /* Disabled reads by ground and cursor, never by faded ink. */
              }}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </button>
            <button
              onClick={() => setPage((p: number) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="flex items-center gap-1 px-3 py-2"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 14, fontWeight: 800,
                color: page >= totalPages ? 'var(--fg-3)' : 'var(--fg-on-brand)',
                backgroundColor: page >= totalPages ? 'var(--paper-sunk)' : 'var(--brand-schwarz)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                boxShadow: page >= totalPages ? 'none' : 'var(--shadow-raised)',
                cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                /* Disabled reads by ground and cursor, never by faded ink. */
              }}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OrdersTable({ orders, hasSearch, search, sort, onSort, variant = 'ru', onOpen, pdShown = {}, revealCustomer }: { orders: CrmOrder[]; hasSearch: boolean; search: string; sort: { key: string; dir: 'asc' | 'desc' }; onSort: (k: string) => void; variant?: CrmSource; onOpen?: (orderNumber: string) => void; pdShown?: Record<string, { name?: string; phone?: string; email?: string; city?: string } | 'loading' | 'error'>; revealCustomer?: (number: string) => void }) {
  if (variant === 'com') {
    // Website (.com/Stripe) orders — no loyalty columns; USD; SKU line items
    return (
      <table className="w-full">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <SortTh label="Order" sortKey="number" current={sort} onSort={onSort} align="left" />
            <Th align="left">Customer</Th>
            <Th align="left">Items</Th>
            <SortTh label="Total" sortKey="total" current={sort} onSort={onSort} />
            <Th align="left">Country</Th>
            <SortTh label="Status" sortKey="status" current={sort} onSort={onSort} align="left" />
            <Th align="left">Paid</Th>
            <Th align="left">Shipped</Th>
            <SortTh label="Date" sortKey="date" current={sort} onSort={onSort} align="left" />
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 && (
            <tr>
              <td colSpan={9} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                {hasSearch ? `No orders matching "${search}"` : 'No website orders yet'}
              </td>
            </tr>
          )}
          {orders.map((o) => (
            <tr
              key={`${o.order_source ?? 'website'}-${o.number}`}
              onClick={() => onOpen?.(String(o.number))}
              title="Open order card"
              style={{ borderBottom: '1px solid var(--border-hairline)', cursor: onOpen ? 'pointer' : 'default' }}
              onMouseEnter={(e) => { if (onOpen) (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--paper-sunk, #F3F0E8)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent'; }}
            >
              <Td bold style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: 12 }}>
                {o.number}
                {o.order_source && o.order_source !== 'website' && (
                  <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: 6 }}>{o.order_source}</span>
                )}
              </Td>
              <Td>
                {o.customer_name}
                {o.email && <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{o.email}</div>}
              </Td>
              <td className="px-6 py-3 text-left relative group" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                {(() => {
                  const its = o.items ?? [];
                  if (!its.length) return '—';
                  const n = its.reduce((s, it) => s + (Number(it.qty) || 1), 0);
                  return (
                    <>
                      <span style={{ background: 'var(--paper-sunk, #F3F0E8)', borderRadius: 999, padding: '2px 10px', fontWeight: 500, color: 'var(--fg-1)', cursor: 'default', whiteSpace: 'nowrap' }}>
                        {n} item{n === 1 ? '' : 's'}
                      </span>
                      <div className="hidden group-hover:block absolute z-30" style={{ top: '100%', left: 24, background: 'var(--paper, #FFFFFF)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: '8px 12px', whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(26,21,25,.10)' }}>
                        {its.map((it, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 18, fontSize: 12, padding: '2px 0' }}>
                            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{it.sku}</span>
                            <span style={{ color: 'var(--fg-3)' }}>{it.name ? `${it.name} · ` : ''}×{it.qty}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  );
                })()}
              </td>
              <Td align="right" bold>${o.total.toLocaleString('en-US')}</Td>
              <td className="px-6 py-3 text-left" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                {o.ship_country ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <img
                      src={`/flags/${o.ship_country.toLowerCase()}.svg`}
                      alt=""
                      width={19}
                      height={14}
                      style={{ borderRadius: 2, boxShadow: '0 0 0 1px rgba(26,21,25,.12)' }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                    <span style={{ fontSize: 11 }}>{o.ship_country}</span>
                  </span>
                ) : '—'}
              </td>
              <OrderStatusCell primary={o.status} secondary={o.fulfillment_status} />
              <OrderPaymentCell {...comPayment(o)} />
              <OrderShipmentCell {...comShipment(o)} />
              <Td muted>{o.created_at}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <Th align="left">Order</Th>
          <Th align="left">Customer</Th>
          <Th align="left">Items</Th>
          <SortTh label="Total" sortKey="total" current={sort} onSort={onSort} />
          <Th align="left">Paid</Th>
          <Th align="left">Shipped</Th>
          <Th align="left">Delivered</Th>
          <SortTh label="Date" sortKey="date" current={sort} onSort={onSort} align="left" />
        </tr>
      </thead>
      <tbody>
        {orders.length === 0 && (
          <tr>
            <td colSpan={8} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              {hasSearch ? `No orders matching "${search}"` : 'No orders'}
            </td>
          </tr>
        )}
        {orders.map((o) => (
          <tr
            key={o.id}
            onClick={() => onOpen?.(String(o.number))}
            title="Открыть карточку заказа"
            style={{ borderBottom: '1px solid var(--border-hairline)', cursor: onOpen ? 'pointer' : 'default' }}
            onMouseEnter={(e) => { if (onOpen) (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--paper-sunk, #F3F0E8)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent'; }}
          >
            <Td bold>{o.number}</Td>
            <Td>
              {(() => {
                const pd = pdShown[o.number];
                if (pd === 'loading') return <span style={{ color: 'var(--fg-3)' }}>…</span>;
                if (pd === 'error') return <span style={{ color: 'var(--status-error)' }}>не открылось</span>;
                if (pd && typeof pd === 'object') return (
                  <span>
                    <b>{pd.name || '—'}</b>
                    <span style={{ display: 'block', color: 'var(--fg-3)', fontSize: 12 }}>
                      {[pd.phone, pd.city].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                );
                return (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); revealCustomer?.(o.number); }}
                    title="Показать имя и телефон. Показ записывается в журнал."
                    style={{ border: '1px solid var(--border-hairline)', background: 'transparent',
                             borderRadius: 6, padding: '4px 9px', cursor: 'pointer',
                             font: 'inherit', fontSize: 13, color: 'var(--fg-2)' }}
                  >
                    {o.customer_name} · показать
                  </button>
                );
              })()}
            </Td>
            {/* Штук в заказе; состав раскрывается мышью и с клавиатуры. */}
            <td className="px-6 py-3 text-left relative group" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              {o.items_count ? (
                <>
                  <span
                    tabIndex={0}
                    aria-label={`${o.items_count} товаров в заказе. Наведите или нажмите Tab, чтобы увидеть состав.`}
                    title={(o.items ?? []).length ? undefined
                      : 'Состав не показан: лента витрины .ru отдаёт в позиции только количество, без названия и артикула'}
                    style={{ background: 'var(--paper-sunk)', borderRadius: 'var(--radius-pill)', padding: '2px 10px',
                             fontWeight: 500, color: 'var(--fg-1)', cursor: 'help', whiteSpace: 'nowrap' }}>
                    {o.items_count} item{o.items_count === 1 ? '' : 's'}
                  </span>
                  {(o.items ?? []).length > 0 && (
                    <div className="hidden group-hover:block group-focus-within:block absolute z-30" role="tooltip"
                         style={{ top: '100%', left: 24, background: 'var(--paper)',
                                  border: '1px solid var(--border-hairline)', borderRadius: 8, padding: '8px 12px',
                                  minWidth: 250, maxWidth: 420, boxShadow: 'var(--shadow-card)' }}>
                      {(o.items ?? []).map((it, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 18,
                                              fontSize: 12, padding: '2px 0' }}>
                          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{it.sku ?? '—'}</span>
                          <span style={{ color: 'var(--fg-3)', textAlign: 'right' }}>{it.name ? `${it.name} · ` : ''}×{it.qty}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : '—'}
            </td>
            <Td align="right" bold>{o.total.toLocaleString('ru-RU')} ₽</Td>
            <OrderPaymentCell {...ruPayment(o)} />
            <OrderShipmentCell {...ruShipment(o)} />
            <OrderDeliveryCell {...ruDelivery(o)} />
            <Td muted>{o.created_at}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Статус · Оплата · Отправление — три общие ячейки обеих витрин (Владелец 2026-08-31):
// у .com теперь та же колонка статуса и те же два столбца, что в зеркале .ru.
// Компоненты рисуют, картирование полей витрины делают ru*/com* ниже.

function OrderStatusCell({ primary, secondary }: { primary?: string | null; secondary?: string | null }) {
  return (
    <Td muted>
      {primary || '—'}
      {secondary && secondary !== primary && (
        <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-3)' }}>{secondary}</span>
      )}
    </Td>
  );
}

type PayState = 'unknown' | 'paid' | 'awaiting' | 'unpaid' | 'refunded' | 'failed' | 'none';

function OrderPaymentCell({ state, at, method }: { state: PayState; at?: string | null; method?: string | null }) {
  const methodLine = method
    ? <span style={{ display: 'block', fontWeight: 400, fontSize: 12, color: 'var(--fg-3)' }}>{method}</span>
    : null;
  if (state === 'paid') {
    return (
      <Td>
        <span style={{ color: 'var(--status-success)', fontWeight: 700 }}>оплачен{at ? <span style={{ display: 'block', fontWeight: 400, fontSize: 12, color: 'var(--fg-3)' }}>{new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span> : null}</span>
        {methodLine}
      </Td>
    );
  }
  if (state === 'refunded') {
    return <Td><span style={{ color: 'var(--status-warning)', fontWeight: 700 }}>возврат</span>{methodLine}</Td>;
  }
  if (state === 'failed') {
    return <Td><span style={{ color: 'var(--status-error)', fontWeight: 700 }}>оплата не прошла</span>{methodLine}</Td>;
  }
  const label = state === 'awaiting' ? 'ждёт оплаты' : state === 'unpaid' ? 'не оплачен' : '—';
  return <Td><span style={{ color: 'var(--fg-3)' }}>{label}</span>{state === 'unknown' ? null : methodLine}</Td>;
}

function OrderShipmentCell({ id, detail, trackingUrl, missing, waiting }: { id?: string | null; detail?: string | null; trackingUrl?: string | null; missing?: boolean; waiting?: number }) {
  if (id) {
    // «Ждёт в пункте выдачи» — деньги, которые уже уедут назад, если покупатель
    // не придёт: срок хранения идёт, а Ozon об этом сам не напоминает. Поэтому
    // предупреждающим цветом, а не строкой мелким шрифтом.
    const body = (
      <span style={{ fontWeight: 700 }}>
        {id}
        {waiting ? (
          <span style={{
            display: 'block', marginTop: 3, fontSize: 12, fontWeight: 700,
            color: 'var(--status-warning)', whiteSpace: 'nowrap',
          }}>
            ждёт в пункте выдачи{waiting > 1 ? ` · ${waiting} посылки` : ''}
          </span>
        ) : null}
        {detail ? <span style={{ display: 'block', fontWeight: 400, fontSize: 12, color: 'var(--fg-3)' }}>{detail}</span> : null}
      </span>
    );
    return (
      <Td>
        {trackingUrl
          ? <a href={trackingUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }} onClick={(e) => e.stopPropagation()}>{body}</a>
          : body}
      </Td>
    );
  }
  if (missing) return (
    <Td>
      <span style={{
        color: 'var(--status-error)', fontWeight: 700,
        background: 'color-mix(in srgb, var(--status-error) 10%, transparent)',
        borderRadius: 'var(--radius-pill)', padding: '3px 10px', display: 'inline-block', maxWidth: 360,
      }}>
        нет отправления
        {detail ? <span style={{ display: 'block', marginTop: 2, fontSize: 12, fontWeight: 700 }}>{detail}</span> : null}
      </span>
    </Td>
  );
  return <Td><span style={{ color: 'var(--fg-3)' }}>—</span></Td>;
}

// Доставлено — конец пути заказа. Витрина отдельного поля «вручено в» не
// отдаёт: для delivered время вручения — это delivery_updated_at, момент
// последней смены статуса доставки. Отменённый заказ до этой графы не
// доезжает, и она говорит об этом прямо, а не молчит прочерком.
type DeliveryState = 'delivered' | 'transit' | 'cancelled' | 'none';

function OrderDeliveryCell({ state, at, parts }: { state: DeliveryState; at?: string | null; parts?: string | null }) {
  const partsLine = parts
    ? <span style={{ display: 'block', fontWeight: 400, fontSize: 12, color: 'var(--fg-3)' }}>{parts}</span>
    : null;
  if (state === 'delivered') {
    return (
      <Td>
        <span style={{ color: 'var(--status-success)', fontWeight: 700 }}>
          доставлен
          {at ? <span style={{ display: 'block', fontWeight: 400, fontSize: 12, color: 'var(--fg-3)' }}>
            {new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </span> : null}
        </span>
        {partsLine}
      </Td>
    );
  }
  if (state === 'transit') {
    return <Td><span style={{ fontWeight: 700 }}>в пути</span>{partsLine}</Td>;
  }
  if (state === 'cancelled') {
    return <Td><span style={{ color: 'var(--fg-2)', fontWeight: 700 }}>отменён</span></Td>;
  }
  return <Td><span style={{ color: 'var(--fg-3)' }}>—</span></Td>;
}

function ruDelivery(o: CrmOrder): { state: DeliveryState; at?: string | null; parts?: string | null } {
  if (o.paid === undefined) return { state: 'none' };
  const store = o.storefront_status ?? '';
  const total = o.delivery_parts_total ?? 0;
  const received = o.delivery_parts_received ?? 0;
  const parts = total > 1 ? `получено ${received} из ${total}` : null;
  if (o.delivery_status === 'delivered' || store === 'delivered') {
    // Время вручения показываем только по живой синхронизации витрины. У строк
    // разового импорта старой базы ('kit') delivery_updated_at — это момент
    // заливки 17.08, один на 1463 заказа; выдавать его за дату вручения нельзя.
    const trusted = o.mirror_source === 'site';
    return { state: 'delivered', at: trusted ? (o.delivery_updated_at ?? null) : null, parts };
  }
  if (store === 'cancelled' || store === 'refunded') return { state: 'cancelled' };
  if (o.delivery_status === 'delivering' || store === 'wait_for_delivery') {
    return { state: 'transit', parts };
  }
  return { state: 'none' };
}

function shortFactDate(epoch: number | null | undefined): string | null {
  if (!epoch) return null;
  return new Date(epoch * 1000).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function ruStockExplanation(o: CrmOrder): string {
  const facts = o.stock_facts ?? [];
  if (!facts.length) return 'Ozon: товар недоступен · состав заказа ещё не пришёл в зеркало';

  const own = facts.reduce((n, f) => n + f.our_stock + f.assembleable, 0);
  const inTransit = facts.reduce((n, f) => n + (f.ozon_in_transit ?? 0), 0);
  const supply = facts.reduce((n, f) => n + (f.ozon_supply_qty ?? 0), 0);
  const ozonKnown = facts.every((f) => f.ozon_available !== null);
  const ozon = facts.reduce((n, f) => n + (f.ozon_available ?? 0), 0);
  const ownAt = facts.map((f) => f.our_stock_at).filter((v): v is number => Boolean(v)).sort((a, b) => b - a)[0] ?? null;
  if (inTransit > 0) {
    return `Запас для выбранного ПВЗ временно закончился · Ozon подтверждает: ${inTransit} шт. уже в пути на склад · приносим извинения за задержку: после приёмки заказ сразу упакуют и отправят`;
  }

  if (supply > 0) {
    return `Запас для выбранного ПВЗ временно закончился · Ozon подтверждает пополнение: ${supply} шт. в активной поставке · приносим извинения за задержку: после приёмки заказ сразу упакуют и отправят`;
  }

  const lines: string[] = [];
  lines.push(ozonKnown && ozon > 0
    ? `Ozon не выдаёт товар для выбранного ПВЗ · по стране ${ozon} шт.`
    : 'Запас Ozon закончился');
  if (own > 0) lines.push(`На наших складах РФ учтено ${own} шт.${ownAt ? ` на ${shortFactDate(ownAt)}` : ''}`);
  lines.push('Поставка в Ozon не подтверждена');
  return lines.join(' · ');
}

// Картирование зеркала .ru — поведение то же, что до выноса ячеек.
function ruPayment(o: CrmOrder): { state: PayState; at?: string | null } {
  if (o.paid === undefined) return { state: 'unknown' };
  if (o.paid) return { state: 'paid', at: o.paid_at };
  if (o.storefront_status === 'awaiting_payment') return { state: 'awaiting' };
  if (o.storefront_status === 'cancelled') return { state: 'none' };
  return { state: 'unpaid' };
}

function ruShipment(o: CrmOrder): { id?: string | null; detail?: string | null; missing?: boolean; waiting?: number } {
  if (o.paid === undefined) return {};
  if (o.delivery_order_id) {
    // Разбивку показываем только когда посылок больше одной: Ozon режет заказ по
    // своим складам, части приезжают в разные дни, и «забрал две трети» иначе с
    // экрана не читается вовсе.
    const parts = o.delivery_parts_total ?? 0;
    const partsLine = parts > 1
      ? `${parts} посылки · получено ${o.delivery_parts_received ?? 0}`
      : null;
    return {
      id: o.delivery_order_id,
      detail: [o.delivery_status, partsLine, o.tracking_number].filter(Boolean).join(' · '),
      // Не статус, а отдельная ось: посылка в пункте всё ещё delivering.
      waiting: o.delivery_parts_at_point ?? 0,
    };
  }
  const failure = o.delivery_substatus === 'shipment_out_of_stock'
    ? ruStockExplanation(o)
    : o.delivery_substatus === 'shipment_creation_failed'
      ? 'Ozon: ошибка создания'
      : null;
  return {
    missing: !!o.paid && !['cancelled', 'refunded', 'delivered'].includes(o.storefront_status ?? ''),
    detail: failure,
  };
}

// Картирование витрины .com: financial_status — деньги, fulfillment_status — отправление.
// Времени подтверждения платежа у .com нет: `placed_at` пишется из `pi.created`
// (`mapPaymentIntent`, api/src/lib/crm-website.ts) — это момент создания
// PaymentIntent, а не успеха оплаты. При отложенном подтверждении и ручном
// списании он врёт, поэтому «Оплата» на .com показывается без времени, пока
// бэкенд не отдаст настоящий paid_at.
function comPayment(o: CrmOrder): { state: PayState; at?: string | null; method?: string | null } {
  const method = (o as any).payment_method as string | null | undefined;
  if (o.status === 'paid') return { state: 'paid', method };
  if (o.status === 'refunded' || o.status === 'partially_refunded') return { state: 'refunded', method };
  if (o.status === 'failed') return { state: 'failed', method };
  if (o.status === 'pending') return { state: 'awaiting', method };
  if (o.fulfillment_status === 'cancelled') return { state: 'none' };
  return { state: 'unpaid', method };
}

function comShipment(o: CrmOrder): { id?: string | null; detail?: string | null; trackingUrl?: string | null; missing?: boolean } {
  if (o.fulfillment_status === 'cancelled') return {};
  const shipped = o.fulfillment_status === 'shipped' || o.fulfillment_status === 'delivered';
  if (o.tracking_number) {
    return { id: o.tracking_number, detail: o.fulfillment_status, trackingUrl: o.tracking_url };
  }
  if (shipped) return { id: o.fulfillment_status, trackingUrl: o.tracking_url };
  const settled = o.status === 'refunded' || o.status === 'partially_refunded' || o.status === 'failed';
  return { missing: o.status === 'paid' && !settled };
}

function CartStatusBadge({ status }: { status: CrmCart['status'] }) {
  const map: Record<CrmCart['status'], { bg: string; fg: string; label: string }> = {
    initiated: { bg: 'color-mix(in srgb, var(--status-warning) 12%, transparent)', fg: 'var(--status-warning)', label: 'initiated' },
    converted: { bg: 'color-mix(in srgb, var(--status-success) 12%, transparent)', fg: 'var(--status-success)', label: 'converted' },
    abandoned: { bg: 'color-mix(in srgb, var(--status-error) 10%, transparent)', fg: 'var(--status-error)', label: 'abandoned' },
    recovered: { bg: 'color-mix(in srgb, var(--status-info) 12%, transparent)', fg: 'var(--status-info)', label: 'recovered' },
  };
  const s = map[status] ?? map.initiated;
  return (
    <span style={{ background: s.bg, color: s.fg, borderRadius: 5, padding: '2px 8px', fontSize: 12, fontWeight: 600 }}>
      {s.label}
    </span>
  );
}

function CartsTable({ carts, hasSearch, search, sort, onSort }: { carts: CrmCart[]; hasSearch: boolean; search: string; sort: { key: string; dir: 'asc' | 'desc' }; onSort: (k: string) => void }) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <SortTh label="Order" sortKey="number" current={sort} onSort={onSort} align="left" />
          <Th align="left">Customer</Th>
          <Th align="left">Items</Th>
          <SortTh label="Value" sortKey="total" current={sort} onSort={onSort} />
          <Th align="left">Country</Th>
          <SortTh label="Status" sortKey="status" current={sort} onSort={onSort} align="left" />
          <SortTh label="Started" sortKey="date" current={sort} onSort={onSort} align="left" />
        </tr>
      </thead>
      <tbody>
        {carts.length === 0 && (
          <tr>
            <td colSpan={7} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              {hasSearch ? `No carts matching "${search}"` : 'No carts captured yet'}
            </td>
          </tr>
        )}
        {carts.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <Td bold>{r.number}</Td>
            <Td>
              {r.customer_name}
              {r.email && <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{r.email}</div>}
            </Td>
            <Td muted>{(r.items ?? []).map((it) => `${it.sku}×${it.qty}`).join(', ') || '—'}</Td>
            <Td align="right" bold>${r.total.toLocaleString('en-US')}</Td>
            <Td muted>{r.country || '—'}</Td>
            <Td><CartStatusBadge status={r.status} /></Td>
            <Td muted>{r.initiated_at}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type RevealedCustomer = { name?: string | null; phone?: string | null; email?: string | null;
  loyalty?: { balance: number | null; level: string | null; privilege_pct: number | null } };

function CustomersTable({ customers, hasSearch, search, sort, onSort, variant = 'ru', onOpen }: { customers: CrmCustomer[]; hasSearch: boolean; search: string; sort: { key: string; dir: 'asc' | 'desc' }; onSort: (k: string) => void; variant?: CrmSource; onOpen?: (customerId: string) => void }) {
  // Список .ru приходит обезличенным: в колонке «Заказ N», телефона и почты нет.
  // Имя, телефон, почта и бонусы — по кнопке в строке, по одному покупателю,
  // с записью в журнал на стороне России (pd_access_log, key:<ключ>).
  // Решение Владельца 31.08.2026: кнопка, а не выгрузка.
  const [revealed, setRevealed] = useState<Record<string, RevealedCustomer | 'loading' | 'error'>>({});
  const revealByKey = async (key: string) => {
    if (revealed[key]) return;
    setRevealed((m) => ({ ...m, [key]: 'loading' }));
    try {
      const res = await fetch(`${API_BASE}/api/crm/customer-key/${encodeURIComponent(key)}?who=erp-ui`);
      const j = await res.json();
      if (!j?.success) throw new Error('нет данных');
      setRevealed((m) => ({ ...m, [key]: {
        name: j.result?.customer?.name, phone: j.result?.customer?.phone,
        email: j.result?.customer?.email, loyalty: j.result?.loyalty } }));
    } catch {
      setRevealed((m) => ({ ...m, [key]: 'error' }));
    }
  };
  if (variant === 'com') {
    // Website (.com) customer database — no loyalty columns; USD; source tag
    return (
      <table className="w-full">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <SortTh label="Customer" sortKey="name" current={sort} onSort={onSort} align="left" />
            <Th align="left">Email</Th>
            <Th align="left">Phone</Th>
            <Th align="left">Country</Th>
            <Th align="left">Source</Th>
            <SortTh label="Orders" sortKey="orders" current={sort} onSort={onSort} />
            <SortTh label="Total spent" sortKey="spent" current={sort} onSort={onSort} />
            <SortTh label="Registered" sortKey="registered" current={sort} onSort={onSort} align="left" />
          </tr>
        </thead>
        <tbody>
          {customers.length === 0 && (
            <tr>
              <td colSpan={8} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                {hasSearch ? `No customers matching "${search}"` : 'No website customers yet'}
              </td>
            </tr>
          )}
          {customers.map((cu) => (
            <tr
              key={cu.id}
              onClick={() => onOpen?.(String(cu.id))}
              title="Open customer card"
              style={{ borderBottom: '1px solid var(--border-hairline)', cursor: onOpen ? 'pointer' : 'default' }}
              onMouseEnter={(e) => { if (onOpen) (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--paper-sunk, #F3F0E8)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'transparent'; }}
            >
              <Td bold>{cu.name}</Td>
              <Td muted>{cu.email || '—'}</Td>
              <Td muted>{cu.phone || '—'}</Td>
              <Td muted>{cu.country || '—'}</Td>
              <Td muted>{cu.customer_source || 'website'}</Td>
              <Td align="right" bold>{cu.orders_count}</Td>
              <Td align="right" bold>${cu.total_spent.toLocaleString('en-US')}</Td>
              <Td muted>{cu.created_at}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <Th align="left">Customer</Th>
          {/* Город — второй графой (Владелец 02.09.2026). В ленте витрины его
              нет: приходит из связки, которую набивает крон по карточке
              последнего заказа. Прочерк значит «витрина города не назвала». */}
          <Th align="left">City</Th>
          <Th align="left">Email</Th>
          <Th align="left">Phone</Th>
          <SortTh label="Orders" sortKey="orders" current={sort} onSort={onSort} />
          <SortTh label="Total spent" sortKey="spent" current={sort} onSort={onSort} />
          <Th align="left">Level</Th>
          <SortTh label="Balance" sortKey="balance" current={sort} onSort={onSort} />
          {/* Лента .ru даты регистрации не отдаёт: в этой графе всегда стояла
              дата последнего заказа. Теперь она названа своим именем и по ней
              же идёт порядок по умолчанию — свежие сверху. */}
          <SortTh label="Last order" sortKey="last_order" current={sort} onSort={onSort} align="left" />
        </tr>
      </thead>
      <tbody>
        {customers.length === 0 && (
          <tr>
            <td colSpan={9} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              {hasSearch ? `No customers matching "${search}"` : 'No customers'}
            </td>
          </tr>
        )}
        {customers.map((cu) => {
          const key = cu.key ?? null;
          const r = key ? revealed[key] : undefined;
          const shown = r && typeof r === 'object' ? r : null;
          const level = shown?.loyalty?.level ?? cu.loyalty_level;
          // После показа по кнопке счёта может не оказаться — тогда процент
          // берём из расчёта по тратам, а не гасим графу заодно с балансом.
          const pct = shown?.loyalty?.privilege_pct ?? cu.loyalty_privilege_pct;
          const balance = shown?.loyalty?.balance ?? cu.loyalty_balance;
          return (
          <tr key={cu.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <Td bold>
              {!cu.depersonalized || !key ? cu.name
                : r === 'loading' ? <span style={{ color: 'var(--fg-3)' }}>…</span>
                : r === 'error' ? <span style={{ color: 'var(--status-error)' }}>не открылось</span>
                : shown ? (shown.name || '—')
                : (
                  <button
                    type="button"
                    onClick={() => revealByKey(key)}
                    title="Показать имя, телефон и почту. Показ записывается в журнал."
                    style={{ border: '1px solid var(--border-hairline)', background: 'transparent',
                             borderRadius: 6, padding: '4px 9px', cursor: 'pointer',
                             font: 'inherit', fontSize: 13, color: 'var(--fg-2)' }}
                  >
                    {cu.name} · показать
                  </button>
                )}
            </Td>
            <Td muted>{cu.city || '—'}</Td>
            <Td muted>{shown ? (shown.email || '—') : (cu.email || '—')}</Td>
            <Td muted>{shown ? (shown.phone || '—') : (cu.phone || '—')}</Td>
            <Td align="right" bold>{cu.orders_count}</Td>
            <Td align="right" bold>{cu.total_spent.toLocaleString('ru-RU')} ₽</Td>
            {/* Уровень: из счёта, если он есть, иначе посчитан по сумме
                покупок тем же правилом клуба. Подпись говорит, что это
                расчёт, — чтобы расчёт не выдавали за счёт. */}
            <Td bold style={{ color: level ? 'var(--fg-1)' : 'var(--fg-3)' }}
                title={cu.loyalty_level_basis === 'spent'
                  ? 'Уровень посчитан по сумме покупок: счёта в клубе у этого покупателя нет'
                  : undefined}>
              {level || '—'}
              {pct !== null && pct !== undefined && (
                <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: 6 }}>{pct}%</span>
              )}
            </Td>
            {/* Баланс. Остаток счёта показываем, когда счёт найден. Когда не
                найден — показываем то, что о баллах всё же известно: сколько
                покупатель ими заплатил в заказах (Владелец 02.09.2026: «если
                что-то есть — показывай, не надо прятать»). Прочерк остаётся
                только там, где нет ни того, ни другого. */}
            <Td align="right" bold style={{ color: balance === null || balance === undefined ? 'var(--fg-3)' : 'var(--fg-1)' }}
                title={balance === null || balance === undefined
                  ? (cu.loyalty_used
                    ? `Остаток счёта не виден: счёт заведён на телефон, а лента .ru отдаёт обезличенный ключ. Известно одно — баллами оплачено ${cu.loyalty_used} ₽`
                    : 'Баллов не видно: счёт лояльности заведён на телефон, а лента .ru отдаёт обезличенный ключ — связать их пока нечем')
                  : undefined}>
              {balance !== null && balance !== undefined
                ? balance.toLocaleString('ru-RU')
                : cu.loyalty_used
                  ? <span style={{ fontWeight: 400, color: 'var(--fg-2)' }}>
                      −{cu.loyalty_used.toLocaleString('ru-RU')}<span style={{ color: 'var(--fg-3)' }}> потрачено</span>
                    </span>
                  : '—'}
            </Td>
            <Td muted>{cu.last_order_at ?? cu.created_at}</Td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={`px-6 py-3 text-${align}`} style={{ fontSize: 12, fontWeight: 400, color: 'var(--fg-2)', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  );
}

function SortTh({ label, sortKey, current, onSort, align = 'right' }: { label: string; sortKey: string; current: { key: string; dir: 'asc' | 'desc' }; onSort: (k: string) => void; align?: 'left' | 'right' }) {
  const activeCol = current.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} className={`px-6 py-3 text-${align}`} style={{ fontSize: 12, fontWeight: activeCol ? 600 : 400, color: activeCol ? 'var(--fg-1)' : 'var(--fg-2)', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}>
      {label}{activeCol ? (current.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

function Td({
  children, align = 'left', bold = false, muted = false, style = {}, title,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  bold?: boolean;
  muted?: boolean;
  style?: React.CSSProperties;
  // Подпись при наведении: клетка иногда должна объяснить, почему она пустая.
  title?: string;
}) {
  return (
    <td className={`px-6 py-3 text-${align}`} title={title} style={{
      fontSize: 13,
      fontWeight: bold ? 700 : 400,
      color: muted ? 'var(--fg-3)' : 'var(--fg-1)',
      whiteSpace: align === 'right' ? 'nowrap' : undefined,
      ...style,
    }}>
      {children}
    </td>
  );
}
