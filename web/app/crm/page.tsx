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

interface CrmFunnel {
  source: string;
  stages: {
    registered: number;
    loyalty_members: number;
    bought_at_least_once: number;
    repeat_buyers: number;
  };
  conversion_to_buyer_pct: number;
  repeat_rate_pct: number;
  welcome_burnt_estimate: number;
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
  items?: Array<{ sku: string; name?: string; qty: number }>;
  order_source?: string;
  fulfillment_status?: string | null;
  tracking_url?: string | null;
}

interface CrmCustomer {
  id: number | string;
  name: string;
  email: string | null;
  phone: string | null;
  orders_count: number;
  total_spent: number;
  average_order: number;
  created_at: string;
  loyalty_balance: number | null;
  loyalty_level: string | null;
  loyalty_privilege_pct: number | null;
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

export default function CrmPage() {
  const [stats, setStats] = useState<CrmStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [metrika, setMetrika] = useState<MetrikaStats | null>(null);
  const [metrikaLoading, setMetrikaLoading] = useState(true);

  const [timeline, setTimeline] = useState<CrmTimeline | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(true);

  const [funnel, setFunnel] = useState<CrmFunnel | null>(null);
  const [funnelLoading, setFunnelLoading] = useState(true);

  const [tab, setTab] = useState<TabId>('orders');

  // Which storefront feeds the Orders/Customers tabs:
  // 'ru'  — dasexperten.ru via Yandex KIT (/api/crm/*, RUB)
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
  const [ordersMeta, setOrdersMeta] = useState<PageMeta | null>(null);
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

  const loadFunnel = useCallback(async () => {
    setFunnelLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/crm/funnel`);
      const data = await res.json();
      if (data.success && data.result) setFunnel(data.result);
    } catch (e) {
      // Silent
    } finally {
      setFunnelLoading(false);
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
      } else {
        setOrdersError(data.errors?.[0]?.message || 'Failed to load orders');
      }
    } catch (e) {
      setOrdersError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setOrdersLoading(false);
    }
  }, [ordersPage, ordersLimit, ordersActiveSearch, ordersSort, crmSource]);

  const [custSort, setCustSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'spent', dir: 'desc' });
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
  useEffect(() => { loadFunnel(); }, [loadFunnel]);
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
    setCustSort({ key: 'spent', dir: 'desc' });
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
    loadFunnel();
    if (crmSource === 'com') loadComStats();
    if (crmSource === 'pricing') loadMatrix(); // Geo Price Matrix view — reload it too
    if (tab === 'orders') loadOrders();
    else if (tab === 'customers') loadCustomers();
    else if (tab === 'carts') loadCarts();
  }

  const isLoading = statsLoading || metrikaLoading || timelineLoading || funnelLoading || ordersLoading || customersLoading;

  return (
    <div className="space-y-6 max-w-full crm-mock">
      {/* Owner order 2026-07-21: port the mockup typography VERBATIM — Plus Jakarta Sans body,
          Fraunces numerals/headings. Do NOT adapt to the ERP shell fonts. */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap');
        .crm-mock{font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;}
        .crm-mock h1{font-family:'Fraunces',serif;font-weight:600;}
        .crm-mock tbody tr:hover{background:#F3F0E8;}
      `}</style>
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Headphones className="h-7 w-7" style={{ color: 'var(--brand-rot)' }} />
            <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--fg-1)' }}>CRM</h1>
          </div>
          <p style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 4 }}>
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
              fontSize: 14, fontWeight: 700, color: 'var(--fg-1)',
              backgroundColor: 'var(--paper-sunk)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
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
          sublabel="Yandex KIT · ₽"
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
        <div className="grid grid-cols-6 gap-4">
          <KpiTile label="Customers" value={stats.customers_total.toLocaleString('ru-RU')} />
          <KpiTile label="Loyalty members" value={stats.loyalty_members_total.toLocaleString('ru-RU')} />
          <KpiTile label="Orders (total)" value={stats.orders_total.toLocaleString('ru-RU')} />
          <KpiTile label="Orders this month" value={stats.orders_this_month.toLocaleString('ru-RU')} />
          <KpiTile label="Revenue this month" value={`${stats.revenue_this_month_rub.toLocaleString('ru-RU')} ₽`} />
          <KpiTile
            label="Visits today"
            value={metrika ? metrika.today.visits.toLocaleString('ru-RU') : (metrikaLoading ? '…' : '—')}
          />
        </div>
      )}

      {/* Loyalty conversion funnel — .ru/KIT analytics */}
      {crmSource === 'ru' && <LoyaltyFunnel funnel={funnel} loading={funnelLoading} />}

      {/* Daily activity — visits behind, registrations middle, orders front */}
      {crmSource === 'ru' && (
        <DailyActivityChart
          crmTimeline={timeline?.timeline ?? null}
          metrikaTimeline={metrika?.timeline ?? null}
          loading={timelineLoading || metrikaLoading}
        />
      )}

      {/* Tabs */}
      {crmSource !== 'pricing' && (
      <div className="flex items-center gap-1" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
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
          <OrdersTable orders={orders} hasSearch={!!ordersActiveSearch} search={ordersActiveSearch} sort={ordersSort} onSort={sortOrders} variant={crmSource} />
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
          <CustomersTable customers={customers} hasSearch={!!customersActiveSearch} search={customersActiveSearch} sort={custSort} onSort={sortCustomers} variant={crmSource} />
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

function LoyaltyFunnel({
  funnel,
  loading,
}: {
  funnel: CrmFunnel | null;
  loading: boolean;
}) {
  if (loading && !funnel) {
    return (
      <div style={{
        backgroundColor: 'var(--paper)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
        padding: '20px 24px',
        height: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
      </div>
    );
  }

  if (!funnel) return null;

  const { stages } = funnel;

  // Normalize bar widths to the largest stage (registered)
  const maxValue = Math.max(1, stages.registered);

  const stagesData = [
    {
      key: 'registered',
      label: 'Registered',
      sublabel: 'Total customer accounts',
      value: stages.registered,
      color: '#CECBF6',
      textColor: '#26215C',
      pct: 100,
    },
    {
      key: 'loyalty',
      label: 'Loyalty members',
      sublabel: 'Joined loyalty program',
      value: stages.loyalty_members,
      color: '#A8A0EE',
      textColor: '#26215C',
      pct: stages.registered > 0 ? Math.round((stages.loyalty_members / stages.registered) * 100) : 0,
    },
    {
      key: 'bought',
      label: 'Bought once',
      sublabel: 'Made at least 1 order',
      value: stages.bought_at_least_once,
      color: '#9FE1CB',
      textColor: '#04342C',
      pct: stages.registered > 0 ? Math.round((stages.bought_at_least_once / stages.registered) * 100) : 0,
    },
    {
      key: 'repeat',
      label: 'Repeat buyers',
      sublabel: 'Made 2+ orders',
      value: stages.repeat_buyers,
      color: '#5DCAA5',
      textColor: '#04342C',
      pct: stages.registered > 0 ? Math.round((stages.repeat_buyers / stages.registered) * 100) : 0,
    },
  ];

  return (
    <div style={{
      backgroundColor: 'var(--paper)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-sm)',
      padding: '20px 24px',
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-1)' }}>Loyalty conversion funnel</div>
          <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>Where customers move from sign-up to repeat purchase</div>
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 14 }}>
          <span style={{ color: 'var(--fg-3)' }}>
            Conversion <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{funnel.conversion_to_buyer_pct}%</span>
          </span>
          <span style={{ color: 'var(--fg-3)' }}>
            Welcome burnt <span style={{ fontWeight: 700, color: '#993C1D' }}>~{funnel.welcome_burnt_estimate.toLocaleString('ru-RU')}</span>
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {stagesData.map((stage) => {
          const widthPct = (stage.value / maxValue) * 100;
          return (
            <div key={stage.key} style={{ display: 'flex', alignItems: 'stretch', gap: 12 }}>
              <div style={{ minWidth: 160, paddingTop: 6 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-1)' }}>{stage.label}</div>
                <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>{stage.sublabel}</div>
              </div>
              <div style={{ flex: 1, position: 'relative' }}>
                <div style={{
                  width: `${Math.max(widthPct, 4)}%`,
                  minWidth: 100,
                  backgroundColor: stage.color,
                  padding: '12px 16px',
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  transition: 'width 300ms ease',
                }}>
                  <span style={{ fontSize: 18, fontWeight: 700, color: stage.textColor }}>
                    {stage.value.toLocaleString('ru-RU')}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: stage.textColor, opacity: 0.7 }}>
                    {stage.pct}%
                  </span>
                </div>
              </div>
            </div>
          );
        })}
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

  // Merge by date — CRM timeline drives the day list (always 30 entries),
  // Metrika visits looked up per-day. If a Metrika day is missing, treat as 0.
  const merged = (crmTimeline ?? []).map((d) => {
    const m = metrikaTimeline?.find((x) => x.date === d.date);
    return {
      date: d.date,
      visits: m?.visits ?? 0,
      registrations: d.registrations,
      orders: d.orders,
    };
  });

  if (!loading && merged.length === 0) {
    return null;
  }

  const maxVisits = Math.max(1, ...merged.map((d) => d.visits));
  const maxActivity = Math.max(1, ...merged.map((d) => Math.max(d.registrations, d.orders)));

  // SVG geometry
  const W = 600;
  const H = 140;
  const padTop = 16;
  const padBottom = 24;
  const chartH = H - padTop - padBottom;
  const days = merged.length || 30;
  const slot = W / days;
  const wideBarW = slot * 0.66;
  const narrowBarW = slot * 0.32;

  function visitsBar(value: number, idx: number) {
    const h = (value / maxVisits) * chartH;
    const x = idx * slot + (slot - wideBarW) / 2;
    const y = padTop + (chartH - h);
    return { x, y, w: wideBarW, h };
  }

  function activityBar(value: number, idx: number) {
    const h = (value / maxActivity) * chartH;
    const x = idx * slot + (slot - narrowBarW) / 2;
    const y = padTop + (chartH - h);
    return { x, y, w: narrowBarW, h };
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
  const totalRegs = merged.reduce((s, d) => s + d.registrations, 0);
  const totalOrders = merged.reduce((s, d) => s + d.orders, 0);

  const hoverDay = hoverIdx !== null ? merged[hoverIdx] : null;

  return (
    <div style={{
      backgroundColor: 'var(--paper)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-sm)',
      padding: '20px 24px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-1)' }}>Daily activity</div>
          <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>Last 30 days · hover to inspect</div>
        </div>
        {!loading && merged.length > 0 && (
          <div style={{ display: 'flex', gap: 16, fontSize: 14 }}>
            <span style={{ color: 'var(--fg-3)' }}>
              <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{totalVisits.toLocaleString('ru-RU')}</span> visits
            </span>
            <span style={{ color: 'var(--fg-3)' }}>
              <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{totalRegs.toLocaleString('ru-RU')}</span> reg
            </span>
            <span style={{ color: 'var(--fg-3)' }}>
              <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{totalOrders.toLocaleString('ru-RU')}</span> orders
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

              {/* Visits — gray, wide, behind */}
              {merged.map((d, i) => {
                const r = visitsBar(d.visits, i);
                if (r.h < 0.5) return null;
                const isHover = hoverIdx === i;
                return (
                  <rect key={`v${i}`} x={r.x} y={r.y} width={r.w} height={r.h} rx="2"
                        fill="#D3D1C7" fillOpacity={isHover ? 0.75 : 0.5} />
                );
              })}
              {/* Registrations — purple, narrow, middle */}
              {merged.map((d, i) => {
                const r = activityBar(d.registrations, i);
                if (r.h < 0.5) return null;
                const isHover = hoverIdx === i;
                return (
                  <rect key={`r${i}`} x={r.x} y={r.y} width={r.w} height={r.h} rx="2"
                        fill="#7F77DD" fillOpacity={isHover ? 0.85 : 0.55} />
                );
              })}
              {/* Orders — teal, even narrower, front */}
              {merged.map((d, i) => {
                const r = activityBar(d.orders, i);
                const w = r.w * 0.6;
                const x = r.x + (r.w - w) / 2;
                if (r.h < 0.5) return null;
                return (
                  <rect key={`o${i}`} x={x} y={r.y} width={w} height={r.h} rx="1.5"
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
                  <span style={{ width: 12, height: 10, backgroundColor: '#D3D1C7', opacity: 0.6, borderRadius: 2, display: 'inline-block' }} />
                  Visits <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{hoverDay.visits.toLocaleString('ru-RU')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
                  <span style={{ width: 10, height: 10, backgroundColor: '#7F77DD', opacity: 0.7, borderRadius: 2, display: 'inline-block' }} />
                  Registrations <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{hoverDay.registrations.toLocaleString('ru-RU')}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
                  <span style={{ width: 8, height: 10, backgroundColor: '#1D9E75', borderRadius: 2, display: 'inline-block' }} />
                  Orders <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{hoverDay.orders.toLocaleString('ru-RU')}</span>
                </div>
              </>
            ) : (
              <span style={{ color: 'var(--fg-3)' }}>Hover any day on the chart to see exact numbers</span>
            )}
          </div>

          {/* Legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12, fontSize: 14 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
              <span style={{ width: 14, height: 10, backgroundColor: '#D3D1C7', opacity: 0.5, borderRadius: 2, display: 'inline-block' }} />
              Visits (Yandex Metrika)
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
              <span style={{ width: 10, height: 10, backgroundColor: '#7F77DD', opacity: 0.55, borderRadius: 2, display: 'inline-block' }} />
              Registrations
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-3)' }}>
              <span style={{ width: 8, height: 10, backgroundColor: '#1D9E75', borderRadius: 2, display: 'inline-block' }} />
              Orders
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
    <div className="grid grid-cols-6 gap-4">
      <div className="col-span-2 p-5" style={{
        background: 'linear-gradient(135deg, var(--schwarz-ink, #1A1519), #2B2228)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--paper, #FBFAF6)',
      }}>
        <div style={{ fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase', color: '#C9A94F' }}>Sales · last 30 days</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
          <span style={{ fontFamily: "'Fraunces', serif", fontSize: 34, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmt(sales30)}</span>
          {deltaPct !== null && (
            <span style={{ fontSize: 13, fontWeight: 700, color: deltaPct < 0 ? '#FF6B6B' : '#2FB894' }}>
              {deltaPct < 0 ? '▼' : '▲'} {Math.abs(deltaPct)}%
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#8E8790', marginTop: 2 }}>
          {deltaPct !== null ? `vs ${fmt(prev30)} prior 30 days` : 'no prior-period data'}
        </div>
        {spark.length > 1 && (
          <svg viewBox="0 0 240 44" preserveAspectRatio="none" style={{ width: '100%', height: 36, marginTop: 10, display: 'block' }} aria-hidden="true">
            <polyline points={pts} fill="none" stroke="#2FB894" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
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
    <div className="p-5" style={{
      backgroundColor: 'var(--paper)',
      border: '1px solid var(--border-hairline)',
      borderTop: accent ? '2px solid var(--brand-rot, #E5202C)' : '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>{label}</div>
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 28, fontWeight: 600, color: 'var(--fg-1)', marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--fg-3)', marginTop: 4 }}>{sub}</div>}
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
      className="flex items-center gap-2 px-5 py-3"
      style={{
        fontSize: 14,
        fontWeight: 700,
        color: active ? 'var(--brand-rot)' : 'var(--fg-3)',
        backgroundColor: 'transparent',
        borderBottom: active ? '2px solid var(--brand-rot)' : '2px solid transparent',
        marginBottom: '-1px',
        cursor: 'pointer',
      }}
    >
      {icon}
      {label}
      {count !== null && (
        <span style={{
          fontSize: 14,
          fontWeight: 700,
          color: active ? 'var(--brand-rot)' : 'var(--fg-muted)',
          padding: '2px 8px',
          backgroundColor: active ? 'rgba(199, 33, 39, 0.08)' : 'var(--paper-sunk)',
          borderRadius: 'var(--radius-sm)',
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
      className="px-4 py-2"
      style={{
        textAlign: 'left',
        backgroundColor: active ? 'rgba(199, 33, 39, 0.08)' : 'var(--paper)',
        border: active ? '1px solid var(--brand-rot)' : '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: active ? 'var(--brand-rot)' : 'var(--fg-1)' }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--fg-3)' }}>{sublabel}</div>
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
        <button onClick={savePrices} disabled={saving || dirtyCount === 0} className="flex items-center gap-2 px-3 py-1.5" style={{
          fontSize: 13, fontWeight: 700,
          color: dirtyCount ? '#fff' : 'var(--fg-3)',
          backgroundColor: dirtyCount ? 'var(--brand-rot)' : 'var(--paper-sunk)',
          border: '1px solid ' + (dirtyCount ? 'var(--brand-rot)' : 'var(--border-hairline)'),
          borderRadius: 'var(--radius-sm)', cursor: (saving || !dirtyCount) ? 'default' : 'pointer',
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
      backgroundColor: 'var(--paper)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <div className="px-6 py-4 flex items-center justify-between gap-4 flex-wrap"
           style={{ borderBottom: '1px solid var(--border-hairline)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-1)' }}>
          {title}
          {totalCount > 0 && (
            <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: 8 }}>
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
                fontSize: 14, fontWeight: 700,
                color: page === 1 ? 'var(--fg-muted)' : 'var(--fg-1)',
                backgroundColor: 'var(--paper-sunk)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                cursor: page === 1 ? 'not-allowed' : 'pointer',
                opacity: page === 1 ? 0.5 : 1,
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
                fontSize: 14, fontWeight: 700,
                color: page >= totalPages ? 'var(--fg-muted)' : 'var(--fg-1)',
                backgroundColor: 'var(--paper-sunk)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                cursor: page >= totalPages ? 'not-allowed' : 'pointer',
                opacity: page >= totalPages ? 0.5 : 1,
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

function OrdersTable({ orders, hasSearch, search, sort, onSort, variant = 'ru' }: { orders: CrmOrder[]; hasSearch: boolean; search: string; sort: { key: string; dir: 'asc' | 'desc' }; onSort: (k: string) => void; variant?: CrmSource }) {
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
            <Th align="left">Payment</Th>
            <SortTh label="Date" sortKey="date" current={sort} onSort={onSort} align="left" />
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 && (
            <tr>
              <td colSpan={8} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                {hasSearch ? `No orders matching "${search}"` : 'No website orders yet'}
              </td>
            </tr>
          )}
          {orders.map((o) => (
            <tr key={`${o.order_source ?? 'website'}-${o.number}`} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
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
              <Td><OrderStatusPill financial={o.status} fulfillment={o.fulfillment_status} trackingUrl={o.tracking_url} /></Td>
              <Td muted>{(o as any).payment_method || '—'}</Td>
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
          <SortTh label="Total" sortKey="total" current={sort} onSort={onSort} />
          <SortTh label="Credited" sortKey="credited" current={sort} onSort={onSort} />
          <SortTh label="Charged" sortKey="charged" current={sort} onSort={onSort} />
          <Th align="left">Level</Th>
          <SortTh label="Balance" sortKey="balance" current={sort} onSort={onSort} />
          <Th align="left">Status</Th>
          <SortTh label="Date" sortKey="date" current={sort} onSort={onSort} align="left" />
        </tr>
      </thead>
      <tbody>
        {orders.length === 0 && (
          <tr>
            <td colSpan={9} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              {hasSearch ? `No orders matching "${search}"` : 'No orders'}
            </td>
          </tr>
        )}
        {orders.map((o) => (
          <tr key={o.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <Td bold>{o.number}</Td>
            <Td>{o.customer_name}</Td>
            <Td align="right" bold>{o.total.toLocaleString('ru-RU')} ₽</Td>
            <Td align="right" bold style={{ color: o.bonus_credited > 0 ? '#0a7a3b' : 'var(--fg-3)' }}>
              {o.bonus_credited > 0 ? `+${o.bonus_credited}` : '—'}
            </Td>
            <Td align="right" bold style={{ color: o.bonus_charged > 0 ? '#a83232' : 'var(--fg-3)' }}>
              {o.bonus_charged > 0 ? `−${o.bonus_charged}` : '—'}
            </Td>
            <Td bold style={{ color: o.loyalty_level ? 'var(--fg-1)' : 'var(--fg-3)' }}>
              {o.loyalty_level || '—'}
              {o.loyalty_privilege_pct !== null && (
                <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: 6 }}>{o.loyalty_privilege_pct}%</span>
              )}
            </Td>
            <Td align="right" bold style={{ color: o.loyalty_balance === null ? 'var(--fg-3)' : 'var(--fg-1)' }}>
              {o.loyalty_balance === null ? '—' : o.loyalty_balance.toLocaleString('ru-RU')}
            </Td>
            <Td muted>{o.status}</Td>
            <Td muted>{o.created_at}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OrderStatusPill({ financial, fulfillment, trackingUrl }: { financial: string; fulfillment?: string | null; trackingUrl?: string | null }) {
  let label = 'Paid';
  let fg = 'var(--fg-3)';
  let bg = 'var(--paper-sunk, #F1EFE8)';
  let strike = false;
  if (fulfillment === 'cancelled') { label = 'Cancelled'; strike = true; }
  else if (financial === 'refunded' || financial === 'partially_refunded') { label = 'Refunded'; fg = '#8A6D1F'; bg = '#FBF3D8'; }
  else if (financial === 'failed') { label = 'Failed'; fg = '#B22222'; bg = '#FBE6E6'; }
  else if (financial === 'pending') { label = 'Pending'; }
  else if (fulfillment === 'delivered') { label = 'Delivered'; fg = '#0E7C66'; bg = '#E1F5EE'; }
  else if (fulfillment === 'shipped') { label = 'Shipped'; fg = '#185FA5'; bg = '#E6F1FB'; }
  const pill = (
    <span style={{ fontSize: 12, fontWeight: 600, color: fg, background: bg, borderRadius: 999, padding: '3px 10px', textDecoration: strike ? 'line-through' : undefined, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
  if (label === 'Shipped' && trackingUrl) {
    return <a href={trackingUrl} target="_blank" rel="noreferrer">{pill}</a>;
  }
  return pill;
}

function CartStatusBadge({ status }: { status: CrmCart['status'] }) {
  const map: Record<CrmCart['status'], { bg: string; fg: string; label: string }> = {
    initiated: { bg: 'rgba(180,140,0,0.14)', fg: '#8a6d00', label: 'initiated' },
    converted: { bg: 'rgba(10,122,59,0.14)', fg: '#0a7a3b', label: 'converted' },
    abandoned: { bg: 'rgba(168,50,50,0.12)', fg: '#a83232', label: 'abandoned' },
    recovered: { bg: 'rgba(40,90,180,0.14)', fg: '#2a5ab4', label: 'recovered' },
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

function CustomersTable({ customers, hasSearch, search, sort, onSort, variant = 'ru' }: { customers: CrmCustomer[]; hasSearch: boolean; search: string; sort: { key: string; dir: 'asc' | 'desc' }; onSort: (k: string) => void; variant?: CrmSource }) {
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
            <tr key={cu.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
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
          <Th align="left">Email</Th>
          <Th align="left">Phone</Th>
          <SortTh label="Orders" sortKey="orders" current={sort} onSort={onSort} />
          <SortTh label="Total spent" sortKey="spent" current={sort} onSort={onSort} />
          <Th align="left">Level</Th>
          <SortTh label="Balance" sortKey="balance" current={sort} onSort={onSort} />
          <Th align="left">Registered</Th>
        </tr>
      </thead>
      <tbody>
        {customers.length === 0 && (
          <tr>
            <td colSpan={8} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              {hasSearch ? `No customers matching "${search}"` : 'No customers'}
            </td>
          </tr>
        )}
        {customers.map((cu) => (
          <tr key={cu.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <Td bold>{cu.name}</Td>
            <Td muted>{cu.email || '—'}</Td>
            <Td muted>{cu.phone || '—'}</Td>
            <Td align="right" bold>{cu.orders_count}</Td>
            <Td align="right" bold>{cu.total_spent.toLocaleString('ru-RU')} ₽</Td>
            <Td bold style={{ color: cu.loyalty_level ? 'var(--fg-1)' : 'var(--fg-3)' }}>
              {cu.loyalty_level || '—'}
              {cu.loyalty_privilege_pct !== null && (
                <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: 6 }}>{cu.loyalty_privilege_pct}%</span>
              )}
            </Td>
            <Td align="right" bold style={{ color: cu.loyalty_balance === null ? 'var(--fg-3)' : 'var(--fg-1)' }}>
              {cu.loyalty_balance === null ? '—' : cu.loyalty_balance.toLocaleString('ru-RU')}
            </Td>
            <Td muted>{cu.created_at}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={`px-6 py-3 text-${align}`} style={{ fontSize: 12, fontWeight: 400, color: '#888780', whiteSpace: 'nowrap' }}>
      {children}
    </th>
  );
}

function SortTh({ label, sortKey, current, onSort, align = 'right' }: { label: string; sortKey: string; current: { key: string; dir: 'asc' | 'desc' }; onSort: (k: string) => void; align?: 'left' | 'right' }) {
  const activeCol = current.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} className={`px-6 py-3 text-${align}`} style={{ fontSize: 12, fontWeight: activeCol ? 600 : 400, color: activeCol ? 'var(--fg-1)' : '#888780', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none' }}>
      {label}{activeCol ? (current.dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

function Td({
  children, align = 'left', bold = false, muted = false, style = {},
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  bold?: boolean;
  muted?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <td className={`px-6 py-3 text-${align}`} style={{
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
