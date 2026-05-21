'use client';

export const runtime = 'edge';

import { useEffect, useState, useMemo } from 'react';
import { Loader2, Flame, AlertTriangle, Check, Flag, Lock, X, CheckCircle2, Download, FilePlus, FileText } from 'lucide-react';
import * as XLSX from 'xlsx-js-style';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { apiGet, apiPost } from '@/lib/api';

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
const C40_VOLUME_M3 = 76;  // 40HQ High Cube interior volume

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

  // Create Draft modal state
  const [draftModalOpen, setDraftModalOpen] = useState(false);
  const [draftSuccess, setDraftSuccess] = useState<{ reference: string; operation_id: string; line_items_count: number; total_units: number; total_amount: number; currency: string } | null>(null);

  // For pallet mode: overrides come from backend's r.cartons (natural reorder).
  // For container modes: overrides come from autoFillCartons greedy with tier ladder.
  function computeOverridesForMode(rows: PlannerRow[], m: SizingMode, manual: Record<string, number>): Record<string, number> {
    if (m === 'pallet') {
      const out: Record<string, number> = {};
      for (const r of rows) {
        if (Object.prototype.hasOwnProperty.call(manual, r.base_sku)) continue;
        out[r.base_sku] = r.cartons; // backend's suggested baseline
      }
      return out;
    }
    const target = m === '20ft' ? C20_VOLUME_M3 : C40_VOLUME_M3;
    return autoFillCartons(rows, target, m, manual);
  }

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
          setAutoOverrides(computeOverridesForMode(res.result.rows, mode, {}));
        } else {
          setError(res.errors[0]?.message ?? 'Failed to load suggestions');
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Network error'))
      .finally(() => setDetailLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGroup, stockZone, currency]);

  function getTargetVolume(m: SizingMode): number {
    if (m === '20ft') return C20_VOLUME_M3;
    if (m === '40ft') return C40_VOLUME_M3;
    return Infinity; // pallets mode — no volume target, baseline is what it is
  }

  // Recompute auto when mode changes
  function handleModeChange(m: SizingMode) {
    setMode(m);
    if (detail) {
      setAutoOverrides(computeOverridesForMode(detail.rows, m, manualOverrides));
    }
  }

  // User types in a Cartons cell → lock that SKU
  function handleManualEdit(baseSku: string, value: number) {
    const newManual = { ...manualOverrides, [baseSku]: value };
    setManualOverrides(newManual);
    if (detail) {
      setAutoOverrides(computeOverridesForMode(detail.rows, mode, newManual));
    }
  }

  // Unlock a specific SKU — algorithm takes back over
  function handleUnlock(baseSku: string) {
    const newManual = { ...manualOverrides };
    delete newManual[baseSku];
    setManualOverrides(newManual);
    if (detail) {
      setAutoOverrides(computeOverridesForMode(detail.rows, mode, newManual));
    }
  }

  // Reset all manual locks
  function handleResetAll() {
    setManualOverrides({});
    if (detail) {
      setAutoOverrides(computeOverridesForMode(detail.rows, mode, {}));
    }
  }

  // Download current plan as styled .xlsx — branded layout, no DB write.
  function handleDownloadExcel() {
    if (!detail) return;
    const cur = currency.toUpperCase();

    // Re-compute totals inside
    let dlCartons = 0, dlUnits = 0, dlVolume = 0, dlAmount = 0;
    let dlAnyAmount = false;
    type ExportRow = {
      sku: string; product: string; bundle: string; cartons: number;
      qtyPerCarton: number; totalQty: number; unitPrice: number;
      lineAmount: number; volume: number;
    };
    const exportRows: ExportRow[] = detail.rows
      .filter(r => finalCartons(r) > 0)
      .map(r => {
        const c = finalCartons(r);
        const u = finalUnits(r);
        const v = finalVolume(r);
        const a = finalAmount(r);
        dlCartons += c; dlUnits += u; dlVolume += v;
        if (a !== null) { dlAmount += a; dlAnyAmount = true; }
        return {
          sku: r.base_sku.toUpperCase(),
          product: r.product_name,
          bundle: r.bundle_size > 1 ? `${r.bundle_size}-pack` : 'single',
          cartons: c,
          qtyPerCarton: r.ctn_qty ?? 0,
          totalQty: u,
          unitPrice: r.unit_price ?? 0,
          lineAmount: a ?? 0,
          volume: Math.round(v * 1000) / 1000,
        };
      });

    if (exportRows.length === 0) return;

    const today = new Date();
    const yyyy = today.getFullYear();
    const yymmdd = today.toISOString().slice(2, 10).replace(/-/g, '');
    const docNo = `${today.toISOString().slice(0, 10)}-${detail.group.id.replace(/[^a-z0-9]+/gi, '').slice(0, 4).toUpperCase()}`;

    // ========================================
    // Brand colors (hex without #)
    // ========================================
    const BLACK = '1A1A1A';
    const GOLD = 'D4A017';
    const RED = 'C4302B';
    const STRIPE = 'FAFAF7';
    const BORDER = 'D6D3D1';
    const TEXT_DARK = '1A1A1A';
    const TEXT_MUTED = '888888';
    const TEXT_SUBTLE = '555555';

    // ========================================
    // Style presets
    // ========================================
    const border = {
      top: { style: 'thin', color: { rgb: BORDER } },
      bottom: { style: 'thin', color: { rgb: BORDER } },
      left: { style: 'thin', color: { rgb: BORDER } },
      right: { style: 'thin', color: { rgb: BORDER } },
    };

    const styleBrandTitle = {
      font: { name: 'Calibri', sz: 22, bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: BLACK } },
      alignment: { vertical: 'center', horizontal: 'left' },
    };
    const styleBrandTagline = {
      font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: GOLD } },
      fill: { fgColor: { rgb: BLACK } },
      alignment: { vertical: 'center', horizontal: 'left' },
    };
    const styleBrandRight = {
      font: { name: 'Calibri', sz: 11, color: { rgb: 'AAAAAA' } },
      fill: { fgColor: { rgb: BLACK } },
      alignment: { vertical: 'center', horizontal: 'right' },
    };
    const styleBrandDocNo = {
      font: { name: 'Calibri', sz: 13, bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: BLACK } },
      alignment: { vertical: 'center', horizontal: 'right' },
    };
    const styleGoldStripe = {
      fill: { fgColor: { rgb: GOLD } },
    };
    const styleDocTitle = {
      font: { name: 'Calibri', sz: 16, bold: true, color: { rgb: TEXT_DARK } },
      alignment: { vertical: 'center', horizontal: 'left' },
    };
    const styleMeta = {
      font: { name: 'Calibri', sz: 10, color: { rgb: TEXT_MUTED } },
      alignment: { vertical: 'center', horizontal: 'left' },
    };
    const styleBlockHeader = {
      font: { name: 'Calibri', sz: 9, bold: true, color: { rgb: TEXT_MUTED } },
      alignment: { vertical: 'center', horizontal: 'left' },
    };
    const styleBlockTitle = {
      font: { name: 'Calibri', sz: 12, bold: true, color: { rgb: TEXT_DARK } },
      alignment: { vertical: 'center', horizontal: 'left', wrapText: false },
      border,
    };
    const styleBlockBody = {
      font: { name: 'Calibri', sz: 10, color: { rgb: TEXT_SUBTLE } },
      alignment: { vertical: 'top', horizontal: 'left', wrapText: true },
      border,
    };
    const styleTableHeader = {
      font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: BLACK } },
      alignment: { vertical: 'center', horizontal: 'center', wrapText: false, shrinkToFit: true },
      border,
    };
    const styleTableCell = (stripe: boolean, align: 'left' | 'right' | 'center', bold = false) => ({
      font: { name: 'Calibri', sz: 11, bold, color: { rgb: TEXT_DARK }, shrinkToFit: true },
      fill: stripe ? { fgColor: { rgb: STRIPE } } : { fgColor: { rgb: 'FFFFFF' } },
      alignment: { vertical: 'center', horizontal: align, wrapText: false, shrinkToFit: true },
      border,
    });
    const styleTableCellMuted = (stripe: boolean, align: 'left' | 'right' | 'center') => ({
      font: { name: 'Calibri', sz: 11, color: { rgb: TEXT_MUTED }, shrinkToFit: true },
      fill: stripe ? { fgColor: { rgb: STRIPE } } : { fgColor: { rgb: 'FFFFFF' } },
      alignment: { vertical: 'center', horizontal: align, wrapText: false, shrinkToFit: true },
      border,
    });
    const styleTotalCell = (align: 'left' | 'right' | 'center', goldText = false) => ({
      font: {
        name: 'Calibri', sz: 11, bold: true,
        color: { rgb: goldText ? GOLD : 'FFFFFF' },
      },
      fill: { fgColor: { rgb: BLACK } },
      alignment: { vertical: 'center', horizontal: align, wrapText: false },
      border,
    });
    const styleFooter = {
      font: { name: 'Calibri', sz: 9, italic: true, color: { rgb: TEXT_MUTED } },
      alignment: { vertical: 'center', horizontal: 'left' },
    };

    // ========================================
    // Build sheet
    // ========================================
    const ws: any = {};
    const setCell = (addr: string, value: any, style?: any, type: 's' | 'n' = 's', fmt?: string) => {
      ws[addr] = { v: value, t: type, s: style };
      if (fmt) ws[addr].z = fmt;
    };

    // Row 1: brand band (height ~30)
    setCell('A1', 'DAS EXPERTEN', styleBrandTitle);
    setCell('B1', '', styleBrandTitle);
    setCell('C1', '', styleBrandTitle);
    setCell('D1', '', styleBrandTitle);
    setCell('E1', '', styleBrandRight);
    setCell('F1', '', styleBrandRight);
    setCell('G1', 'PURCHASE PLAN', styleBrandRight);
    setCell('H1', '', styleBrandDocNo);
    setCell('I1', '', styleBrandDocNo);

    // Row 2: tagline + doc no
    setCell('A2', 'INNOVATIV UND PRAKTISCH', styleBrandTagline);
    setCell('B2', '', styleBrandTagline);
    setCell('C2', '', styleBrandTagline);
    setCell('D2', '', styleBrandTagline);
    setCell('E2', '', styleBrandDocNo);
    setCell('F2', '', styleBrandDocNo);
    setCell('G2', '', styleBrandDocNo);
    setCell('H2', 'No. ' + docNo, styleBrandDocNo);
    setCell('I2', '', styleBrandDocNo);

    // Row 3: gold stripe (height ~4)
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']) {
      setCell(col + '3', '', styleGoldStripe);
    }

    // Row 4: spacer
    // Row 5: doc title
    setCell('A5', 'Purchase Plan — ' + detail.group.name, styleDocTitle);

    // Row 6: meta
    const ld = summary?.rules.lead_time_days ?? 0;
    const cv = summary?.rules.coverage_days ?? 0;
    setCell('A6', `Date: ${today.toISOString().slice(0, 10)}    ·    Currency: ${cur}    ·    Stock zone: ${stockZone}    ·    Rules: lead ${ld}d + cover ${cv}d (target ${ld + cv}d)`, styleMeta);

    // Row 7: spacer
    // Row 8: block headers
    setCell('A8', 'BUYER', styleBlockHeader);
    setCell('E8', 'MANUFACTURER', styleBlockHeader);

    // Row 9: block titles
    setCell('A9', 'DAS EXPERTEN EURASIA LLC', styleBlockTitle);
    setCell('B9', '', styleBlockTitle);
    setCell('C9', '', styleBlockTitle);
    setCell('D9', '', styleBlockTitle);
    setCell('E9', (() => {
      // Group name → manufacturer name
      if (detail.group.id === 'jinxia_group') return 'YANGZHOU JINXIA';
      if (detail.group.id === 'honghui_group') return 'HONGHUI / WDAA / MEIZHIYUAN';
      return detail.group.name.toUpperCase();
    })(), styleBlockTitle);
    setCell('F9', '', styleBlockTitle);
    setCell('G9', '', styleBlockTitle);
    setCell('H9', '', styleBlockTitle);
    setCell('I9', '', styleBlockTitle);

    // Row 10: block body line 1
    setCell('A10', 'Saransk, Russia', styleBlockBody);
    setCell('B10', '', styleBlockBody);
    setCell('C10', '', styleBlockBody);
    setCell('D10', '', styleBlockBody);
    setCell('E10', detail.group.id === 'jinxia_group' ? 'Yangzhou, China' : 'Guangzhou, China', styleBlockBody);
    setCell('F10', '', styleBlockBody);
    setCell('G10', '', styleBlockBody);
    setCell('H10', '', styleBlockBody);
    setCell('I10', '', styleBlockBody);

    // Row 11: block body line 2
    setCell('A11', 'INN 9704117379 · VTB Bank, Moscow', styleBlockBody);
    setCell('B11', '', styleBlockBody);
    setCell('C11', '', styleBlockBody);
    setCell('D11', '', styleBlockBody);
    setCell('E11', `Lead ${ld}d · Coverage ${cv}d`, styleBlockBody);
    setCell('F11', '', styleBlockBody);
    setCell('G11', '', styleBlockBody);
    setCell('H11', '', styleBlockBody);
    setCell('I11', '', styleBlockBody);

    // Row 12: spacer
    // Row 13: ITEMS header label
    setCell('A13', 'ITEMS', styleBlockHeader);

    // Row 14: table header
    const headerRow = 14;
    const headers = ['SKU', 'Product', 'Bundle', 'Cartons', 'Qty / ctn', 'Total qty', `Unit ${cur === 'CNY' ? '¥' : '$'}`, `Line ${cur === 'CNY' ? '¥' : '$'}`, 'm³'];
    headers.forEach((h, i) => {
      const col = String.fromCharCode(65 + i);
      setCell(col + headerRow, h, styleTableHeader);
    });

    // Table rows
    let r = headerRow + 1;
    exportRows.forEach((row, idx) => {
      const stripe = idx % 2 === 0;
      setCell(`A${r}`, row.sku, styleTableCell(stripe, 'left', true));
      setCell(`B${r}`, row.product, styleTableCell(stripe, 'left'));
      setCell(`C${r}`, row.bundle, styleTableCellMuted(stripe, 'center'));
      setCell(`D${r}`, row.cartons, styleTableCell(stripe, 'right', true), 'n');
      setCell(`E${r}`, row.qtyPerCarton, styleTableCell(stripe, 'right'), 'n');
      setCell(`F${r}`, row.totalQty, styleTableCell(stripe, 'right', true), 'n', '#,##0');
      setCell(`G${r}`, row.unitPrice, styleTableCell(stripe, 'right'), 'n', '0.00');
      setCell(`H${r}`, row.lineAmount, styleTableCell(stripe, 'right', true), 'n', '#,##0.00');
      setCell(`I${r}`, row.volume, styleTableCellMuted(stripe, 'right'), 'n', '0.000');
      r++;
    });

    // Total row
    setCell(`A${r}`, 'TOTAL', styleTotalCell('left'));
    setCell(`B${r}`, '', styleTotalCell('left'));
    setCell(`C${r}`, '', styleTotalCell('center'));
    setCell(`D${r}`, dlCartons, styleTotalCell('right'), 'n');
    setCell(`E${r}`, '', styleTotalCell('right'));
    setCell(`F${r}`, dlUnits, styleTotalCell('right'), 'n', '#,##0');
    setCell(`G${r}`, '', styleTotalCell('right'));
    setCell(`H${r}`, dlAnyAmount ? Math.round(dlAmount * 100) / 100 : 0, styleTotalCell('right', true), 'n', '#,##0.00');
    setCell(`I${r}`, Math.round(dlVolume * 1000) / 1000, styleTotalCell('right'), 'n', '0.000');
    const totalRow = r;
    r++;

    // Footer
    r++;
    setCell(`A${r}`, `Generated by Das Operator ERP · planner module · page 1 of 1`, styleFooter);

    // ========================================
    // Sheet metadata: merges, column widths, row heights
    // ========================================
    ws['!ref'] = `A1:I${r}`;
    ws['!merges'] = [
      // Brand band
      { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },  // DAS EXPERTEN row 1 A-D
      { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },  // tagline row 2 A-D
      { s: { r: 0, c: 4 }, e: { r: 0, c: 8 } },  // PURCHASE PLAN row 1 E-I
      { s: { r: 1, c: 4 }, e: { r: 1, c: 8 } },  // doc no row 2 E-I
      // Gold stripe row 3 — full width
      { s: { r: 2, c: 0 }, e: { r: 2, c: 8 } },
      // Title row 5
      { s: { r: 4, c: 0 }, e: { r: 4, c: 8 } },
      // Meta row 6
      { s: { r: 5, c: 0 }, e: { r: 5, c: 8 } },
      // Block headers row 8
      { s: { r: 7, c: 0 }, e: { r: 7, c: 3 } },
      { s: { r: 7, c: 4 }, e: { r: 7, c: 8 } },
      // Block titles/bodies rows 9-11
      { s: { r: 8, c: 0 }, e: { r: 8, c: 3 } },
      { s: { r: 8, c: 4 }, e: { r: 8, c: 8 } },
      { s: { r: 9, c: 0 }, e: { r: 9, c: 3 } },
      { s: { r: 9, c: 4 }, e: { r: 9, c: 8 } },
      { s: { r: 10, c: 0 }, e: { r: 10, c: 3 } },
      { s: { r: 10, c: 4 }, e: { r: 10, c: 8 } },
      // ITEMS label row 13
      { s: { r: 12, c: 0 }, e: { r: 12, c: 8 } },
      // Footer
      { s: { r: r - 1, c: 0 }, e: { r: r - 1, c: 8 } },
    ];

    // Wider columns to avoid wrapping
    ws['!cols'] = [
      { wch: 13 },  // A — SKU (DE120AAAA fits)
      { wch: 30 },  // B — Product (NANO MASSAGE 4in1 fits)
      { wch: 10 },  // C — Bundle (4-pack fits)
      { wch: 10 },  // D — Cartons
      { wch: 11 },  // E — Qty/ctn
      { wch: 13 },  // F — Total qty
      { wch: 11 },  // G — Unit price
      { wch: 15 },  // H — Line total
      { wch: 10 },  // I — m³
    ];

    // Row heights
    ws['!rows'] = [];
    ws['!rows'][0] = { hpt: 30 };  // brand band title
    ws['!rows'][1] = { hpt: 18 };  // tagline
    ws['!rows'][2] = { hpt: 5 };   // gold stripe
    ws['!rows'][3] = { hpt: 12 };  // spacer
    ws['!rows'][4] = { hpt: 24 };  // doc title
    ws['!rows'][5] = { hpt: 18 };  // meta
    ws['!rows'][6] = { hpt: 12 };  // spacer
    ws['!rows'][7] = { hpt: 14 };  // block headers (small caps)
    ws['!rows'][8] = { hpt: 22 };  // block titles
    ws['!rows'][9] = { hpt: 16 };  // block body 1
    ws['!rows'][10] = { hpt: 16 }; // block body 2
    ws['!rows'][11] = { hpt: 14 }; // spacer
    ws['!rows'][12] = { hpt: 14 }; // ITEMS label
    ws['!rows'][13] = { hpt: 24 }; // table header
    for (let i = 14; i <= totalRow; i++) ws['!rows'][i] = { hpt: 20 };
    ws['!rows'][totalRow] = { hpt: 26 }; // total row taller
    ws['!rows'][r - 1] = { hpt: 16 }; // footer

    // Page setup
    ws['!margins'] = { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 };
    ws['!pageSetup'] = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Purchase Plan');

    const groupSlug = detail.group.id.replace(/[^a-z0-9]+/gi, '_');
    const fname = `Purchase-Plan-${groupSlug}-${yyyy}${yymmdd.slice(2)}.xlsx`;
    XLSX.writeFile(wb, fname);
  }

  // Download current plan as styled PDF — single page, landscape A4.
  // Brand band on top, buyer/manufacturer boxes, items table auto-fit, footer.
  function handleDownloadPDF() {
    if (!detail) return;
    const cur = currency.toUpperCase();

    // Re-compute totals
    let dlCartons = 0, dlUnits = 0, dlVolume = 0, dlAmount = 0;
    let dlAnyAmount = false;
    type Row = { sku: string; product: string; bundle: string; cartons: number; qtyPerCarton: number; totalQty: number; unitPrice: number; lineAmount: number; volume: number };
    const exportRows: Row[] = detail.rows
      .filter(r => finalCartons(r) > 0)
      .map(r => {
        const c = finalCartons(r);
        const u = finalUnits(r);
        const v = finalVolume(r);
        const a = finalAmount(r);
        dlCartons += c; dlUnits += u; dlVolume += v;
        if (a !== null) { dlAmount += a; dlAnyAmount = true; }
        return {
          sku: r.base_sku.toUpperCase(),
          product: r.product_name,
          bundle: r.bundle_size > 1 ? `${r.bundle_size}-pack` : 'single',
          cartons: c,
          qtyPerCarton: r.ctn_qty ?? 0,
          totalQty: u,
          unitPrice: r.unit_price ?? 0,
          lineAmount: a ?? 0,
          volume: Math.round(v * 1000) / 1000,
        };
      });
    if (exportRows.length === 0) return;

    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const groupSlug = detail.group.id.replace(/[^a-z0-9]+/gi, '_').toUpperCase().slice(0, 4);
    const docNo = `${dateStr}-${groupSlug}`;
    const ld = summary?.rules.lead_time_days ?? 0;
    const cv = summary?.rules.coverage_days ?? 0;

    // Resolve manufacturer name shown on the PDF
    let mfrName = detail.group.name.toUpperCase();
    let mfrLocation = 'China';
    if (detail.group.id === 'jinxia_group') {
      mfrName = 'YANGZHOU JINXIA';
      mfrLocation = 'Yangzhou, China';
    } else if (detail.group.id === 'honghui_group') {
      mfrName = 'HONGHUI / WDAA / MEIZHIYUAN';
      mfrLocation = 'Guangzhou, China';
    }

    // A4 portrait: 210 × 297 mm
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 12;

    // ===== Brand band =====
    const bandH = 16;
    doc.setFillColor(26, 26, 26); // #1A1A1A
    doc.rect(0, 0, pageW, bandH, 'F');

    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('DAS EXPERTEN', margin, 9);

    doc.setTextColor(212, 160, 23); // #D4A017 gold
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.text('INNOVATIV UND PRAKTISCH', margin, 13.5);

    // Right side of band
    doc.setTextColor(140, 140, 140);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.text('PURCHASE PLAN', pageW - margin, 8, { align: 'right' });
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(docNo, pageW - margin, 13, { align: 'right' });

    // Gold stripe
    doc.setFillColor(212, 160, 23);
    doc.rect(0, bandH, pageW, 1.2, 'F');

    // ===== Title + meta =====
    let y = bandH + 6;
    doc.setTextColor(26, 26, 26);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text(`Purchase Plan — ${detail.group.name}`, margin, y);

    y += 5;
    doc.setTextColor(120, 113, 108);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(
      `Date: ${dateStr}   ·   Currency: ${cur}   ·   Stock zone: ${stockZone}   ·   Rules: lead ${ld}d + cover ${cv}d (target ${ld + cv}d)`,
      margin, y
    );

    // ===== Buyer / Manufacturer blocks =====
    y += 4;
    const blockW = (pageW - margin * 2 - 6) / 2;
    const blockH = 16;
    const drawBlock = (x: number, header: string, title: string, body: string) => {
      doc.setDrawColor(214, 211, 209);
      doc.setLineWidth(0.2);
      doc.rect(x, y, blockW, blockH);
      doc.setTextColor(136, 136, 136);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.5);
      doc.text(header, x + 3, y + 3.5);
      doc.setTextColor(26, 26, 26);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text(title, x + 3, y + 8);
      doc.setTextColor(85, 85, 85);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(body, x + 3, y + 12.5);
    };
    drawBlock(margin, 'BUYER', 'DAS EXPERTEN EURASIA LLC', 'Saransk, Russia · INN 9704117379');
    drawBlock(margin + blockW + 6, 'MANUFACTURER', mfrName, `${mfrLocation} · Lead ${ld}d · Coverage ${cv}d`);

    y += blockH + 6;

    // ===== Items table — auto-fit, single page =====
    // Estimate available height
    const footerH = 10;
    const availH = pageH - y - footerH - margin;
    const headerRowH = 7;
    const totalRowH = 8;
    // Pick row height so all rows fit
    const dataRowH = Math.min(7, Math.max(4, (availH - headerRowH - totalRowH) / exportRows.length));
    // Font size scales with row height
    const cellFont = dataRowH >= 6 ? 9 : dataRowH >= 5 ? 8 : 7;
    const headerFont = Math.max(7, cellFont - 0.5);

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [[
        'SKU', 'Product', 'Bundle',
        'Ctn', 'Qty/ctn', 'Total qty',
        `Unit ${cur === 'CNY' ? '¥' : '$'}`,
        `Line ${cur === 'CNY' ? '¥' : '$'}`,
        'm³',
      ]],
      body: [
        ...exportRows.map(r => [
          r.sku, r.product, r.bundle,
          r.cartons.toString(),
          r.qtyPerCarton.toString(),
          r.totalQty.toLocaleString('en-US'),
          r.unitPrice.toFixed(2),
          r.lineAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
          r.volume.toFixed(2),
        ]),
      ],
      foot: [[
        { content: 'TOTAL', colSpan: 3, styles: { halign: 'left' } },
        dlCartons.toString(),
        '',
        dlUnits.toLocaleString('en-US'),
        {
          content: dlAnyAmount
            ? (Math.round(dlAmount * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + (cur === 'CNY' ? '¥' : '$')
            : '',
          colSpan: 2,
          styles: { halign: 'right' },
        },
        (Math.round(dlVolume * 100) / 100).toFixed(2),
      ]],
      theme: 'plain',
      styles: {
        font: 'helvetica',
        fontSize: cellFont,
        cellPadding: { top: dataRowH / 3, bottom: dataRowH / 3, left: 2, right: 2 },
        lineColor: [230, 228, 224],
        lineWidth: 0.1,
        textColor: [26, 26, 26],
        overflow: 'ellipsize',
      },
      headStyles: {
        fillColor: [26, 26, 26],
        textColor: [255, 255, 255],
        fontSize: headerFont,
        fontStyle: 'bold',
        cellPadding: { top: 2.4, bottom: 2.4, left: 2, right: 2 },
        halign: 'center',
        valign: 'middle',
        lineWidth: 0,
      },
      bodyStyles: { valign: 'middle' },
      alternateRowStyles: { fillColor: [250, 250, 247] },
      footStyles: {
        fillColor: [26, 26, 26],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: cellFont + 0.5,
        cellPadding: { top: 2.5, bottom: 2.5, left: 2, right: 2 },
        lineWidth: 0,
        overflow: 'visible',
      },
      columnStyles: {
        0: { halign: 'left', fontStyle: 'bold', cellWidth: 22 },
        1: { halign: 'left', cellWidth: 'auto' },
        2: { halign: 'center', cellWidth: 14, textColor: [136, 136, 136] },
        3: { halign: 'right', fontStyle: 'bold', cellWidth: 11 },
        4: { halign: 'right', cellWidth: 13 },
        5: { halign: 'right', fontStyle: 'bold', cellWidth: 18 },
        6: { halign: 'right', cellWidth: 16 },
        7: { halign: 'right', fontStyle: 'bold', cellWidth: 22 },
        8: { halign: 'right', cellWidth: 14, textColor: [102, 102, 102] },
      },
      didParseCell: (data) => {
        // Gold-tint the grand total amount cell (footer, merged across Unit+Line cols = index 6)
        if (data.section === 'foot' && data.column.index === 6) {
          data.cell.styles.textColor = [212, 160, 23];
        }
      },
      didDrawPage: () => {
        // Footer
        const fy = pageH - 6;
        doc.setTextColor(136, 136, 136);
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7);
        doc.text(
          `Generated by Das Operator ERP · planner module · ${today.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          margin, fy
        );
        doc.text('Page 1 of 1', pageW - margin, fy, { align: 'right' });
      },
    });

    const fname = `Purchase-Plan-${detail.group.id.replace(/[^a-z0-9]+/gi, '_')}-${dateStr.replace(/-/g, '')}.pdf`;
    doc.save(fname);
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

  const targetVol = getTargetVolume(mode);
  const manualExceedsTarget = mode !== 'pallet' && manualVolume > targetVol + 0.01;
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
          <div className="flex items-center gap-3 px-4 py-3 rounded" style={{ display: manualExceedsTarget ? 'flex' : 'none', background: '#FCEBEB', border: '0.5px solid #F09595', fontSize: '13px', color: '#791F1F' }}>
            <span style={{ fontSize: 16 }}>⚠</span>
            <span><b>Manual entries take {manualVolume.toFixed(2)} m³</b> — exceeds {mode === '20ft' ? '20ft' : '40HQ'} capacity ({targetVol} m³). Unlock entries to rebalance.</span>
          </div>

          {/* Manual locks banner with reset button */}
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded" style={{ display: (hasManualEntries && !manualExceedsTarget) ? 'flex' : 'none', background: '#FAEEDA', fontSize: '13px', color: '#854F0B' }}>
            <span><b>{Object.keys(manualOverrides).length} manual {Object.keys(manualOverrides).length === 1 ? 'entry' : 'entries'} locked.</b> Algorithm rebalances unlocked SKUs.</span>
            <button onClick={handleResetAll} style={{ fontSize: 12, padding: '4px 10px', background: 'white', border: '0.5px solid #BA7517', borderRadius: 4, color: '#854F0B', fontWeight: 500, cursor: 'pointer' }}>
              Reset all to auto
            </button>
          </div>

          {/* Sizing buttons */}
          <SizingButtons
            mode={mode}
            baselinePallets={totPallets}
            onModeChange={handleModeChange}
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

          {/* Success banner — shown after a draft is created */}
          <div style={{ display: draftSuccess ? 'flex' : 'none', background: '#EAF3DE', border: '0.5px solid #B6D58F', borderRadius: 8, padding: '14px 18px', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <CheckCircle2 className="w-5 h-5" style={{ color: '#27500A' }} />
              <div>
                <div style={{ fontWeight: 700, color: '#27500A', fontSize: 14 }}>
                  Draft {draftSuccess?.reference} created
                </div>
                <div style={{ fontSize: 12, color: '#3F6E1D', marginTop: 2 }}>
                  {draftSuccess?.line_items_count} SKUs · {(draftSuccess?.total_units ?? 0).toLocaleString()} units · {fmtMoney(draftSuccess?.total_amount ?? 0, (draftSuccess?.currency ?? 'cny').toLowerCase() as 'cny' | 'usd')} · status: <b>draft</b>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <a
                href={`/operations/${draftSuccess?.operation_id}`}
                style={{ background: 'white', border: '0.5px solid #B6D58F', color: '#27500A', padding: '6px 12px', borderRadius: 4, fontSize: 12, fontWeight: 500, textDecoration: 'none' }}
              >
                Open operation →
              </a>
              <button
                onClick={() => setDraftSuccess(null)}
                style={{ background: 'transparent', border: 'none', color: '#27500A', cursor: 'pointer', padding: '6px 8px' }}
                aria-label="dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Two actions: Download Excel + Create Draft */}
          <div className="flex justify-end gap-3 pt-4 border-t border-stone-200">
            <button
              disabled={totCartons === 0}
              onClick={() => handleDownloadExcel()}
              style={{
                fontSize: '14px',
                fontWeight: 500,
                padding: '10px 18px',
                background: 'white',
                color: '#1c1917',
                border: '0.5px solid #a8a29e',
                borderRadius: 6,
                cursor: totCartons === 0 ? 'not-allowed' : 'pointer',
                opacity: totCartons === 0 ? 0.4 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Download className="w-4 h-4" />
              Download as Excel
            </button>
            <button
              disabled={totCartons === 0}
              onClick={() => handleDownloadPDF()}
              style={{
                fontSize: '14px',
                fontWeight: 500,
                padding: '10px 18px',
                background: 'white',
                color: '#1c1917',
                border: '0.5px solid #a8a29e',
                borderRadius: 6,
                cursor: totCartons === 0 ? 'not-allowed' : 'pointer',
                opacity: totCartons === 0 ? 0.4 : 1,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <FileText className="w-4 h-4" />
              Download as PDF
            </button>
            <button
              disabled={totCartons === 0}
              className="px-5 py-2.5 rounded bg-stone-900 text-white disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ fontSize: '14px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}
              onClick={() => setDraftModalOpen(true)}
            >
              <FilePlus className="w-4 h-4" />
              Create Draft Operation
            </button>
          </div>

          {/* Create Draft Purchase Modal */}
          <CreateDraftModal
            open={draftModalOpen}
            onClose={() => setDraftModalOpen(false)}
            groupId={selectedGroup!}
            groupName={detail.group.name}
            rows={detail.rows}
            finalCartons={finalCartons}
            finalUnits={finalUnits}
            finalAmount={finalAmount}
            totals={{ cartons: totCartons, units: totUnits, amount: anyAmount ? totAmount : 0 }}
            currency={currency}
            onCreated={(res) => {
              setDraftModalOpen(false);
              setDraftSuccess(res);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
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
  mode, baselinePallets, onModeChange,
}: {
  mode: SizingMode;
  baselinePallets: number;
  onModeChange: (mode: SizingMode) => void;
}) {
  const palletSelected = mode === 'pallet';
  const c20Selected = mode === '20ft';
  const c40Selected = mode === '40ft';

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {/* PALLETS — read-only display of natural reorder */}
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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontSize: 36, fontWeight: 500, color: palletSelected ? '#0C447C' : '#57534e', lineHeight: 1 }}>
            {baselinePallets.toFixed(1)}
          </div>
          <div style={{ fontSize: 14, fontWeight: 500, color: palletSelected ? '#0C447C' : '#57534e', letterSpacing: '0.3px' }}>
            PALLETS
          </div>
        </div>
        <div style={{ fontSize: 11, color: palletSelected ? '#185FA5' : '#78716c', marginTop: 6 }}>
          natural reorder
        </div>
      </button>

      {/* 20FT */}
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
          28 m³ — fill priority
        </div>
      </button>

      {/* 40HQ */}
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
          40HQ CONTAINER
        </div>
        <div style={{ fontSize: 11, color: c40Selected ? '#185FA5' : '#78716c', marginTop: 8 }}>
          76 m³ — fill priority
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
                    <button
                      title="Unlock — algorithm takes over"
                      onClick={() => onUnlock(r.base_sku)}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: '#854F0B', fontSize: 14, lineHeight: 1, width: 16, height: 16, display: isLocked ? 'flex' : 'none', alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Lock className="w-3.5 h-3.5" />
                    </button>
                    <span style={{ width: 16, visibility: 'hidden', display: isLocked ? 'none' : 'inline-block' }}>·</span>
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

// ============================================================
// CREATE DRAFT PURCHASE MODAL
// ============================================================
interface OptionsResponse {
  manufacturers: Array<{
    manufacturer_id: string;
    manufacturer_name: string;
    partner_id: string | null;
    trade_name: string | null;
    abbreviation: string | null;
    country: string | null;
  }>;
  companies: Array<{
    id: string;
    abbreviation: string | null;
    trade_name: string;
    jurisdiction: string | null;
    base_currency: string | null;
  }>;
  warehouses: Array<{ id: string; name: string; country: string | null }>;
  contracts: Array<{
    id: string;
    contract_no: string;
    partner_id: string;
    our_company_id: string;
    currency: string;
  }>;
}

interface CreateDraftResult {
  operation_id: string;
  reference: string;
  total_amount: number;
  currency: string;
  line_items_count: number;
  total_units: number;
}

function CreateDraftModal({
  open, onClose, groupId, groupName, rows, finalCartons, finalUnits, finalAmount, totals, currency, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  groupId: string;
  groupName: string;
  rows: PlannerRow[];
  finalCartons: (r: PlannerRow) => number;
  finalUnits: (r: PlannerRow) => number;
  finalAmount: (r: PlannerRow) => number | null;
  totals: { cartons: number; units: number; amount: number };
  currency: 'cny' | 'usd';
  onCreated: (res: CreateDraftResult) => void;
}) {
  const [opts, setOpts] = useState<OptionsResponse | null>(null);
  const [loadingOpts, setLoadingOpts] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Form state
  const [entityId, setEntityId] = useState<string>('dee');
  const [manufacturerPartnerId, setManufacturerPartnerId] = useState<string>('');
  const [contractId, setContractId] = useState<string>('');
  const [warehouseFromId, setWarehouseFromId] = useState<string>('');
  const [warehouseToId, setWarehouseToId] = useState<string>('');

  // Load options on open
  useEffect(() => {
    if (!open || opts) return;
    setLoadingOpts(true);
    apiGet<OptionsResponse>(`/api/planner/options?group=${groupId}`)
      .then((res) => {
        if (res.success && res.result) {
          setOpts(res.result);
          // Default manufacturer = first one
          const firstMfr = res.result.manufacturers[0];
          if (firstMfr?.partner_id) {
            setManufacturerPartnerId(firstMfr.partner_id);
          }
        } else {
          setSubmitError(res.errors[0]?.message ?? 'Failed to load options');
        }
      })
      .finally(() => setLoadingOpts(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, groupId]);

  // Currency derived from price toggle (CNY for direct, USD for DEI)
  const opCurrency = useMemo(() => currency.toUpperCase(), [currency]);

  // Auto-pick contract whenever (entity × partner × currency) changes
  useEffect(() => {
    if (!opts || !entityId || !manufacturerPartnerId) return;
    const matching = opts.contracts.filter(
      c => c.our_company_id === entityId
        && c.partner_id === manufacturerPartnerId
        && c.currency === opCurrency
    );
    if (matching.length > 0) {
      // Prefer one without /A suffix (main, not addendum)
      const main = matching.find(c => !/\/[Aa]/.test(c.contract_no)) ?? matching[0];
      setContractId(main.id);
    } else {
      setContractId('');
    }
  }, [opts, entityId, manufacturerPartnerId, opCurrency]);

  // Auto-pick warehouse_from based on manufacturer (YZH for Jinxia, GZH for paste factories)
  useEffect(() => {
    if (!manufacturerPartnerId) return;
    if (manufacturerPartnerId === 'jinxia') setWarehouseFromId('yzh');
    else setWarehouseFromId('gzh'); // honghui / wdaa / meizhiyuan
  }, [manufacturerPartnerId]);

  // Warehouse_to options filtered by entity
  const warehouseToOptions = useMemo(() => {
    if (!opts) return [];
    // Country mapping by entity
    const entityCountry: Record<string, string[]> = {
      dee: ['Russia'],
      dei: ['UAE'],
      dasean: ['Vietnam'],
      dec: [],
    };
    const allowed = entityCountry[entityId] ?? [];
    const factoryWh = warehouseFromId; // collection at source always allowed
    return opts.warehouses.filter(w => {
      if (w.id === factoryWh) return true;
      if (w.country && allowed.includes(w.country)) return true;
      return false;
    });
  }, [opts, entityId, warehouseFromId]);

  // Default warehouse_to when entity / mfr changes
  useEffect(() => {
    if (warehouseToOptions.length === 0) return;
    // Don't change if current selection is still valid
    if (warehouseToOptions.some(w => w.id === warehouseToId)) return;
    // Pick first non-factory destination
    const dest = warehouseToOptions.find(w => w.id !== warehouseFromId) ?? warehouseToOptions[0];
    setWarehouseToId(dest.id);
  }, [warehouseToOptions, warehouseFromId, warehouseToId]);

  // Computed reference preview — matches backend: {MfrCode}-YYMMDD{seq}
  // Seq is unknown until POST, so we show "?" placeholder.
  const referencePreview = useMemo(() => {
    if (!opts) return '—';
    const mfr = opts.manufacturers.find(m => m.partner_id === manufacturerPartnerId);
    if (!mfr) return '—';
    const d = new Date();
    const yy = String(d.getUTCFullYear()).slice(2);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mfrCodeMap: Record<string, string> = {
      jinxia: 'JINX', honghui: 'HHUI', wdaa: 'WDAA', meizhiyuan: 'MZHN',
    };
    const mfrCode = mfrCodeMap[mfr.partner_id || mfr.manufacturer_id]
      || (mfr.abbreviation || mfr.partner_id || mfr.manufacturer_id).toUpperCase();
    return `${mfrCode}-${yy}${mm}${dd}XX`;
  }, [opts, manufacturerPartnerId]);

  // Line items snapshot from planner final values
  const lineItemsToSend = useMemo(() => {
    return rows
      .filter(r => finalCartons(r) > 0)
      .map(r => ({
        product_id: r.base_sku,
        qty: finalUnits(r),
        cartons: finalCartons(r),
        unit_price: r.unit_price ?? 0,
      }));
  }, [rows, finalCartons, finalUnits]);

  async function handleSubmit() {
    if (!opts) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await apiPost<CreateDraftResult>('/api/planner/create-draft', {
        our_company_id: entityId,
        manufacturer_partner_id: manufacturerPartnerId,
        contract_id: contractId,
        warehouse_from_id: warehouseFromId,
        warehouse_to_id: warehouseToId,
        currency: opCurrency,
        operation_date: Math.floor(Date.now() / 1000),
        line_items: lineItemsToSend,
      });
      if (res.success && res.result) {
        onCreated(res.result);
      } else {
        setSubmitError(res.errors[0]?.message ?? 'Failed to create draft');
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const contractMatchFound = contractId !== '';

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'white', borderRadius: 12, maxWidth: 720, width: '100%',
          maxHeight: '90vh', overflow: 'auto', padding: 24, boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontSize: 18, fontWeight: 500 }}>Create Draft Purchase</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#a8a29e' }}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div style={{ fontSize: 13, color: '#78716c', marginBottom: 20 }}>
          <b>{groupName}</b> · {lineItemsToSend.length} SKUs · {totals.units.toLocaleString()} units · {fmtMoney(totals.amount, currency)}
        </div>

        {loadingOpts ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#a8a29e' }} />
          </div>
        ) : !opts ? (
          <div style={{ color: '#791F1F', padding: 12, fontSize: 13 }}>Failed to load options.</div>
        ) : (
          <>
            {/* Entity */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11.5, color: '#78716c', marginBottom: 6, letterSpacing: 0.3 }}>OUR ENTITY (BUYER)</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {opts.companies.map(c => {
                  const sel = c.id === entityId;
                  return (
                    <button
                      key={c.id}
                      onClick={() => setEntityId(c.id)}
                      style={{
                        flex: 1,
                        padding: 10,
                        border: sel ? '2px solid #185FA5' : '0.5px solid #d6d3d1',
                        background: sel ? '#E6F1FB' : 'white',
                        borderRadius: 6,
                        fontWeight: 500,
                        fontSize: 13.5,
                        color: sel ? '#0C447C' : '#57534e',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div>{(c.abbreviation || c.id).toUpperCase()}</div>
                      <div style={{ fontSize: 11, fontWeight: 400, color: sel ? '#185FA5' : '#78716c', marginTop: 2 }}>
                        {c.jurisdiction || '—'} · {c.base_currency || '—'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Manufacturer */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11.5, color: '#78716c', marginBottom: 6, letterSpacing: 0.3 }}>MANUFACTURER (SELLER)</div>
              <select
                value={manufacturerPartnerId}
                onChange={(e) => setManufacturerPartnerId(e.target.value)}
                style={{ width: '100%', padding: '9px 12px', border: '0.5px solid #a8a29e', borderRadius: 6, fontWeight: 700, fontSize: 13.5, background: 'white' }}
              >
                {opts.manufacturers.map(m => (
                  <option key={m.manufacturer_id} value={m.partner_id ?? m.manufacturer_id}>
                    {(m.trade_name || m.manufacturer_name)} — {m.abbreviation || m.manufacturer_id.toUpperCase()} ({m.country || ''})
                  </option>
                ))}
              </select>
            </div>

            {/* Contract */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11.5, color: '#78716c', marginBottom: 6, letterSpacing: 0.3 }}>CONTRACT</div>
              <select
                value={contractId}
                onChange={(e) => setContractId(e.target.value)}
                style={{ width: '100%', padding: '9px 12px', border: '0.5px solid ' + (contractMatchFound ? '#a8a29e' : '#F09595'), borderRadius: 6, fontWeight: 700, fontSize: 13.5, background: 'white' }}
              >
                {!contractMatchFound && <option value="">— no matching contract —</option>}
                {opts.contracts
                  .filter(c => c.our_company_id === entityId && c.partner_id === manufacturerPartnerId && c.currency === opCurrency)
                  .map(c => (
                    <option key={c.id} value={c.id}>
                      {c.contract_no} · {c.currency}
                    </option>
                  ))
                }
              </select>
              {contractMatchFound ? (
                <div style={{ fontSize: 11, color: '#639922', marginTop: 4 }}>
                  ✓ auto-picked by ({entityId.toUpperCase()} × {manufacturerPartnerId} × {opCurrency})
                </div>
              ) : (
                <div style={{ fontSize: 11, color: '#791F1F', marginTop: 4 }}>
                  ✗ no active contract for this combination. Create one in /partners first.
                </div>
              )}
            </div>

            {/* Warehouse From / To */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 11.5, color: '#78716c', marginBottom: 6, letterSpacing: 0.3 }}>WAREHOUSE FROM</div>
                <select
                  value={warehouseFromId}
                  onChange={(e) => setWarehouseFromId(e.target.value)}
                  style={{ width: '100%', padding: '9px 12px', border: '0.5px solid #a8a29e', borderRadius: 6, fontWeight: 700, fontSize: 13.5, background: 'white' }}
                >
                  {opts.warehouses.filter(w => ['gzh', 'yzh'].includes(w.id)).map(w => (
                    <option key={w.id} value={w.id}>{w.id.toUpperCase()} — {w.name}</option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: '#78716c', marginTop: 4 }}>factory warehouse</div>
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: '#78716c', marginBottom: 6, letterSpacing: 0.3 }}>WAREHOUSE TO</div>
                <select
                  value={warehouseToId}
                  onChange={(e) => setWarehouseToId(e.target.value)}
                  style={{ width: '100%', padding: '9px 12px', border: '0.5px solid #a8a29e', borderRadius: 6, fontWeight: 700, fontSize: 13.5, background: 'white' }}
                >
                  {warehouseToOptions.map(w => (
                    <option key={w.id} value={w.id}>
                      {w.id.toUpperCase()} — {w.name} ({w.country})
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: 11, color: '#78716c', marginTop: 4 }}>destination filtered by entity</div>
              </div>
            </div>

            {/* Reference preview */}
            <div style={{ background: '#FAFAF7', borderRadius: 6, padding: '12px 14px', marginBottom: 20 }}>
              <div style={{ fontSize: 11.5, color: '#78716c', letterSpacing: 0.3 }}>REFERENCE (AUTO)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#1c1c1c', marginTop: 2 }}>
                {referencePreview}
              </div>
            </div>

            {/* Submit error */}
            <div style={{ display: submitError ? 'block' : 'none', background: '#FCEBEB', border: '0.5px solid #F09595', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#791F1F', marginBottom: 16 }}>
              ⚠ {submitError}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingTop: 16, borderTop: '0.5px solid #e7e5e4' }}>
              <button
                onClick={onClose}
                disabled={submitting}
                style={{ background: 'transparent', border: 'none', color: '#57534e', fontSize: 13, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                disabled={!contractMatchFound || submitting || lineItemsToSend.length === 0}
                onClick={handleSubmit}
                style={{
                  background: '#1c1917', color: 'white', padding: '10px 20px',
                  border: 'none', borderRadius: 6, fontWeight: 500, fontSize: 13.5,
                  cursor: (contractMatchFound && !submitting) ? 'pointer' : 'not-allowed',
                  opacity: (contractMatchFound && !submitting && lineItemsToSend.length > 0) ? 1 : 0.4,
                  display: 'flex', alignItems: 'center', gap: 8,
                }}
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Create Draft {referencePreview} →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
