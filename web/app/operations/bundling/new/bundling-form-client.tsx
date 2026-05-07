'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

// =============================================================================
// SKU pair definitions — from_sku (single) → to_sku (bundle), ratio
// brushOnly = true means no swap (can only pack, not unpack)
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
  // Pastes 2-pack
  { fromSku: 'de201', fromName: 'SCHWARZ Paste 70ml',       toSku: 'de201aa', toName: 'SCHWARZ 2-pack',         ratio: 2 },
  { fromSku: 'de202', fromName: 'DETOX Paste 70ml',          toSku: 'de202aa', toName: 'DETOX 2-pack',           ratio: 2 },
  { fromSku: 'de203', fromName: 'GINGER FORCE Paste 70ml',   toSku: 'de203aa', toName: 'GINGER FORCE 2-pack',   ratio: 2 },
  { fromSku: 'de205', fromName: 'COCOCANNABIS Paste 70ml',   toSku: 'de205aa', toName: 'COCOCANNABIS 2-pack',   ratio: 2 },
  { fromSku: 'de206', fromName: 'SYMBIOS Paste 70ml',        toSku: 'de206aa', toName: 'SYMBIOS 2-pack',         ratio: 2 },
  { fromSku: 'de207', fromName: 'BUDDY MICROBIES Paste 50ml',toSku: 'de207aa', toName: 'BUDDY MICROBIES 2-pack', ratio: 2 },
  { fromSku: 'de208', fromName: 'EVOLUTION Kids Paste 50ml', toSku: 'de208aa', toName: 'EVOLUTION Kids 2-pack',  ratio: 2 },
  // Brushes (pack only)
  { fromSku: 'de101', fromName: 'ETALON Brush',              toSku: 'de101aa',   toName: 'ETALON 2in1',          ratio: 2,  brushOnly: true },
  { fromSku: 'de107', fromName: 'MITTEL Brush',              toSku: 'de107aaaa', toName: 'MITTEL 4in1',          ratio: 4,  brushOnly: true },
  { fromSku: 'de116', fromName: 'KRAFT Brush',               toSku: 'de116aaaa', toName: 'KRAFT 4in1',           ratio: 4,  brushOnly: true },
  { fromSku: 'de117', fromName: 'ZERO Brush',                toSku: 'de117aa',   toName: 'ZERO 2in1',            ratio: 2,  brushOnly: true },
  { fromSku: 'de119', fromName: 'GROSSE Brush',              toSku: 'de119aa',   toName: 'GROSSE 2in1',          ratio: 2,  brushOnly: true },
  { fromSku: 'de120', fromName: 'NANO MASSAGE Brush',        toSku: 'de120aaaa', toName: 'NANO MASSAGE 4in1',    ratio: 4,  brushOnly: true },
  { fromSku: 'de122', fromName: 'AKTIV Brush',               toSku: 'de122aaaa', toName: 'AKTIV 4in1',           ratio: 4,  brushOnly: true },
  { fromSku: 'de123', fromName: 'BIO Brush',                 toSku: 'de123aaaa', toName: 'BIO 4in1',             ratio: 4,  brushOnly: true },
];

const BUNDLING_WAREHOUSES = [
  { id: 'wh_lbr', label: 'wh_lbr — Люберцы' },
  { id: 'wh_flp', label: 'wh_flp — FlyPost' },
];

const COMPANY_MAP: Record<string, string> = {
  'wh_lbr': 'cmp_dee',
  'wh_flp': 'cmp_dee',
};

function fmt(n: number): string {
  return Math.round(n).toLocaleString('ru-RU');
}

const API_BASE = 'https://dasoperator-api.dasexperten.workers.dev';

