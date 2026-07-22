// =============================================================================
// COGS-RU — Russia landed cost per offer unit (Justina + Zina)
//
// Owner 2026-07-22:
//   factory  = Purchasing CNY→USD or Purchasing USD (multipack already priced
//              as offer unit when present; else base × bundle_size)
//   freight  = $6,000 / 20'GP practical 85% fill by packing norms (Zina)
//   duty     = paste 6.5%; brush / floss / other 15% on (factory + freight)
//   CZ mark  = 3 RUB × physical paste tubes (bundle_size) — Honest Sign:
//              QR + China side + 1 RUB
//   VAT 22%  = NOT in COGS (recoverable import VAT)
//   result   = RUB at latest CBR FX
// =============================================================================

export const COGS_RU_PRICE_TYPE_ID = 'cogs_ru';
export const COGS_RU_CONTAINER_USD = 6000;
export const COGS_RU_MARK_RUB_PER_PASTE_TUBE = 3;

const CONTAINER_CBM = 33.2;
const CONTAINER_KG = 21800;
const PRACTICAL_FILL = 0.85;

function unitsPer20gp(cbm: number, units: number, kg?: number): number {
  const byCube = Math.floor((CONTAINER_CBM / cbm) * PRACTICAL_FILL);
  const ctns =
    kg != null ? Math.min(byCube, Math.floor((CONTAINER_KG / kg) * PRACTICAL_FILL)) : byCube;
  return ctns * units;
}

/** Freight USD per single physical unit (or per multipack for 4-pack masters). */
export const COGS_RU_FREIGHT = {
  paste_tube: COGS_RU_CONTAINER_USD / unitsPer20gp(0.365 * 0.325 * 0.34, 288),
  brush_single: COGS_RU_CONTAINER_USD / unitsPer20gp(0.41 * 0.38 * 0.25, 288, 8.5),
  floss: COGS_RU_CONTAINER_USD / unitsPer20gp(0.41 * 0.38 * 0.25, 288, 8.0),
  brush_4pack_offer: COGS_RU_CONTAINER_USD / unitsPer20gp(0.52 * 0.43 * 0.25, 144),
} as const;

export type CogsGroup = 'paste' | 'brush' | 'floss' | 'mouthwash' | 'other';

export function cogsGroup(category: string | null | undefined, productId: string): CogsGroup {
  const c = (category || '').toLowerCase();
  const s = productId.toLowerCase();
  if (s === 'de310' || c.includes('mouth')) return 'mouthwash';
  if (c.includes('paste') || s.startsWith('de2')) return 'paste';
  if (c.includes('floss')) return 'floss';
  if (c.includes('brush') || s.startsWith('de1')) return 'brush';
  return 'other';
}

export interface CogsRuInput {
  productId: string;
  category: string | null;
  bundleSize: number;
  /** Factory cost already for the offer unit (multipack if applicable), USD */
  factoryUsd: number;
  rubPerUsd: number;
}

export interface CogsRuBreakdown {
  product_id: string;
  group: CogsGroup;
  bundle_size: number;
  factory_usd: number;
  freight_usd: number;
  duty_rate: number;
  duty_usd: number;
  mark_rub: number;
  cogs_usd_ex_mark: number;
  cogs_rub: number;
  formula: string;
}

export function computeCogsRu(input: CogsRuInput): CogsRuBreakdown {
  const bundle = Math.max(1, Math.floor(input.bundleSize || 1));
  const group = cogsGroup(input.category, input.productId);

  let freightUsd: number;
  let dutyRate: number;
  let markRub: number;

  if (group === 'paste') {
    freightUsd = COGS_RU_FREIGHT.paste_tube * bundle;
    dutyRate = 0.065;
    markRub = COGS_RU_MARK_RUB_PER_PASTE_TUBE * bundle;
  } else if (group === 'floss') {
    freightUsd = COGS_RU_FREIGHT.floss * bundle;
    dutyRate = 0.15;
    markRub = 0;
  } else if (group === 'brush') {
    freightUsd = bundle >= 4 ? COGS_RU_FREIGHT.brush_4pack_offer : COGS_RU_FREIGHT.brush_single * bundle;
    dutyRate = 0.15;
    markRub = 0;
  } else {
    // mouthwash / other — non-paste duty; paste-like freight for volume products
    freightUsd = COGS_RU_FREIGHT.paste_tube * bundle;
    dutyRate = 0.15;
    markRub = 0;
  }

  const cv = input.factoryUsd + freightUsd;
  const dutyUsd = cv * dutyRate;
  const cogsUsdExMark = cv + dutyUsd;
  const cogsRub = Math.round((cogsUsdExMark * input.rubPerUsd + markRub) * 100) / 100;

  return {
    product_id: input.productId,
    group,
    bundle_size: bundle,
    factory_usd: input.factoryUsd,
    freight_usd: freightUsd,
    duty_rate: dutyRate,
    duty_usd: dutyUsd,
    mark_rub: markRub,
    cogs_usd_ex_mark: cogsUsdExMark,
    cogs_rub: cogsRub,
    formula:
      'CV=factory+freight; duty=CV×rate; COGS-RUB=CV×FX+duty×FX+CZ; VAT22% excluded',
  };
}
