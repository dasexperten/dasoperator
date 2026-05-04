// =============================================================================
// Products pricing — auto-fill price for (product, contract) pair
//
// Resolution chain:
//   contract → partner → partner.price_type_id
//   then product_prices(product_id, price_type_id) → most recent active row
//
// Returns price in minor units, currency from contract.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const productsPricing = new Hono<{ Bindings: Env }>();

interface PricingContext {
  price_type_id: string | null;
  currency: string;
}

interface PriceRow {
  sell_price: number;
  currency: string;
  effective_from: number;
  effective_until: number | null;
}

// =============================================================================
// GET /api/products/:productId/price?contract_id=ctr_xxx
// =============================================================================
productsPricing.get('/:productId/price', async (c) => {
  const productId = c.req.param('productId');
  const contractId = c.req.query('contract_id');

  if (!contractId) {
    return fail(c, 400, [{
      code: 'missing_contract_id',
      message: 'contract_id query param is required',
    }]);
  }

  // Fetch contract → partner → price_type chain in one JOIN
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

  if (!ctx.price_type_id) {
    return ok(c, {
      price: null,
      currency: ctx.currency,
      source: 'no_price_type',
    }, ['Partner has no price_type assigned — price cannot be auto-filled']);
  }

  // Most recent active price for (product, price_type)
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
  `).bind(productId, ctx.price_type_id, now, now).first<PriceRow>();

  if (!priceRow) {
    return ok(c, {
      price: null,
      currency: ctx.currency,
      source: 'not_found',
      price_type_id: ctx.price_type_id,
    }, [`No active price for product ${productId} in price_type ${ctx.price_type_id}`]);
  }

  return ok(c, {
    price: priceRow.sell_price,
    currency: priceRow.currency,
    source: 'price_list',
    price_type_id: ctx.price_type_id,
    effective_from: priceRow.effective_from,
    effective_until: priceRow.effective_until,
  });
});

export default productsPricing;
