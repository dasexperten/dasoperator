// =============================================================================
// Pricelist parser — Pricer skill is source of truth for product prices
//
// Architecture:
//   1. .md files live in R2 bucket "das-pricelists" (uploaded via sync script)
//   2. This module reads them on-demand, parses tables, returns price map
//   3. Parsed map cached in KV CACHE (key: pricelist:<file>, TTL: 1 hour)
//   4. KV miss → R2 fetch → parse → cache → return
//
// Mapping price_type_id → R2 filename:
//   pt_distr_rub    → PL-DISTR_RF.md   (Distributor RUB)
//   pt_distr_usd    → PL-DASEX-USD.md  (Distributor USD)
//   pt_export_usd   → PL-INT_USD.md    (Export USD generic)
//   pt_wb_ru        → PL-RSP_RF.md     (Russia retail / WB)
//   pt_cn_b2b       → PL-PRCH_CNY.md   (China factory B2B)
//
// Markdown format (parsed):
//   | SKU   | Product | Price (RUB) |
//   |-------|---------|-------------|
//   | DE201 | ...     | 102         |
//
// Returns: { "DE201": 102, "DE202": 102, ... }
//
// All prices are stored as decimal (102 not 10200). Caller converts to minor
// units if needed for D1 (multiply by 100, or 1 for VND/JPY/KRW).
// =============================================================================

import type { Env } from '../types';

export const PRICE_TYPE_TO_FILE: Record<string, string> = {
  pt_distr_rub:  'PL-DISTR_RF.md',
  pt_distr_usd:  'PL-DASEX-USD.md',
  pt_export_usd: 'PL-INT_USD.md',
  pt_wb_ru:      'PL-RSP_RF.md',
  pt_cn_b2b:     'PL-PRCH_CNY.md',
};

export const PRICE_TYPE_CURRENCY: Record<string, string> = {
  pt_distr_rub:  'RUB',
  pt_distr_usd:  'USD',
  pt_export_usd: 'USD',
  pt_wb_ru:      'RUB',
  pt_cn_b2b:     'CNY',
};

const CACHE_TTL_SECONDS = 3600;  // 1 hour

export interface Pricelist {
  filename: string;
  currency: string;
  lastUpdated: string;
  prices: Record<string, number>;  // SKU → price (decimal, not minor units)
  parsedAt: number;
}

/**
 * Parse markdown pricelist content into SKU→price map.
 * Looks for table rows like: | DE201 | ... | 102 |
 * Last numeric column wins (handles tables with extra columns).
 */
function parseMarkdownPricelist(filename: string, content: string): Pricelist {
  const lines = content.split('\n');
  const prices: Record<string, number> = {};

  // Detect currency from header
  let currency = 'USD';
  const currencyMatch = content.match(/\*\*Currency:\*\*\s*(\w+)/);
  if (currencyMatch && currencyMatch[1]) currency = currencyMatch[1];

  // Detect last updated
  let lastUpdated = '';
  const lastUpdatedMatch = content.match(/\*\*Last updated:\*\*\s*([^\n]+)/);
  if (lastUpdatedMatch && lastUpdatedMatch[1]) lastUpdated = lastUpdatedMatch[1].trim();

  // Parse table rows: | SKU | Product | Price |
  // Pattern: starts with |, has SKU like DE\d+ in first cell, ends with number in some cell
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    if (trimmed.includes('---')) continue;  // separator row

    const cells = trimmed.split('|').map((c) => c.trim()).filter((c) => c.length > 0);
    if (cells.length < 2) continue;

    const skuCandidate = cells[0];
    if (!skuCandidate) continue;
    if (!/^DE\d+[A-Z]*$/i.test(skuCandidate)) continue;  // must look like DE201, DE201AA

    // Find the last cell that parses as a positive number
    let price: number | null = null;
    for (let i = cells.length - 1; i >= 1; i--) {
      const cell = cells[i];
      if (!cell) continue;
      const num = parseFloat(cell.replace(/[,\s]/g, ''));
      if (!isNaN(num) && num > 0) {
        price = num;
        break;
      }
    }
    if (price === null) continue;

    prices[skuCandidate.toUpperCase()] = price;
  }

  return {
    filename,
    currency,
    lastUpdated,
    prices,
    parsedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Get parsed pricelist for a given price_type_id.
 * Reads from KV cache → R2 fallback → parse → cache → return.
 * Throws if R2 file missing or parse fails.
 */
export async function getPricelist(
  env: Env,
  priceTypeId: string,
): Promise<Pricelist> {
  const filename = PRICE_TYPE_TO_FILE[priceTypeId];
  if (!filename) {
    throw new Error(`Unknown price_type_id: ${priceTypeId}`);
  }

  const cacheKey = `pricelist:${filename}`;

  // Try KV cache first
  const cached = await env.CACHE.get(cacheKey, 'json') as Pricelist | null;
  if (cached) return cached;

  // Cache miss → fetch from R2
  const obj = await env.PRICELISTS.get(filename);
  if (!obj) {
    throw new Error(`Pricelist file not found in R2: ${filename}`);
  }

  const content = await obj.text();
  const parsed = parseMarkdownPricelist(filename, content);

  // Cache for 1 hour
  await env.CACHE.put(cacheKey, JSON.stringify(parsed), {
    expirationTtl: CACHE_TTL_SECONDS,
  });

  return parsed;
}

/**
 * Get a single price for a product+price_type pair.
 * Returns null if SKU not in this pricelist.
 */
export async function getProductPrice(
  env: Env,
  productId: string,
  priceTypeId: string,
): Promise<{ price: number; currency: string; source: string } | null> {
  // Normalize productId — could be "DE201" or "de201" or even with prd_ prefix (legacy)
  const sku = productId.replace(/^prd_/, '').toUpperCase();

  const pricelist = await getPricelist(env, priceTypeId);
  const price = pricelist.prices[sku];

  if (price === undefined) return null;

  return {
    price,
    currency: pricelist.currency,
    source: pricelist.filename,
  };
}

/**
 * Invalidate cache for a single pricelist (call after R2 upload via sync script).
 */
export async function invalidatePricelistCache(env: Env, priceTypeId: string): Promise<void> {
  const filename = PRICE_TYPE_TO_FILE[priceTypeId];
  if (!filename) return;
  await env.CACHE.delete(`pricelist:${filename}`);
}