export default function BundlingFormClient() {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = useState('wh_lbr');
  const [stocks, setStocks] = useState<Record<string, number>>({});
  const [loadingStocks, setLoadingStocks] = useState(false);
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [swapped, setSwapped] = useState<Record<number, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoadingStocks(true);
      try {
        const res = await fetch(`${API_BASE}/api/stocks?warehouse_id=${warehouseId}`);
        const d = await res.json() as { success: boolean; result?: { stocks?: Array<{ product_id: string; on_hand: number }> } };
        if (d.success && d.result?.stocks) {
          const map: Record<string, number> = {};
          for (const s of d.result.stocks) map[s.product_id] = s.on_hand;
          setStocks(map);
        }
      } catch { /* silent */ }
      setLoadingStocks(false);
    };
    load();
    setQtys({});
    setSwapped({});
  }, [warehouseId]);

  const handleSwap = (i: number) => {
    setSwapped(prev => ({ ...prev, [i]: !prev[i] }));
    setQtys(prev => ({ ...prev, [i]: 0 }));
  };

  const handleQty = (i: number, val: string) => {
    const n = Math.max(0, parseInt(val) || 0);
    setQtys(prev => ({ ...prev, [i]: n }));
  };

  const activeItems = SKU_PAIRS.map((pair, i) => {
    const sw = swapped[i] ?? false;
    const qty = qtys[i] ?? 0;
    if (qty === 0) return null;
    const fromSku = sw ? pair.toSku : pair.fromSku;
    const toSku   = sw ? pair.fromSku : pair.toSku;
    const gets    = sw ? qty * pair.ratio : Math.floor(qty / pair.ratio);
    const dir     = sw ? 'unpack' : 'pack';
    return { from_product_id: fromSku, to_product_id: toSku, from_qty: qty, to_qty: gets, direction: dir as 'pack' | 'unpack' };
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
          warehouse_id: warehouseId,
          our_company_id: COMPANY_MAP[warehouseId] ?? 'cmp_dee',
          items: activeItems,
        }),
      });
      const d = await res.json() as { success: boolean; result?: { id: string; reference: string }; errors?: Array<{ message: string }> };
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
                <col style={{ width: '28%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '5%' }} />
                <col style={{ width: '28%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '3%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-hairline)', backgroundColor: 'var(--paper-sunk)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }} id="th-from">Списать</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Остаток</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Qty</th>
                  <th />
                  <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Получить</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Остаток</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: '14px', color: 'var(--fg-2)', fontWeight: 500 }}>Получим</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {SKU_PAIRS.map((pair, i) => {
                  const sw = swapped[i] ?? false;
                  const fromSku  = sw ? pair.toSku  : pair.fromSku;
                  const fromName = sw ? pair.toName : pair.fromName;
                  const toSku    = sw ? pair.fromSku : pair.toSku;
                  const toName   = sw ? pair.fromName : pair.toName;
                  const fromStk  = stocks[fromSku] ?? 0;
                  const toStk    = stocks[toSku]   ?? 0;
                  const qty      = qtys[i] ?? 0;
                  const gets     = qty > 0 ? (sw ? qty * pair.ratio : Math.floor(qty / pair.ratio)) : 0;
                  const over     = qty > 0 && qty > fromStk;

                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-hairline)' }}>
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{fromName}</div>
                        <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{fromSku.toUpperCase()}</div>
                      </td>
                      <td style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(fromStk)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '8px 8px' }}>
                        <input
                          type="number"
                          min="0"
                          value={qty || ''}
                          placeholder="0"
                          onChange={e => handleQty(i, e.target.value)}
                          style={{
                            width: '64px',
                            textAlign: 'right',
                            padding: '4px 6px',
                            fontSize: '14px',
                            fontWeight: 700,
                            border: `1px solid ${over ? 'var(--brand-rot)' : 'var(--border-hairline)'}`,
                            borderRadius: 'var(--radius-sm)',
                            backgroundColor: 'var(--paper-sunk)',
                            color: over ? 'var(--brand-rot)' : 'var(--fg-1)',
                          }}
                        />
                      </td>
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
                      <td style={{ padding: '8px 12px' }}>
                        <div style={{ fontWeight: 700, color: 'var(--fg-1)' }}>{toName}</div>
                        <div style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{toSku.toUpperCase()}</div>
                      </td>
                      <td style={{ textAlign: 'right', padding: '8px 12px', color: 'var(--fg-3)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(toStk)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '8px 12px', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                        {gets > 0 ? (
                          <span style={{ color: 'var(--status-success)' }}>+{fmt(gets)}</span>
                        ) : (
                          <span style={{ color: 'var(--fg-3)' }}>—</span>
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
