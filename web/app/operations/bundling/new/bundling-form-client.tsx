'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

// =============================================================================
// SKU pair definitions
// fromSku = single unit, toSku = bundle
// ratio: how many singles make one bundle
// brushOnly = no swap (pack direction only)
// =============================================================================
interface SkuPair {
  fromSku: string;
  fromName: string;
  toSku: string;
  toName: string;
  ratio: number;
  brushOnly?: boolean;
}

const SKU_PAIRS: SkuPair[] = [
  { fromSku: 'de201', fromName: 'SCHWARZ Paste 70ml',        toSku: 'de201aa',   toName: 'SCHWARZ 2-pack',          ratio: 2 },
  { fromSku: 'de202', fromName: 'DETOX Paste 70ml',           toSku: 'de202aa',   toName: 'DETOX 2-pack',            ratio: 2 },
  { fromSku: 'de203', fromName: 'GINGER FORCE Paste 70ml',    toSku: 'de203aa',   toName: 'GINGER FORCE 2-pack',     ratio: 2 },
  { fromSku: 'de205', fromName: 'COCOCANNABIS Paste 70ml',    toSku: 'de205aa',   toName: 'COCOCANNABIS 2-pack',     ratio: 2 },
  { fromSku: 'de206', fromName: 'SYMBIOS Paste 70ml',         toSku: 'de206aa',   toName: 'SYMBIOS 2-pack',          ratio: 2 },
  { fromSku: 'de207', fromName: 'BUDDY MICROBIES Paste 50ml', toSku: 'de207aa',   toName: 'BUDDY MICROBIES 2-pack',  ratio: 2 },
  { fromSku: 'de208', fromName: 'EVOLUTION Kids Paste 50ml',  toSku: 'de208aa',   toName: 'EVOLUTION Kids 2-pack',   ratio: 2 },
  { fromSku: 'de101', fromName: 'ETALON Brush',               toSku: 'de101aa',   toName: 'ETALON 2in1',             ratio: 2,  brushOnly: true },
  { fromSku: 'de107', fromName: 'MITTEL Brush',               toSku: 'de107aaaa', toName: 'MITTEL 4in1',             ratio: 4,  brushOnly: true },
  { fromSku: 'de116', fromName: 'KRAFT Brush',                toSku: 'de116aaaa', toName: 'KRAFT 4in1',              ratio: 4,  brushOnly: true },
  { fromSku: 'de117', fromName: 'ZERO Brush',                 toSku: 'de117aa',   toName: 'ZERO 2in1',               ratio: 2,  brushOnly: true },
  { fromSku: 'de119', fromName: 'GROSSE Brush',               toSku: 'de119aa',   toName: 'GROSSE 2in1',             ratio: 2,  brushOnly: true },
  { fromSku: 'de120', fromName: 'NANO MASSAGE Brush',         toSku: 'de120aaaa', toName: 'NANO MASSAGE 4in1',       ratio: 4,  brushOnly: true },
  { fromSku: 'de122', fromName: 'AKTIV Brush',                toSku: 'de122aaaa', toName: 'AKTIV 4in1',              ratio: 4,  brushOnly: true },
  { fromSku: 'de123', fromName: 'BIO Brush',                  toSku: 'de123aaaa', toName: 'BIO 4in1',                ratio: 4,  brushOnly: true },
];

const BUNDLING_WAREHOUSES = [
  { id: 'lbr', label: 'LBR — Люберцы' },
  { id: 'flp', label: 'FLP — FlyPost' },
];

const COMPANY_MAP: Record<string, string> = {
  'lbr': 'dee',
  'flp': 'dee',
};

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

function fmt(n: number): string {
  return Math.round(n).toLocaleString('ru-RU');
}

// =============================================================================
// Per-row state: either "from" side or "to" side was last edited.
// This lets the user drive from either column.
// =============================================================================
type RowInput = { side: 'from' | 'to'; value: number } | null;

