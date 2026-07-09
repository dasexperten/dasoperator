// =============================================================================
// Ozon → RUB price sync.
//
// Pulls current Ozon Seller prices and writes them into the AUTO override layer
// (fx:pricing:auto.RUB) so the storefront + checkout + Geo Price Matrix show the
// Ozon price for the Russian market. One-way, read-only from Ozon.
//
// LOCK RULE: a cell that was set by hand (manual layer, fx:pricing:overrides) is
// LOCKED — the sync never overwrites it. It writes/refreshes only unlocked cells.
//
// Mapping: Ozon offer_id (uppercased) == our SKU (DE###). Pack-only SKUs derive
// the per-unit price: DE###AA = 2-pack (/2), DE###AAAA = 4-pack (/4). Final RUB =
// Ozon price × (1 − OZON_BUYER_DISCOUNT) — the actual Ozon-Card buyer price.
// =============================================================================

import type { Env } from '../types';
import { readOverrides, readAuto, writeAuto } from './pricing-overrides';
import basePrices from '../pricing/base-prices.json';

const OZON_PRICES_URL = 'https://api-seller.ozon.ru/v5/product/info/prices';
const KNOWN_SKUS = new Set(Object.keys((basePrices as { prices: Record<string, string> }).prices));

// Extra Ozon buyer discount (Ozon Card etc.) NOT reflected in the API price
// field — the actual price a buyer pays is price × (1 − this). Owner-set.
const OZON_BUYER_DISCOUNT = 0.45;

interface OzonPriceItem {
  offer_id?: string;
  price?: { price?: string | number; marketing_seller_price?: string | number };
}

function num(v: string | number | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export interface OzonSyncResult {
  ok: boolean;
  fetched: number;   // Ozon items seen
  matched: number;   // mapped to a known SKU with a positive price
  updated: number;   // RUB auto values actually changed
  locked: number;    // SKUs skipped because a manual RUB override is locked
  skus: string[];    // SKUs updated
  error?: string;
}

export async function syncOzonPricesToRub(env: Env): Promise<OzonSyncResult> {
  const clientId = env.OZON_CLIENT_ID;
  const apiKey = env.OZON_API_KEY;
  if (!clientId || !apiKey) return { ok: false, fetched: 0, matched: 0, updated: 0, locked: 0, skus: [], error: 'ozon_creds_missing' };

  // Collect every Ozon offer_id → buyer price. Some SKUs are sold only as
  // multi-packs: offer_id "DE###AA" = 2-pack, "DE###AAAA" = 4-pack. For those we
  // derive the single-unit price (pack price / pack size).
  const byOffer: Record<string, number> = {};
  let fetched = 0;
  let cursor = '';

  try {
    for (let page = 0; page < 50; page++) {
      const resp = await fetch(OZON_PRICES_URL, {
        method: 'POST',
        headers: { 'Client-Id': String(clientId), 'Api-Key': String(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor, limit: 1000, filter: { visibility: 'ALL' } }),
      });
      if (!resp.ok) return { ok: false, fetched, matched: 0, updated: 0, locked: 0, skus: [], error: `ozon_http_${resp.status}` };
      const data = (await resp.json()) as { items?: OzonPriceItem[]; cursor?: string };
      const items = data.items || [];
      fetched += items.length;
      for (const it of items) {
        const oid = (it.offer_id || '').toUpperCase();
        if (!oid) continue;
        const price = num(it.price?.price) || num(it.price?.marketing_seller_price);
        if (price > 0) byOffer[oid] = price;
      }
      cursor = data.cursor || '';
      if (!cursor || items.length === 0) break;
    }
  } catch (e) {
    return { ok: false, fetched, matched: 0, updated: 0, locked: 0, skus: [], error: e instanceof Error ? e.message : String(e) };
  }

  // Resolve per-unit RUB for each known SKU: single, else 2-pack (AA)/2, else 4-pack (AAAA)/4.
  const priceBySku: Record<string, number> = {};
  for (const sku of KNOWN_SKUS) {
    const single = byOffer[sku] ?? 0;
    const pack2 = byOffer[sku + 'AA'] ?? 0;    // 2-pack
    const pack4 = byOffer[sku + 'AAAA'] ?? 0;  // 4-pack
    let unit = 0;
    if (single > 0) unit = single;
    else if (pack2 > 0) unit = pack2 / 2;
    else if (pack4 > 0) unit = pack4 / 4;
    // Apply the Ozon buyer discount that the API price doesn't include.
    if (unit > 0) priceBySku[sku] = Math.round(unit * (1 - OZON_BUYER_DISCOUNT));
  }

  const matchedSkus = Object.keys(priceBySku);
  if (matchedSkus.length === 0) return { ok: true, fetched, matched: 0, updated: 0, locked: 0, skus: [] };

  // Write into the AUTO layer only. Skip any SKU with a LOCKED manual RUB override.
  const [manual, auto] = await Promise.all([readOverrides(env), readAuto(env)]);
  const lockedRub = manual.RUB || {};
  if (!auto.RUB) auto.RUB = {};
  const updated: string[] = [];
  let locked = 0;
  for (const sku of matchedSkus) {
    const p = priceBySku[sku];
    if (p == null) continue;
    if (lockedRub[sku] != null) { locked++; continue; } // hand-set → never touch
    if (auto.RUB[sku] !== p) {
      auto.RUB[sku] = p;
      updated.push(sku);
    }
  }
  if (updated.length) await writeAuto(env, auto);

  return { ok: true, fetched, matched: matchedSkus.length, updated: updated.length, locked, skus: updated.sort() };
}
