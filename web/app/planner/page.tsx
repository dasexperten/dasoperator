'use client';

export const runtime = 'edge';

import { useEffect, useState, useMemo } from 'react';
import { Loader2, Flame, AlertTriangle, Check, Flag, Lock } from 'lucide-react';
import { apiGet } from '@/lib/api';

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
  rules: { window_days: number; coverage_days: number; lead_time_days: number; excluded_warehouses: string[] };
  groups: SummaryGroup[];
}

interface PlannerRow {
  base_sku: string;
  product_name: string;
  category: string;
  subcategory: string | null;
  manufacturer_id: string;
  lifecycle_status: string;
  bundle_size: number;
  base_sku_link: string | null;
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
  unit_price: number | null;
  amount: number | null;
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
  rules: { window_days: number; coverage_days: number; lead_time_days: number; stock_zone: 'russia' | 'worldwide'; currency: 'cny' | 'usd' };
  rows: PlannerRow[];
  scenarios: Scenario[];
  totals: { sku_count: number; skus_to_order: number; total_units_suggested: number };
}

function currencySymbol(c: 'cny' | 'usd'): string {
  return c === 'cny' ? '¥' : '$';
}

function fmtMoney(amount: number | null, currency: 'cny' | 'usd'): string {
  if (amount === null) return '—';
  return `${currencySymbol(currency)}${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const PALLET_VOLUME_M3 = 1.44;
const C20_VOLUME_M3 = 28;
const C40_VOLUME_M3 = 56;
const DEFAULT_PALLETS = 6;

type SizingMode = 'pallet' | '20ft' | '40ft';

// ============================================================
// AUTO FILL ALGORITHM
// Greedy by score = vel^1.5 / cover_after, respecting manual locks.
// For container modes: cap relaxes in tiers until container fills.
// (Container fill is PRIORITY — cap is a soft preference, not a wall.)
// Pallets mode: single strict cap 180d (user picks volume = picks demand).
// ============================================================
function autoFillCartons(
  rows: PlannerRow[],
  targetVolumeM3: number,
  mode: SizingMode,
  manualOverrides: Record<string, number>,
): Record<string, number> {
  // Tier ladder per mode. Pallets = one strict tier. Containers = progressive relaxation.
  const TIERS = mode === 'pallet' ? [180] : mode === '20ft' ? [365, 545, 730, 910, 1095] : [540, 730, 910, 1095, 1280];

  const overrides: Record<string, number> = {};
  for (const r of rows) overrides[r.base_sku] = 0;

  // Manual entries reserve their volume up front.
  let manualVol = 0;
  for (const r of rows) {
    if (Object.prototype.hasOwnProperty.call(manualOverrides, r.base_sku)) {
      manualVol += (manualOverrides[r.base_sku] ?? 0) * (r.ctn_volume_m3 ?? 0);
    }
  }

  function coverAfter(r: PlannerRow, cartons: number): number {
    if (r.velocity_per_day <= 0) return Infinity;
    const newUnits = cartons * (r.ctn_qty ?? 0);
    const total = r.available_stock + newUnits;
    return total / r.velocity_per_day;
  }

  let freeVol = targetVolumeM3 - manualVol;

  for (const cap of TIERS) {
    let safety = 0;
    while (freeVol > 0.001 && safety < 100000) {
      let bestRow: PlannerRow | null = null;
      let bestAddCartons = 0;
      let bestAddVol = 0;
      let bestScore = -1;

      for (const r of rows) {
        if (Object.prototype.hasOwnProperty.call(manualOverrides, r.base_sku)) continue;
        if (r.velocity_per_day <= 0) continue;
        if (r.is_new_launch) continue;
        if (r.lifecycle_status !== 'active') continue;
        const ctnVol = r.ctn_volume_m3 ?? 0;
        if (ctnVol <= 0) continue;

        const cur = overrides[r.base_sku] ?? 0;
        const addCartons = cur === 0 ? Math.ceil(r.moq / (r.ctn_qty ?? 1)) : 1;
        const addVol = addCartons * ctnVol;
        if (addVol > freeVol) continue;

        const newCov = coverAfter(r, cur + addCartons);
        if (newCov > cap) continue;

        const cov = Math.max(1, newCov);
        const score = Math.pow(r.velocity_per_day, 1.5) / cov;

        if (score > bestScore) {
          bestScore = score;
          bestRow = r;
          bestAddCartons = addCartons;
          bestAddVol = addVol;
        }
      }

      if (bestRow === null) break;
      overrides[bestRow.base_sku] = (overrides[bestRow.base_sku] ?? 0) + bestAddCartons;
      freeVol -= bestAddVol;
      safety++;
    }
    if (freeVol < 0.001) break;
  }

  return overrides;
}

// ============================================================
// MAIN PAGE — single screen, manufacturer pills + plan inline
// ============================================================
export default function PlannerPage() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [stockZone, setStockZone] = useState<'russia' | 'worldwide'>('russia');
  const [currency, setCurrency] = useState<'cny' | 'usd'>('cny');

  const [detail, setDetail] = useState<SuggestionsResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Auto cartons (algorithm output) — only for unlocked SKUs
  const [autoOverrides, setAutoOverrides] = useState<Record<string, number>>({});
  // Manual cartons (user-typed, locked) — algorithm never touches these
  const [manualOverrides, setManualOverrides] = useState<Record<string, number>>({});

  const [mode, setMode] = useState<SizingMode>('pallet');
  const [palletCount, setPalletCount] = useState<number>(DEFAULT_PALLETS);

  // Load summary on mount
  useEffect(() => {
    apiGet<SummaryResponse>('/api/planner/summary')
      .then((res) => {
        if (res.success && res.result) {
          setSummary(res.result);
          // Auto-select first (most urgent) group
          if (res.result.groups.length > 0 && !selectedGroup) {
            setSelectedGroup(res.result.groups[0].group_id);
          }
        } else {
          setError(res.errors[0]?.message ?? 'Failed to load planner summary');
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Network error'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load detail when group / stockZone / currency changes
  useEffect(() => {
    if (!selectedGroup) {
      setDetail(null);
      setAutoOverrides({});
      setManualOverrides({});
      return;
    }
    setDetailLoading(true);
    apiGet<SuggestionsResponse>(
      `/api/planner/suggestions?group=${selectedGroup}&stock_zone=${stockZone}&currency=${currency}`
    )
      .then((res) => {
        if (res.success && res.result) {
          setDetail(res.result);
          // Reset all overrides on group/zone change — fresh plan
          setManualOverrides({});
          const target = mode === '20ft' ? C20_VOLUME_M3 : mode === '40ft' ? C40_VOLUME_M3 : palletCount * PALLET_VOLUME_M3;
          setAutoOverrides(autoFillCartons(res.result.rows, target, mode, {}));
        } else {
          setError(res.errors[0]?.message ?? 'Failed to load suggestions');
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Network error'))
      .finally(() => setDetailLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup, stockZone, currency]);

  function getTargetVolume(m: SizingMode, p: number): number {
    if (m === '20ft') return C20_VOLUME_M3;
    if (m === '40ft') return C40_VOLUME_M3;
    return p * PALLET_VOLUME_M3;
  }

  // Recompute auto when mode / pallet count changes
  function handleModeChange(m: SizingMode) {
    setMode(m);
    if (detail) {
      const target = getTargetVolume(m, palletCount);
      setAutoOverrides(autoFillCartons(detail.rows, target, m, manualOverrides));
    }
  }
  function handlePalletCountChange(n: number) {
    setPalletCount(n);
    if (detail && n > 0) {
      setAutoOverrides(autoFillCartons(detail.rows, n * PALLET_VOLUME_M3, 'pallet', manualOverrides));
    }
  }

  // User types in a Cartons cell → lock that SKU
  function handleManualEdit(baseSku: string, value: number) {
    const newManual = { ...manualOverrides, [baseSku]: value };
    setManualOverrides(newManual);
    if (detail) {
      const target = getTargetVolume(mode, palletCount);
      setAutoOverrides(autoFillCartons(detail.rows, target, mode, newManual));
    }
  }

  // Unlock a specific SKU — algorithm takes back over
  function handleUnlock(baseSku: string) {
    const newManual = { ...manualOverrides };
    delete newManual[baseSku];
    setManualOverrides(newManual);
    if (detail) {
      const target = getTargetVolume(mode, palletCount);
      setAutoOverrides(autoFillCartons(detail.rows, target, mode, newManual));
    }
  }

  // Reset all manual locks
  function handleResetAll() {
    setManualOverrides({});
    if (detail) {
      const target = getTargetVolume(mode, palletCount);
      setAutoOverrides(autoFillCartons(detail.rows, target, mode, {}));
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>;
  }
  if (error) {
    return <div className="p-6"><div className="px-4 py-3 rounded border border-red-200 bg-red-50 text-red-700" style={{ fontSize: '14px' }}>{error}</div></div>;
  }

  // Compute totals using final values (manual overrides take precedence)
  function finalCartons(r: PlannerRow): number {
    if (Object.prototype.hasOwnProperty.call(manualOverrides, r.base_sku)) {
      return Math.max(0, manualOverrides[r.base_sku] ?? 0);
    }
    if (Object.prototype.hasOwnProperty.call(autoOverrides, r.base_sku)) {
      return Math.max(0, autoOverrides[r.base_sku] ?? 0);
    }
    return 0;
  }
  function finalUnits(r: PlannerRow): number { return finalCartons(r) * (r.ctn_qty ?? 0); }
  function finalVolume(r: PlannerRow): number { return finalCartons(r) * (r.ctn_volume_m3 ?? 0); }
  function finalPallets(r: PlannerRow): number { return finalVolume(r) / PALLET_VOLUME_M3; }
  function finalAmount(r: PlannerRow): number | null {
    const u = finalUnits(r);
    if (u === 0 || r.unit_price === null) return null;
    return Math.round(r.unit_price * u * 100) / 100;
  }

  let totUnits = 0, totCartons = 0, totVolume = 0, totPallets = 0, totAmount = 0;
  let anyAmount = false;
  let manualVolume = 0;
  if (detail) {
    for (const r of detail.rows) {
      const c = finalCartons(r);
      if (c <= 0) continue;
      totCartons += c; totUnits += finalUnits(r); totVolume += finalVolume(r); totPallets += finalPallets(r);
      const amt = finalAmount(r);
      if (amt !== null) { totAmount += amt; anyAmount = true; }
      if (Object.prototype.hasOwnProperty.call(manualOverrides, r.base_sku)) {
        manualVolume += finalVolume(r);
      }
    }
  }
  totVolume = Math.round(totVolume * 100) / 100;
  totPallets = Math.round(totPallets * 100) / 100;
  totAmount = Math.round(totAmount * 100) / 100;

  const targetVol = getTargetVolume(mode, palletCount);
  const manualExceedsTarget = manualVolume > targetVol + 0.01;
  const hasManualEntries = Object.keys(manualOverrides).length > 0;

  return (
    <div className="p-6 space-y-5">
      {/* HEADER */}
      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 500 }}>Procurement Planner</h1>
        <p className="text-stone-500" style={{ fontSize: '14px', marginTop: '4px' }}>
          Sorted by urgency · one manufacturer per cycle · window {summary?.rules.window_days}d · coverage {summary?.rules.coverage_days}d · lead {summary?.rules.lead_time_days}d
        </p>
      </div>

      {/* MANUFACTURER PILLS */}
      <div className="flex gap-2 flex-wrap">
        {summary?.groups.map((g) => (
          <ManufacturerPill
            key={g.group_id}
            group={g}
            selected={g.group_id === selectedGroup}
            onClick={() => setSelectedGroup(g.group_id)}
          />
        ))}
      </div>

      {/* DETAIL CONTENT */}
      {selectedGroup && detail ? (
        <>
          {/* Info strip — totals + toggles */}
          <div className="flex items-center justify-between flex-wrap gap-3" style={{ background: '#FAFAF7', padding: '12px 16px', borderRadius: 8 }}>
            <div style={{ fontSize: '14px' }}>
              <span style={{ fontWeight: 700 }}>{totCartons} cartons</span>
              <span className="text-stone-400 mx-2">·</span>
              <span className="text-stone-600">{totUnits.toLocaleString()} units</span>
              <span className="text-stone-400 mx-2">·</span>
              <span className="text-stone-600">{totVolume.toFixed(2)} m³</span>
              <span className="text-stone-400 mx-2">·</span>
              <span className="text-stone-600">{totPallets.toFixed(1)} pallets</span>
            </div>
            <div className="flex items-center gap-4" style={{ fontSize: '13px' }}>
              <div className="flex items-center gap-2">
                <span className="text-stone-500">Stock:</span>
                <ToggleGroup value={stockZone} options={[{ id: 'russia', label: 'Russia' }, { id: 'worldwide', label: 'Worldwide' }]} onChange={(v) => setStockZone(v as 'russia' | 'worldwide')} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-stone-500">Price:</span>
                <ToggleGroup value={currency} options={[{ id: 'cny', label: 'CNY' }, { id: 'usd', label: 'USD' }]} onChange={(v) => setCurrency(v as 'cny' | 'usd')} disabledIds={['usd']} />
              </div>
              {detailLoading && <Loader2 className="w-4 h-4 animate-spin text-stone-400" />}
            </div>
          </div>

          {/* Manual override warning bar */}
          {manualExceedsTarget && (
            <div className="flex items-center gap-3 px-4 py-3 rounded" style={{ background: '#FCEBEB', border: '0.5px solid #F09595', fontSize: '13px', color: '#791F1F' }}>
              <span style={{ fontSize: 16 }}>⚠</span>
              <span><b>Manual entries take {manualVolume.toFixed(2)} m³</b> — exceeds {mode === 'pallet' ? `${palletCount} pallets (${targetVol.toFixed(2)} m³)` : `${mode} (${targetVol} m³)`}. Raise target or unlock entries to rebalance.</span>
            </div>
          )}

          {/* Manual locks banner with reset button */}
          {hasManualEntries && !manualExceedsTarget && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded" style={{ background: '#FAEEDA', fontSize: '13px', color: '#854F0B' }}>
              <span><b>{Object.keys(manualOverrides).length} manual {Object.keys(manualOverrides).length === 1 ? 'entry' : 'entries'} locked.</b> Algorithm rebalances unlocked SKUs.</span>
              <button onClick={handleResetAll} style={{ fontSize: 12, padding: '4px 10px', background: 'white', border: '0.5px solid #BA7517', borderRadius: 4, color: '#854F0B', fontWeight: 500, cursor: 'pointer' }}>
                Reset all to auto
              </button>
            </div>
          )}

          {/* Sizing buttons */}
          <SizingButtons
            mode={mode}
            palletCount={palletCount}
            onModeChange={handleModeChange}
            onPalletCountChange={handlePalletCountChange}
          />

          {/* Table */}
          <SkuTable
            rows={detail.rows}
            currency={currency}
            manualOverrides={manualOverrides}
            onManualEdit={handleManualEdit}
            onUnlock={handleUnlock}
            finalCartons={finalCartons}
            finalUnits={finalUnits}
            finalVolume={finalVolume}
            finalPallets={finalPallets}
            finalAmount={finalAmount}
            totals={{ cartons: totCartons, units: totUnits, volume: totVolume, pallets: totPallets, amount: anyAmount ? totAmount : null }}
          />

          {/* Create Draft Purchase */}
          <div className="flex justify-end pt-4 border-t border-stone-200">
            <button
              disabled={totCartons === 0}
              className="px-5 py-2.5 rounded bg-stone-900 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ fontSize: '14px', fontWeight: 500 }}
              onClick={() => {
                alert(`Will create draft Purchase for ${detail.group.name}\nTotal: ${totCartons} cartons · ${totUnits.toLocaleString()} units · ${fmtMoney(totAmount, currency)}\n\n(Actual draft creation lands next phase)`);
              }}
            >
              Create Draft Purchase
            </button>
          </div>
        </>
      ) : (
        <div className="text-stone-500 text-center py-12 border border-dashed border-stone-200 rounded" style={{ fontSize: '14px' }}>
          Click a manufacturer above to see its plan.
        </div>
      )}
    </div>
  );
}

// ============================================================
// MANUFACTURER PILL
// ============================================================
function ManufacturerPill({ group, selected, onClick }: { group: SummaryGroup; selected: boolean; onClick: () => void }) {
  const isCritical = group.urgency === 'critical';
  const isHigh = group.urgency === 'high';
  const dotColor = isCritical ? '#A32D2D' : isHigh ? '#BA7517' : '#639922';
  const badgeBg = isCritical ? '#FCEBEB' : isHigh ? '#FAEEDA' : '#EAF3DE';
  const badgeColor = isCritical ? '#791F1F' : isHigh ? '#854F0B' : '#27500A';
  const badgeLabel = isCritical ? 'MOST URGENT' : isHigh ? 'HIGH' : 'CALM';

  return (
    <button
      onClick={onClick}
      style={{
        padding: '10px 16px',
        border: selected ? '2px solid #185FA5' : '0.5px solid #d6d3d1',
        background: selected ? '#E6F1FB' : 'white',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: selected ? '#0C447C' : '#1c1c1c' }}>{group.group_name}</div>
        <div style={{ fontSize: 11, color: selected ? '#185FA5' : '#78716c', marginTop: 2 }}>
          {group.skus_to_order} to order · min cover {group.min_cover_days === null ? '—' : `${group.min_cover_days}d`} · {group.dearth_flags} dearth
        </div>
      </div>
      <div style={{ fontSize: 10, color: badgeColor, background: badgeBg, padding: '2px 8px', borderRadius: 4, fontWeight: 500, marginLeft: 4, letterSpacing: '0.3px' }}>
        {badgeLabel}
      </div>
    </button>
  );
}

// ============================================================
// TOGGLE GROUP
// ============================================================
function ToggleGroup({ value, options, onChange, disabledIds }: { value: string; options: Array<{ id: string; label: string }>; onChange: (v: string) => void; disabledIds?: string[] }) {
  return (
    <div className="inline-flex border border-stone-300 rounded-md overflow-hidden">
      {options.map((opt, i) => {
        const active = opt.id === value;
        const disabled = disabledIds?.includes(opt.id);
        return (
          <button
            key={opt.id}
            onClick={() => { if (!disabled) onChange(opt.id); }}
            disabled={disabled}
            title={disabled ? 'Not available yet — purchase price list not loaded' : undefined}
            className={active ? 'bg-stone-900 text-white' : 'bg-transparent text-stone-600'}
            style={{
              padding: '5px 12px',
              fontSize: '13px',
              fontWeight: active ? 500 : 400,
              borderLeft: i > 0 ? '0.5px solid #d6d3d1' : undefined,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.4 : 1,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// SIZING BUTTONS
// ============================================================
function SizingButtons({
  mode, palletCount, onModeChange, onPalletCountChange,
}: {
  mode: SizingMode;
  palletCount: number;
  onModeChange: (mode: SizingMode) => void;
  onPalletCountChange: (n: number) => void;
}) {
  const palletSelected = mode === 'pallet';
  const c20Selected = mode === '20ft';
  const c40Selected = mode === '40ft';

  const pSub = `${(palletCount * PALLET_VOLUME_M3).toFixed(2)} m³ · within max 6`;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {/* PALLETS */}
      <button
        type="button"
        onClick={() => onModeChange('pallet')}
        className="rounded-lg transition text-left"
        style={{
          padding: '14px 16px',
          minHeight: 110,
          border: palletSelected ? '2px solid #185FA5' : '0.5px solid #d6d3d1',
          background: palletSelected ? '#E6F1FB' : 'white',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', top: 8, right: 12, fontSize: 10, color: '#0C447C', fontWeight: 500, letterSpacing: '0.3px', display: palletSelected ? 'block' : 'none' }}>
          SELECTED ★
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="number"
            min={1}
            max={99}
            value={palletCount}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              onPalletCountChange(isNaN(v) ? 0 : v);
              onModeChange('pallet');
            }}
            style={{
              width: 64,
              height: 52,
              fontSize: 36,
              fontWeight: 500,
              textAlign: 'center',
              border: '0.5px solid ' + (palletSelected ? '#185FA5' : '#a8a29e'),
              borderRadius: 6,
              background: 'white',
              color: palletSelected ? '#0C447C' : '#57534e',
              padding: 0,
              lineHeight: 1,
            }}
          />
          <div style={{ fontSize: 14, fontWeight: 500, color: palletSelected ? '#0C447C' : '#57534e', letterSpacing: '0.3px' }}>
            PALLETS
          </div>
        </div>
        <div style={{ fontSize: 11, color: palletSelected ? '#185FA5' : '#78716c', marginTop: 6 }}>
          {pSub}
        </div>
      </button>

      {/* 20ft */}
      <button
        type="button"
        onClick={() => onModeChange('20ft')}
        className="rounded-lg transition"
        style={{
          padding: '14px 16px',
          minHeight: 110,
          border: c20Selected ? '2px solid #185FA5' : '0.5px solid #d6d3d1',
          background: c20Selected ? '#E6F1FB' : 'white',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', top: 8, right: 12, fontSize: 10, color: '#0C447C', fontWeight: 500, letterSpacing: '0.3px', display: c20Selected ? 'block' : 'none' }}>
          SELECTED ★
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: c20Selected ? '#0C447C' : '#57534e', letterSpacing: '0.3px' }}>
          20FT CONTAINER
        </div>
        <div style={{ fontSize: 11, color: c20Selected ? '#185FA5' : '#78716c', marginTop: 8 }}>
          28 m³ capacity
        </div>
      </button>

      {/* 40ft */}
      <button
        type="button"
        onClick={() => onModeChange('40ft')}
        className="rounded-lg transition"
        style={{
          padding: '14px 16px',
          minHeight: 110,
          border: c40Selected ? '2px solid #185FA5' : '0.5px solid #d6d3d1',
          background: c40Selected ? '#E6F1FB' : 'white',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          position: 'relative',
        }}
      >
        <div style={{ position: 'absolute', top: 8, right: 12, fontSize: 10, color: '#0C447C', fontWeight: 500, letterSpacing: '0.3px', display: c40Selected ? 'block' : 'none' }}>
          SELECTED ★
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: c40Selected ? '#0C447C' : '#57534e', letterSpacing: '0.3px' }}>
          40FT CONTAINER
        </div>
        <div style={{ fontSize: 11, color: c40Selected ? '#185FA5' : '#78716c', marginTop: 8 }}>
          56 m³ capacity
        </div>
      </button>
    </div>
  );
}

// ============================================================
// SKU TABLE
// ============================================================
function SkuTable({
  rows, currency, manualOverrides, onManualEdit, onUnlock,
  finalCartons, finalUnits, finalVolume, finalPallets, finalAmount, totals,
}: {
  rows: PlannerRow[]; currency: 'cny' | 'usd';
  manualOverrides: Record<string, number>;
  onManualEdit: (sku: string, value: number) => void;
  onUnlock: (sku: string) => void;
  finalCartons: (r: PlannerRow) => number;
  finalUnits: (r: PlannerRow) => number;
  finalVolume: (r: PlannerRow) => number;
  finalPallets: (r: PlannerRow) => number;
  finalAmount: (r: PlannerRow) => number | null;
  totals: { cartons: number; units: number; volume: number; pallets: number; amount: number | null };
}) {
  type SortKey = 'sku' | 'sales' | 'ends' | 'cartons';
  type SortDir = 'asc' | 'desc';
  const defaultDirs: Record<SortKey, SortDir> = { sku: 'asc', sales: 'desc', ends: 'asc', cartons: 'desc' };
  const [sortKey, setSortKey] = useState<SortKey>('cartons');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  function clickHeader(k: SortKey) {
    if (sortKey === k) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(k);
      setSortDir(defaultDirs[k]);
    }
  }

  const sortedRows = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      let av: number | string = 0, bv: number | string = 0;
      if (sortKey === 'sku') { av = a.base_sku; bv = b.base_sku; }
      else if (sortKey === 'sales') { av = a.velocity_per_day; bv = b.velocity_per_day; }
      else if (sortKey === 'ends') {
        const ac = a.cover_days; const bc = b.cover_days;
        if (ac === null && bc === null) return 0;
        if (ac === null) return 1;
        if (bc === null) return -1;
        av = ac; bv = bc;
      }
      else if (sortKey === 'cartons') { av = finalCartons(a); bv = finalCartons(b); }
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    return out;
  }, [rows, sortKey, sortDir, finalCartons]);

  function SortArrow({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span style={{ color: '#cbd5e1', marginLeft: 4 }}>↕</span>;
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  if (rows.length === 0) {
    return (
      <div className="text-stone-500 text-center py-8 border border-dashed border-stone-200 rounded" style={{ fontSize: '14px' }}>
        No SKUs in this manufacturer group.
      </div>
    );
  }

  return (
    <div className="border border-stone-200 rounded-lg overflow-hidden">
      <table className="w-full" style={{ fontSize: '13.5px' }}>
        <thead>
          <tr className="border-b border-stone-200 bg-stone-50 text-stone-500" style={{ fontSize: '11.5px' }}>
            <th className="text-left px-3 py-2 cursor-pointer select-none" onClick={() => clickHeader('sku')}>
              SKU<SortArrow k="sku" />
            </th>
            <th className="text-left px-3 py-2">Product</th>
            <th className="text-right px-3 py-2 cursor-pointer select-none" onClick={() => clickHeader('sales')}>
              Sales/day<SortArrow k="sales" />
            </th>
            <th className="text-right px-3 py-2">Stock</th>
            <th className="text-right px-3 py-2 cursor-pointer select-none" onClick={() => clickHeader('ends')}>
              Ends in<SortArrow k="ends" />
            </th>
            <th className="text-right px-3 py-2 cursor-pointer select-none" onClick={() => clickHeader('cartons')}>
              Cartons<SortArrow k="cartons" />
            </th>
            <th className="text-right px-3 py-2">Units</th>
            <th className="text-right px-3 py-2">Volume</th>
            <th className="text-right px-3 py-2">Pallets</th>
            <th className="text-right px-3 py-2">Amount</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r, idx) => {
            const cartons = finalCartons(r);
            const units = finalUnits(r);
            const volume = finalVolume(r);
            const pallets = finalPallets(r);
            const amount = finalAmount(r);
            const isStockout = r.available_stock === 0 && !r.is_new_launch && r.velocity_per_day > 0;
            const coverColor = r.cover_days === null ? 'text-stone-400' : r.cover_days <= 30 ? 'text-red-600' : r.cover_days <= 90 ? 'text-amber-600' : 'text-green-600';
            const isLocked = Object.prototype.hasOwnProperty.call(manualOverrides, r.base_sku);
            const rowStripe = idx % 2 === 0 ? '#FFFEF9' : 'white';
            const rowBg = isLocked ? '#FAEEDA' : rowStripe;

            return (
              <tr key={r.base_sku} style={{ background: rowBg }}>
                <td className="px-3 py-2.5" style={{ fontWeight: 700 }}>{r.base_sku.toUpperCase()}</td>
                <td className="px-3 py-2.5">
                  <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {r.product_name}
                    {r.bundle_size === 2 && (
                      <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#dbeafe', color: '#1e40af', fontWeight: 500 }}>2×</span>
                    )}
                    {r.bundle_size === 4 && (
                      <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#dcfce7', color: '#166534', fontWeight: 500 }}>4×</span>
                    )}
                  </div>
                  <div style={{ display: (r.is_new_launch || (r.dearth_days > 0 && r.velocity_per_day > 0) || isStockout) ? 'flex' : 'none', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 2, fontSize: '11px' }}>
                    {r.is_new_launch && <span className="text-blue-600">new launch · manual qty</span>}
                    {r.dearth_days > 0 && r.velocity_per_day > 0 && (
                      <span className="text-red-600 flex items-center gap-1">
                        <Flag className="w-3 h-3" /> {r.dearth_days}d zero
                      </span>
                    )}
                    {isStockout && <span className="text-red-600">⚠ stockout</span>}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{r.is_new_launch ? '—' : r.velocity_per_day.toFixed(1)}</td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{r.available_stock.toLocaleString()}</td>
                <td className={`px-3 py-2.5 text-right ${coverColor}`} style={{ fontWeight: 700 }}>{r.cover_days === null ? '—' : r.cover_days + 'd'}</td>
                <td className="px-3 py-2.5 text-right">
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {isLocked ? (
                      <button
                        title="Unlock — algorithm takes over"
                        onClick={() => onUnlock(r.base_sku)}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: '#854F0B', fontSize: 14, lineHeight: 1, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      >
                        <Lock className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <span style={{ width: 16, visibility: 'hidden' }}>·</span>
                    )}
                    <input
                      type="number"
                      min={0}
                      value={cartons}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        onManualEdit(r.base_sku, isNaN(v) ? 0 : v);
                      }}
                      style={{
                        width: 60,
                        textAlign: 'right',
                        padding: '3px 6px',
                        border: isLocked ? '1.5px solid #BA7517' : '0.5px solid #a8a29e',
                        borderRadius: 4,
                        fontWeight: 700,
                        fontSize: 14,
                        background: 'white',
                        color: cartons > 0 ? undefined : '#a8a29e',
                      }}
                    />
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{units > 0 ? units.toLocaleString() : '—'}</td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{volume > 0 ? volume.toFixed(2) : '—'}</td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{pallets > 0 ? pallets.toFixed(2) : '—'}</td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{amount !== null ? fmtMoney(amount, currency) : '—'}</td>
              </tr>
            );
          })}
          {/* TOTALS */}
          <tr className="border-t-2 border-stone-300 bg-stone-50">
            <td className="px-3 py-2.5" style={{ fontWeight: 700 }} colSpan={5}>TOTAL</td>
            <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{totals.cartons || '—'}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{totals.units > 0 ? totals.units.toLocaleString() : '—'}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{totals.volume.toFixed(2)}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{totals.pallets.toFixed(2)}</td>
            <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{totals.amount !== null ? fmtMoney(totals.amount, currency) : '—'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
