// =============================================================================
// Manual price overrides (Phase 2) — the editable zone×SKU matrix.
//
// Stored in the FX KV namespace under a single key so both this Worker and the
// checkout Worker read it cheaply:
//   fx:pricing:overrides  → JSON { [currency]: { [sku]: amount } }
//
// A present value is the FINAL price in that currency (no FX, no rounding) — it
// overrides the computed EUR×FX×rounding for that (currency, SKU) cell.
// =============================================================================

import type { Env } from '../types';
import type { Overrides } from '../pricing/resolver';

export const OVERRIDES_KEY = 'fx:pricing:overrides';

export async function readOverrides(env: Env): Promise<Overrides> {
  try {
    const raw = await env.FX.get(OVERRIDES_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Overrides;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

// Set (amount > 0) or clear (amount null) one cell. Returns the new map.
export async function setOverride(
  env: Env,
  currency: string,
  sku: string,
  amount: number | null
): Promise<Overrides> {
  const o = await readOverrides(env);
  if (amount == null || !(amount > 0)) {
    if (o[currency]) {
      delete o[currency][sku];
      if (Object.keys(o[currency]).length === 0) delete o[currency];
    }
  } else {
    if (!o[currency]) o[currency] = {};
    o[currency][sku] = amount;
  }
  await env.FX.put(OVERRIDES_KEY, JSON.stringify(o));
  return o;
}
