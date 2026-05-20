'use client';

export const runtime = 'edge';

import { useEffect, useState, useMemo } from 'react';
import { Loader2, Flame, AlertTriangle, Check, ArrowLeft, Flag, Package, Truck } from 'lucide-react';
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

type SizingMode = 'pallet' | '20ft' | '40ft';



export default function PlannerPage() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [stockZone, setStockZone] = useState<'russia' | 'worldwide'>('russia');
  const [currency, setCurrency] = useState<'cny' | 'usd'>('cny');

  const [detail, setDetail] = useState<SuggestionsResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [cartonOverrides, setCartonOverrides] = useState<Record<string, number>>({});

  useEffect(() => {
    apiGet<SummaryResponse>('/api/planner/summary')
      .then((res) => {
        if (res.success && res.result) setSummary(res.result);
        else setError(res.errors[0]?.message ?? 'Failed to load planner summary');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Network error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedGroup) {
      setDetail(null);
      setCartonOverrides({});
      return;
    }
    setDetailLoading(true);
    apiGet<SuggestionsResponse>(
      `/api/planner/suggestions?group=${selectedGroup}&stock_zone=${stockZone}&currency=${currency}`
    )
      .then((res) => {
        if (res.success && res.result) {
          setDetail(res.result);
          setCartonOverrides({});
        } else {
          setError(res.errors[0]?.message ?? 'Failed to load suggestions');
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Network error'))
      .finally(() => setDetailLoading(false));
  }, [selectedGroup, stockZone, currency]);

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>;
  }

  if (error) {
    return <div className="p-6"><div className="px-4 py-3 rounded border border-red-200 bg-red-50 text-red-700" style={{ fontSize: '14px' }}>{error}</div></div>;
  }

  if (selectedGroup && detail) {
    return (
      <PlannerDetail
        detail={detail}
        loading={detailLoading}
        stockZone={stockZone}
        currency={currency}
        cartonOverrides={cartonOverrides}
        setCartonOverrides={setCartonOverrides}
        onBack={() => setSelectedGroup(null)}
        onStockZone={setStockZone}
        onCurrency={setCurrency}
      />
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 style={{ fontSize: '22px', fontWeight: 500 }}>Procurement Planner</h1>
        <p className="text-stone-500" style={{ fontSize: '14px', marginTop: '4px' }}>
          Sorted by urgency · one manufacturer per cycle · window {summary?.rules.window_days}d · coverage {summary?.rules.coverage_days}d · lead {summary?.rules.lead_time_days}d
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {summary?.groups.map((g) => <ManufacturerCard key={g.group_id} group={g} onClick={() => setSelectedGroup(g.group_id)} />)}
      </div>
      <div className="text-stone-500 text-center py-8 border border-dashed border-stone-200 rounded" style={{ fontSize: '14px' }}>
        Click a manufacturer above to see its plan.<br />
        <span className="text-stone-400" style={{ fontSize: '13px' }}>Red is suggested by urgency — final call is yours.</span>
      </div>
    </div>
  );
}

function ManufacturerCard({ group, onClick }: { group: SummaryGroup; onClick: () => void }) {
  const isCritical = group.urgency === 'critical';
  const isHigh = group.urgency === 'high';
  const borderClass = isCritical ? 'border-red-500 border-2 bg-red-50' : isHigh ? 'border-amber-400 border' : 'border-stone-200 border opacity-90';
  const badgeColor = isCritical ? 'text-red-700' : isHigh ? 'text-amber-700' : 'text-green-700';
  const BadgeIcon = isCritical ? Flame : isHigh ? AlertTriangle : Check;
  const badgeLabel = isCritical ? 'Most urgent' : isHigh ? 'High' : 'Calm';

  return (
    <button onClick={onClick} className={`text-left rounded-lg p-5 transition hover:shadow-md ${borderClass}`} style={{ background: isCritical ? undefined : 'white' }}>
      <div className={`flex items-center gap-2 ${badgeColor}`} style={{ fontSize: '12px', fontWeight: 500, textTransform: 'uppercase' }}>
        <BadgeIcon className="w-3.5 h-3.5" />{badgeLabel}
      </div>
      <div style={{ fontSize: '17px', fontWeight: 500, marginTop: '6px' }}>{group.group_name}</div>
      <div className="text-stone-500" style={{ fontSize: '13px', marginTop: '2px' }}>{group.categories.join(' · ')}</div>
      <div className="mt-4 pt-4 border-t border-current border-opacity-15 grid grid-cols-3 gap-3" style={{ fontSize: '13px' }}>
        <div><div className="text-stone-500">SKUs to order</div><div style={{ fontSize: '18px', fontWeight: 700, marginTop: '2px' }}>{group.skus_to_order}</div></div>
        <div><div className="text-stone-500">Min cover</div><div style={{ fontSize: '18px', fontWeight: 700, marginTop: '2px' }}>{group.min_cover_days === null ? '—' : `${group.min_cover_days}d`}</div></div>
        <div><div className="text-stone-500">Dearth flags</div><div style={{ fontSize: '18px', fontWeight: 700, marginTop: '2px' }}>{group.dearth_flags}</div></div>
      </div>
    </button>
  );
}

function PlannerDetail({
  detail, loading, stockZone, currency, cartonOverrides, setCartonOverrides, onBack, onStockZone, onCurrency,
}: {
  detail: SuggestionsResponse; loading: boolean;
  stockZone: 'russia' | 'worldwide'; currency: 'cny' | 'usd';
  cartonOverrides: Record<string, number>;
  setCartonOverrides: (next: Record<string, number>) => void;
  onBack: () => void;
  onStockZone: (z: 'russia' | 'worldwide') => void;
  onCurrency: (c: 'cny' | 'usd') => void;
}) {
  function finalCartons(r: PlannerRow): number {
    if (Object.prototype.hasOwnProperty.call(cartonOverrides, r.base_sku)) return Math.max(0, cartonOverrides[r.base_sku] ?? 0);
    return r.cartons;
  }
  function finalUnits(r: PlannerRow): number { return finalCartons(r) * (r.ctn_qty ?? 0); }
  function finalVolume(r: PlannerRow): number { return finalCartons(r) * (r.ctn_volume_m3 ?? 0); }
  function finalPallets(r: PlannerRow): number { return finalVolume(r) / 1.44; }
  function finalAmount(r: PlannerRow): number | null {
    const u = finalUnits(r);
    if (u === 0 || r.unit_price === null) return null;
    return Math.round(r.unit_price * u * 100) / 100;
  }

  // Sizing controls state — default to 6 pallets (max pallet mode)
  const baselineMinVolume = detail.rows.reduce((s, r) => s + (r.suggested_order > 0 ? r.volume_m3 : 0), 0);
  const baselineMinPallets = Math.max(1, Math.ceil(baselineMinVolume / PALLET_VOLUME_M3));
  const DEFAULT_PALLETS = 6;

  const [mode, setMode] = useState<SizingMode>('pallet');
  const [palletCount, setPalletCount] = useState<number>(DEFAULT_PALLETS);

  // Apply default sizing on first load (and when mode/zone changes back)
  useEffect(() => {
    if (Object.keys(cartonOverrides).length === 0) {
      let targetVol = DEFAULT_PALLETS * PALLET_VOLUME_M3;
      if (mode === '20ft') targetVol = C20_VOLUME_M3;
      else if (mode === '40ft') targetVol = C40_VOLUME_M3;
      else targetVol = palletCount * PALLET_VOLUME_M3;
      setCartonOverrides(autoFillCartons(detail.rows, targetVol, mode));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.rows, mode]);

  let totUnits = 0, totCartons = 0, totVolume = 0, totPallets = 0, totAmount = 0;
  let anyAmount = false;
  for (const r of detail.rows) {
    const c = finalCartons(r);
    if (c <= 0) continue;
    totCartons += c; totUnits += finalUnits(r); totVolume += finalVolume(r); totPallets += finalPallets(r);
    const amt = finalAmount(r);
    if (amt !== null) { totAmount += amt; anyAmount = true; }
  }
  totVolume = Math.round(totVolume * 100) / 100;
  totPallets = Math.round(totPallets * 100) / 100;
  totAmount = Math.round(totAmount * 100) / 100;

  return (
    <div className="p-6 space-y-5">
      <div>
        <button onClick={onBack} className="flex items-center gap-2 text-stone-600 hover:text-stone-900" style={{ fontSize: '14px' }}>
          <ArrowLeft className="w-4 h-4" /> Back to manufacturers
        </button>
        <h1 className="mt-3" style={{ fontSize: '22px', fontWeight: 500 }}>{detail.group.name}</h1>
        <p className="text-stone-500" style={{ fontSize: '14px', marginTop: '4px' }}>
          {totCartons} cartons · {totUnits.toLocaleString()} units · {totVolume.toFixed(2)} m³ · {totPallets.toFixed(1)} pallets
        </p>
      </div>

      <div className="flex items-center gap-5 flex-wrap" style={{ fontSize: '13px' }}>
        <div className="flex items-center gap-2">
          <span className="text-stone-500">Stock:</span>
          <ToggleGroup value={stockZone} options={[{ id: 'russia', label: 'Russia' }, { id: 'worldwide', label: 'Worldwide' }]} onChange={(v) => onStockZone(v as 'russia' | 'worldwide')} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-stone-500">Price:</span>
          <ToggleGroup value={currency} options={[{ id: 'cny', label: 'CNY' }, { id: 'usd', label: 'USD' }]} onChange={(v) => onCurrency(v as 'cny' | 'usd')} disabledIds={['usd']} />
        </div>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-stone-400" />}
      </div>

      <div style={{ display: mode === 'pallet' ? 'block' : 'none' }}>
        <SmartHint
          rows={detail.rows}
          overrides={cartonOverrides}
          targetVolume={palletCount * PALLET_VOLUME_M3}
          onAddPallet={(extra) => {
            const newCount = palletCount + extra;
            setPalletCount(newCount);
            setCartonOverrides(autoFillCartons(detail.rows, newCount * PALLET_VOLUME_M3, 'pallet'));
          }}
        />
      </div>

      <SizingButtons
        rows={detail.rows}
        mode={mode}
        palletCount={palletCount}
        onModeChange={(m) => {
          setMode(m);
          let targetVol = palletCount * PALLET_VOLUME_M3;
          if (m === '20ft') targetVol = C20_VOLUME_M3;
          else if (m === '40ft') targetVol = C40_VOLUME_M3;
          else targetVol = palletCount * PALLET_VOLUME_M3;
          setCartonOverrides(autoFillCartons(detail.rows, targetVol, m));
        }}
        onPalletCountChange={(n) => {
          setPalletCount(n);
          if (n > 0) {
            setCartonOverrides(autoFillCartons(detail.rows, n * PALLET_VOLUME_M3, 'pallet'));
          }
        }}
      />

      <SkuTable
        rows={detail.rows} currency={currency}
        cartonOverrides={cartonOverrides} setCartonOverrides={setCartonOverrides}
        finalCartons={finalCartons} finalUnits={finalUnits} finalVolume={finalVolume} finalPallets={finalPallets} finalAmount={finalAmount}
        totals={{ cartons: totCartons, units: totUnits, volume: totVolume, pallets: totPallets, amount: anyAmount ? totAmount : null }}
      />

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
    </div>
  );
}

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

/**
 * Apply sizing target to base recommendations:
 *   - For each row, start with `cartons` = MOQ baseline (r.cartons).
 *   - Compute current total volume.
 *   - If target volume > current, scale up: distribute extra cartons to SKUs sorted by velocity DESC.
 *   - If target volume < current (only possible when user types small N pallets), reduce by trimming
 *     the lowest-velocity ordered SKU's cartons in carton-multiples.
 * Returns map: base_sku → cartons.
 */
function autoFillCartons(rows: PlannerRow[], targetVolumeM3: number, mode: SizingMode = 'pallet'): Record<string, number> {
  const PHASE_B_CAP = mode === 'pallet' ? 180 : mode === '20ft' ? 365 : 540;
  // Algorithm: two-phase greedy
  //
  // Phase A — MOQ entry for active SKUs:
  //   Score = velocity^1.5 / cover_after_MOQ
  //   Sort descending. Walk list; add MOQ to each that fits in free space.
  //
  // Phase B — Top up by +1 carton:
  //   Score = velocity^2 / cover_after_plus_1
  //   Pick highest-score SKU already in order, add 1 carton. Repeat while space allows.
  //
  // Baseline (suggested_order > 0) stays as starting point. Phase B may top up these
  // baseline SKUs too if their +1 score wins.

  const overrides: Record<string, number> = {};
  for (const r of rows) overrides[r.base_sku] = r.cartons;

  function currentVolume(): number {
    let v = 0;
    for (const r of rows) {
      const c = overrides[r.base_sku] ?? 0;
      v += c * (r.ctn_volume_m3 ?? 0);
    }
    return v;
  }

  function coverAfter(r: PlannerRow, cartons: number): number {
    if (r.velocity_per_day <= 0) return Infinity;
    const newUnits = cartons * (r.ctn_qty ?? 0);
    const total = r.available_stock + newUnits;
    return total / r.velocity_per_day;
  }

  let freeVol = targetVolumeM3 - currentVolume();
  if (freeVol <= 0) return overrides;

  // ============================================================
  // PHASE A — MOQ entry, sorted by vel^1.5 / cover_after
  // ============================================================
  const eligibleNew = rows
    .filter((r) =>
      !r.is_new_launch &&
      r.lifecycle_status === 'active' &&
      r.velocity_per_day > 0 &&
      (r.ctn_volume_m3 ?? 0) > 0 &&
      r.suggested_order === 0,
    )
    .map((r) => {
      const moqCartons = Math.ceil(r.moq / (r.ctn_qty ?? 1));
      const moqVolume = moqCartons * (r.ctn_volume_m3 ?? 0);
      const cov = Math.max(1, coverAfter(r, moqCartons));
      const score = Math.pow(r.velocity_per_day, 1.5) / cov;
      return { r, moqCartons, moqVolume, score };
    })
    .sort((a, b) => b.score - a.score);

  for (const cand of eligibleNew) {
    if (cand.moqVolume <= freeVol) {
      overrides[cand.r.base_sku] = cand.moqCartons;
      freeVol -= cand.moqVolume;
    }
  }

  // ============================================================
  // PHASE B — +1 carton top-up by vel² / cover_after_+1
  // ============================================================
  let safety = 0;
  while (freeVol > 0.001 && safety < 100000) {
    let bestRow: PlannerRow | null = null;
    let bestScore = -1;
    for (const r of rows) {
      const cur = overrides[r.base_sku] ?? 0;
      if (cur === 0) continue;
      if (r.velocity_per_day <= 0) continue;
      if (r.is_new_launch) continue;
      if (r.lifecycle_status !== 'active') continue;
      const ctnVol = r.ctn_volume_m3 ?? 0;
      if (ctnVol <= 0) continue;
      if (ctnVol > freeVol) continue;
      const newCov = coverAfter(r, cur + 1);
      if (newCov > PHASE_B_CAP) continue;
      const cov = Math.max(1, newCov);
      const score = Math.pow(r.velocity_per_day, 1.5) / cov;
      if (score > bestScore) {
        bestScore = score;
        bestRow = r;
      }
    }
    if (bestRow === null) break;
    overrides[bestRow.base_sku] = (overrides[bestRow.base_sku] ?? 0) + 1;
    freeVol -= bestRow.ctn_volume_m3 ?? 0;
    safety++;
  }

  return overrides;
}


/**
 * Given current overrides + targetVolume, find the highest-score SKU
 * that does NOT fit in the current free space but WOULD fit if we added 1 more pallet.
 * Used for the "upsell hint" under the buttons.
 */
function findUpsellCandidate(
  rows: PlannerRow[],
  overrides: Record<string, number>,
  freeVolumeM3: number,
): { sku: PlannerRow; needPallets: number } | null {
  const candidates = rows
    .filter((r) =>
      !r.is_new_launch &&
      r.lifecycle_status === 'active' &&
      r.velocity_per_day > 0 &&
      (r.ctn_volume_m3 ?? 0) > 0 &&
      (overrides[r.base_sku] ?? 0) === 0,
    )
    .map((r) => {
      const moqCartons = Math.ceil(r.moq / (r.ctn_qty ?? 1));
      const moqVolume = moqCartons * (r.ctn_volume_m3 ?? 0);
      return {
        r,
        moqVolume,
        score: r.velocity_per_day / ((r.cover_days ?? 0) + 30),
      };
    })
    .filter((c) => c.moqVolume > freeVolumeM3)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;
  const top = candidates[0];
  const extraVolNeeded = top.moqVolume - freeVolumeM3;
  const extraPallets = Math.ceil(extraVolNeeded / PALLET_VOLUME_M3);
  return { sku: top.r, needPallets: extraPallets };
}

function SmartHint({
  rows,
  overrides,
  targetVolume,
  onAddPallet,
}: {
  rows: PlannerRow[];
  overrides: Record<string, number>;
  targetVolume: number;
  onAddPallet: (n: number) => void;
}) {
  // current used volume
  let used = 0;
  for (const r of rows) {
    const c = overrides[r.base_sku] ?? 0;
    used += c * (r.ctn_volume_m3 ?? 0);
  }
  const free = targetVolume - used;
  if (free <= 0.05) return null; // basically full

  const hint = findUpsellCandidate(rows, overrides, free);
  if (!hint) return null;

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded"
      style={{
        background: 'rgba(0, 87, 184, 0.06)',
        border: '1px dashed rgba(0, 87, 184, 0.35)',
        fontSize: '13px',
      }}
    >
      <div style={{ flex: 1, color: '#1e40af' }}>
        Add <b>{hint.needPallets}</b> more pallet{hint.needPallets > 1 ? 's' : ''} to fit{' '}
        <b>{hint.sku.base_sku.toUpperCase()} {hint.sku.product_name}</b>
        <span style={{ color: '#64748b', marginLeft: 6 }}>
          (velocity {hint.sku.velocity_per_day.toFixed(1)}/d, ends in {hint.sku.cover_days ?? '—'}d)
        </span>
      </div>
      <button
        onClick={() => onAddPallet(hint.needPallets)}
        style={{
          padding: '5px 12px',
          background: '#1d4ed8',
          color: 'white',
          fontSize: '12px',
          fontWeight: 500,
          borderRadius: 6,
          border: 'none',
          cursor: 'pointer',
        }}
      >
        +{hint.needPallets} pallet → add {hint.sku.base_sku.toUpperCase()}
      </button>
    </div>
  );
}

function SizingButtons({
  rows, mode, palletCount, onModeChange, onPalletCountChange,
}: {
  rows: PlannerRow[];
  mode: SizingMode;
  palletCount: number; // current value for the editable pallet input
  onModeChange: (mode: SizingMode) => void;
  onPalletCountChange: (n: number) => void;
}) {
  // Compute minimum pallets from MOQ baseline (for placeholder/sub-text)
  let minVolume = 0;
  for (const r of rows) {
    if (r.suggested_order > 0) minVolume += r.volume_m3;
  }
  const minPallets = minVolume / PALLET_VOLUME_M3;
  const minPalletsCeil = Math.max(1, Math.ceil(minPallets));

  const palletSelected = mode === 'pallet';
  const c20Selected = mode === '20ft';
  const c40Selected = mode === '40ft';

  // Subtext for pallet button
  const pSub = palletCount <= 6
    ? `${(palletCount * 1.44).toFixed(2)} m³ · within max 6`
    : `${(palletCount * 1.44).toFixed(2)} m³ · over max — consider 20ft`;

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
      {/* PALLET — large button, only the digit is huge */}
      <button
        type="button"
        onClick={() => onModeChange('pallet')}
        className="rounded-lg transition relative md:col-span-2"
        style={{
          padding: '24px 28px',
          minHeight: 200,
          border: palletSelected ? '2px solid #3b82f6' : '0.5px solid #d6d3d1',
          background: palletSelected ? '#eff6ff' : 'white',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        {palletSelected && (
          <div style={{ position: 'absolute', top: 8, right: 10, fontSize: 11, color: '#1d4ed8', fontWeight: 500, textTransform: 'uppercase' }}>
            Selected ★
          </div>
        )}
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
            width: 140,
            padding: '8px 12px',
            border: '0.5px solid ' + (palletSelected ? '#3b82f6' : '#a8a29e'),
            borderRadius: 6,
            fontWeight: 700,
            fontSize: 96,
            lineHeight: 1,
            textAlign: 'center',
            background: 'white',
            color: palletSelected ? '#1d4ed8' : '#57534e',
            flexShrink: 0,
          }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <div style={{ fontSize: 18, fontWeight: 700, textTransform: 'uppercase', color: palletSelected ? '#1d4ed8' : '#57534e' }}>
            pallets
          </div>
          <div style={{ fontSize: 12, color: palletSelected ? '#1d4ed8' : '#78716c', opacity: palletSelected ? 0.75 : 1 }}>
            {pSub}
          </div>
          {palletCount < minPalletsCeil && (
            <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 500 }}>
              below minimum ({minPalletsCeil})
            </div>
          )}
        </div>
      </button>

      {/* 20ft container — label only */}
      <button
        type="button"
        onClick={() => onModeChange('20ft')}
        className="rounded-lg text-left transition"
        style={{
          padding: '14px 12px 16px',
          minHeight: 130,
          border: c20Selected ? '2px solid #3b82f6' : '0.5px solid #d6d3d1',
          background: c20Selected ? '#eff6ff' : 'white',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {c20Selected && (
          <div style={{ position: 'absolute', top: 8, right: 10, fontSize: 11, color: '#1d4ed8', fontWeight: 500, textTransform: 'uppercase' }}>
            Selected ★
          </div>
        )}
        <div style={{ fontSize: 18, fontWeight: 500, textTransform: 'uppercase', color: c20Selected ? '#1d4ed8' : '#57534e' }}>
          20ft container
        </div>
        <div style={{ fontSize: 11.5, marginTop: 10, color: c20Selected ? '#1d4ed8' : '#78716c' }}>
          28 m³ capacity
        </div>
      </button>

      {/* 40ft container — label only */}
      <button
        type="button"
        onClick={() => onModeChange('40ft')}
        className="rounded-lg text-left transition"
        style={{
          padding: '14px 12px 16px',
          minHeight: 130,
          border: c40Selected ? '2px solid #3b82f6' : '0.5px solid #d6d3d1',
          background: c40Selected ? '#eff6ff' : 'white',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {c40Selected && (
          <div style={{ position: 'absolute', top: 8, right: 10, fontSize: 11, color: '#1d4ed8', fontWeight: 500, textTransform: 'uppercase' }}>
            Selected ★
          </div>
        )}
        <div style={{ fontSize: 18, fontWeight: 500, textTransform: 'uppercase', color: c40Selected ? '#1d4ed8' : '#57534e' }}>
          40ft container
        </div>
        <div style={{ fontSize: 11.5, marginTop: 10, color: c40Selected ? '#1d4ed8' : '#78716c' }}>
          56 m³ capacity
        </div>
      </button>
    </div>
  );
}

function SkuTable({
  rows, currency, cartonOverrides, setCartonOverrides,
  finalCartons, finalUnits, finalVolume, finalPallets, finalAmount, totals,
}: {
  rows: PlannerRow[]; currency: 'cny' | 'usd';
  cartonOverrides: Record<string, number>;
  setCartonOverrides: (next: Record<string, number>) => void;
  finalCartons: (r: PlannerRow) => number;
  finalUnits: (r: PlannerRow) => number;
  finalVolume: (r: PlannerRow) => number;
  finalPallets: (r: PlannerRow) => number;
  finalAmount: (r: PlannerRow) => number | null;
  totals: { cartons: number; units: number; volume: number; pallets: number; amount: number | null };
}) {
  type SortKey = 'sku' | 'sales' | 'ends' | 'cartons';
  type SortDir = 'asc' | 'desc';
  // Default sort direction per column per Aram's spec:
  // SKU asc, Sales/day desc, Ends in asc, Cartons desc
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
        // null cover = put at end regardless of direction
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
            <th className="text-right px-3 py-2 cursor-pointer select-none" onClick={() => clickHeader('cartons')} style={{ color: 'inherit', fontWeight: 500 }}>
              Cartons<SortArrow k="cartons" />
            </th>
            <th className="text-right px-3 py-2">Units</th>
            <th className="text-right px-3 py-2">Volume</th>
            <th className="text-right px-3 py-2">Pallets</th>
            <th className="text-right px-3 py-2">Amount</th>
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r) => {
            const isStockout = r.available_stock === 0 && !r.is_new_launch && r.velocity_per_day > 0;
            const coverColor = r.cover_days === null ? 'text-stone-400' : r.cover_days <= 30 ? 'text-red-600' : r.cover_days <= 90 ? 'text-amber-600' : 'text-green-600';
            const cartons = finalCartons(r);
            const ordered = cartons > 0;
            const units = finalUnits(r);
            const volume = finalVolume(r);
            const pallets = finalPallets(r);
            const amount = finalAmount(r);
            return (
              <tr key={r.base_sku} className="border-b border-stone-100 last:border-0" style={{ background: ordered ? '#FFFBEB' : undefined }}>
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
                  {(r.is_new_launch || (r.dearth_days > 0 && r.velocity_per_day > 0) || isStockout) && (
                    <div className="flex flex-wrap items-center gap-2 mt-0.5" style={{ fontSize: '11px' }}>
                      {r.is_new_launch && <span className="text-blue-600">new launch · manual qty</span>}
                      {r.dearth_days > 0 && r.velocity_per_day > 0 && (
                        <span className="text-red-600 flex items-center gap-1">
                          <Flag className="w-3 h-3" /> {r.dearth_days}d zero
                        </span>
                      )}
                      {isStockout && <span className="text-red-600">⚠ stockout</span>}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{r.is_new_launch ? '—' : r.velocity_per_day.toFixed(1)}</td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{r.available_stock.toLocaleString()}</td>
                <td className={`px-3 py-2.5 text-right ${coverColor}`} style={{ fontWeight: 700 }}>{r.cover_days === null ? '—' : r.cover_days + 'd'}</td>
                <td className="px-3 py-2.5 text-right">
                  <input
                    type="number" min={0} value={cartons}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      setCartonOverrides({ ...cartonOverrides, [r.base_sku]: isNaN(v) ? 0 : v });
                    }}
                    style={{
                      width: 60, textAlign: 'right', padding: '3px 6px',
                      border: '0.5px solid #a8a29e', borderRadius: 4,
                      fontWeight: 700, fontSize: 14, background: 'white',
                      color: cartons > 0 ? undefined : '#a8a29e',
                    }}
                  />
                </td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{units > 0 ? units.toLocaleString() : '—'}</td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{volume > 0 ? volume.toFixed(2) : '—'}</td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{pallets > 0 ? pallets.toFixed(2) : '—'}</td>
                <td className="px-3 py-2.5 text-right" style={{ fontWeight: 700 }}>{amount !== null ? fmtMoney(amount, currency) : '—'}</td>
              </tr>
            );
          })}
          {/* TOTALS row */}
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
