'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Plus, Edit3, PackagePlus } from 'lucide-react';
import {
  getWarehouse, getStocks, getStockMovements, getInventorySessions,
  type WarehouseDetail, type StockRow, type StockMovement, type InventorySession,
} from '@/lib/api';

type Tab = 'stock' | 'movements' | 'sessions';

const SESSION_STATUS_COLORS: Record<InventorySession['status'], { bg: string; fg: string; border: string }> = {
  open:      { bg: 'rgba(13,25,158,0.08)',  fg: 'var(--line-innoweiss)', border: 'rgba(13,25,158,0.3)' },
  counting:  { bg: 'rgba(199,122,0,0.08)',  fg: 'var(--status-warning)', border: 'rgba(199,122,0,0.3)' },
  committed: { bg: 'rgba(46,125,79,0.08)',  fg: 'var(--status-success)', border: 'rgba(46,125,79,0.3)' },
  cancelled: { bg: 'var(--paper-sunk)',     fg: 'var(--fg-3)',           border: 'var(--border-hairline)' },
};

function formatDate(unix: number | null | undefined): string {
  if (!unix) return '—';
  return new Date(unix * 1000).toISOString().split('T')[0]!;
}

function formatCases(onHand: number, piecesPerCase: number): string {
  if (piecesPerCase <= 1 || onHand <= 0) return '—';
  const cases = Math.floor(onHand / piecesPerCase);
  const pcs = onHand % piecesPerCase;
  if (cases === 0) return `${pcs} pcs`;
  if (pcs === 0) return `${cases} cases`;
  return `${cases} cs + ${pcs} pcs`;
}

