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

  // SINGLE SOURCE OF TRUTH: D1 product_prices.
  // R2 .md pricelists kept as archive only; no code reads them anymore.
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
    }, [`No price for product ${productId} in price_type ${priceTypeId} (no D1 row)`]);
  }

  return ok(c, {
    price: priceRow.sell_price,
    currency: priceRow.currency,
    source: 'd1',
    price_type_id: priceTypeId,
    effective_from: priceRow.effective_from,
    effective_until: priceRow.effective_until,
  });
});

export default productsPricing;

// =============================================================================
// POST /api/products/:productId/prices — add a new price row in D1
// Body: { price_type_id, sell_price, effective_from?, effective_until?, notes? }
// Currency is read from the price_type — no need to send it.
// If an active price already exists for the same price_type_id, it gets
// closed (effective_until = effective_from of the new one) so we don't have
// overlapping active rows.
// =============================================================================
import { z } from 'zod';

const newPriceSchema = z.object({
  price_type_id: z.string().min(1),
  sell_price: z.number().min(0),
  effective_from: z.number().int().optional(),
  effective_until: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
});

productsPricing.post('/:productId/prices', async (c) => {
  const productId = c.req.param('productId').toLowerCase();
  const body = await c.req.json().catch(() => null);
  if (!body) return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);

  const parsed = newPriceSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, [{ code: 'invalid_body', message: 'Validation failed', details: { issues: parsed.error.issues } }]);
  }
  const data = parsed.data;

  // Verify product
  const product = await c.env.DB.prepare('SELECT id FROM products WHERE id = ? AND deleted_at IS NULL').bind(productId).first();
  if (!product) {
    return fail(c, 404, [{ code: 'product_not_found', message: `Product ${productId} not found` }]);
  }

  // Look up price_type to get its currency
  const pt = await c.env.DB.prepare('SELECT id, currency FROM price_types WHERE id = ?').bind(data.price_type_id).first<{ id: string; currency: string }>();
  if (!pt) {
    return fail(c, 400, [{ code: 'invalid_price_type', message: `price_type ${data.price_type_id} does not exist` }]);
  }

  const now = Math.floor(Date.now() / 1000);
  const effectiveFrom = data.effective_from ?? now;
  const effectiveUntil = data.effective_until ?? null;
  const id = `price_${crypto.randomUUID()}`;

  // Close any currently-active row for this product+price_type by setting
  // effective_until to (new effective_from - 1) — keeps history clean.
  await c.env.DB.prepare(`
    UPDATE product_prices
    SET effective_until = ?, updated_at = ?
    WHERE product_id = ?
      AND price_type_id = ?
      AND (effective_until IS NULL OR effective_until > ?)
      AND effective_from < ?
  `).bind(effectiveFrom - 1, now, productId, data.price_type_id, effectiveFrom, effectiveFrom).run();

  // Insert the new row
  await c.env.DB.prepare(`
    INSERT INTO product_prices (id, product_id, price_type_id, sell_price, currency, effective_from, effective_until, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, productId, data.price_type_id, data.sell_price, pt.currency, effectiveFrom, effectiveUntil, data.notes ?? null, now, now).run();

  const created = await c.env.DB.prepare(`
    SELECT pp.*, pt.code AS price_type_code, pt.description AS price_type_description, pt.used_by_entity
    FROM product_prices pp
    JOIN price_types pt ON pp.price_type_id = pt.id
    WHERE pp.id = ?
  `).bind(id).first();

  return ok(c, created);
});


// =============================================================================
// PATCH /api/products/:productId/prices/:priceId — update an existing price
// Body: { sell_price?, effective_from?, effective_until?, notes? }
// Used by UI inline edit. Does NOT create history rows — modifies the row in
// place. For history-preserving change, use POST (which closes prev + opens new).
// =============================================================================
const patchPriceSchema = z.object({
  sell_price: z.number().min(0).optional(),
  effective_from: z.number().int().optional(),
  effective_until: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
});

productsPricing.patch('/:productId/prices/:priceId', async (c) => {
  const productId = c.req.param('productId').toLowerCase();
  const priceId = c.req.param('priceId');
  const body = await c.req.json().catch(() => null);
  if (!body) return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be JSON' }]);

  const parsed = patchPriceSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, [{ code: 'invalid_body', message: 'Validation failed', details: { issues: parsed.error.issues } }]);
  }
  const data = parsed.data;

  const row = await c.env.DB.prepare(
    'SELECT id FROM product_prices WHERE id = ? AND product_id = ?'
  ).bind(priceId, productId).first();
  if (!row) {
    return fail(c, 404, [{ code: 'price_not_found', message: `Price ${priceId} for product ${productId} not found` }]);
  }

  const now = Math.floor(Date.now() / 1000);
  const updates: string[] = [];
  const params: unknown[] = [];

  if (data.sell_price !== undefined) { updates.push('sell_price = ?'); params.push(data.sell_price); }
  if (data.effective_from !== undefined) { updates.push('effective_from = ?'); params.push(data.effective_from); }
  if (data.effective_until !== undefined) { updates.push('effective_until = ?'); params.push(data.effective_until); }
  if (data.notes !== undefined) { updates.push('notes = ?'); params.push(data.notes); }

  if (updates.length === 0) {
    return fail(c, 400, [{ code: 'no_changes', message: 'No fields to update' }]);
  }

  updates.push('updated_at = ?');
  params.push(now);
  params.push(priceId);

  await c.env.DB.prepare(
    `UPDATE product_prices SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...params).run();

  const updated = await c.env.DB.prepare(`
    SELECT pp.*, pt.code AS price_type_code, pt.description AS price_type_description, pt.used_by_entity
    FROM product_prices pp
    JOIN price_types pt ON pp.price_type_id = pt.id
    WHERE pp.id = ?
  `).bind(priceId).first();

  return ok(c, updated);
});

