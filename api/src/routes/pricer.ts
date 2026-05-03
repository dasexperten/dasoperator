import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { queryFirst } from '../lib/db';

// =============================================================================
// POST /api/pricer/quote
// Body: { sku: "DE201", price_type: "pt_distr_rub", qty: 100, discount_pct?: 5 }
// Returns: line item quote with unit_price, line_amount, currency
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

  // Normalize sku to product_id (e.g. "DE201" → "prd_de201")
  const productId = sku.startsWith('prd_') ? sku : `prd_${sku.toLowerCase()}`;
  const priceTypeId = price_type.startsWith('pt_') ? price_type : `pt_${price_type.toLowerCase()}`;

  // Find active price for this product+price_type
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
      message: `No active price for product ${productId} with price_type ${priceTypeId}`,
    }]);
  }

  // Calculate (all in minor units — kopecks/cents)
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
      unit_price: unitPriceMinor / 100,            // human-readable
      unit_price_minor: unitPriceMinor,            // exact integer for backend
      discount_pct,
      unit_price_after_discount: unitPriceAfterDiscMinor / 100,
      line_amount: lineAmountMinor / 100,
      line_amount_minor: lineAmountMinor,
    },
    metadata: {
      price_id: priceRow.price_id,
      effective_from: priceRow.effective_from,
      effective_until: priceRow.effective_until,
    },
  });
});

export default pricer;
