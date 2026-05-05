import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { queryFirst } from '../lib/db';
import { getProductPrice, getPricelist, invalidatePricelistCache, PRICE_TYPE_TO_FILE } from '../lib/pricelist';

// =============================================================================
// POST /api/pricer/quote
// Body: { sku: "DE201", price_type: "pt_distr_rub", qty: 100, discount_pct?: 5 }
// Returns: line item quote with unit_price, line_amount, currency
//
// Phase 5.1-pricer-r2: R2 pricelist first, D1 fallback.
// =============================================================================

const pricer = new Hono<{ Bindings: Env }>();

const quoteSchema = z.object({
  sku: z.string().min(1),
  price_type: z.string().min(1),
  qty: z.number().int().positive(),
  discount_pct: z.number().min(0).max(100).optional().default(0),
});

interface PriceRow {
  price_id: string;
  product_id: string;
  product_name: string;
  invoice_label: string;
  price_type_id: string;
  price_type_code: string;
  sell_price: number;
  currency: string;
  effective_from: number;
  effective_until: number | null;
}

pricer.post('/quote', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Request body must be valid JSON' }]);
  }

  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Request body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const { sku, price_type, qty, discount_pct } = parsed.data;

  // Normalize: SKU stored without prd_ prefix (Phase 4.3c-clean — bare ids)
  const productId = sku.replace(/^prd_/, '').toLowerCase();
  const priceTypeId = price_type.startsWith('pt_') ? price_type : `pt_${price_type.toLowerCase()}`;

  // STEP 1: try R2 pricelist (source of truth)
  try {
    const r2Price = await getProductPrice(c.env, productId, priceTypeId);
    if (r2Price) {
      const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(r2Price.currency);
      const minorFactor = isZeroDecimal ? 1 : 100;
      const unitPriceMinor = Math.round(r2Price.price * minorFactor);
      const unitPriceAfterDiscMinor = Math.round(unitPriceMinor * (100 - discount_pct) / 100);
      const lineAmountMinor = unitPriceAfterDiscMinor * qty;

      // Fetch product display name from D1 for the response
      const productMeta = await queryFirst<{ product_name: string; invoice_label: string }>(
        c.env.DB,
        'SELECT product_name, invoice_label FROM products WHERE id = ? AND deleted_at IS NULL',
        productId
      );

      return ok(c, {
        quote: {
          sku: productId,
          product_name: productMeta?.product_name ?? sku,
          invoice_label: productMeta?.invoice_label ?? sku,
          price_type: priceTypeId,
          qty,
          currency: r2Price.currency,
          unit_price: unitPriceMinor / minorFactor,
          unit_price_minor: unitPriceMinor,
          discount_pct,
          unit_price_after_discount: unitPriceAfterDiscMinor / minorFactor,
          line_amount: lineAmountMinor / minorFactor,
          line_amount_minor: lineAmountMinor,
        },
        metadata: {
          source: 'pricer_r2',
          source_file: r2Price.source,
        },
      });
    }
  } catch (err) {
    console.warn(`R2 quote read failed for ${productId}/${priceTypeId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // STEP 2: fallback to D1 product_prices
  const now = Math.floor(Date.now() / 1000);
  const priceRow = await queryFirst<PriceRow>(
    c.env.DB,
    `SELECT
       pp.id as price_id,
       pp.product_id,
       p.product_name,
       p.invoice_label,
       pp.price_type_id,
       pt.code as price_type_code,
       pp.sell_price,
       pp.currency,
       pp.effective_from,
       pp.effective_until
     FROM product_prices pp
     JOIN products p ON pp.product_id = p.id
     JOIN price_types pt ON pp.price_type_id = pt.id
     WHERE pp.product_id = ?
       AND pp.price_type_id = ?
       AND pp.effective_from <= ?
       AND (pp.effective_until IS NULL OR pp.effective_until >= ?)
       AND p.deleted_at IS NULL
     ORDER BY pp.effective_from DESC
     LIMIT 1`,
    productId,
    priceTypeId,
    now,
    now
  );

  if (!priceRow) {
    return fail(c, 404, [{
      code: 'price_not_found',
      message: `No active price for product ${productId} with price_type ${priceTypeId} (R2 and D1 both empty)`,
    }]);
  }

  const isZeroDecimal = ['VND', 'JPY', 'KRW'].includes(priceRow.currency);
  const minorFactor = isZeroDecimal ? 1 : 100;
  const unitPriceMinor = priceRow.sell_price;
  const unitPriceAfterDiscMinor = Math.round(unitPriceMinor * (100 - discount_pct) / 100);
  const lineAmountMinor = unitPriceAfterDiscMinor * qty;

  return ok(c, {
    quote: {
      sku: priceRow.product_id,
      product_name: priceRow.product_name,
      invoice_label: priceRow.invoice_label,
      price_type: priceRow.price_type_code,
      qty,
      currency: priceRow.currency,
      unit_price: unitPriceMinor / minorFactor,
      unit_price_minor: unitPriceMinor,
      discount_pct,
      unit_price_after_discount: unitPriceAfterDiscMinor / minorFactor,
      line_amount: lineAmountMinor / minorFactor,
      line_amount_minor: lineAmountMinor,
    },
    metadata: {
      source: 'd1_fallback',
      price_id: priceRow.price_id,
      effective_from: priceRow.effective_from,
      effective_until: priceRow.effective_until,
    },
  });
});

// =============================================================================
// POST /api/pricer/refresh-cache
// Invalidate KV cache for one or all pricelists after R2 upload.
// Body: { price_type_id?: "pt_distr_rub" }  — empty = invalidate all
// =============================================================================
pricer.post('/refresh-cache', async (c) => {
  let body: { price_type_id?: string } = {};
  try {
    body = await c.req.json() as { price_type_id?: string };
  } catch {
    // empty body OK — invalidate all
  }

  if (body.price_type_id) {
    await invalidatePricelistCache(c.env, body.price_type_id);
    return ok(c, { invalidated: [body.price_type_id] });
  }

  const all = Object.keys(PRICE_TYPE_TO_FILE);
  await Promise.all(all.map((id) => invalidatePricelistCache(c.env, id)));
  return ok(c, { invalidated: all });
});

// =============================================================================
// GET /api/pricer/list/:price_type_id
// Returns full SKU→price map for a single pricelist file.
// Used by /products list to show prices in the chosen currency.
// =============================================================================
pricer.get('/list/:priceTypeId', async (c) => {
  const priceTypeId = c.req.param('priceTypeId');
  const filename = PRICE_TYPE_TO_FILE[priceTypeId];
  if (!filename) {
    return fail(c, 400, [{
      code: 'unknown_price_type',
      message: `Unknown price_type_id: ${priceTypeId}`,
    }]);
  }

  try {
    const pricelist = await getPricelist(c.env, priceTypeId);
    return ok(c, {
      price_type_id: priceTypeId,
      filename: pricelist.filename,
      currency: pricelist.currency,
      last_updated: pricelist.lastUpdated,
      prices: pricelist.prices,
      count: Object.keys(pricelist.prices).length,
    });
  } catch (err) {
    return fail(c, 500, [{
      code: 'pricelist_read_failed',
      message: err instanceof Error ? err.message : String(err),
    }]);
  }
});

export default pricer;
