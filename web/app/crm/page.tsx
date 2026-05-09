'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Headphones, AlertCircle } from 'lucide-react';

interface CrmStats {
  source: string;
  customers_total: number;
  orders_total: number;
  orders_this_month: number;
  revenue_this_month_rub: number;
  loyalty_members_total: number;
  recent_orders: Array<{
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
  }>;
  synced_at: number;
}

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

async function fetchCrmStats(): Promise<{ success: boolean; result: CrmStats | null; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/crm/stats`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    return data;
  } catch (e) {
    return { success: false, result: null, error: e instanceof Error ? e.message : 'Network error' };
  }
}

export default function CrmPage() {
  const [data, setData] = useState<CrmStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const res = await fetchCrmStats();
    if (res.success && res.result) {
      setData(res.result);
    } else {
      setError(res.error || 'Backend endpoint /api/crm/stats not yet wired to Retail CRM');
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6 max-w-full">
      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Headphones className="h-7 w-7" style={{ color: 'var(--brand-rot)' }} />
            <h1 style={{ fontSize: 28, fontWeight: 700, color: 'var(--fg-1)' }}>
              CRM
            </h1>
          </div>
          <p style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 4 }}>
            Retail CRM — customers, orders, revenue
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2"
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: 'var(--fg-1)',
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {loading && !data && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} />
        </div>
      )}

      {error && !loading && (
        <div
          className="flex items-start gap-3 p-4"
          style={{
            backgroundColor: 'var(--paper-sunk)',
            border: '1px solid var(--border-hairline)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--brand-rot)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg-1)' }}>
              Retail CRM not connected yet
            </div>
            <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 4 }}>
              {error}
            </div>
            <div style={{ fontSize: 14, color: 'var(--fg-3)', marginTop: 12 }}>
              To enable: backend /api/crm/stats endpoint needs to be wired to
              Retail CRM REST API v5. API key already provisioned in master
              secrets — pending shop-domain confirmation from administrator.
            </div>
          </div>
        </div>
      )}

      {data && !error && (
        <>
          <div className="grid grid-cols-5 gap-4">
            <KpiTile
              label="Customers"
              value={data.customers_total.toLocaleString('ru-RU')}
            />
            <KpiTile
              label="Loyalty members"
              value={data.loyalty_members_total.toLocaleString('ru-RU')}
            />
            <KpiTile
              label="Orders (total)"
              value={data.orders_total.toLocaleString('ru-RU')}
            />
            <KpiTile
              label="Orders this month"
              value={data.orders_this_month.toLocaleString('ru-RU')}
            />
            <KpiTile
              label="Revenue this month"
              value={`${data.revenue_this_month_rub.toLocaleString('ru-RU')} ₽`}
            />
          </div>

          <div
            style={{
              backgroundColor: 'var(--paper)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div
              className="px-6 py-4"
              style={{ borderBottom: '1px solid var(--border-hairline)' }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg-1)' }}>
                Recent orders
              </div>
            </div>
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
                  {data.recent_orders.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-6 py-8 text-center" style={{ fontSize: 14, color: 'var(--fg-3)' }}>
                        No orders to display
                      </td>
                    </tr>
                  )}
                  {data.recent_orders.map((o) => (
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
                          <span style={{ fontWeight: 400, color: 'var(--fg-3)', marginLeft: 6 }}>
                            {o.loyalty_privilege_pct}%
                          </span>
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
          </div>

          <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>
            Source: {data.source} · synced{' '}
            {new Date(data.synced_at * 1000).toLocaleString('ru-RU')}
          </div>
        </>
      )}
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="p-5"
      style={{
        backgroundColor: 'var(--paper)',
        border: '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <div style={{ fontSize: 14, color: 'var(--fg-3)' }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--fg-1)', marginTop: 8 }}>
        {value}
      </div>
    </div>
  );
}
