'use client';

export const runtime = 'edge';

import { useEffect, useState, useCallback, Fragment } from 'react';
import { Loader2, RefreshCw, AlertTriangle, Globe, ChevronDown, ChevronRight } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api';
import { formatMinor } from '@/lib/money';

// ---- Types mirror the /api/website/* responses --------------------------
interface OrderLine {
  stripe_price_id: string | null;
  sku_raw: string | null;
  product_id: string | null;
  item_name: string | null;
  qty: number;
  unit_amount: number;
  line_total: number;
}
interface WebsiteOrder {
  id: string;
  number: string | null;
  created_date: number;
  status: string | null;
  payment_status: string | null;
  currency: string;
  amount_total: number;
  buyer_email: string | null;
  buyer_name: string | null;
  ship_country: string | null;
  lines: OrderLine[];
}
interface UnmatchedSku {
  sku_raw: string;
  occurrences: number;
  last_seen: number | null;
  source: string;
}
interface Health {
  configured: boolean;
  orders_watermark: number | null;
  counts: { orders: number; unmatched_order_lines: number; catalog_prices: number } | null;
  sync: {
    orders: SyncLog | null;
    catalog: SyncLog | null;
  };
}
interface SyncLog {
  kind: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  rows_synced: number | null;
  error_message: string | null;
}

function fmtDate(unix: number | null | undefined): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function Badge({ text, tone }: { text: string; tone: 'green' | 'amber' | 'gray' | 'red' }) {
  const cls = {
    green: 'bg-green-100 text-green-800',
    amber: 'bg-amber-100 text-amber-800',
    gray: 'bg-gray-100 text-gray-700',
    red: 'bg-red-100 text-red-800',
  }[tone];
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{text}</span>;
}

function paymentTone(s: string | null): 'green' | 'amber' | 'gray' {
  if (s === 'paid') return 'green';
  if (s === 'unpaid') return 'amber';
  return 'gray';
}

