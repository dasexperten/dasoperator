'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, RefreshCw, Headphones, AlertCircle, Search, ChevronLeft, ChevronRight } from 'lucide-react';

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

interface CrmOrdersResp {
  source: string;
  pagination: {
    page: number;
    limit: number;
    total_count: number;
    total_pages: number;
  };
  search: string;
  orders: CrmOrder[];
  synced_at: number;
}

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export default function CrmPage() {
  const [stats, setStats] = useState<CrmStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [orders, setOrders] = useState<CrmOrdersResp | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState('');

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const res = await fetch(`${API_BASE}/api/crm/stats`);
      const data = await res.json();
      if (data.success && data.result) {
        setStats(data.result);
      } else {
        setStatsError(data.errors?.[0]?.message || 'Failed to load');
      }
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
        page: String(page),
        limit: String(limit),
      });
      if (activeSearch) params.set('search', activeSearch);
      const res = await fetch(`${API_BASE}/api/crm/orders?${params}`);
      const data = await res.json();
      if (data.success && data.result) {
        setOrders(data.result);
      } else {
        setOrdersError(data.errors?.[0]?.message || 'Failed to load orders');
      }
    } catch (e) {
      setOrdersError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setOrdersLoading(false);
    }
  }, [page, limit, activeSearch]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadOrders(); }, [loadOrders]);

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setActiveSearch(searchInput.trim());
  }

  function clearSearch() {
    setSearchInput('');
    setActiveSearch('');
    setPage(1);
  }

  const totalPages = orders?.pagination.total_pages ?? 1;
  const totalCount = orders?.pagination.total_count ?? 0;
  const startRow = totalCount === 0 ? 0 : (page - 1) * limit + 1;
  const endRow = orders ? Math.min(page * limit, totalCount) : 0;

  return (
    <div className="space-y-6 max-w-full">
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
          onClick={() => { loadStats(); loadOrders(); }}
          disabled={statsLoading || ordersLoading}
          className="flex items-center gap-2 px-4 py-2"
          style={{
            fontSize: 14, fontWeight: 700, color: 'var(--fg-1)',
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            cursor: statsLoading || ordersLoading ? 'wait' : 'pointer',
          }}
        >
          <RefreshCw className={`h-4 w-4 ${statsLoading || ordersLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {statsError && (
        <div className="flex items-start gap-3 p-4" style={{
          backgroundColor: 'var(--paper-sunk)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 'var(--radius-sm)',
        }}>
          <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--brand-rot)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-1)' }}>
              Retail CRM stats unavailable
            </div>
            <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 4 }}>{statsError}</div>
          </div>
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-5 gap-4">
          <KpiTile label="Customers" value={stats.customers_total.toLocaleString('ru-RU')} />
          <KpiTile label="Loyalty members" value={stats.loyalty_members_total.toLocaleString('ru-RU')} />
          <KpiTile label="Orders (total)" value={stats.orders_total.toLocaleString('ru-RU')} />
          <KpiTile label="Orders this month" value={stats.orders_this_month.toLocaleString('ru-RU')} />
          <KpiTile label="Revenue this month" value={`${stats.revenue_this_month_rub.toLocaleString('ru-RU')} ₽`} />
        </div>
      )}

      <div style={{
        backgroundColor: 'var(--paper)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
      }}>
        <div className="px-6 py-4 flex items-center justify-between gap-4 flex-wrap"
             style={{ borderBottom: '1px solid var(--border-hairline)' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-1)' }}>
            Orders
            {totalCount > 0 && (
              <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: 8 }}>
                {startRow.toLocaleString('ru-RU')}–{endRow.toLocaleString('ru-RU')} of {totalCount.toLocaleString('ru-RU')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <form onSubmit={handleSearchSubmit} className="relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2"
                      style={{ color: 'var(--fg-muted)' }} />
              <input
                type="text"
                placeholder="Search customer or order #"
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
              <button onClick={clearSearch} style={{
                fontSize: 14, color: 'var(--brand-rot)', fontWeight: 700,
                cursor: 'pointer',
              }}>
                Clear
              </button>
            )}

            <select
              value={limit}
              onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}
              style={{
                fontSize: 14, fontWeight: 700,
                padding: '8px 12px',
                backgroundColor: 'var(--paper-sunk)',
                border: '1px solid var(--border-hairline)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--fg-1)',
                cursor: 'pointer',
              }}
            >
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>
        </div>

        {ordersError && (
          <div className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--brand-rot)' }}>
            {ordersError}
          </div>
        )}

        {ordersLoading && !orders && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
          </div>
        )}

        {orders && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                  <th className="px-6 py-3 text-left" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>Order</th>
                  <th className="px-6 py-3 text-left" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>Customer</th>
                  <th className="px-6 py-3 text-right" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>Total</th>
                  <th className="px-6 py-3 text-right" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>Credited</th>
                  <th className="px-6 py-3 text-right" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>Charged</th>
                  <th className="px-6 py-3 text-left" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>Level</th>
                  <th className="px-6 py-3 text-right" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>Balance</th>
                  <th className="px-6 py-3 text-left" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>Status</th>
                  <th className="px-6 py-3 text-left" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-3)' }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {orders.orders.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                      {activeSearch ? `No orders matching "${activeSearch}"` : 'No orders'}
                    </td>
                  </tr>
                )}
                {orders.orders.map((o) => (
                  <tr key={o.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                    <td className="px-6 py-3" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-1)' }}>{o.number}</td>
                    <td className="px-6 py-3" style={{ fontSize: 14, color: 'var(--fg-1)' }}>{o.customer_name}</td>
                    <td className="px-6 py-3 text-right" style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-1)' }}>
                      {o.total.toLocaleString('ru-RU')} ₽
                    </td>
                    <td className="px-6 py-3 text-right" style={{ fontSize: 14, fontWeight: 700, color: o.bonus_credited > 0 ? '#0a7a3b' : 'var(--fg-3)' }}>
                      {o.bonus_credited > 0 ? `+${o.bonus_credited}` : '—'}
                    </td>
                    <td className="px-6 py-3 text-right" style={{ fontSize: 14, fontWeight: 700, color: o.bonus_charged > 0 ? '#a83232' : 'var(--fg-3)' }}>
                      {o.bonus_charged > 0 ? `−${o.bonus_charged}` : '—'}
                    </td>
                    <td className="px-6 py-3" style={{ fontSize: 14, fontWeight: 700, color: o.loyalty_level ? 'var(--fg-1)' : 'var(--fg-3)' }}>
                      {o.loyalty_level || '—'}
                      {o.loyalty_privilege_pct !== null && (
                        <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: 6 }}>{o.loyalty_privilege_pct}%</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-right" style={{ fontSize: 14, fontWeight: 700, color: o.loyalty_balance === null ? 'var(--fg-3)' : 'var(--fg-1)' }}>
                      {o.loyalty_balance === null ? '—' : o.loyalty_balance.toLocaleString('ru-RU')}
                    </td>
                    <td className="px-6 py-3" style={{ fontSize: 14, color: 'var(--fg-3)' }}>{o.status}</td>
                    <td className="px-6 py-3" style={{ fontSize: 14, color: 'var(--fg-3)' }}>{o.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {orders && totalPages > 1 && (
          <div className="px-6 py-4 flex items-center justify-between"
               style={{ borderTop: '1px solid var(--border-hairline)' }}>
            <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>
              Page <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{page}</span> of <span style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{totalPages}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
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
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
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

      {orders && (
        <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>
          Source: {orders.source} · synced {new Date(orders.synced_at * 1000).toLocaleString('ru-RU')}
        </div>
      )}
    </div>
  );
}

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
