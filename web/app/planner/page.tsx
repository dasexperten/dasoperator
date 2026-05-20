'use client';

export const runtime = 'edge';

import { useEffect, useState } from 'react';
import { Loader2, Flame, AlertTriangle, Check, ArrowLeft, Flag, Package, Truck } from 'lucide-react';
import { apiGet } from '@/lib/api';

// =============================================================================
// Types matching the /api/planner backend
// =============================================================================
interface SummaryGroup {
  group_id: string;
  group_name: string;
  notes: string | null;
  categories: string[];
  sku_count: number;
  skus_to_order: number;
  skus_zero: number;
  skus_critical: number;
  dearth_flags: number;
  min_cover_days: number | null;
  urgency: 'critical' | 'high' | 'calm';
}

interface SummaryResponse {
  rules: {
    window_days: number;
    coverage_days: number;
    lead_time_days: number;
    excluded_warehouses: string[];
  };
  groups: SummaryGroup[];
}

interface PlannerRow {
  base_sku: string;
  product_name: string;
  category: string;
  subcategory: string | null;
  manufacturer_id: string;
  lifecycle_status: string;
  ctn_qty: number | null;
  ctn_volume_m3: number | null;
  units_60d: number;
  days_with_stock: number;
  velocity_per_day: number;
  available_stock: number;
  in_transit: number;
  cover_days: number | null;
  raw_need: number;
  moq: number;
  suggested_order: number;
  cartons: number;
  volume_m3: number;
  pallets: number;
  dearth_days: number;
  is_new_launch: boolean;
}

interface Scenario {
  mode: 'pallet' | '20ft' | '40ft';
  total_units: number;
  total_volume_m3: number;
  pallets: number;
  fill_pct: number;
  recommended: boolean;
}

interface SuggestionsResponse {
  group: { id: string; name: string; notes: string | null };
  rules: SummaryResponse['rules'];
  rows: PlannerRow[];
  scenarios: Scenario[];
  totals: {
    sku_count: number;
    skus_to_order: number;
    total_units_suggested: number;
  };
}

// =============================================================================
// Page component
// =============================================================================
export default function PlannerPage() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [detail, setDetail] = useState<SuggestionsResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Load summary on mount
  useEffect(() => {
    apiGet<SummaryResponse>('/api/planner/summary')
      .then((res) => {
        if (res.success && res.result) setSummary(res.result);
        else setError(res.errors[0]?.message ?? 'Failed to load planner summary');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Network error'))
      .finally(() => setLoading(false));
  }, []);

  // Load detail when group is selected
  useEffect(() => {
    if (!selectedGroup) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    apiGet<SuggestionsResponse>(`/api/planner/suggestions?group=${selectedGroup}`)
      .then((res) => {
        if (res.success && res.result) setDetail(res.result);
        else setError(res.errors[0]?.message ?? 'Failed to load suggestions');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Network error'))
      .finally(() => setDetailLoading(false));
  }, [selectedGroup]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-stone-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="px-4 py-3 rounded border border-red-200 bg-red-50 text-red-700" style={{ fontSize: '14px' }}>
          {error}
        </div>
      </div>
    );
  }

  // Detail view if a group is selected
  if (selectedGroup && detail) {
    return <PlannerDetail detail={detail} onBack={() => setSelectedGroup(null)} loading={detailLoading} />;
  }

  // Summary view (cards)
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 500 }}>Procurement Planner</h1>
        <p className="text-stone-500" style={{ fontSize: '14px', marginTop: '4px' }}>
          Sorted by urgency · one manufacturer per cycle ·
          window {summary?.rules.window_days}d · coverage {summary?.rules.coverage_days}d ·
          lead {summary?.rules.lead_time_days}d
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {summary?.groups.map((g) => (
          <ManufacturerCard key={g.group_id} group={g} onClick={() => setSelectedGroup(g.group_id)} />
        ))}
      </div>

      <div className="text-stone-500 text-center py-8 border border-dashed border-stone-200 rounded" style={{ fontSize: '14px' }}>
        Click a manufacturer above to see its plan.<br />
        <span className="text-stone-400" style={{ fontSize: '13px' }}>
          Red is suggested by urgency — final call is yours.
        </span>
      </div>
    </div>
  );
}

