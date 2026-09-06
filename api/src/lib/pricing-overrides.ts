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

// Two layers, both { [currency]: { [sku]: amount } }:
//   fx:pricing:overrides  — MANUAL hand edits. LOCKED: never auto-synced/overwritten.
//   fx:pricing:auto       — AUTO writes (e.g. the Ozon sync). Refreshed by crons.
// Effective price = auto, then manual wins per cell.
export const OVERRIDES_KEY = 'fx:pricing:overrides';
export const AUTO_KEY = 'fx:pricing:auto';

// Owner-approved Philippines INNOWEISS test: PHP 499 for exactly seven days
// from 2026-09-04 09:46 UTC. The old override store has no validity field, so
// the central read path closes this one legacy test safely. It only rolls back
// the exact unchanged test tuple; a later Owner edit to any other amount wins.
export const PH_INNOWEISS_TEST_END_UTC = '2026-09-11T09:46:00Z';
const PH_INNOWEISS_TEST_PRICE = 499;
const PH_INNOWEISS_RETURN_PRICE = 1849;

async function readMap(env: Env, key: string): Promise<Overrides> {
  try {
    const raw = await env.FX.get(key);
    if (!raw) return {};
    const o = JSON.parse(raw) as Overrides;
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export function readOverrides(env: Env): Promise<Overrides> { return readMap(env, OVERRIDES_KEY); }
export function readAuto(env: Env): Promise<Overrides> { return readMap(env, AUTO_KEY); }

// Merge auto + manual → effective (manual wins per cell).
export function mergeLayers(auto: Overrides, manual: Overrides): Overrides {
  const out: Overrides = {};
  for (const src of [auto, manual]) {
    for (const cur of Object.keys(src)) {
      out[cur] = { ...(out[cur] || {}), ...src[cur] };
    }
  }
  return out;
}

export function closeExpiredApprovedPriceTests(
  manual: Overrides,
  nowMs = Date.now()
): { manual: Overrides; changed: boolean } {
  if (nowMs < Date.parse(PH_INNOWEISS_TEST_END_UTC)) return { manual, changed: false };
  if (manual.PHP?.DE210 !== PH_INNOWEISS_TEST_PRICE) return { manual, changed: false };
  return {
    manual: {
      ...manual,
      PHP: { ...manual.PHP, DE210: PH_INNOWEISS_RETURN_PRICE },
    },
    changed: true,
  };
}

// Read both layers + the effective merge in one shot.
export async function readEffective(
  env: Env
): Promise<{ effective: Overrides; manual: Overrides; auto: Overrides }> {
  let [manual, auto] = await Promise.all([readOverrides(env), readAuto(env)]);
  const expiry = closeExpiredApprovedPriceTests(manual);
  if (expiry.changed) {
    manual = expiry.manual;
    await env.FX.put(OVERRIDES_KEY, JSON.stringify(manual));
  }
  return { effective: mergeLayers(auto, manual), manual, auto };
}

// Overwrite the whole AUTO layer (used by sync jobs).
export async function writeAuto(env: Env, auto: Overrides): Promise<void> {
  await env.FX.put(AUTO_KEY, JSON.stringify(auto));
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
