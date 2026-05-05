// =============================================================================
// Products pricing — auto-fill price for (product, contract) pair
//
// Resolution chain:
//   contract → partner → partner.price_type_id
//   then Pricer R2 pricelist → SKU lookup
//   fallback: D1 product_prices (legacy seed data)
//
// Phase 5.1-pricer-r2: R2-first, D1 fallback.
// Pricer skill = source of truth. Edit .md → re-upload to R2 → cache invalidate.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { getProductPrice } from '../lib/pricelist';

const productsPricing = new Hono<{ Bindings: Env }>();

interface PricingContext {
  price_type_id: string | null;
  currency: string;
}

interface DbPriceRow {
  sell_price: number;
  currency: string;
  effective_from: number;
  effective_until: number | null;
}

// =============================================================================
// GET /api/products/:productId/price?contract_id=ctr_xxx
//   OR  /api/products/:productId/price?price_type_id=pt_distr_rub  (direct)
// =============================================================================
productsPricing.get('/:productId/price', async (c) => {
  const productId = c.req.param('productId');
  const contractId = c.req.query('contract_id');
  const directPriceTypeId = c.req.query('price_type_id');

  let priceTypeId: string | null = null;
  let contractCurrency: string | null = null;

  if (directPriceTypeId) {
    priceTypeId = directPriceTypeId;
  } else if (contractId) {
    const ctx = await c.env.DB.prepare(`
      SELECT p.price_type_id, c.currency
      FROM contracts c
      JOIN partners p ON c.partner_id = p.id
      WHERE c.id = ? AND c.deleted_at IS NULL AND p.deleted_at IS NULL
    `).bind(contractId).first<PricingContext>();

    if (!ctx) {
      return fail(c, 404, [{
        code: 'contract_not_found',
        message: `Contract ${contractId} not found or partner missing`,
      }]);
    }

    priceTypeId = ctx.price_type_id;
    contractCurrency = ctx.currency;

    if (!priceTypeId) {
      return ok(c, {
        price: null,
        currency: contractCurrency,
        source: 'no_price_type',
      }, ['Partner has no price_type assigned — price cannot be auto-filled']);
    }
  } else {
    return fail(c, 400, [{
      code: 'missing_query',
      message: 'Either contract_id or price_type_id query param is required',
    }]);
  }

  // STEP 1: try R2 pricelist (source of truth)
  try {
    const r2Price = await getProductPrice(c.env, productId, priceTypeId);
    if (r2Price) {
      const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(r2Price.currency);
      const minorFactor = isZeroDecimal ? 1 : 100;
      const sellPriceMinor = Math.round(r2Price.price * minorFactor);
      return ok(c, {
        price: sellPriceMinor,
        currency: r2Price.currency,
        source: 'pricer_r2',
        source_file: r2Price.source,
        price_type_id: priceTypeId,
      });
    }
  } catch (err) {
    console.warn(`R2 pricelist read failed for ${productId}/${priceTypeId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // STEP 2: fallback to D1 product_prices
  const now = Math.floor(Date.now() / 1000);
  const priceRow = await c.env.DB.prepare(`
    SELECT sell_price, currency, effective_from, effective_until
    FROM product_prices
    WHERE product_id = ?
      AND price_type_id = ?
      AND effective_from <= ?
      AND (effective_until IS NULL OR effective_until > ?)
    ORDER BY effective_from DESC
    LIMIT 1
  `).bind(productId, priceTypeId, now, now).first<DbPriceRow>();

  if (!priceRow) {
    return ok(c, {
      price: null,
      currency: contractCurrency,
      source: 'not_found',
      price_type_id: priceTypeId,
    }, [`No price for product ${productId} in price_type ${priceTypeId} (R2 and D1 both empty)`]);
  }

  return ok(c, {
    price: priceRow.sell_price,
    currency: priceRow.currency,
    source: 'd1_fallback',
    price_type_id: priceTypeId,
    effective_from: priceRow.effective_from,
    effective_until: priceRow.effective_until,
  });
});

export default productsPricing;
