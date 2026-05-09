'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback } from 'react';
import {
  Loader2, RefreshCw, Headphones, AlertCircle, Search,
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
}

interface CrmCustomer {
  id: number;
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
}

interface PageMeta {
  page: number;
  limit: number;
  total_count: number;
  total_pages: number;
}

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

type TabId = 'orders' | 'customers';

export default function CrmPage() {
  const [stats, setStats] = useState<CrmStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [tab, setTab] = useState<TabId>('orders');

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

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const params = new URLSearchParams({
        page: String(ordersPage),
        limit: String(ordersLimit),
      });
      if (ordersActiveSearch) params.set('search', ordersActiveSearch);
      const res = await fetch(`${API_BASE}/api/crm/orders?${params}`);
      const data = await res.json();
      if (data.success && data.result) {
        setOrders(data.result.orders);
        setOrdersMeta(data.result.pagination);
      } else {
        setOrdersError(data.errors?.[0]?.message || 'Failed to load orders');
      }
    } catch (e) {
      setOrdersError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setOrdersLoading(false);
    }
  }, [ordersPage, ordersLimit, ordersActiveSearch]);

  const loadCustomers = useCallback(async () => {
    setCustomersLoading(true);
    setCustomersError(null);
    try {
      const params = new URLSearchParams({
        page: String(customersPage),
        limit: String(customersLimit),
      });
      if (customersActiveSearch) params.set('search', customersActiveSearch);
      const res = await fetch(`${API_BASE}/api/crm/customers?${params}`);
      const data = await res.json();
      if (data.success && data.result) {
        setCustomers(data.result.customers);
        setCustomersMeta(data.result.pagination);
      } else {
        setCustomersError(data.errors?.[0]?.message || 'Failed to load customers');
      }
    } catch (e) {
      setCustomersError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setCustomersLoading(false);
    }
  }, [customersPage, customersLimit, customersActiveSearch]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { if (tab === 'orders') loadOrders(); }, [tab, loadOrders]);
  useEffect(() => { if (tab === 'customers') loadCustomers(); }, [tab, loadCustomers]);

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

  function refreshAll() {
    loadStats();
    if (tab === 'orders') loadOrders();
    else loadCustomers();
  }

  const isLoading = statsLoading || ordersLoading || customersLoading;

  return (
    <div className="space-y-6 max-w-full">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Headphones className="h-7 w-7" style={{ color: 'var(--brand-rot)' }} />
            <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--fg-1)' }}>CRM</h1>
          </div>
          <p style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 4 }}>
            Retail CRM — customers, orders, revenue
          </p>
        </div>
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
      </div>

      {statsError && (
        <ErrorBox title="Retail CRM stats unavailable" message={statsError} />
      )}

      {/* KPI tiles */}
      {stats && (
        <div className="grid grid-cols-5 gap-4">
          <KpiTile label="Customers" value={stats.customers_total.toLocaleString('ru-RU')} />
          <KpiTile label="Loyalty members" value={stats.loyalty_members_total.toLocaleString('ru-RU')} />
          <KpiTile label="Orders (total)" value={stats.orders_total.toLocaleString('ru-RU')} />
          <KpiTile label="Orders this month" value={stats.orders_this_month.toLocaleString('ru-RU')} />
          <KpiTile label="Revenue this month" value={`${stats.revenue_this_month_rub.toLocaleString('ru-RU')} ₽`} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
        <TabButton
          active={tab === 'orders'}
          onClick={() => setTab('orders')}
          icon={<ShoppingBag className="h-4 w-4" />}
          label="Orders"
          count={stats?.orders_total ?? null}
        />
        <TabButton
          active={tab === 'customers'}
          onClick={() => setTab('customers')}
          icon={<Users className="h-4 w-4" />}
          label="Customers"
          count={stats?.customers_total ?? null}
        />
      </div>

      {/* Tab content */}
      {tab === 'orders' && (
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
          <OrdersTable orders={orders} hasSearch={!!ordersActiveSearch} search={ordersActiveSearch} />
        </DataTablePanel>
      )}

      {tab === 'customers' && (
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
          <CustomersTable customers={customers} hasSearch={!!customersActiveSearch} search={customersActiveSearch} />
        </DataTablePanel>
      )}

      {stats && (
        <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>
          Source: {stats.source} · synced {new Date(stats.synced_at * 1000).toLocaleString('ru-RU')}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Components
// ============================================================================

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-5" style={{
      backgroundColor: 'var(--paper)',
      border: '1px solid var(--border-hairline)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--fg-1)', marginTop: 8 }}>{value}</div>
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

function OrdersTable({ orders, hasSearch, search }: { orders: CrmOrder[]; hasSearch: boolean; search: string }) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <Th align="left">Order</Th>
          <Th align="left">Customer</Th>
          <Th align="right">Total</Th>
          <Th align="right">Credited</Th>
          <Th align="right">Charged</Th>
          <Th align="left">Level</Th>
          <Th align="right">Balance</Th>
          <Th align="left">Status</Th>
          <Th align="left">Date</Th>
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
            <Td align="right" bold>{o.total.toLocaleString('ru-RU')} ₽</Td>
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

function CustomersTable({ customers, hasSearch, search }: { customers: CrmCustomer[]; hasSearch: boolean; search: string }) {
  return (
    <table className="w-full">
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <Th align="left">Customer</Th>
          <Th align="left">Email</Th>
          <Th align="left">Phone</Th>
          <Th align="right">Orders</Th>
          <Th align="right">Total spent</Th>
          <Th align="left">Level</Th>
          <Th align="right">Balance</Th>
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
            <Td align="right" bold>{cu.total_spent.toLocaleString('ru-RU')} ₽</Td>
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
    <th className={`px-6 py-3 text-${align}`} style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>
      {children}
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
      fontSize: 14,
      fontWeight: bold ? 700 : 400,
      color: muted ? 'var(--fg-3)' : 'var(--fg-1)',
      ...style,
    }}>
      {children}
    </td>
  );
}
