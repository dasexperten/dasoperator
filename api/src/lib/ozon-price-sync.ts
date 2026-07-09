// =============================================================================
// Ozon → RUB price sync.
//
// Pulls current Ozon Seller prices and writes them as manual RUB overrides
// (fx:pricing:overrides.RUB) so the storefront + checkout + Geo Price Matrix
// show exactly the Ozon price for the Russian market. One-way, read-only from
// Ozon (we never change anything on Ozon).
//
// Mapping: Ozon offer_id (uppercased) == our catalogue SKU (DE###). Only SKUs
// present in base-prices.json are touched; SKUs not on Ozon keep their existing
// manual/RSP override or the computed value.
//
// Price chosen: marketing_price (what the buyer sees after Ozon promos) when > 0,
// else the regular price.
// =============================================================================

import type { Env } from '../types';
import { readOverrides, OVERRIDES_KEY } from './pricing-overrides';
import basePrices from '../pricing/base-prices.json';

const OZON_PRICES_URL = 'https://api-seller.ozon.ru/v5/product/info/prices';
const KNOWN_SKUS = new Set(Object.keys((basePrices as { prices: Record<string, string> }).prices));

interface OzonPriceItem {
  offer_id?: string;
  price?: { price?: string | number; marketing_price?: string | number };
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
  updated: number;   // RUB overrides actually changed
  skus: string[];    // SKUs updated
  error?: string;
}

export async function syncOzonPricesToRub(env: Env): Promise<OzonSyncResult> {
  const clientId = env.OZON_CLIENT_ID;
  const apiKey = env.OZON_API_KEY;
  if (!clientId || !apiKey) return { ok: false, fetched: 0, matched: 0, updated: 0, skus: [], error: 'ozon_creds_missing' };

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
      if (!resp.ok) return { ok: false, fetched, matched: 0, updated: 0, skus: [], error: `ozon_http_${resp.status}` };
      const data = (await resp.json()) as { items?: OzonPriceItem[]; cursor?: string };
      const items = data.items || [];
      fetched += items.length;
      for (const it of items) {
        const oid = (it.offer_id || '').toUpperCase();
        if (!oid) continue;
        const price = num(it.price?.marketing_price) || num(it.price?.price);
        if (price > 0) byOffer[oid] = price;
      }
      cursor = data.cursor || '';
      if (!cursor || items.length === 0) break;
    }
  } catch (e) {
    return { ok: false, fetched, matched: 0, updated: 0, skus: [], error: e instanceof Error ? e.message : String(e) };
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
    if (unit > 0) priceBySku[sku] = Math.round(unit);
  }

  const matchedSkus = Object.keys(priceBySku);
  if (matchedSkus.length === 0) return { ok: true, fetched, matched: 0, updated: 0, skus: [] };

  // Merge into the RUB overrides in a single KV write.
  const overrides = await readOverrides(env);
  if (!overrides.RUB) overrides.RUB = {};
  const updated: string[] = [];
  for (const sku of matchedSkus) {
    const p = priceBySku[sku];
    if (p == null) continue;
    if (overrides.RUB[sku] !== p) {
      overrides.RUB[sku] = p;
      updated.push(sku);
    }
  }
  if (updated.length) await env.FX.put(OVERRIDES_KEY, JSON.stringify(overrides));

  return { ok: true, fetched, matched: matchedSkus.length, updated: updated.length, skus: updated.sort() };
}