// =============================================================================
// Manufacturer card
// =============================================================================
function ManufacturerCard({ group, onClick }: { group: SummaryGroup; onClick: () => void }) {
  const isCritical = group.urgency === 'critical';
  const isHigh = group.urgency === 'high';

  const borderClass = isCritical
    ? 'border-red-500 border-2 bg-red-50'
    : isHigh
      ? 'border-amber-400 border'
      : 'border-stone-200 border opacity-90';

  const badgeColor = isCritical ? 'text-red-700' : isHigh ? 'text-amber-700' : 'text-green-700';
  const BadgeIcon = isCritical ? Flame : isHigh ? AlertTriangle : Check;
  const badgeLabel = isCritical ? 'Most urgent' : isHigh ? 'High' : 'Calm';

  return (
    <button
      onClick={onClick}
      className={`text-left rounded-lg p-5 transition hover:shadow-md ${borderClass}`}
      style={{ background: isCritical ? undefined : 'white' }}
    >
      <div className={`flex items-center gap-2 ${badgeColor}`} style={{ fontSize: '12px', fontWeight: 500, textTransform: 'uppercase' }}>
        <BadgeIcon className="w-3.5 h-3.5" />
        {badgeLabel}
      </div>

      <div style={{ fontSize: '17px', fontWeight: 500, marginTop: '6px' }}>{group.group_name}</div>
      <div className="text-stone-500" style={{ fontSize: '13px', marginTop: '2px' }}>
        {group.categories.join(' · ')}
      </div>

      <div className="mt-4 pt-4 border-t border-current border-opacity-15 grid grid-cols-3 gap-3" style={{ fontSize: '13px' }}>
        <div>
          <div className="text-stone-500">SKUs to order</div>
          <div style={{ fontSize: '18px', fontWeight: 700, marginTop: '2px' }}>{group.skus_to_order}</div>
        </div>
        <div>
          <div className="text-stone-500">Min cover</div>
          <div style={{ fontSize: '18px', fontWeight: 700, marginTop: '2px' }}>
            {group.min_cover_days === null ? '—' : `${group.min_cover_days}d`}
          </div>
        </div>
        <div>
          <div className="text-stone-500">Dearth flags</div>
          <div style={{ fontSize: '18px', fontWeight: 700, marginTop: '2px' }}>{group.dearth_flags}</div>
        </div>
      </div>
    </button>
  );
}