// =============================================================================
// GET /api/products/:productId/prices/:priceTypeId/history — full timeline
// Returns all D1 rows for this product+price_type, newest first.
// =============================================================================
productsPricing.get('/:productId/prices/:priceTypeId/history', async (c) => {
  const productId = c.req.param('productId').toLowerCase();
  const priceTypeId = c.req.param('priceTypeId');
  const now = Math.floor(Date.now() / 1000);

  const rows = await c.env.DB.prepare(`
    SELECT
      pp.id, pp.price_type_id, pp.sell_price, pp.currency,
      pp.effective_from, pp.effective_until, pp.notes,
      pp.created_at, pp.updated_at,
      CASE
        WHEN pp.effective_until IS NULL THEN 1
        WHEN pp.effective_until > ? THEN 1
        ELSE 0
      END AS is_active,
      CASE
        WHEN pp.effective_from > ? THEN 1
        ELSE 0
      END AS is_scheduled
    FROM product_prices pp
    WHERE pp.product_id = ? AND pp.price_type_id = ?
    ORDER BY pp.effective_from DESC, pp.created_at DESC
  `).bind(now, now, productId, priceTypeId).all();

  return ok(c, { count: rows.results.length, history: rows.results });
});

// =============================================================================
// DELETE /api/products/:productId/prices/:priceId — soft-close a price
// Sets effective_until = now (immediate end of validity).
// =============================================================================
productsPricing.delete('/:productId/prices/:priceId', async (c) => {
  const productId = c.req.param('productId').toLowerCase();
  const priceId = c.req.param('priceId');
  const now = Math.floor(Date.now() / 1000);

  const row = await c.env.DB.prepare(
    'SELECT id FROM product_prices WHERE id = ? AND product_id = ?'
  ).bind(priceId, productId).first();
  if (!row) {
    return fail(c, 404, [{ code: 'price_not_found', message: `Price ${priceId} for product ${productId} not found` }]);
  }

  await c.env.DB.prepare(
    'UPDATE product_prices SET effective_until = ?, updated_at = ? WHERE id = ?'
  ).bind(now, now, priceId).run();

  return ok(c, { id: priceId, closed_at: now });
});