export default function WebsitePage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [orders, setOrders] = useState<WebsiteOrder[]>([]);
  const [unmatched, setUnmatched] = useState<UnmatchedSku[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [h, o, u] = await Promise.all([
        apiGet<Health>('/api/website/health'),
        apiGet<{ orders: WebsiteOrder[] }>('/api/website/orders?limit=50'),
        apiGet<{ unmatched: UnmatchedSku[] }>('/api/website/unmatched-skus'),
      ]);
      if (h.result) setHealth(h.result);
      if (o.result) setOrders(o.result.orders || []);
      if (u.result) setUnmatched(u.result.unmatched || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const r = await apiPost('/api/website/sync/orders', {});
      if (!r.success) {
        setError(r.errors?.[0]?.message || 'Sync failed');
      }
      await apiPost('/api/website/sync/catalog', {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, [load]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const notConfigured = health && !health.configured;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Globe className="w-6 h-6 text-gray-700" />
          <div>
            <h1 className="text-xl font-semibold">Website — dasexperten storefront</h1>
            <p className="text-sm text-gray-500">Stripe checkout orders mirrored into the ERP (Cloudflare Pages storefront).</p>
          </div>
        </div>
        <button
          onClick={syncNow}
          disabled={syncing || Boolean(notConfigured)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded bg-gray-900 text-white text-sm disabled:opacity-40"
        >
          {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Sync now
        </button>
      </div>

      {notConfigured && (
        <div className="mb-4 p-3 rounded bg-amber-50 border border-amber-200 text-amber-800 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          STRIPE_KEY is not configured on the API Worker. Set it with <code className="mx-1">wrangler secret put STRIPE_KEY</code> to enable sync.
        </div>
      )}
      {error && (
        <div className="mb-4 p-3 rounded bg-red-50 border border-red-200 text-red-800 text-sm">{error}</div>
      )}

      {/* Sync status card */}
      <div className="mb-6 grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="p-3 rounded border bg-white">
          <div className="text-xs text-gray-500">Orders mirrored</div>
          <div className="text-lg font-semibold">{health?.counts?.orders ?? '—'}</div>
        </div>
        <div className="p-3 rounded border bg-white">
          <div className="text-xs text-gray-500">Unmatched lines</div>
          <div className="text-lg font-semibold">{health?.counts?.unmatched_order_lines ?? '—'}</div>
        </div>
        <div className="p-3 rounded border bg-white">
          <div className="text-xs text-gray-500">Catalog prices</div>
          <div className="text-lg font-semibold">{health?.counts?.catalog_prices ?? '—'}</div>
        </div>
        <div className="p-3 rounded border bg-white">
          <div className="text-xs text-gray-500">Last orders sync</div>
          <div className="text-sm font-medium flex items-center gap-2">
            {health?.sync?.orders ? (
              <>
                <Badge
                  text={health.sync.orders.status}
                  tone={health.sync.orders.status === 'ok' ? 'green' : health.sync.orders.status === 'error' ? 'red' : 'gray'}
                />
                <span className="text-gray-500">{fmtDate(health.sync.orders.finished_at)}</span>
              </>
            ) : '—'}
          </div>
        </div>
      </div>
      {health?.sync?.orders?.error_message && (
        <div className="mb-4 text-xs text-red-700">Last sync error: {health.sync.orders.error_message}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-gray-500"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <>
          {/* Orders table */}
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Orders</h2>
          <div className="overflow-x-auto border rounded mb-8 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs">
                <tr>
                  <th className="text-left px-3 py-2 w-6"></th>
                  <th className="text-left px-3 py-2">Order</th>
                  <th className="text-left px-3 py-2">Date</th>
                  <th className="text-left px-3 py-2">Buyer</th>
                  <th className="text-left px-3 py-2">Ship</th>
                  <th className="text-right px-3 py-2">Total</th>
                  <th className="text-left px-3 py-2">Payment</th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No orders yet. Run a sync.</td></tr>
                )}
                {orders.map((o) => {
                  const open = expanded.has(o.id);
                  const hasUnmatched = o.lines.some((l) => !l.product_id);
                  return (
                    <Fragment key={o.id}>
                      <tr className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => toggle(o.id)}>
                        <td className="px-3 py-2 text-gray-400">
                          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{o.number || o.id.slice(0, 14)}</td>
                        <td className="px-3 py-2 text-gray-600">{fmtDate(o.created_date)}</td>
                        <td className="px-3 py-2">{o.buyer_email || o.buyer_name || '—'}</td>
                        <td className="px-3 py-2">{o.ship_country || '—'}</td>
                        <td className="px-3 py-2 text-right font-medium">{formatMinor(o.amount_total, o.currency)}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <Badge text={o.payment_status || 'unknown'} tone={paymentTone(o.payment_status)} />
                            {hasUnmatched && <Badge text="unmatched SKU" tone="red" />}
                          </div>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-gray-50/60">
                          <td></td>
                          <td colSpan={6} className="px-3 py-2">
                            <table className="w-full text-xs">
                              <thead className="text-gray-500">
                                <tr>
                                  <th className="text-left py-1">Item</th>
                                  <th className="text-left py-1">SKU</th>
                                  <th className="text-right py-1">Qty</th>
                                  <th className="text-right py-1">Unit</th>
                                  <th className="text-right py-1">Line</th>
                                </tr>
                              </thead>
                              <tbody>
                                {o.lines.map((l, i) => (
                                  <tr key={i}>
                                    <td className="py-1">{l.item_name || '—'}</td>
                                    <td className="py-1">
                                      {l.product_id
                                        ? <span className="font-mono uppercase">{l.product_id}</span>
                                        : <Badge text={l.sku_raw ? `unmatched: ${l.sku_raw}` : 'no SKU'} tone="red" />}
                                    </td>
                                    <td className="py-1 text-right">{l.qty}</td>
                                    <td className="py-1 text-right">{formatMinor(l.unit_amount, o.currency)}</td>
                                    <td className="py-1 text-right">{formatMinor(l.line_total, o.currency)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Unmatched SKUs */}
          <h2 className="text-sm font-semibold text-gray-700 mb-2">
            Unmatched SKUs {unmatched.length > 0 && <span className="text-red-600">({unmatched.length})</span>}
          </h2>
          <p className="text-xs text-gray-500 mb-2">
            SKUs charged on the storefront that have no matching product in the ERP catalog. Fix by aligning the
            Stripe price <code>metadata.sku</code> with the ERP <code>products.id</code>, or by adding the product to the ERP — the next sync re-matches automatically.
          </p>
          <div className="overflow-x-auto border rounded bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs">
                <tr>
                  <th className="text-left px-3 py-2">SKU (raw)</th>
                  <th className="text-left px-3 py-2">Source</th>
                  <th className="text-right px-3 py-2">Occurrences</th>
                  <th className="text-left px-3 py-2">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {unmatched.length === 0 && (
                  <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-400">All storefront SKUs match the ERP catalog. 🎉</td></tr>
                )}
                {unmatched.map((u) => (
                  <tr key={u.sku_raw} className="border-t">
                    <td className="px-3 py-2 font-mono">{u.sku_raw}</td>
                    <td className="px-3 py-2 text-gray-600">{u.source}</td>
                    <td className="px-3 py-2 text-right">{u.occurrences}</td>
                    <td className="px-3 py-2 text-gray-600">{fmtDate(u.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