// =============================================================================
// Detail view: SKU table + scenarios
// =============================================================================
function PlannerDetail({
  detail,
  onBack,
  loading,
}: {
  detail: SuggestionsResponse;
  onBack: () => void;
  loading: boolean;
}) {
  return (
    <div className="p-6 space-y-5">
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-stone-600 hover:text-stone-900"
          style={{ fontSize: '14px' }}
        >
          <ArrowLeft className="w-4 h-4" /> Back to manufacturers
        </button>
        <h1 className="mt-3" style={{ fontSize: '22px', fontWeight: 500 }}>
          {detail.group.name}
        </h1>
        <p className="text-stone-500" style={{ fontSize: '14px', marginTop: '4px' }}>
          {detail.totals.skus_to_order} of {detail.totals.sku_count} SKUs to order ·
          target {detail.totals.total_units_suggested.toLocaleString()} units
        </p>
      </div>

      {loading && <Loader2 className="w-5 h-5 animate-spin text-stone-400" />}

      <ScenariosRow scenarios={detail.scenarios} />

      <SkuTable rows={detail.rows} />

      <div className="flex justify-end pt-4 border-t border-stone-200">
        <button
          disabled={detail.totals.skus_to_order === 0}
          className="px-5 py-2.5 rounded bg-stone-900 text-white disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ fontSize: '14px', fontWeight: 500 }}
          onClick={() => {
            alert(
              `Will create draft Purchase for ${detail.group.name}\n` +
              `Total: ${detail.totals.total_units_suggested.toLocaleString()} units across ${detail.totals.skus_to_order} SKUs\n\n` +
              `(Phase 9.1: actual draft creation lands next)`
            );
          }}
        >
          Create Draft Purchase
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Scenarios row
// =============================================================================
function ScenariosRow({ scenarios }: { scenarios: Scenario[] }) {
  const ICONS = { pallet: Package, '20ft': Truck, '40ft': Truck };
  const LABELS = { pallet: 'Pallet mode', '20ft': '20ft container', '40ft': '40ft container' };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {scenarios.map((s) => {
        const Icon = ICONS[s.mode];
        const isRecommended = s.recommended;
        const className = isRecommended
          ? 'border-2 border-blue-500 bg-blue-50'
          : 'border border-stone-200 bg-white';

        // Determine if this scenario is "out of bounds" (pallet > 6, 40ft when unnecessary)
        const isOutOfBounds =
          (s.mode === 'pallet' && s.pallets > 6) ||
          (s.mode === '40ft' && s.fill_pct < 60);

        return (
          <div
            key={s.mode}
            className={`rounded-lg p-4 ${className}`}
            style={{ opacity: isOutOfBounds && !isRecommended ? 0.55 : 1 }}
          >
            <div
              className={`flex items-center gap-2 ${isRecommended ? 'text-blue-700' : 'text-stone-500'}`}
              style={{ fontSize: '12px', fontWeight: 500, textTransform: 'uppercase' }}
            >
              <Icon className="w-3.5 h-3.5" />
              {LABELS[s.mode]}
              {isRecommended && <span className="ml-1">★</span>}
            </div>
            <div className="mt-2" style={{ fontSize: '14px', fontWeight: 500 }}>
              {s.total_units.toLocaleString()} units · {s.total_volume_m3.toFixed(1)} m³
            </div>
            <div className="text-stone-500" style={{ fontSize: '12px', marginTop: '2px' }}>
              {s.mode === 'pallet'
                ? `${s.pallets} pallets` + (s.pallets > 6 ? ' · over limit (max 6)' : '')
                : `${s.fill_pct}% filled`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =============================================================================
// SKU table
// =============================================================================
function SkuTable({ rows }: { rows: PlannerRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-stone-500 text-center py-8 border border-dashed border-stone-200 rounded" style={{ fontSize: '14px' }}>
        No SKUs in this manufacturer group.
      </div>
    );
  }

  return (
    <div className="border border-stone-200 rounded-lg overflow-hidden">
      <table className="w-full" style={{ fontSize: '14px' }}>
        <thead>
          <tr className="border-b border-stone-200 bg-stone-50 text-stone-500" style={{ fontSize: '12px' }}>
            <th className="text-left px-3 py-2.5">SKU</th>
            <th className="text-left px-3 py-2.5">Product</th>
            <th className="text-right px-3 py-2.5">Sales/day</th>
            <th className="text-right px-3 py-2.5">Stock</th>
            <th className="text-right px-3 py-2.5">In transit</th>
            <th className="text-right px-3 py-2.5">Cover</th>
            <th className="text-right px-3 py-2.5">Order</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isZero = r.available_stock === 0 && !r.is_new_launch && r.velocity_per_day > 0;
            const coverColor =
              r.cover_days === null
                ? 'text-stone-400'
                : r.cover_days <= 30
                  ? 'text-red-600'
                  : r.cover_days <= 90
                    ? 'text-amber-600'
                    : 'text-green-600';

            return (
              <tr
                key={r.base_sku}
                className="border-b border-stone-100 last:border-0"
                style={{ background: r.suggested_order > 0 ? '#FFFBEB' : undefined }}
              >
                <td className="px-3 py-2.5 align-top" style={{ fontWeight: 700 }}>{r.base_sku.toUpperCase()}</td>
                <td className="px-3 py-2.5 align-top">
                  <div style={{ fontWeight: 700 }}>{r.product_name}</div>
                  <div className="flex flex-wrap items-center gap-2 mt-0.5" style={{ fontSize: '11px' }}>
                    {r.is_new_launch && (
                      <span className="text-blue-600">new launch · manual qty</span>
                    )}
                    {r.dearth_days > 0 && r.velocity_per_day > 0 && (
                      <span className="text-red-600 flex items-center gap-1">
                        <Flag className="w-3 h-3" /> {r.dearth_days}d zero
                      </span>
                    )}
                    {isZero && (
                      <span className="text-red-600">⚠ stockout</span>
                    )}
                  </div>
                  <div className="mt-1.5 text-stone-500" style={{ fontSize: '11.5px', lineHeight: 1.5 }}>
                    {!r.is_new_launch && (
                      <>60d sales: <b className="text-stone-700">{r.units_60d.toLocaleString()}</b>
                      {r.dearth_days > 0 && <> ({r.days_with_stock}d w/ stock)</>} · </>
                    )}
                    MOQ <b className="text-stone-700">{r.moq.toLocaleString()}</b>
                    {!r.is_new_launch && <> · raw need <b className="text-stone-700">{r.raw_need.toLocaleString()}</b></>}
                    {r.ctn_qty && r.ctn_qty > 0 && (
                      <> · ctn <b className="text-stone-700">{r.ctn_qty}</b> ({(r.ctn_volume_m3 ?? 0).toFixed(3)} m³)</>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right align-top" style={{ fontWeight: 700 }}>
                  {r.is_new_launch ? '—' : r.velocity_per_day.toFixed(1)}
                </td>
                <td className="px-3 py-2.5 text-right align-top" style={{ fontWeight: 700 }}>
                  {r.available_stock.toLocaleString()}
                </td>
                <td className="px-3 py-2.5 text-right align-top" style={{ fontWeight: 700 }}>
                  {r.in_transit > 0 ? r.in_transit.toLocaleString() : '—'}
                </td>
                <td className={`px-3 py-2.5 text-right align-top ${coverColor}`} style={{ fontWeight: 700 }}>
                  {r.cover_days === null ? '—' : `${r.cover_days}d`}
                </td>
                <td className="px-3 py-2.5 text-right align-top">
                  {r.suggested_order > 0 ? (
                    <>
                      <div style={{ fontWeight: 700 }}>{r.suggested_order.toLocaleString()}</div>
                      <div className="text-stone-500" style={{ fontSize: '11.5px', marginTop: '2px' }}>
                        {r.cartons} ctn · {r.volume_m3.toFixed(2)} m³ · {r.pallets} pal
                      </div>
                    </>
                  ) : (
                    <span style={{ fontWeight: 700 }}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
