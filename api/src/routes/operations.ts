import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';
import { issueNextSequence } from '../lib/sequence-format';
import { sequenceIdForCompany } from '../lib/company-sequence';

const operations = new Hono<{ Bindings: Env }>();

// =============================================================================
// Schemas
// =============================================================================

const lineItemSchema = z.object({
  product_id: z.string().min(1),
  qty: z.number().int().positive(),
  unit_price: z.number().int().nonnegative(),
  discount_pct: z.number().int().min(0).max(100).default(0),
  cartons: z.number().int().nonnegative().default(0),
  inner_boxes: z.number().int().nonnegative().default(0),
  item_description: z.string().nullable().optional(),
});

const createOperationSchema = z.object({
  operation_type: z.enum(['sale', 'purchase', 'transfer']),
  operation_date: z.number().int().positive(),
  our_company_id: z.string().min(1),
  partner_id: z.string().nullable().optional(),
  manufacturer_id: z.string().nullable().optional(),
  warehouse_from_id: z.string().nullable().optional(),
  warehouse_to_id: z.string().nullable().optional(),
  currency: z.string().min(3).max(3),
  price_type_id: z.string().nullable().optional(),
  incoterms: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  line_items: z.array(lineItemSchema).min(1),
}).refine(
  (data) => {
    if (data.operation_type === 'sale' || data.operation_type === 'purchase') {
      return !!data.partner_id;
    }
    return true;
  },
  { message: 'partner_id required for sale and purchase operations' }
).refine(
  (data) => {
    if (data.operation_type === 'sale' || data.operation_type === 'transfer') {
      return !!data.warehouse_from_id;
    }
    return true;
  },
  { message: 'warehouse_from_id required for sale and transfer operations' }
).refine(
  (data) => {
    if (data.operation_type === 'purchase' || data.operation_type === 'transfer') {
      return !!data.warehouse_to_id;
    }
    return true;
  },
  { message: 'warehouse_to_id required for purchase and transfer operations' }
);

// =============================================================================
// Helpers
// =============================================================================

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

interface ProductRow {
  id: string;
  product_name: string;
  invoice_label: string;
}

interface PartnerRow {
  id: string;
  trade_name: string;
  status: string;
}