export default function BundlingFormClient() {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState('lbr');
  const [stocks, setStocks] = useState<Record<string, number>>({});
  const [loadingStocks, setLoadingStocks] = useState(false);

  // rowInputs[i] = the last side + value the user typed for row i
  const [rowInputs, setRowInputs] = useState<Record<number, RowInput>>({});
  const [swapped, setSwapped] = useState<Record<number, boolean>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for Enter-key navigation: fromRefs[i] and toRefs[i]
  const fromRefs = useRef<(HTMLInputElement | null)[]>([]);
  const toRefs   = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    fromRefs.current = fromRefs.current.slice(0, SKU_PAIRS.length);
    toRefs.current   = toRefs.current.slice(0, SKU_PAIRS.length);
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoadingStocks(true);
      try {
        const res = await fetch(`${API_BASE}/api/stocks?warehouse_id=${warehouseId}`);
        const d = await res.json() as {
          success: boolean;
          result?: { stocks?: Array<{ product_id: string; on_hand: number }> };
        };
        if (d.success && d.result?.stocks) {
          const map: Record<string, number> = {};
          for (const s of d.result.stocks) map[s.product_id] = s.on_hand;
          setStocks(map);
        }
      } catch { /* silent */ }
      setLoadingStocks(false);
    };
    load();
    setRowInputs({});
    setSwapped({});
  }, [warehouseId]);

  const handleSwap = (i: number) => {
    setSwapped(prev => ({ ...prev, [i]: !prev[i] }));
    setRowInputs(prev => ({ ...prev, [i]: null }));
  };

  // Compute derived qty for a row given the input
  function deriveQtys(i: number, input: RowInput, sw: boolean) {
    const ratio = SKU_PAIRS[i]!.ratio;
    if (!input || input.value === 0) return { fromQty: 0, toQty: 0 };

    if (input.side === 'from') {
      const fromQty = input.value;
      const toQty   = sw ? fromQty * ratio : Math.floor(fromQty / ratio);
      return { fromQty, toQty };
    } else {
      // side === 'to': user told us how many bundles they want
      const toQty   = input.value;
      const fromQty = sw ? Math.floor(toQty / ratio) : toQty * ratio;
      return { fromQty, toQty };
    }
  }

  const handleFromChange = (i: number, val: string) => {
    const n = Math.max(0, parseInt(val) || 0);
    setRowInputs(prev => ({ ...prev, [i]: n > 0 ? { side: 'from', value: n } : null }));
  };

  const handleToChange = (i: number, val: string) => {
    const n = Math.max(0, parseInt(val) || 0);
    setRowInputs(prev => ({ ...prev, [i]: n > 0 ? { side: 'to', value: n } : null }));
  };

  // Enter key: move to next visible row in the same column
  const handleFromKeyDown = (i: number, e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    for (let j = i + 1; j < SKU_PAIRS.length; j++) {
      if (fromRefs.current[j]) { fromRefs.current[j]!.focus(); break; }
    }
  };

  const handleToKeyDown = (i: number, e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    for (let j = i + 1; j < SKU_PAIRS.length; j++) {
      // For brushOnly rows the "to" input doesn't exist — skip
      if (!SKU_PAIRS[j]?.brushOnly && toRefs.current[j]) {
        toRefs.current[j]!.focus();
        break;
      }
    }
  };

  const activeItems = SKU_PAIRS.map((pair, i) => {
    const sw    = swapped[i] ?? false;
    const input = rowInputs[i] ?? null;
    const { fromQty, toQty } = deriveQtys(i, input, sw);
    if (fromQty === 0 || toQty === 0) return null;
    const fromSku = sw ? pair.toSku   : pair.fromSku;
    const toSku   = sw ? pair.fromSku : pair.toSku;
    const dir     = sw ? 'unpack' : 'pack';
    return { from_product_id: fromSku, to_product_id: toSku, from_qty: fromQty, to_qty: toQty, direction: dir as 'pack' | 'unpack' };
  }).filter(Boolean);

  const totalFrom = activeItems.reduce((s, it) => s + (it?.from_qty ?? 0), 0);
  const totalTo   = activeItems.reduce((s, it) => s + (it?.to_qty   ?? 0), 0);

  const handleSubmit = async () => {
    if (activeItems.length === 0) { setError('Введи количество хотя бы в одной строке'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/bundling`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          warehouse_id:   warehouseId,
          our_company_id: COMPANY_MAP[warehouseId] ?? 'dee',
          items: activeItems,
        }),
      });
      const d = await res.json() as {
        success: boolean;
        result?: { id: string; reference: string };
        errors?: Array<{ message: string }>;
      };
      if (d.success && d.result) {
        router.push(`/operations/${d.result.id}`);
      } else {
        setError(d.errors?.[0]?.message ?? 'Failed to create bundling');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    }
    setSubmitting(false);
  };

  return (
    <div className="space-y-6">
      {/* HEADER */}
      <div>
        <p style={{ fontSize: '14px', color: 'var(--fg-2)' }}>bundling operation</p>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-display-md)', fontWeight: 900, color: 'var(--fg-1)', marginTop: '4px' }}>
          New Bundling
        </h1>
      </div>

      <div className="dx-ribbon-rule" />

      {/* WAREHOUSE */}
      <div>
        <p className="dx-section-label" style={{ marginBottom: '10px' }}>WAREHOUSE</p>
        <div className="flex gap-3 flex-wrap">
          {BUNDLING_WAREHOUSES.map(wh => (
            <button
              key={wh.id}
              onClick={() => setWarehouseId(wh.id)}
              style={{
                padding: '10px 18px',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${warehouseId === wh.id ? 'var(--brand-rot)' : 'var(--border-hairline)'}`,
                backgroundColor: warehouseId === wh.id ? 'var(--brand-rot)' : 'var(--paper)',
                color: warehouseId === wh.id ? 'var(--paper)' : 'var(--fg-1)',
                fontWeight: 700,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              {wh.label}
            </button>
          ))}
        </div>
      </div>

      {/* TABLE */}
      <div>
        <p className="dx-section-label" style={{ marginBottom: '10px' }}>POSITIONS</p>
        <div style={{ border: '1px solid var(--border-hairline)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {loadingStocks ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--fg-3)' }} />
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '25%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '5%' }} />
                <col style={{ width: '25%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '5%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
                  <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Списать</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Остаток</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Qty</th>
                  <th />
                  <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Получить</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Остаток</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Получим</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {SKU_PAIRS.map((pair, i) => {
                  const sw     = swapped[i] ?? false;
                  const input  = rowInputs[i] ?? null;
                  const { fromQty, toQty } = deriveQtys(i, input, sw);

                  const fromSku  = sw ? pair.toSku   : pair.fromSku;
                  const fromName = sw ? pair.toName  : pair.fromName;
                  const toSku    = sw ? pair.fromSku : pair.toSku;
                  const toName   = sw ? pair.fromName: pair.toName;
                  const fromStk  = stocks[fromSku] ?? 0;
                  const toStk    = stocks[toSku]   ?? 0;
                  const over     = fromQty > 0 && fromQty > fromStk;

                  // Display values in inputs — show the one the user typed,
                  // show the derived one as a calculated value in the other field
                  const fromDisplay = input?.side === 'from' ? input.value : (fromQty > 0 ? fromQty : '');
                  const toDisplay   = input?.side === 'to'   ? input.value : (toQty   > 0 ? toQty   : '');

                  const inputStyle = (active: boolean, warn: boolean) => ({
                    width: '80px',
                    textAlign: 'right' as const,
                    padding: '4px 6px',
                    fontSize: '14px',
                    fontWeight: 700,
                    border: `1px solid ${warn ? 'var(--brand-rot)' : active ? 'var(--fg-2)' : 'var(--border-hairline)'}`,
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: active ? 'var(--paper)' : 'var(--paper-sunk)',
                    color: warn ? 'var(--brand-rot)' : 'var(--fg-1)',
                    outline: 'none',
                  });

                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      {/* FROM name */}
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{fromName}</div>
                        <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{fromSku.toUpperCase()}</div>
                      </td>
                      {/* FROM stock */}
                      <td style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                        {fmt(fromStk)}
                      </td>
                      {/* FROM qty input */}
                      <td style={{ textAlign: 'right', padding: '8px 8px' }}>
                        <input
                          ref={el => { fromRefs.current[i] = el; }}
                          type="number"
                          min="0"
                          value={fromDisplay}
                          placeholder="0"
                          onChange={e => handleFromChange(i, e.target.value)}
                          onKeyDown={e => handleFromKeyDown(i, e)}
                          style={inputStyle(input?.side === 'from', over)}
                        />
                      </td>
                      {/* SWAP / ARROW */}
                      <td style={{ textAlign: 'center', padding: '0 4px' }}>
                        {pair.brushOnly ? (
                          <span style={{ color: 'var(--fg-3)', fontSize: '16px' }}>→</span>
                        ) : (
                          <button
                            onClick={() => handleSwap(i)}
                            title="Поменять направление"
                            style={{
                              width: '28px', height: '28px',
                              borderRadius: '50%',
                              border: '1px solid var(--border-hairline)',
                              backgroundColor: 'var(--paper-sunk)',
                              cursor: 'pointer',
                              fontSize: '14px',
                              color: 'var(--fg-2)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            ⇄
                          </button>
                        )}
                      </td>
                      {/* TO name */}
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{toName}</div>
                        <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{toSku.toUpperCase()}</div>
                      </td>
                      {/* TO stock */}
                      <td style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                        {fmt(toStk)}
                      </td>
                      {/* TO qty — editable for pastes, read-only display for brushes */}
                      <td style={{ textAlign: 'right', padding: '8px 8px' }}>
                        {pair.brushOnly ? (
                          // Brushes: show derived result, not editable
                          toQty > 0 ? (
                            <span style={{ color: 'var(--status-success)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                              +{fmt(toQty)}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--fg-3)' }}>—</span>
                          )
                        ) : (
                          // Pastes: editable from either side
                          <input
                            ref={el => { toRefs.current[i] = el; }}
                            type="number"
                            min="0"
                            value={toDisplay}
                            placeholder="0"
                            onChange={e => handleToChange(i, e.target.value)}
                            onKeyDown={e => handleToKeyDown(i, e)}
                            style={{
                              ...inputStyle(input?.side === 'to', false),
                              color: toQty > 0 ? 'var(--status-success)' : 'var(--fg-3)',
                            }}
                          />
                        )}
                      </td>
                      <td />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* SUMMARY + SUBMIT */}
      {activeItems.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ fontSize: '14px', color: 'var(--fg-2)' }}>
            <span style={{ color: 'var(--brand-rot)', fontWeight: 700 }}>−{fmt(totalFrom)}</span>
            <span style={{ color: 'var(--fg-3)', margin: '0 8px' }}>списывается</span>
            <span style={{ color: 'var(--status-success)', fontWeight: 700 }}>+{fmt(totalTo)}</span>
            <span style={{ color: 'var(--fg-3)', marginLeft: '8px' }}>зачисляется</span>
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              padding: '10px 24px',
              backgroundColor: 'var(--brand-rot)',
              color: 'var(--paper)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              fontWeight: 700,
              fontSize: '14px',
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Зафиксировать bundling
          </button>
        </div>
      )}

      {error && (
        <p style={{ color: 'var(--brand-rot)', fontSize: '14px' }}>{error}</p>
      )}
    </div>
  );
}