export default function WarehouseDetailClient({ warehouseId }: { warehouseId: string }) {
  const [warehouse, setWarehouse] = useState<WarehouseDetail | null>(null);
  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [sessions, setSessions] = useState<InventorySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('stock');

  // Read ?sku=XXX from URL to highlight
  const initialSku = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('sku')?.toLowerCase() ?? null;
  }, []);

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [whRes, stocksRes, movRes, sessRes] = await Promise.all([
          getWarehouse(warehouseId),
          getStocks({ warehouse_id: warehouseId }),
          getStockMovements({ warehouse_id: warehouseId, limit: 100 }),
          getInventorySessions({ warehouse_id: warehouseId }),
        ]);
        if (whRes.success && whRes.result) {
          setWarehouse(whRes.result);
          setError(null);
        } else {
          setError(whRes.errors?.[0]?.message ?? 'Warehouse not found');
        }
        if (stocksRes.success && stocksRes.result) setStocks(stocksRes.result.stocks);
        if (movRes.success && movRes.result) setMovements(movRes.result.movements);
        if (sessRes.success && sessRes.result) setSessions(sessRes.result.sessions);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Network error');
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [warehouseId]);

  const totalOnHand = useMemo(
    () => stocks.reduce((sum, s) => sum + s.on_hand, 0),
    [stocks]
  );
  const totalSkus = stocks.length;
  const nonZeroSkus = stocks.filter((s) => s.on_hand > 0).length;

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--fg-muted)' }} /></div>;
  }

  if (error || !warehouse) {
    return (
      <div className="space-y-4 max-w-2xl">
        <Link href="/warehouses" className="text-sm inline-flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
          <ArrowLeft className="h-4 w-4" />Back to Warehouses
        </Link>
        <div className="p-4 text-sm" style={{ backgroundColor: 'rgba(229,32,44,0.05)', border: '1px solid rgba(229,32,44,0.2)', color: 'var(--brand-rot)', borderRadius: 'var(--radius-sm)' }}>
          {error ?? 'Warehouse not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-7xl">
      <Link href="/warehouses" className="text-sm inline-flex items-center gap-1" style={{ color: 'var(--fg-2)' }}>
        <ArrowLeft className="h-4 w-4" />Back to Warehouses
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="px-2 py-1" style={{ fontSize: '14px', backgroundColor: 'var(--paper-sunk)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-xs)', color: 'var(--fg-2)', fontWeight: 700 }}>
              {warehouse.code}
            </span>
            {warehouse.warehouse_type && (
              <span className="inline-block" style={{ padding: '3px 8px', fontSize: '14px', backgroundColor: 'var(--paper-sunk)', color: 'var(--fg-2)', border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-pill)' }}>
                {warehouse.warehouse_type}
              </span>
            )}
          </div>
          <h1 className="dx-product-name" style={{ fontSize: '40px', color: 'var(--fg-1)', lineHeight: 1.05 }}>
            {warehouse.name}
          </h1>
          <p className="mt-3" style={{ fontSize: 'var(--fs-body-sm)', color: 'var(--fg-2)' }}>
            {[warehouse.city, warehouse.country].filter(Boolean).join(', ') || '—'}
            {warehouse.last_counted_at && (
              <span style={{ color: 'var(--fg-3)', marginLeft: '12px' }}>
                · last counted {formatDate(warehouse.last_counted_at)}
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <ActionButton href={`/warehouses/${warehouseId}/sessions/new`} icon={<Plus className="h-3.5 w-3.5" />}>
            Start Session
          </ActionButton>
          <ActionButton href={`/warehouses/${warehouseId}/adjust`} icon={<Edit3 className="h-3.5 w-3.5" />}>
            Adjust Stock
          </ActionButton>
          <ActionButton href={`/warehouses/${warehouseId}/receipt`} icon={<PackagePlus className="h-3.5 w-3.5" />} primary>
            Receipt
          </ActionButton>
        </div>
      </div>

      <div className="dx-ribbon-rule" />

      {/* KPI summary */}
      <div className="grid grid-cols-3 gap-4">
        <KpiCard label="Total on hand" value={totalOnHand.toLocaleString('en-US')} suffix="pcs" />
        <KpiCard label="SKUs with stock" value={`${nonZeroSkus} / ${totalSkus}`} />
        <KpiCard label="Sessions" value={sessions.length.toString()} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 dx-ribbon-rule" style={{ borderBottom: '1px solid var(--border-hairline)' }}>
        <TabButton active={tab === 'stock'} onClick={() => setTab('stock')} label={`Stock (${stocks.length})`} />
        <TabButton active={tab === 'movements'} onClick={() => setTab('movements')} label={`Movements (${movements.length})`} />
        <TabButton active={tab === 'sessions'} onClick={() => setTab('sessions')} label={`Sessions (${sessions.length})`} />
      </div>

      {tab === 'stock' && <StockTab stocks={stocks} initialSku={initialSku} warehouseId={warehouseId} />}
      {tab === 'movements' && <MovementsTab movements={movements} />}
      {tab === 'sessions' && <SessionsTab sessions={sessions} />}
    </div>
  );
}

function StockTab({ stocks, initialSku, warehouseId }: { stocks: StockRow[]; initialSku: string | null; warehouseId: string }) {
  if (stocks.length === 0) {
    return (
      <div className="bg-card p-12 text-center" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', color: 'var(--fg-3)', fontSize: '14px' }}>
        No stock at this warehouse yet
      </div>
    );
  }

  return (
    <div className="bg-card overflow-hidden" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <Th>SKU</Th><Th>Product</Th><Th right>On hand</Th><Th right>Cases</Th><Th>Last movement</Th><Th>Actions</Th>
          </tr>
        </thead>
        <tbody>
          {stocks.map((s) => {
            const skuShort = s.product_id.replace('prd_', '').toUpperCase();
            const skuLower = s.product_id.replace('prd_', '').toLowerCase();
            const highlighted = initialSku && skuShort.toLowerCase() === initialSku;
            const muted = s.on_hand === 0;
            return (
              <tr key={s.id} style={{
                borderBottom: '1px solid var(--border-hairline)',
                backgroundColor: highlighted ? 'rgba(254,240,4,0.12)' : undefined,
              }}>
                <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 700, color: muted ? 'var(--fg-muted)' : 'var(--fg-1)' }}>
                  <Link href={`/products/${skuLower}`} style={{ color: 'inherit' }}>{skuShort}</Link>
                </td>
                <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 700, color: muted ? 'var(--fg-muted)' : 'var(--fg-1)' }}>
                  <Link href={`/products/${skuLower}`} style={{ color: 'inherit' }}>
                    <span className="dx-product-name">{s.product_name}</span>
                  </Link>
                </td>
                <td className="px-4 py-3 text-right" style={{ fontSize: '14px', fontWeight: 700, color: muted ? 'var(--fg-muted)' : 'var(--fg-1)' }}>
                  {s.on_hand.toLocaleString('en-US')}
                </td>
                <td className="px-4 py-3 text-right" style={{ fontSize: '14px', color: muted ? 'var(--fg-muted)' : 'var(--fg-2)' }}>
                  {formatCases(s.on_hand, s.pieces_per_case)}
                </td>
                <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
                  {formatDate(s.last_movement_at)}
                </td>
                <td className="px-4 py-3" style={{ fontSize: '14px' }}>
                  <Link href={`/warehouses/${warehouseId}/adjust?sku=${skuLower}`} style={{ color: 'var(--brand-rot)', marginRight: '12px' }}>Adjust</Link>
                  <Link href={`/warehouses/${warehouseId}/recount?sku=${skuLower}`} style={{ color: 'var(--brand-rot)' }}>Recount</Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MovementsTab({ movements }: { movements: StockMovement[] }) {
  if (movements.length === 0) {
    return (
      <div className="bg-card p-12 text-center" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', color: 'var(--fg-3)', fontSize: '14px' }}>
        No movements yet
      </div>
    );
  }
  return (
    <div className="bg-card overflow-hidden" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <Th>Date</Th><Th>SKU</Th><Th>Type</Th><Th right>Qty</Th><Th>Source</Th><Th>Reason</Th><Th right>Balance after</Th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => {
            const skuShort = m.product_id.replace('prd_', '').toUpperCase();
            const skuLower = m.product_id.replace('prd_', '').toLowerCase();
            const qtyColor = m.quantity > 0 ? 'var(--status-success)' : m.quantity < 0 ? 'var(--brand-rot)' : 'var(--fg-3)';
            return (
              <tr key={m.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{formatDate(m.performed_at)}</td>
                <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                  <Link href={`/products/${skuLower}`} style={{ color: 'inherit' }}>{skuShort}</Link>
                </td>
                <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                  {m.movement_type}
                </td>
                <td className="px-4 py-3 text-right" style={{ fontSize: '14px', fontWeight: 700, color: qtyColor }}>
                  {m.quantity > 0 ? '+' : ''}{m.quantity.toLocaleString('en-US')}
                </td>
                <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
                  {m.source}
                </td>
                <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-2)', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.reason ?? '—'}
                </td>
                <td className="px-4 py-3 text-right" style={{ fontSize: '14px', color: 'var(--fg-1)' }}>
                  {m.balance_after.toLocaleString('en-US')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTab({ sessions }: { sessions: InventorySession[] }) {
  if (sessions.length === 0) {
    return (
      <div className="bg-card p-12 text-center" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', color: 'var(--fg-3)', fontSize: '14px' }}>
        No inventory sessions yet
      </div>
    );
  }
  return (
    <div className="bg-card overflow-hidden" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
      <table className="w-full text-sm">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-hairline)' }}>
            <Th>Reference</Th><Th>Status</Th><Th>Started</Th><Th right>Lines</Th><Th right>Discrepancies</Th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => {
            const ss = SESSION_STATUS_COLORS[s.status];
            return (
              <tr key={s.id} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                <td className="px-4 py-3" style={{ fontSize: '14px', fontWeight: 700, color: 'var(--fg-1)' }}>
                  {s.reference}
                </td>
                <td className="px-4 py-3">
                  <span className="inline-block" style={{ padding: '3px 8px', fontSize: '14px', backgroundColor: ss.bg, color: ss.fg, border: `1px solid ${ss.border}`, borderRadius: 'var(--radius-pill)' }}>
                    {s.status}
                  </span>
                </td>
                <td className="px-4 py-3" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
                  {formatDate(s.started_at)}
                </td>
                <td className="px-4 py-3 text-right" style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
                  {s.total_lines}
                </td>
                <td className="px-4 py-3 text-right" style={{ fontSize: '14px', color: s.total_discrepancies > 0 ? 'var(--brand-rot)' : 'var(--fg-3)', fontWeight: s.total_discrepancies > 0 ? 700 : 400 }}>
                  {s.total_discrepancies}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function KpiCard({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="bg-card p-4" style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)' }}>
      <div className="mb-2" style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{label}</div>
      <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--fg-1)', lineHeight: 1 }}>
        {value}
        {suffix && <span style={{ fontSize: '14px', color: 'var(--fg-3)', fontWeight: 400, marginLeft: '6px' }}>{suffix}</span>}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2"
      style={{
        fontSize: '14px',
        
        backgroundColor: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid var(--brand-rot)' : '2px solid transparent',
        color: active ? 'var(--fg-1)' : 'var(--fg-3)',
        cursor: 'pointer',
        marginBottom: '-1px',
      }}
    >
      {label}
    </button>
  );
}

function ActionButton({ href, icon, children, primary = false }: {
  href: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 px-3 py-1.5"
      style={{
        backgroundColor: primary ? 'var(--brand-rot)' : 'transparent',
        color: primary ? 'var(--paper)' : 'var(--fg-1)',
        border: primary ? 'none' : '1px solid var(--border-hairline)',
        borderRadius: 'var(--radius-sm)',
        fontSize: '14px',
        fontWeight: 600,
      }}
    >
      {icon}
      {children}
    </Link>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`${right ? 'text-right' : 'text-left'} px-4 py-3`} style={{ fontSize: '14px', color: 'var(--fg-3)', backgroundColor: 'var(--paper-sunk)' }}>
      {children}
    </th>
  );
}