// =============================================================================
// POST /api/operations
// =============================================================================
operations.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, [{ code: 'invalid_json', message: 'Body must be valid JSON' }]);
  }

  const parsed = createOperationSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 422, [{
      code: 'invalid_body',
      message: 'Body validation failed',
      details: { issues: parsed.error.issues },
    }]);
  }

  const data = parsed.data;
  const warnings: string[] = [];

  // -------------------------------------------------------------------------
  // Validation: existence checks
  // -------------------------------------------------------------------------

  // Company exists
  const company = await c.env.DB.prepare(
    'SELECT id, abbreviation FROM companies WHERE id = ?'
  ).bind(data.our_company_id).first<{ id: string; abbreviation: string }>();

  if (!company) {
    return fail(c, 404, [{
      code: 'company_not_found',
      message: `our_company_id ${data.our_company_id} does not exist`,
    }]);
  }

  // Partner exists (if specified)
  let partner: PartnerRow | null = null;
  if (data.partner_id) {
    partner = await c.env.DB.prepare(
      'SELECT id, trade_name, status FROM partners WHERE id = ? AND deleted_at IS NULL'
    ).bind(data.partner_id).first<PartnerRow>();

    if (!partner) {
      return fail(c, 404, [{
        code: 'partner_not_found',
        message: `partner_id ${data.partner_id} does not exist`,
      }]);
    }

    if (partner.status === 'pending' || partner.status === 'blocked') {
      warnings.push(`partner_${partner.status}: ${partner.trade_name} has status ${partner.status}`);
    }
  }

  // Warehouses exist (if specified)
  if (data.warehouse_from_id) {
    const wh = await c.env.DB.prepare(
      'SELECT id FROM warehouses WHERE id = ?'
    ).bind(data.warehouse_from_id).first();
    if (!wh) {
      return fail(c, 404, [{
        code: 'warehouse_not_found',
        message: `warehouse_from_id ${data.warehouse_from_id} does not exist`,
      }]);
    }
  }
  if (data.warehouse_to_id) {
    const wh = await c.env.DB.prepare(
      'SELECT id FROM warehouses WHERE id = ?'
    ).bind(data.warehouse_to_id).first();
    if (!wh) {
      return fail(c, 404, [{
        code: 'warehouse_not_found',
        message: `warehouse_to_id ${data.warehouse_to_id} does not exist`,
      }]);
    }
  }

  // All products exist (single batched lookup)
  const productIds = data.line_items.map((li) => li.product_id);
  const placeholders = productIds.map(() => '?').join(', ');
  const productRows = await c.env.DB.prepare(
    `SELECT id, product_name, invoice_label FROM products WHERE id IN (${placeholders})`
  ).bind(...productIds).all<ProductRow>();

  const productMap = new Map<string, ProductRow>();
  for (const p of productRows.results) {
    productMap.set(p.id, p);
  }

  const missingProducts = productIds.filter((id) => !productMap.has(id));
  if (missingProducts.length > 0) {
    return fail(c, 404, [{
      code: 'product_not_found',
      message: `Unknown product_id(s): ${missingProducts.join(', ')}`,
    }]);
  }

  // -------------------------------------------------------------------------
  // Issue reference number from sequences
  // -------------------------------------------------------------------------

  const sequenceId = sequenceIdForCompany(data.our_company_id);
  if (!sequenceId) {
    return fail(c, 500, [{
      code: 'sequence_mapping_missing',
      message: `No sequence mapped for company ${data.our_company_id}`,
    }]);
  }

  const seqResult = await issueNextSequence(c.env.DB, sequenceId);
  if (!seqResult) {
    return fail(c, 500, [{
      code: 'sequence_failed',
      message: `Failed to issue from sequence ${sequenceId}`,
    }]);
  }

  // -------------------------------------------------------------------------
  // Compute money fields
  // -------------------------------------------------------------------------

  let totalAmount = 0;
  const lineItemsComputed = data.line_items.map((li) => {
    const product = productMap.get(li.product_id)!;
    const description = li.item_description ?? product.invoice_label;

    const unitPriceAfterDisc =
      li.discount_pct === 0
        ? li.unit_price
        : Math.round(li.unit_price * (100 - li.discount_pct) / 100);
    const lineAmount = unitPriceAfterDisc * li.qty;

    totalAmount += lineAmount;

    return {
      id: genId('li'),
      product_id: li.product_id,
      item_description: description,
      qty: li.qty,
      cartons: li.cartons,
      inner_boxes: li.inner_boxes,
      unit_price: li.unit_price,
      discount_pct: li.discount_pct,
      unit_price_after_disc: unitPriceAfterDisc,
      line_amount: lineAmount,
      currency: data.currency,
      line_usd_equiv: null,
    };
  });

  // FX deferred to Phase 2.0c-2b
  if (data.currency !== 'USD') {
    warnings.push(
      `fx_unavailable: total_usd_equiv not computed for currency ${data.currency}; FX rate refresh pending Phase 2.0c-2b`
    );
  }

  // -------------------------------------------------------------------------
  // Build batch (operation header + N line_items)
  // -------------------------------------------------------------------------

  const operationId = genId('op');
  const now = Math.floor(Date.now() / 1000);

  const isUsd = data.currency === 'USD';
  const totalUsdEquiv = isUsd ? totalAmount : null;
  const fxRateToUsd = isUsd ? 1_000_000 : null;

  // NOTE: reference is squatted into order_doc_ref column for now.
  // TODO Phase 2.0c-2c: migration 0004 ALTER TABLE operations ADD COLUMN reference,
  // then move this value out of order_doc_ref (which should hold buyer's PO ref).
  const insertOpStmt = c.env.DB.prepare(`
    INSERT INTO operations (
      id, operation_date, operation_type, partner_id, our_company_id,
      manufacturer_id, warehouse_from_id, warehouse_to_id,
      shipment_scheme, shipper_id, order_doc_ref, status, paid,
      price_type_id, currency, fx_rate_to_usd, total_amount, total_usd_equiv,
      incoterms, hs_code, lead_time_days, notes,
      created_at, updated_at, deleted_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'draft', 0,
      ?, ?, ?, ?, ?, ?, NULL, NULL, ?,
      ?, ?, NULL
    )
  `).bind(
    operationId,
    data.operation_date,
    data.operation_type,
    data.partner_id ?? null,
    data.our_company_id,
    data.manufacturer_id ?? null,
    data.warehouse_from_id ?? null,
    data.warehouse_to_id ?? null,
    seqResult.formatted,  // order_doc_ref doubles as our reference (tech debt — see TODO above)
    data.price_type_id ?? null,
    data.currency,
    fxRateToUsd,
    totalAmount,
    totalUsdEquiv,
    data.incoterms ?? null,
    data.notes ?? null,
    now,
    now
  );

  const lineItemStmts = lineItemsComputed.map((li) =>
    c.env.DB.prepare(`
      INSERT INTO line_items (
        id, operation_id, product_id, item_description,
        qty, cartons, inner_boxes,
        unit_price, discount_pct, unit_price_after_disc,
        line_amount, currency, line_usd_equiv,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      li.id, operationId, li.product_id, li.item_description,
      li.qty, li.cartons, li.inner_boxes,
      li.unit_price, li.discount_pct, li.unit_price_after_disc,
      li.line_amount, li.currency, li.line_usd_equiv,
      now, now
    )
  );

  // Atomic batch — operation + all line_items
  try {
    await c.env.DB.batch([insertOpStmt, ...lineItemStmts]);
  } catch (err) {
    return fail(c, 500, [{
      code: 'insert_failed',
      message: 'Failed to insert operation',
      details: { error: err instanceof Error ? err.message : String(err) },
    }]);
  }

  // -------------------------------------------------------------------------
  // Build response
  // -------------------------------------------------------------------------

  return ok(c, {
    operation: {
      id: operationId,
      reference: seqResult.formatted,
      operation_type: data.operation_type,
      operation_date: data.operation_date,
      our_company_id: data.our_company_id,
      partner_id: data.partner_id ?? null,
      manufacturer_id: data.manufacturer_id ?? null,
      warehouse_from_id: data.warehouse_from_id ?? null,
      warehouse_to_id: data.warehouse_to_id ?? null,
      status: 'draft',
      paid: 0,
      price_type_id: data.price_type_id ?? null,
      currency: data.currency,
      fx_rate_to_usd: fxRateToUsd,
      total_amount: totalAmount,
      total_usd_equiv: totalUsdEquiv,
      incoterms: data.incoterms ?? null,
      notes: data.notes ?? null,
      created_at: now,
      updated_at: now,
    },
    line_items: lineItemsComputed,
    warnings,
  }, ['Operation created in draft status']);
});

// =============================================================================
// GET /api/operations/:id
// Returns operation + ordered line_items.
// Aliases order_doc_ref → reference for symmetry with POST response shape.
// =============================================================================
operations.get('/:id', async (c) => {
  const opId = c.req.param('id');

  const op = await c.env.DB.prepare(
    'SELECT * FROM operations WHERE id = ? AND deleted_at IS NULL'
  ).bind(opId).first<Record<string, unknown>>();

  if (!op) {
    return fail(c, 404, [{
      code: 'operation_not_found',
      message: `Operation ${opId} not found`,
    }]);
  }

  const lineItems = await c.env.DB.prepare(
    'SELECT * FROM line_items WHERE operation_id = ? ORDER BY created_at ASC'
  ).bind(opId).all();

  return ok(c, {
    operation: {
      ...op,
      reference: op.order_doc_ref,  // alias for symmetry with POST response
    },
    line_items: lineItems.results,
  });
});

export default operations;
